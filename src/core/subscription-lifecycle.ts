import { audit } from "./finance";
import { stripeClient } from "../integrations/stripe/client";
import { createPaymentMethodSetupIntent } from "../integrations/stripe/subscriptions";
import { PublicAppError } from "../lib/app-error";
import { decryptString, encryptString, sha256Hex } from "../lib/crypto";
import { id, one } from "../lib/db";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function expiryIso(days = 14): string {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
}

async function updateSessionStatus(env: Env, sessionId: string, status: string) {
  await env.DB.prepare(
    "UPDATE payment_method_update_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(status, sessionId).run();
}

async function updateLocalCancellation(env: Env, subscriptionId: string, data: {
  cancel_at_period_end: boolean;
  current_period_end?: number | null;
  status?: string | null;
  cancelled_at?: number | null;
  reason?: string | null;
}) {
  const effectiveAt = data.current_period_end ? new Date(data.current_period_end * 1000).toISOString() : null;
  const cancelledAt = data.cancelled_at ? new Date(data.cancelled_at * 1000).toISOString() : null;
  await env.DB.prepare(
    `UPDATE subscriptions
     SET cancel_at_period_end=?,
         cancellation_effective_at=?,
         cancelled_at=?,
         cancellation_reason=?,
         status=CASE WHEN ?='canceled' THEN 'CANCELLED' ELSE status END,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).bind(
    data.cancel_at_period_end ? 1 : 0,
    data.cancel_at_period_end ? effectiveAt : null,
    cancelledAt,
    data.reason ?? null,
    data.status ?? "",
    subscriptionId
  ).run();
}

export async function scheduleSubscriptionCancellation(env: Env, subscriptionId: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) throw new PublicAppError(404, "Abonnemanget hittades inte.");
  if (!subscription.stripe_subscription_id) throw new PublicAppError(409, "Abonnemanget saknar Stripe Subscription.");
  if (subscription.cancel_at_period_end) return { stripe_subscription_id: subscription.stripe_subscription_id, cancel_at_period_end: true, reused: true };

  const result = await stripeClient(env).subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true
  }, {
    idempotencyKey: `subscription-cancel-at-period-end:${subscription.id}`
  });
  await updateLocalCancellation(env, subscription.id, {
    cancel_at_period_end: Boolean(result.cancel_at_period_end),
    current_period_end: (result as any).current_period_end ?? null,
    status: result.status,
    reason: "PERIOD_END_REQUESTED"
  });
  await audit(env, "STRIPE", null, "SUBSCRIPTION_CANCEL_AT_PERIOD_END_REQUESTED", "subscription", subscription.id, subscription, {
    stripe_subscription_id: result.id,
    cancel_at_period_end: result.cancel_at_period_end
  });
  return { stripe_subscription_id: result.id, cancel_at_period_end: result.cancel_at_period_end, reused: false };
}

export async function undoScheduledSubscriptionCancellation(env: Env, subscriptionId: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) throw new PublicAppError(404, "Abonnemanget hittades inte.");
  if (!subscription.stripe_subscription_id) throw new PublicAppError(409, "Abonnemanget saknar Stripe Subscription.");
  if (!subscription.cancel_at_period_end) return { stripe_subscription_id: subscription.stripe_subscription_id, cancel_at_period_end: false, reused: true };

  const result = await stripeClient(env).subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: false
  }, {
    idempotencyKey: `subscription-undo-cancel-at-period-end:${subscription.id}`
  });
  await updateLocalCancellation(env, subscription.id, {
    cancel_at_period_end: false,
    current_period_end: (result as any).current_period_end ?? null,
    status: result.status,
    reason: null
  });
  await audit(env, "STRIPE", null, "SUBSCRIPTION_CANCEL_AT_PERIOD_END_UNDONE", "subscription", subscription.id, subscription, {
    stripe_subscription_id: result.id,
    cancel_at_period_end: result.cancel_at_period_end
  });
  return { stripe_subscription_id: result.id, cancel_at_period_end: result.cancel_at_period_end, reused: false };
}

export async function cancelSubscriptionImmediately(env: Env, subscriptionId: string, reason: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) throw new PublicAppError(404, "Abonnemanget hittades inte.");
  if (!subscription.stripe_subscription_id) throw new PublicAppError(409, "Abonnemanget saknar Stripe Subscription.");
  const result = await stripeClient(env).subscriptions.cancel(subscription.stripe_subscription_id, {}, {
    idempotencyKey: `subscription-immediate-cancel:${subscription.id}`
  });
  await updateLocalCancellation(env, subscription.id, {
    cancel_at_period_end: false,
    current_period_end: (result as any).current_period_end ?? null,
    status: result.status,
    cancelled_at: (result as any).canceled_at ?? Math.floor(Date.now() / 1000),
    reason: reason || "IMMEDIATE_CANCEL"
  });
  await audit(env, "STRIPE", null, "SUBSCRIPTION_IMMEDIATE_CANCELLED", "subscription", subscription.id, subscription, {
    stripe_subscription_id: result.id,
    reason
  });
  return { stripe_subscription_id: result.id, status: result.status, cancelled_at: (result as any).canceled_at ?? null };
}

export async function createPaymentMethodUpdateLink(env: Env, subscriptionId: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) throw new PublicAppError(404, "Abonnemanget hittades inte.");
  const token = newToken();
  const sessionId = id("pmupd");
  const expiresAt = expiryIso();
  await env.DB.prepare(
    `INSERT INTO payment_method_update_sessions(id,customer_id,subscription_id,token_hash,public_token_enc,expires_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(
    sessionId,
    subscription.customer_id,
    subscription.id,
    await sha256Hex(token),
    await encryptString(token, env.TOKEN_ENCRYPTION_KEY_BASE64),
    expiresAt
  ).run();
  await audit(env, "SYSTEM", null, "PAYMENT_METHOD_UPDATE_LINK_CREATED", "subscription", subscription.id, null, { payment_method_update_session_id: sessionId });
  return {
    id: sessionId,
    url: `${env.APP_BASE_URL.replace(/\/+$/, "")}/customer-order/card-update/${token}`,
    expires_at: expiresAt
  };
}

async function paymentMethodUpdateSessionByToken(env: Env, token: string) {
  const session = await one<any>(
    env.DB,
    "SELECT * FROM payment_method_update_sessions WHERE token_hash=?",
    await sha256Hex(token)
  );
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    throw new PublicAppError(404, "Kortbyteslänken är ogiltig eller har gått ut.");
  }
  return session;
}

export async function getPaymentMethodUpdateSession(env: Env, token: string) {
  const session = await paymentMethodUpdateSessionByToken(env, token);
  if (!session.opened_at) {
    await env.DB.prepare(
      "UPDATE payment_method_update_sessions SET status='OPENED', opened_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(session.id).run();
  }
  const subscription = session.subscription_id ? await one<any>(env.DB, "SELECT id,status,cancel_at_period_end,current_period_end FROM subscriptions WHERE id=?", session.subscription_id) : null;
  return { id: session.id, status: session.status, expires_at: session.expires_at, subscription };
}

export async function createPaymentMethodUpdateSetupIntent(env: Env, token: string) {
  const session = await paymentMethodUpdateSessionByToken(env, token);
  const result = await createPaymentMethodSetupIntent(env, session.customer_id);
  await env.DB.prepare(
    "UPDATE payment_method_update_sessions SET status='SETUP_CREATED', stripe_setup_intent_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(result.setup_intent_id, session.id).run();
  return result;
}

export async function confirmPaymentMethodUpdate(env: Env, token: string) {
  const session = await paymentMethodUpdateSessionByToken(env, token);
  const setupSession = await one<any>(
    env.DB,
    `SELECT * FROM payment_method_setup_sessions
     WHERE customer_id=? AND stripe_setup_intent_id=COALESCE(?, stripe_setup_intent_id)
     ORDER BY updated_at DESC LIMIT 1`,
    session.customer_id,
    session.stripe_setup_intent_id ?? null
  );
  if (!setupSession?.stripe_setup_intent_id) throw new PublicAppError(409, "Betalmetodssession saknas.");
  const stripe = stripeClient(env);
  const setupIntent = await stripe.setupIntents.retrieve(setupSession.stripe_setup_intent_id, { expand: ["payment_method"] });
  if (setupIntent.status !== "succeeded") throw new PublicAppError(409, "Betalmetoden är inte färdigverifierad ännu.");
  const method = setupIntent.payment_method;
  if (!method || typeof method === "string") throw new PublicAppError(409, "Stripe returnerade ingen verifierad betalmetod.");
  const card = method.card;
  await env.DB.batch([
    env.DB.prepare("UPDATE payment_methods SET is_default=0, updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND provider='STRIPE'").bind(session.customer_id),
    env.DB.prepare(
      `INSERT INTO payment_methods(id,customer_id,provider,provider_payment_method_id,type,brand,last4,exp_month,exp_year,status,is_default)
       VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',1)
       ON CONFLICT(provider, provider_payment_method_id)
       DO UPDATE SET brand=excluded.brand,last4=excluded.last4,exp_month=excluded.exp_month,exp_year=excluded.exp_year,status='ACTIVE',is_default=1,updated_at=CURRENT_TIMESTAMP`
    ).bind(id("pm"), session.customer_id, "STRIPE", method.id, method.type, card?.brand ?? null, card?.last4 ?? null, card?.exp_month ?? null, card?.exp_year ?? null),
    env.DB.prepare(
      `UPDATE payment_method_update_sessions
       SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP, payment_method_id=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(method.id, session.id)
  ]);
  await retryPastDueSubscriptionPayment(env, session.subscription_id);
  await audit(env, "USER", "payment-method-update", "PAYMENT_METHOD_REPLACED", "subscription", session.subscription_id ?? session.customer_id, null, {
    payment_method_id: method.id,
    payment_method_update_session_id: session.id
  });
  return { status: "COMPLETED", payment_method_id: method.id };
}

export async function retryPastDueSubscriptionPayment(env: Env, subscriptionId?: string | null) {
  if (!subscriptionId) return { retried: false, reason: "NO_SUBSCRIPTION" };
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription || subscription.status !== "PAST_DUE" || !subscription.stripe_subscription_id) {
    return { retried: false, reason: "NOT_PAST_DUE" };
  }
  const stripe = stripeClient(env);
  const remote = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id, { expand: ["latest_invoice"] });
  const latestInvoice = remote.latest_invoice;
  const invoiceId = typeof latestInvoice === "string" ? latestInvoice : latestInvoice?.id ?? subscription.latest_stripe_invoice_id;
  if (!invoiceId) return { retried: false, reason: "NO_LATEST_INVOICE" };
  const paymentMethod = await one<any>(
    env.DB,
    "SELECT provider_payment_method_id FROM payment_methods WHERE customer_id=? AND provider='STRIPE' AND status='ACTIVE' ORDER BY is_default DESC, updated_at DESC LIMIT 1",
    subscription.customer_id
  );
  const paid = await stripe.invoices.pay(invoiceId, paymentMethod?.provider_payment_method_id ? {
    payment_method: paymentMethod.provider_payment_method_id
  } : undefined, {
    idempotencyKey: `subscription-retry-latest-invoice:${subscription.id}:${invoiceId}`
  });
  await env.DB.prepare(
    "UPDATE subscriptions SET latest_stripe_invoice_id=?, payment_recovered_at=CASE WHEN ?='paid' THEN CURRENT_TIMESTAMP ELSE payment_recovered_at END, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(invoiceId, paid.status, subscription.id).run();
  return { retried: true, invoice_id: invoiceId, invoice_status: paid.status };
}

export async function recoverPaymentMethodUpdateUrl(env: Env, sessionId: string) {
  const session = await one<any>(env.DB, "SELECT * FROM payment_method_update_sessions WHERE id=?", sessionId);
  if (!session) throw new PublicAppError(404, "Kortbyteslänken hittades inte.");
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/customer-order/card-update/${await decryptString(session.public_token_enc, env.TOKEN_ENCRYPTION_KEY_BASE64)}`;
}
