import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { stripeClient } from "./client";
import type { StripeSetupIntentResult } from "./types";

export async function createPaymentMethodSetupIntent(env: Env, customerId: string): Promise<StripeSetupIntentResult> {
  const customer = await one<any>(env.DB, "SELECT id,stripe_customer_id FROM customers WHERE id=?", customerId);
  if (!customer) throw new PublicAppError(404, "Kunden hittades inte.");
  if (!customer.stripe_customer_id) throw new PublicAppError(409, "Kunden saknar Stripe Customer.");

  const now = new Date();
  const nowIso = now.toISOString();
  const existing = await one<any>(
    env.DB,
    `SELECT * FROM payment_method_setup_sessions
     WHERE customer_id=? AND status IN ('CREATED','REQUIRES_PAYMENT_METHOD') AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT 1`,
    customer.id,
    nowIso
  );
  const stripe = stripeClient(env);
  if (existing?.stripe_setup_intent_id) {
    const intent = await stripe.setupIntents.retrieve(existing.stripe_setup_intent_id);
    await env.DB.prepare(
      "UPDATE payment_method_setup_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(setupIntentStatus(intent.status), existing.id).run();
    return {
      setup_session_id: existing.id,
      setup_intent_id: intent.id,
      client_secret: intent.client_secret,
      reused: true
    };
  }

  const sessionId = existing?.id ?? id("pmsetup");
  const expiresAt = existing?.expires_at ?? new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO payment_method_setup_sessions(id,customer_id,stripe_customer_id,status,expires_at)
       VALUES (?,?,?,?,?)`
    ).bind(sessionId, customer.id, customer.stripe_customer_id, "CREATED", expiresAt).run();
  }

  try {
    const intent = await stripe.setupIntents.create(
      {
        customer: customer.stripe_customer_id,
        usage: "off_session",
        automatic_payment_methods: {
          enabled: true
        },
        metadata: {
          webblyftet_customer_id: customer.id,
          webblyftet_setup_session_id: sessionId
        }
      },
      {
        idempotencyKey: `payment-method-setup:${sessionId}`
      }
    );
    await env.DB.prepare(
      `UPDATE payment_method_setup_sessions
       SET stripe_setup_intent_id=?, status=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(intent.id, setupIntentStatus(intent.status), sessionId).run();
    return {
      setup_session_id: sessionId,
      setup_intent_id: intent.id,
      client_secret: intent.client_secret,
      reused: false
    };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE payment_method_setup_sessions SET status='FAILED', updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(sessionId).run();
    throw error;
  }
}

function setupIntentStatus(status: string): string {
  switch (status) {
    case "requires_payment_method":
      return "REQUIRES_PAYMENT_METHOD";
    case "requires_confirmation":
      return "REQUIRES_CONFIRMATION";
    case "requires_action":
      return "REQUIRES_ACTION";
    case "processing":
      return "PROCESSING";
    case "succeeded":
      return "SUCCEEDED";
    case "canceled":
      return "CANCELLED";
    default:
      return "CREATED";
  }
}
