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

  await env.DB.prepare(
    `UPDATE integration_events
     SET status='PROCESSING', payload_json=?, error_message=NULL, processed_at=NULL
     WHERE provider=? AND provider_event_id=? AND status IN ('RECEIVED','FAILED')`
  ).bind(JSON.stringify(event), "STRIPE", event.id).run();

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
    default:
      break;
  }
}

async function handlePaymentIntent(env: Env, intent: Stripe.PaymentIntent, status: "SUCCEEDED" | "FAILED") {
  const customerId = typeof intent.metadata?.webblyftet_customer_id === "string"
    ? intent.metadata.webblyftet_customer_id
    : null;
  if (!customerId) return;
  const payment = await upsertPayment(env, {
    customer_id: customerId,
    amount: intent.amount_received || intent.amount,
    currency: intent.currency.toUpperCase(),
    status,
    provider: "STRIPE",
    provider_payment_id: intent.id,
    paid_at: status === "SUCCEEDED" ? new Date((intent.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString() : null
  });
  await recordPaymentAttempt(env, {
    payment_id: payment!.id,
    provider: "STRIPE",
    provider_attempt_id: intent.latest_charge?.toString() ?? `${intent.id}:${status}`,
    status,
    payload_json: { stripe_payment_intent_id: intent.id }
  });
  if (status === "SUCCEEDED") {
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
