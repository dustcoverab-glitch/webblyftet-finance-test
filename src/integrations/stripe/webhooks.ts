import Stripe from "stripe";
import { id, one } from "../../lib/db";
import { createAccountingEvent, recordPaymentAttempt, upsertPayment } from "../../core/finance";
import { PublicAppError } from "../fortnox/client";
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
  const existing = await one<any>(
    env.DB,
    "SELECT * FROM integration_events WHERE provider=? AND provider_event_id=?",
    "STRIPE",
    event.id
  );
  if (existing?.status === "PROCESSED") return { duplicate: true, row: existing };
  if (existing) return { duplicate: true, row: existing };

  const eventId = id("ievt");
  await env.DB.prepare(
    `INSERT INTO integration_events(id,provider,provider_event_id,event_type,payload_json,status)
     VALUES (?,?,?,?,?,?)`
  ).bind(eventId, "STRIPE", event.id, event.type, JSON.stringify(event), "RECEIVED").run();
  return {
    duplicate: false,
    row: await one<any>(env.DB, "SELECT * FROM integration_events WHERE id=?", eventId)
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
      payload: { stripe_payment_intent_id: intent.id }
    });
  }
}
