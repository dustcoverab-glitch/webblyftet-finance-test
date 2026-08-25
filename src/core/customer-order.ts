import type Stripe from "stripe";
import { acceptPreparedSalesOrder } from "./business-flow";
import { audit } from "./finance";
import { activateStripeSubscription, createPaymentMethodSetupIntent } from "../integrations/stripe/subscriptions";
import { stripeClient } from "../integrations/stripe/client";
import { basicAcceptanceSigningProvider } from "../integrations/signing";
import type { SigningSnapshot } from "../integrations/signing";
import { isStripeConfigured, isStripePublishableKeyConfigured } from "../lib/config";
import { decryptString, encryptString, sha256Hex } from "../lib/crypto";
import { id, one } from "../lib/db";
import { PublicAppError } from "../lib/app-error";
import { WEBBLYFTET_TERMS_VERSION } from "../documents/terms";
import { lineGrossMinor, lineNetMinor, lineVatMinor, recurringMonthlyMinor } from "../lib/money";

export type CustomerOrderSessionResult = {
  id: string;
  url: string;
  expires_at: string;
  status: string;
  reused: boolean;
};

type CustomerOrderSession = {
  id: string;
  sales_order_id: string;
  customer_id: string;
  token_hash: string;
  public_token_enc?: string | null;
  status: string;
  expires_at: string;
  opened_at?: string | null;
  reviewed_at?: string | null;
  signing_snapshot_json?: string | null;
  document_hash?: string | null;
  signer_name?: string | null;
  signer_email?: string | null;
  signed_at?: string | null;
  completed_at?: string | null;
  payment_method_id?: string | null;
  payment_method_brand?: string | null;
  payment_method_last4?: string | null;
  payment_method_exp_month?: number | null;
  payment_method_exp_year?: number | null;
  activation_error?: string | null;
};

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

function nowIso(): string {
  return new Date().toISOString();
}

function expiryIso(days = 21): string {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sessionByToken(env: Env, token: string): Promise<CustomerOrderSession> {
  const tokenHash = await sha256Hex(token);
  const session = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE token_hash=?", tokenHash);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    throw new PublicAppError(404, "Orderlänken är ogiltig eller har gått ut.");
  }
  return session;
}

async function buildSnapshot(env: Env, salesOrderId: string): Promise<SigningSnapshot> {
  const order = await one<any>(
    env.DB,
    `SELECT so.*, c.name customer_name, c.org_number customer_org_number, c.email customer_email,
      c.phone customer_phone, c.address1 customer_address1, c.zip customer_zip, c.city customer_city,
      c.country customer_country, o.title offer_title, o.offer_date, o.expire_date,
      o.remarks offer_remarks, o.fortnox_document_number offer_fortnox_document_number, ov.version_number
     FROM sales_orders so
     JOIN customers c ON c.id=so.customer_id
     JOIN offers o ON o.id=so.offer_id
     LEFT JOIN offer_versions ov ON ov.id=so.offer_version_id
     WHERE so.id=?`,
    salesOrderId
  );
  if (!order) throw new PublicAppError(404, "Order saknas.");
  const rows = await env.DB.prepare("SELECT * FROM sales_order_items WHERE sales_order_id=? ORDER BY created_at").bind(salesOrderId).all<any>();
  const normalizedRows = rows.results.map((row) => ({
    id: row.id,
    description: row.description,
    quantity: Number(row.quantity ?? 0),
    unit: row.unit ?? null,
    unit_price_minor: Number(row.unit_price_minor ?? 0),
    vat_percent: Number(row.vat_percent ?? 0),
    billing_type: row.billing_type === "RECURRING" ? "RECURRING" as const : "ONE_TIME" as const,
    billing_interval: row.billing_interval ?? null,
    product_id: row.product_id ?? null,
    price_id: row.price_id ?? null
  }));
  const oneTime = normalizedRows.filter((row) => row.billing_type === "ONE_TIME");
  const recurring = normalizedRows.filter((row) => row.billing_type === "RECURRING");
  const recurringMonthlyRows = recurring.map((row) => {
    const net = lineNetMinor(row);
    const vat = lineVatMinor(row);
    const gross = lineGrossMinor(row);
    return {
      net: recurringMonthlyMinor(row, net),
      vat: recurringMonthlyMinor(row, vat),
      annual: row.billing_interval === "YEAR" ? gross : gross * 12
    };
  });
  const sum = <T,>(items: T[], fn: (item: T) => number) => items.reduce((total, item) => total + fn(item), 0);
  return {
    generated_at: nowIso(),
    order: {
      id: order.id,
      status: order.status,
      currency: order.currency ?? "SEK",
      one_time_total_minor: Number(order.one_time_total_minor ?? 0),
      recurring_monthly_minor: Number(order.recurring_monthly_minor ?? 0)
    },
    customer: {
      id: order.customer_id,
      name: order.customer_name,
      org_number: order.customer_org_number ?? null,
      email: order.customer_email ?? null,
      phone: order.customer_phone ?? null,
      address1: order.customer_address1 ?? null,
      zip: order.customer_zip ?? null,
      city: order.customer_city ?? null,
      country: order.customer_country ?? "SE",
      contact_name: order.customer_name ?? null
    },
    offer: {
      id: order.offer_id,
      title: order.offer_title,
      version_id: order.offer_version_id,
      version_number: order.version_number ?? null,
      terms_version: WEBBLYFTET_TERMS_VERSION,
      offer_date: order.offer_date ?? null,
      expire_date: order.expire_date ?? null,
      remarks: order.offer_remarks ?? null,
      fortnox_document_number: order.offer_fortnox_document_number ?? null
    },
    rows: normalizedRows,
    totals: {
      one_time_net_minor: sum(oneTime, lineNetMinor),
      one_time_vat_minor: sum(oneTime, lineVatMinor),
      one_time_total_minor: sum(oneTime, lineGrossMinor),
      recurring_monthly_net_minor: sum(recurringMonthlyRows, (row) => row.net),
      recurring_monthly_vat_minor: sum(recurringMonthlyRows, (row) => row.vat),
      recurring_monthly_total_minor: sum(recurringMonthlyRows, (row) => row.net + row.vat),
      recurring_year_total_minor: sum(recurringMonthlyRows, (row) => row.annual)
    }
  };
}

async function ensureSnapshot(env: Env, session: CustomerOrderSession): Promise<{ snapshot: SigningSnapshot; documentHash: string }> {
  if (session.signing_snapshot_json && session.document_hash) {
    return { snapshot: JSON.parse(session.signing_snapshot_json), documentHash: session.document_hash };
  }
  const snapshot = await buildSnapshot(env, session.sales_order_id);
  const snapshotJson = stableJson(snapshot);
  const documentHash = await sha256Hex(snapshotJson);
  await env.DB.prepare(
    `UPDATE customer_order_sessions
     SET signing_snapshot_json=?, document_hash=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND signing_snapshot_json IS NULL`
  ).bind(snapshotJson, documentHash, session.id).run();
  const updated = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", session.id);
  return {
    snapshot: JSON.parse(updated?.signing_snapshot_json ?? snapshotJson),
    documentHash: updated?.document_hash ?? documentHash
  };
}

async function publicSessionPayload(env: Env, session: CustomerOrderSession) {
  const { snapshot, documentHash } = await ensureSnapshot(env, session);
  const [invoices, subscriptions, paymentMethods] = await Promise.all([
    env.DB.prepare("SELECT id,invoice_number,status,total_minor,balance_minor,fortnox_document_number FROM invoices WHERE sales_order_id=? ORDER BY created_at").bind(session.sales_order_id).all<any>(),
    env.DB.prepare("SELECT id,status,stripe_subscription_id FROM subscriptions WHERE sales_order_id=? ORDER BY created_at").bind(session.sales_order_id).all<any>(),
    env.DB.prepare("SELECT id,brand,last4,exp_month,exp_year,status,is_default FROM payment_methods WHERE customer_id=? AND provider='STRIPE' ORDER BY is_default DESC, updated_at DESC LIMIT 3").bind(session.customer_id).all<any>()
  ]);
  const hasRecurring = snapshot.rows.some((row) => row.billing_type === "RECURRING");
  const hasPaymentMethod = Boolean(session.payment_method_id || paymentMethods.results.some((method) => method.status === "ACTIVE"));
  return {
    id: session.id,
    status: session.status,
    expires_at: session.expires_at,
    reviewed_at: session.reviewed_at,
    signed_at: session.signed_at,
    completed_at: session.completed_at,
    signer_name: session.signer_name,
    signer_email: session.signer_email,
    document_hash: documentHash,
    snapshot,
    requirements: {
      signing_required: !session.signed_at,
      payment_method_required: hasRecurring && !hasPaymentMethod,
      activation_required: hasRecurring && subscriptions.results.some((sub) => !["ACTIVE", "CANCELLED", "ENDED"].includes(String(sub.status).toUpperCase()))
    },
    payment_method: session.payment_method_id ? {
      id: session.payment_method_id,
      brand: session.payment_method_brand,
      last4: session.payment_method_last4,
      exp_month: session.payment_method_exp_month,
      exp_year: session.payment_method_exp_year
    } : paymentMethods.results[0] ?? null,
    invoices: invoices.results,
    subscriptions: subscriptions.results,
    stripe_configured: isStripeConfigured(env) && isStripePublishableKeyConfigured(env),
    activation_error: session.activation_error ?? null
  };
}

export async function createCustomerOrderSession(env: Env, salesOrderId: string): Promise<CustomerOrderSessionResult> {
  const order = await one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", salesOrderId);
  if (!order) throw new PublicAppError(404, "Order saknas.");
  if (!["PREPARED", "READY", "CREATED", "PROVISIONING", "PARTIAL_FAILURE"].includes(String(order.status))) {
    throw new PublicAppError(409, "Ordern kan inte skickas till kund i nuvarande status.");
  }
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const tokenEnc = await encryptString(token, env.TOKEN_ENCRYPTION_KEY_BASE64);
  const sessionId = id("cord");
  const expiresAt = expiryIso();
  await env.DB.prepare(
    `UPDATE customer_order_sessions
     SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP
     WHERE sales_order_id=? AND status IN ('CREATED','REVIEWED')`
  ).bind(salesOrderId).run();
  await env.DB.prepare(
    `INSERT INTO customer_order_sessions(id,sales_order_id,customer_id,token_hash,public_token_enc,status,expires_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(sessionId, salesOrderId, order.customer_id, tokenHash, tokenEnc, "CREATED", expiresAt).run();
  const session = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", sessionId);
  if (session) await ensureSnapshot(env, session);
  await audit(env, "SYSTEM", null, "CUSTOMER_ORDER_LINK_CREATED", "sales_order", salesOrderId, null, { customer_order_session_id: sessionId });
  return {
    id: sessionId,
    url: `${env.APP_BASE_URL.replace(/\/+$/, "")}/customer-order/${token}`,
    expires_at: expiresAt,
    status: "CREATED",
    reused: false
  };
}

export async function customerOrderSessionUrl(env: Env, sessionId: string): Promise<string> {
  const session = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", sessionId);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    throw new PublicAppError(404, "Kundlänken är ogiltig eller har gått ut.");
  }
  if (!session.public_token_enc) {
    throw new PublicAppError(409, "Kundlänken saknar återöppningsbar token. Skapa en ny avtalsversion innan e-postutskick.");
  }
  const token = await decryptString(session.public_token_enc, env.TOKEN_ENCRYPTION_KEY_BASE64);
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/customer-order/${token}`;
}

export async function getCustomerOrderSessionForToken(env: Env, token: string) {
  const session = await sessionByToken(env, token);
  if (!session.opened_at) {
    await env.DB.prepare("UPDATE customer_order_sessions SET opened_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(session.id).run();
  }
  const updated = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", session.id);
  return publicSessionPayload(env, updated ?? session);
}

export async function markCustomerOrderReviewed(env: Env, token: string) {
  const session = await sessionByToken(env, token);
  await env.DB.prepare(
    "UPDATE customer_order_sessions SET status=CASE WHEN status='CREATED' THEN 'REVIEWED' ELSE status END, reviewed_at=COALESCE(reviewed_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(session.id).run();
  await audit(env, "USER", "customer-order", "CUSTOMER_ORDER_REVIEWED", "sales_order", session.sales_order_id, null, { customer_order_session_id: session.id });
  const updated = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", session.id);
  return publicSessionPayload(env, updated ?? session);
}

export async function signCustomerOrder(env: Env, token: string, input: {
  signer_name: string;
  signer_email: string;
  ip_address?: string | null;
  user_agent?: string | null;
}) {
  const session = await sessionByToken(env, token);
  if (session.signed_at) return publicSessionPayload(env, session);
  const { documentHash } = await ensureSnapshot(env, session);
  const result = basicAcceptanceSigningProvider.sign({
    session_id: session.id,
    document_hash: documentHash,
    signer_name: input.signer_name,
    signer_email: input.signer_email,
    ip_address: input.ip_address,
    user_agent: input.user_agent
  });
  await env.DB.prepare(
    `UPDATE customer_order_sessions
     SET status='SIGNED', signed_at=CURRENT_TIMESTAMP, signer_name=?, signer_email=?,
       signing_provider=?, signing_request_id=?, evidence_reference=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND signed_at IS NULL`
  ).bind(
    input.signer_name,
    input.signer_email,
    result.provider,
    result.signing_request_id,
    result.evidence_reference,
    session.id
  ).run();
  await audit(env, "USER", "customer-order", "CUSTOMER_ORDER_SIGNED", "sales_order", session.sales_order_id, null, {
    customer_order_session_id: session.id,
    signer_email: input.signer_email,
    document_hash: documentHash
  });
  const confirmedOrder = await acceptPreparedSalesOrder(env, {
    sales_order_id: session.sales_order_id,
    accepted_by_name: input.signer_name,
    accepted_by_email: input.signer_email,
    ip_address: input.ip_address,
    user_agent: input.user_agent
  });
  const flowStatus = ["READY", "COMPLETED"].includes(String(confirmedOrder?.status ?? "").toUpperCase())
    ? "SALES_ORDER_CONFIRMED"
    : "ACCEPTED";
  const flowUpdate = await env.DB.prepare(
    "UPDATE contract_flows SET status=?, updated_at=CURRENT_TIMESTAMP WHERE sales_order_id=? AND status NOT IN ('COMPLETED',?)"
  ).bind(flowStatus, session.sales_order_id, flowStatus).run();
  if ((flowUpdate.meta.changes ?? 0) > 0) {
    const flows = await env.DB.prepare("SELECT id FROM contract_flows WHERE sales_order_id=?").bind(session.sales_order_id).all<{ id: string }>();
    for (const flow of flows.results) {
      await audit(env, "SYSTEM", null, `CONTRACT_FLOW_${flowStatus}`, "contract_flow", flow.id, null, { customer_order_session_id: session.id });
    }
  }
  const updated = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", session.id);
  return publicSessionPayload(env, updated ?? session);
}

export async function createCustomerOrderSetupIntent(env: Env, token: string) {
  const session = await sessionByToken(env, token);
  if (!session.signed_at) throw new PublicAppError(409, "Ordern måste signeras innan betalmetod kan registreras.");
  const payload = await publicSessionPayload(env, session);
  if (!payload.requirements.payment_method_required) return { required: false, reused: true };
  return createPaymentMethodSetupIntent(env, session.customer_id);
}

function paymentMethodFields(method: Stripe.PaymentMethod) {
  const card = method.card;
  return {
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    exp_month: card?.exp_month ?? null,
    exp_year: card?.exp_year ?? null
  };
}

export async function confirmCustomerOrderPaymentMethod(env: Env, token: string) {
  const session = await sessionByToken(env, token);
  const setupSession = await one<any>(
    env.DB,
    `SELECT * FROM payment_method_setup_sessions
     WHERE customer_id=? AND expires_at > ?
     ORDER BY updated_at DESC LIMIT 1`,
    session.customer_id,
    nowIso()
  );
  if (!setupSession?.stripe_setup_intent_id) throw new PublicAppError(409, "Betalmetodssession saknas.");
  const stripe = stripeClient(env);
  const setupIntent = await stripe.setupIntents.retrieve(setupSession.stripe_setup_intent_id, { expand: ["payment_method"] });
  if (setupIntent.status !== "succeeded") throw new PublicAppError(409, "Betalmetoden är inte färdigverifierad ännu.");
  const method = setupIntent.payment_method;
  if (!method || typeof method === "string") throw new PublicAppError(409, "Stripe returnerade ingen verifierad betalmetod.");
  const fields = paymentMethodFields(method);
  await env.DB.batch([
    env.DB.prepare("UPDATE payment_methods SET is_default=0, updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND provider='STRIPE'").bind(session.customer_id),
    env.DB.prepare(
      `INSERT INTO payment_methods(id,customer_id,provider,provider_payment_method_id,type,brand,last4,exp_month,exp_year,status,is_default)
       VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',1)
       ON CONFLICT(provider, provider_payment_method_id)
       DO UPDATE SET brand=excluded.brand,last4=excluded.last4,exp_month=excluded.exp_month,exp_year=excluded.exp_year,status='ACTIVE',is_default=1,updated_at=CURRENT_TIMESTAMP`
    ).bind(id("pm"), session.customer_id, "STRIPE", method.id, method.type, fields.brand, fields.last4, fields.exp_month, fields.exp_year),
    env.DB.prepare(
      `UPDATE customer_order_sessions
       SET status=CASE WHEN status='SIGNED' THEN 'PAYMENT_METHOD_READY' ELSE status END,
         payment_method_id=?, payment_method_brand=?, payment_method_last4=?, payment_method_exp_month=?, payment_method_exp_year=?,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(method.id, fields.brand, fields.last4, fields.exp_month, fields.exp_year, session.id)
  ]);
  await audit(env, "USER", "customer-order", "CUSTOMER_ORDER_PAYMENT_METHOD_READY", "sales_order", session.sales_order_id, null, {
    customer_order_session_id: session.id,
    payment_method_id: method.id
  });
  const updated = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", session.id);
  return publicSessionPayload(env, updated ?? session);
}

export async function activateCustomerOrder(env: Env, token: string) {
  const session = await sessionByToken(env, token);
  if (!session.signed_at) throw new PublicAppError(409, "Ordern måste signeras först.");
  await env.DB.prepare(
    `UPDATE customer_order_sessions
     SET status=CASE WHEN status IN ('SIGNED','PAYMENT_METHOD_READY','ACTION_REQUIRED','PENDING_PAYMENT_CONFIRMATION') THEN 'ACTIVATING' ELSE status END,
       activation_error=NULL,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND completed_at IS NULL`
  ).bind(session.id).run();
  const subscriptions = await env.DB.prepare("SELECT * FROM subscriptions WHERE sales_order_id=? ORDER BY created_at").bind(session.sales_order_id).all<any>();
  let paymentAction = null;
  for (const subscription of subscriptions.results) {
    if (["ACTIVE", "CANCELLED", "ENDED"].includes(String(subscription.status).toUpperCase())) continue;
    const result = await activateStripeSubscription(env, subscription.id);
    if (result.payment_action?.required) paymentAction = result.payment_action;
  }
  if (paymentAction) {
    await env.DB.prepare("UPDATE customer_order_sessions SET status='ACTION_REQUIRED', activation_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(session.id).run();
    return { ...(await getCustomerOrderSessionForToken(env, token)), payment_action: paymentAction };
  }
  const completion = await reconcileCustomerOrderCompletion(env, session.id);
  if (!completion.completed) {
    await env.DB.prepare(
      `UPDATE customer_order_sessions
       SET status=?, activation_error=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND completed_at IS NULL`
    ).bind(
      completion.status,
      completion.reason,
      session.id
    ).run();
    return getCustomerOrderSessionForToken(env, token);
  }
  return getCustomerOrderSessionForToken(env, token);
}

type CompletionEvaluation = {
  completed: boolean;
  status: "COMPLETED" | "ACTIVATING" | "PENDING_PAYMENT_CONFIRMATION" | "ACTION_REQUIRED";
  reason: string | null;
};

export async function reconcileCustomerOrderCompletion(env: Env, sessionId: string): Promise<CompletionEvaluation> {
  const session = await one<CustomerOrderSession>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", sessionId);
  if (!session) return { completed: false, status: "PENDING_PAYMENT_CONFIRMATION", reason: "Kundordern saknas." };
  if (!session.signed_at) return { completed: false, status: "ACTIVATING", reason: "Ordern är inte signerad." };

  const { snapshot } = await ensureSnapshot(env, session);
  const hasRecurring = snapshot.rows.some((row) => row.billing_type === "RECURRING");
  if (!hasRecurring) {
    return completeCustomerOrder(env, session);
  }

  const paymentMethods = await env.DB.prepare(
    "SELECT id FROM payment_methods WHERE customer_id=? AND provider='STRIPE' AND status='ACTIVE' ORDER BY is_default DESC, updated_at DESC LIMIT 1"
  ).bind(session.customer_id).all<any>();
  if (!session.payment_method_id && !paymentMethods.results.length) {
    return { completed: false, status: "ACTIVATING", reason: "Betalmetod saknas." };
  }

  const subscriptions = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE sales_order_id=? ORDER BY created_at"
  ).bind(session.sales_order_id).all<any>();
  const relevant = subscriptions.results.filter((subscription: any) => !["CANCELLED", "ENDED"].includes(String(subscription.status).toUpperCase()));
  if (!relevant.length) return { completed: false, status: "ACTIVATING", reason: "Abonnemang saknas." };

  for (const subscription of relevant) {
    if (String(subscription.status).toUpperCase() !== "ACTIVE" || !subscription.stripe_subscription_id) {
      return { completed: false, status: "PENDING_PAYMENT_CONFIRMATION", reason: "Väntar på aktivt abonnemang och Stripe-bekräftelse." };
    }
    const payments = await env.DB.prepare(
      `SELECT p.*
       FROM payments p
       WHERE p.subscription_id=? AND p.provider='STRIPE' AND p.status='SUCCEEDED'
       ORDER BY p.paid_at ASC, p.created_at ASC`
    ).bind(subscription.id).all<any>();
    if (!payments.results.length) {
      return { completed: false, status: "PENDING_PAYMENT_CONFIRMATION", reason: "Väntar på bekräftad första abonnemangsbetalning." };
    }
    const initialPayment = payments.results[0];
    const accounting = await one<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) count
       FROM accounting_events
       WHERE event_type='SUBSCRIPTION_PAYMENT_RECEIVED'
         AND entity_type='payment'
         AND entity_id=?`,
      initialPayment.id
    );
    if ((accounting?.count ?? 0) !== 1) {
      return { completed: false, status: "PENDING_PAYMENT_CONFIRMATION", reason: "Väntar på canonical accounting event för abonnemangsbetalning." };
    }
  }

  return completeCustomerOrder(env, session);
}

export async function reconcileCustomerOrderCompletionForSalesOrder(env: Env, salesOrderId?: string | null): Promise<void> {
  if (!salesOrderId) return;
  const sessions = await env.DB.prepare(
    `SELECT id FROM customer_order_sessions
     WHERE sales_order_id=? AND status IN ('ACTIVATING','PENDING_PAYMENT_CONFIRMATION','ACTION_REQUIRED','PAYMENT_METHOD_READY','SIGNED')`
  ).bind(salesOrderId).all<{ id: string }>();
  for (const session of sessions.results) {
    await reconcileCustomerOrderCompletion(env, session.id);
  }
}

async function completeCustomerOrder(env: Env, session: CustomerOrderSession): Promise<CompletionEvaluation> {
  const result = await env.DB.prepare(
    `UPDATE customer_order_sessions
     SET status='COMPLETED', completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP), activation_error=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND completed_at IS NULL`
  ).bind(session.id).run();
  if ((result.meta.changes ?? 0) === 1) {
    await audit(env, "SYSTEM", null, "CUSTOMER_ORDER_COMPLETED", "sales_order", session.sales_order_id, null, { customer_order_session_id: session.id });
  }
  await env.DB.prepare(
    "UPDATE sales_orders SET status='COMPLETED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='COMPLETED'"
  ).bind(session.sales_order_id).run();
  await env.DB.prepare(
    "UPDATE contract_flows SET status='COMPLETED', completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE sales_order_id=? AND status!='COMPLETED'"
  ).bind(session.sales_order_id).run();
  return { completed: true, status: "COMPLETED", reason: null };
}
