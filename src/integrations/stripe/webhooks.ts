import Stripe from "stripe";
import { id, one } from "../../lib/db";
import { createAccountingEvent, recordPaymentAttempt, upsertPayment } from "../../core/finance";
import { PublicAppError } from "../../lib/app-error";
import { stripeClient, stripeWebhookCryptoProvider } from "./client";
import { handledStripeEvents } from "./types";

export async function constructStripeWebhookEvent(env: Env, rawBody: string, signature: string | null): Promise<Stripe.Event> {
  if (!signature) throw new PublicAppError(400, "Stripe-signatur saknas.");
  const stripe = stripeClient(env);
  return stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    stripeWebhookCryptoProvider()
  );
}

export async function recordIntegrationEvent(env: Env, event: Stripe.Event) {
  const eventId = id("ievt");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO integration_events(id,provider,provider_event_id,event_type,payload_json,status)
     VALUES (?,?,?,?,?,?)`
  ).bind(eventId, "STRIPE", event.id, event.type, JSON.stringify(event), "RECEIVED").run();

  const existing = await one<any>(
    env.DB,
    "SELECT * FROM integration_events WHERE provider=? AND provider_event_id=?",
    "STRIPE",
    event.id
  );
  if (!existing) throw new PublicAppError(500, "Webhook-event kunde inte registreras.");
  if (existing.status === "PROCESSED") return { duplicate: true, row: existing };
  if (existing.status === "PROCESSING") return { duplicate: true, row: existing };

  const claim = await env.DB.prepare(
    `UPDATE integration_events
     SET status='PROCESSING', payload_json=?, error_message=NULL, processed_at=NULL
     WHERE provider=? AND provider_event_id=? AND status IN ('RECEIVED','FAILED')`
  ).bind(JSON.stringify(event), "STRIPE", event.id).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const row = await one<any>(
      env.DB,
      "SELECT * FROM integration_events WHERE provider=? AND provider_event_id=?",
      "STRIPE",
      event.id
    );
    if (row?.status === "PROCESSED" || row?.status === "PROCESSING") return { duplicate: true, row };
    throw new PublicAppError(409, "Webhook-event kunde inte claimas för processing.");
  }

  const row = await one<any>(
    env.DB,
    "SELECT * FROM integration_events WHERE provider=? AND provider_event_id=?",
    "STRIPE",
    event.id
  );
  if (row?.status !== "PROCESSING") return { duplicate: true, row };
  return {
    duplicate: false,
    row
  };
}

export async function processStripeEvent(env: Env, event: Stripe.Event) {
  const recorded = await recordIntegrationEvent(env, event);
  if (recorded.duplicate) return { received: true, duplicate: true };

  try {
    if ((handledStripeEvents as readonly string[]).includes(event.type)) {
      await handleKnownEvent(env, event);
    }
    await env.DB.prepare(
      "UPDATE integration_events SET status='PROCESSED', processed_at=CURRENT_TIMESTAMP WHERE provider=? AND provider_event_id=?"
    ).bind("STRIPE", event.id).run();
    return { received: true, duplicate: false };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE integration_events SET status='FAILED', error_message=?, processed_at=CURRENT_TIMESTAMP WHERE provider=? AND provider_event_id=?"
    ).bind(error instanceof Error ? error.message : String(error), "STRIPE", event.id).run();
    throw error;
  }
}

async function handleKnownEvent(env: Env, event: Stripe.Event) {
  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentIntent(env, event.data.object as Stripe.PaymentIntent, "SUCCEEDED");
      break;
    case "payment_intent.payment_failed":
      await handlePaymentIntent(env, event.data.object as Stripe.PaymentIntent, "FAILED");
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await syncStripeSubscription(env, event.data.object as Stripe.Subscription, false);
      break;
    case "customer.subscription.deleted":
      await syncStripeSubscription(env, event.data.object as Stripe.Subscription, true);
      break;
    case "setup_intent.succeeded":
      await handleSetupIntentSucceeded(env, event.data.object as Stripe.SetupIntent);
      break;
    case "invoice.paid":
      await handleStripeInvoicePaid(env, event.data.object as Stripe.Invoice);
      break;
    case "invoice.payment_failed":
      await handleStripeInvoicePaymentFailed(env, event.data.object as Stripe.Invoice);
      break;
    default:
      break;
  }
}

async function handleSetupIntentSucceeded(env: Env, intent: Stripe.SetupIntent) {
  const sessionId = typeof intent.metadata?.webblyftet_setup_session_id === "string"
    ? intent.metadata.webblyftet_setup_session_id
    : null;
  if (!sessionId) return;
  const session = await one<any>(env.DB, "SELECT * FROM payment_method_setup_sessions WHERE id=?", sessionId);
  if (!session) return;
  const paymentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id;
  if (!paymentMethodId) return;
  const stripe = stripeClient(env);
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  const card = paymentMethod.card;
  if (!card) return;
  const existingDefault = await one<any>(
    env.DB,
    "SELECT id FROM payment_methods WHERE customer_id=? AND provider='STRIPE' AND is_default=1",
    session.customer_id
  );
  const localId = id("pm");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_methods
        (id,customer_id,provider,provider_payment_method_id,type,brand,last4,exp_month,exp_year,status,is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider, provider_payment_method_id) DO UPDATE SET
         brand=excluded.brand,last4=excluded.last4,exp_month=excluded.exp_month,exp_year=excluded.exp_year,
         status='ACTIVE',is_default=excluded.is_default,updated_at=CURRENT_TIMESTAMP`
    ).bind(localId, session.customer_id, "STRIPE", paymentMethod.id, paymentMethod.type, card.brand, card.last4, card.exp_month, card.exp_year, "ACTIVE", existingDefault ? 0 : 1),
    env.DB.prepare("UPDATE payment_method_setup_sessions SET status='SUCCEEDED', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(session.id)
  ]);
  if (!existingDefault) {
    await stripe.customers.update(session.stripe_customer_id, {
      invoice_settings: {
        default_payment_method: paymentMethod.id
      }
    });
  }
  await env.DB.prepare(
    `INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,after_json)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id("aud"), "STRIPE", null, "PAYMENT_METHOD_ATTACHED", "customer", session.customer_id, JSON.stringify({
    payment_method_id: paymentMethod.id,
    brand: card.brand,
    last4: card.last4
  })).run();
}

async function handleStripeInvoicePaid(env: Env, invoice: Stripe.Invoice) {
  const subscriptionId = stripeInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE stripe_subscription_id=?", subscriptionId);
  if (!subscription) return;
  const customerId = subscription.customer_id;
  const paymentIntentId = stripeInvoicePaymentIntentId(invoice);
  const gross = invoice.amount_paid ?? invoice.total ?? 0;
  let payment = await upsertPayment(env, {
    customer_id: customerId,
    subscription_id: subscription.id,
    amount: gross,
    currency: invoice.currency.toUpperCase(),
    status: "SUCCEEDED",
    provider: "STRIPE",
    provider_payment_id: invoice.id,
    paid_at: new Date((invoice.status_transitions?.paid_at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
  });
  if (payment?.status === "FAILED") {
    await upsertPayment(env, {
      customer_id: customerId,
      subscription_id: subscription.id,
      amount: gross,
      currency: invoice.currency.toUpperCase(),
      status: "PROCESSING",
      provider: "STRIPE",
      provider_payment_id: invoice.id,
      paid_at: null
    });
    payment = await upsertPayment(env, {
      customer_id: customerId,
      subscription_id: subscription.id,
      amount: gross,
      currency: invoice.currency.toUpperCase(),
      status: "SUCCEEDED",
      provider: "STRIPE",
      provider_payment_id: invoice.id,
      paid_at: new Date((invoice.status_transitions?.paid_at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    });
  }
  if (payment?.status !== "SUCCEEDED") return;
  await recordPaymentAttempt(env, {
    payment_id: payment!.id,
    provider: "STRIPE",
    provider_attempt_id: paymentIntentId ?? `${invoice.id}:paid`,
    status: "SUCCEEDED",
    payload_json: {
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId
    }
  });
  await createAccountingEvent(env, {
    event_type: "SUBSCRIPTION_PAYMENT_RECEIVED",
    entity_type: "payment",
    entity_id: payment!.id,
    currency: invoice.currency,
    net_amount: gross,
    vat_amount: 0,
    gross_amount: gross,
    payload: {
      accounting_semantics: "SUBSCRIPTION_SETTLEMENT",
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      period_start: stripeTimestampToIso(invoice.period_start),
      period_end: stripeTimestampToIso(invoice.period_end)
    }
  });
}

async function handleStripeInvoicePaymentFailed(env: Env, invoice: Stripe.Invoice) {
  const subscriptionId = stripeInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE stripe_subscription_id=?", subscriptionId);
  if (!subscription) return;
  await env.DB.prepare("UPDATE subscriptions SET status='PAST_DUE', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(subscription.id).run();
  const payment = await upsertPayment(env, {
    customer_id: subscription.customer_id,
    subscription_id: subscription.id,
    amount: invoice.amount_due ?? invoice.total ?? 0,
    currency: invoice.currency.toUpperCase(),
    status: "FAILED",
    provider: "STRIPE",
    provider_payment_id: invoice.id,
    paid_at: null
  });
  await recordPaymentAttempt(env, {
    payment_id: payment!.id,
    provider: "STRIPE",
    provider_attempt_id: stripeInvoicePaymentIntentId(invoice) ?? `${invoice.id}:failed`,
    status: "FAILED",
    error_message: "Stripe subscription invoice payment failed",
    payload_json: {
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId
    }
  });
}

async function handlePaymentIntent(env: Env, intent: Stripe.PaymentIntent, status: "SUCCEEDED" | "FAILED") {
  const customerId = typeof intent.metadata?.webblyftet_customer_id === "string"
    ? intent.metadata.webblyftet_customer_id
    : null;
  if (!customerId) return;
  let payment = await upsertPayment(env, {
    customer_id: customerId,
    amount: intent.amount_received || intent.amount,
    currency: intent.currency.toUpperCase(),
    status,
    provider: "STRIPE",
    provider_payment_id: intent.id,
    paid_at: status === "SUCCEEDED" ? new Date((intent.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString() : null
  });
  if (status === "SUCCEEDED" && payment?.status === "FAILED") {
    await upsertPayment(env, {
      customer_id: customerId,
      amount: intent.amount_received || intent.amount,
      currency: intent.currency.toUpperCase(),
      status: "PROCESSING",
      provider: "STRIPE",
      provider_payment_id: intent.id,
      paid_at: null
    });
    payment = await upsertPayment(env, {
      customer_id: customerId,
      amount: intent.amount_received || intent.amount,
      currency: intent.currency.toUpperCase(),
      status: "SUCCEEDED",
      provider: "STRIPE",
      provider_payment_id: intent.id,
      paid_at: new Date((intent.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    });
  }
  await recordPaymentAttempt(env, {
    payment_id: payment!.id,
    provider: "STRIPE",
    provider_attempt_id: intent.latest_charge?.toString() ?? `${intent.id}:${status}`,
    status,
    payload_json: { stripe_payment_intent_id: intent.id }
  });
  if (payment?.status === "SUCCEEDED") {
    const gross = intent.amount_received || intent.amount;
    await createAccountingEvent(env, {
      event_type: "PAYMENT_RECEIVED",
      entity_type: "payment",
      entity_id: payment!.id,
      currency: intent.currency,
      net_amount: gross,
      vat_amount: 0,
      gross_amount: gross,
      payload: {
        accounting_semantics: "SETTLEMENT",
        stripe_payment_intent_id: intent.id
      }
    });
  }
}

async function syncStripeSubscription(env: Env, stripeSubscription: Stripe.Subscription, deleted: boolean) {
  const metadata = stripeSubscription.metadata ?? {};
  const localSubscriptionId = typeof metadata.webblyftet_subscription_id === "string"
    ? metadata.webblyftet_subscription_id
    : null;
  const existing = await one<any>(
    env.DB,
    "SELECT * FROM subscriptions WHERE stripe_subscription_id=?",
    stripeSubscription.id
  ) ?? (localSubscriptionId
    ? await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", localSubscriptionId)
    : null);

  if (!existing) return;

  const raw = stripeSubscription as unknown as {
    current_period_start?: number;
    current_period_end?: number;
    cancel_at_period_end?: boolean;
  };
  await env.DB.prepare(
    `UPDATE subscriptions
     SET stripe_subscription_id=?,
         status=?,
         current_period_start=?,
         current_period_end=?,
         cancel_at_period_end=?,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).bind(
    stripeSubscription.id,
    localSubscriptionStatus(stripeSubscription.status, deleted),
    stripeTimestampToIso(raw.current_period_start),
    stripeTimestampToIso(raw.current_period_end),
    raw.cancel_at_period_end ? 1 : 0,
    existing.id
  ).run();
}

function localSubscriptionStatus(status: Stripe.Subscription.Status, deleted: boolean): typeof import("../../core/finance").subscriptionStatuses[number] {
  if (deleted) return "CANCELLED";
  switch (status) {
    case "active":
    case "trialing":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
      return "PAST_DUE";
    case "paused":
      return "PAUSED";
    case "canceled":
      return "CANCELLED";
    case "incomplete_expired":
      return "ENDED";
    default:
      return "PENDING";
  }
}

function stripeTimestampToIso(timestamp?: number): string | null {
  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

function stripeInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | null } | null } | null;
  };
  if (typeof raw.subscription === "string") return raw.subscription;
  if (raw.subscription?.id) return raw.subscription.id;
  return raw.parent?.subscription_details?.subscription ?? null;
}

function stripeInvoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as { payment_intent?: string | { id?: string } | null };
  if (typeof raw.payment_intent === "string") return raw.payment_intent;
  return raw.payment_intent?.id ?? null;
}
