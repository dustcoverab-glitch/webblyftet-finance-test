import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { all, id, one } from "./lib/db";
import { errorJson, oauthErrorPage } from "./lib/errors";
import {
  renderInvoiceDocument,
  renderInvoiceEmailPreview,
  renderOfferDocument,
  renderOfferEmailPreview,
  webblyftetCompanyProfile,
  type DocumentLine
} from "./documents";
import {
  createPrice,
  createProduct,
  createSubscription,
  seedTestProducts
} from "./core/finance";
import {
  acceptOfferToken,
  createOffer as createBusinessOffer,
  createOfferAcceptanceToken,
  getCustomerDetail,
  getInvoiceDetail,
  getOfferDetail,
  getOfferForToken,
  getSubscriptionDetail
} from "./core/business-flow";
import {
  activateCustomerOrder,
  confirmCustomerOrderPaymentMethod,
  createCustomerOrderSession,
  createCustomerOrderSetupIntent,
  getCustomerOrderSessionForToken,
  markCustomerOrderReviewed,
  signCustomerOrder
} from "./core/customer-order";
import {
  createContractFlowCustomerLink,
  createContractFlowFromHandoff,
  getContractFlow,
  listContractFlows,
  simulatedContractFlowHandoff,
  updateContractFlowDraft
} from "./core/contract-flow";
import {
  connectionStatus,
  createAuthUrl,
  exchangeCode
} from "./integrations/fortnox/client";
import { syncCustomerToFortnox, pullCustomersFromFortnox } from "./integrations/fortnox/customers";
import { syncOfferToFortnox } from "./integrations/fortnox/offers";
import { pullInvoicesFromFortnox, syncInvoiceToFortnox } from "./integrations/fortnox/invoices";
import { pullSupplierInvoicesFromFortnox, pullVouchersFromFortnox } from "./integrations/fortnox/accounting";
import { pushReceiptToFortnoxInbox } from "./integrations/fortnox/receipts";
import { sendContractFlowOfferEmail } from "./integrations/email/offers";
import { createOrReuseStripeCustomer } from "./integrations/stripe/customers";
import {
  activateStripeSubscription,
  cancelStripeSubscriptionAtPeriodEnd,
  createPaymentMethodSetupIntent,
  syncPriceToStripe,
  syncProductToStripe
} from "./integrations/stripe/subscriptions";
import { constructStripeWebhookEvent, processStripeEvent } from "./integrations/stripe/webhooks";
import {
  csrfProtection,
  isAllowedReceiptMimeType,
  rateLimitSensitiveRoutes,
  requireCloudflareAccess,
  safeReceiptContentDisposition,
  securityHeaders
} from "./lib/security";
import { isStripeConfigured, isStripePublishableKeyConfigured, maxReceiptUploadBytes } from "./lib/config";

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => errorJson(c, error));
app.use("*", securityHeaders());
app.use("*", requireCloudflareAccess());
app.use("*", csrfProtection());
app.use("*", rateLimitSensitiveRoutes());

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV, now: new Date().toISOString() }));

app.all("/webhooks/stripe", async (c, next) => {
  if (c.req.method !== "POST") return c.text("Not found", 404);
  await next();
});

app.post("/webhooks/stripe", async (c) => {
  const rawBody = await c.req.text();
  const event = await constructStripeWebhookEvent(c.env, rawBody, c.req.header("stripe-signature") ?? null);
  return c.json(await processStripeEvent(c.env, event));
});

app.get("/api/dashboard", async (c) => {
  const [
    customers,
    offers,
    invoices,
    projectInvoices,
    subscriptionInvoices,
    subscriptions,
    subscriptionStatus,
    receivables,
    payments,
    invoiceTrend,
    paymentTrend,
    events,
    audit,
    attentionInvoices,
    attentionPayments,
    attentionSubscriptions,
    attentionOrders,
    attentionSync,
    receipts,
    logs,
    connection
  ] = await Promise.all([
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) count FROM customers"),
    one<{ count: number; value: number; accepted_value: number }>(
      c.env.DB,
      "SELECT COUNT(*) count, COALESCE(SUM(total),0) value, COALESCE(SUM(CASE WHEN status='ACCEPTED' THEN total ELSE 0 END),0) accepted_value FROM offers"
    ),
    one<{ count: number; value: number; outstanding: number }>(
      c.env.DB,
      "SELECT COUNT(*) count, COALESCE(SUM(total),0) value, COALESCE(SUM(COALESCE(balance,total)),0) outstanding FROM invoices WHERE cancelled=0"
    ),
    one<{ count: number; value: number }>(
      c.env.DB,
      "SELECT COUNT(*) count, COALESCE(SUM(total),0) value FROM invoices WHERE cancelled=0 AND invoice_type='PROJECT_INVOICE'"
    ),
    one<{ count: number; value: number }>(
      c.env.DB,
      "SELECT COUNT(*) count, COALESCE(SUM(total),0) value FROM invoices WHERE cancelled=0 AND invoice_type='SUBSCRIPTION_INVOICE'"
    ),
    one<{ active_count: number; mrr_minor: number; cancel_at_period_end: number }>(
      c.env.DB,
      `SELECT COUNT(DISTINCT s.id) active_count,
        COALESCE(SUM(CASE WHEN pr.billing_interval='YEAR' THEN ROUND(si.unit_amount * si.quantity / 12.0) ELSE si.unit_amount * si.quantity END),0) mrr_minor,
        COUNT(DISTINCT CASE WHEN s.cancel_at_period_end=1 THEN s.id END) cancel_at_period_end
       FROM subscriptions s
       LEFT JOIN subscription_items si ON si.subscription_id=s.id
       LEFT JOIN prices pr ON pr.id=si.price_id
       WHERE s.status='ACTIVE'`
    ),
    all<{ status: string; count: number }>(c.env.DB, "SELECT status, COUNT(*) count FROM subscriptions GROUP BY status"),
    one<{ outstanding_minor: number; due_soon_minor: number; overdue_minor: number; paid_30d_minor: number; unpaid_count: number; overdue_count: number }>(
      c.env.DB,
      `SELECT
        COALESCE(SUM(CASE WHEN status NOT IN ('PAID','CREDITED','CANCELLED') THEN COALESCE(balance_minor, ROUND(COALESCE(balance,total) * 100)) ELSE 0 END),0) outstanding_minor,
        COALESCE(SUM(CASE WHEN status NOT IN ('PAID','CREDITED','CANCELLED') AND due_date BETWEEN date('now') AND date('now','+7 days') THEN COALESCE(balance_minor, ROUND(COALESCE(balance,total) * 100)) ELSE 0 END),0) due_soon_minor,
        COALESCE(SUM(CASE WHEN status NOT IN ('PAID','CREDITED','CANCELLED') AND due_date < date('now') THEN COALESCE(balance_minor, ROUND(COALESCE(balance,total) * 100)) ELSE 0 END),0) overdue_minor,
        COALESCE(SUM(CASE WHEN status='PAID' AND updated_at >= datetime('now','-30 days') THEN COALESCE(total_minor, ROUND(total * 100)) ELSE 0 END),0) paid_30d_minor,
        SUM(CASE WHEN status NOT IN ('PAID','CREDITED','CANCELLED') THEN 1 ELSE 0 END) unpaid_count,
        SUM(CASE WHEN status NOT IN ('PAID','CREDITED','CANCELLED') AND due_date < date('now') THEN 1 ELSE 0 END) overdue_count
       FROM invoices
       WHERE cancelled=0`
    ),
    one<{ failed_payments: number; past_due_subscriptions: number }>(
      c.env.DB,
      `SELECT
        (SELECT COUNT(*) FROM payments WHERE status='FAILED') failed_payments,
        (SELECT COUNT(*) FROM subscriptions WHERE status='PAST_DUE') past_due_subscriptions`
    ),
    all<{ month: string; invoiced_minor: number }>(
      c.env.DB,
      `SELECT strftime('%Y-%m', invoice_date) month, COALESCE(SUM(COALESCE(total_minor, ROUND(total * 100))),0) invoiced_minor
       FROM invoices
       WHERE invoice_date >= date('now','start of month','-5 months') AND cancelled=0
       GROUP BY strftime('%Y-%m', invoice_date)
       ORDER BY month`
    ),
    all<{ month: string; paid_minor: number }>(
      c.env.DB,
      `SELECT strftime('%Y-%m', COALESCE(paid_at, created_at)) month, COALESCE(SUM(amount),0) paid_minor
       FROM payments
       WHERE status='SUCCEEDED' AND COALESCE(paid_at, created_at) >= date('now','start of month','-5 months')
       GROUP BY strftime('%Y-%m', COALESCE(paid_at, created_at))
       ORDER BY month`
    ),
    all<any>(c.env.DB, "SELECT * FROM accounting_events ORDER BY occurred_at DESC, created_at DESC LIMIT 10"),
    all<any>(
      c.env.DB,
      `SELECT * FROM audit_log
       WHERE action IN ('OFFER_CREATED','OFFER_ACCEPTED','SALES_ORDER_CREATED','INVOICE_CREATED','SUBSCRIPTION_ACTIVATION_REQUESTED','SUBSCRIPTION_ACTIVATED','PAYMENT_RECEIVED','PAYMENT_FAILED')
       ORDER BY created_at DESC LIMIT 10`
    ),
    all<any>(
      c.env.DB,
      `SELECT i.id, i.invoice_number, i.fortnox_document_number, i.status, i.due_date, i.total, i.balance, i.sync_status, c.name customer_name
       FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.cancelled=0 AND i.status NOT IN ('PAID','CREDITED','CANCELLED') AND (i.due_date < date('now') OR i.sync_status!='SYNCED')
       ORDER BY CASE WHEN i.due_date < date('now') THEN 0 ELSE 1 END, i.due_date LIMIT 6`
    ),
    all<any>(
      c.env.DB,
      `SELECT p.id, p.status, p.amount, p.provider_payment_id, p.created_at, c.name customer_name
       FROM payments p JOIN customers c ON c.id=p.customer_id
       WHERE p.status='FAILED'
       ORDER BY p.created_at DESC LIMIT 4`
    ),
    all<any>(
      c.env.DB,
      `SELECT s.id, s.status, s.stripe_subscription_id, s.updated_at, c.name customer_name
       FROM subscriptions s JOIN customers c ON c.id=s.customer_id
       WHERE s.status='PAST_DUE'
       ORDER BY s.updated_at DESC LIMIT 4`
    ),
    all<any>(
      c.env.DB,
      `SELECT so.id, so.status, so.created_at, c.name customer_name
       FROM sales_orders so JOIN customers c ON c.id=so.customer_id
       WHERE so.status='PARTIAL_FAILURE'
       ORDER BY so.created_at DESC LIMIT 4`
    ),
    all<any>(c.env.DB, "SELECT * FROM sync_log WHERE success=0 ORDER BY created_at DESC LIMIT 4"),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) count FROM receipts"),
    all<any>(c.env.DB, "SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 10"),
    connectionStatus(c.env)
  ]);
  return c.json({
    customers,
    offers,
    invoices,
    projectInvoices,
    subscriptionInvoices,
    subscriptions,
    subscriptionStatus,
    receivables,
    payments,
    trend: { invoices: invoiceTrend, payments: paymentTrend },
    events,
    audit,
    attention: { invoices: attentionInvoices, payments: attentionPayments, subscriptions: attentionSubscriptions, orders: attentionOrders, sync: attentionSync },
    receipts,
    logs,
    connection,
    stripe: { configured: isStripeConfigured(c.env) }
  });
});

app.get("/auth/fortnox/start", async (c) => c.redirect(await createAuthUrl(c.env)));

app.get("/auth/fortnox/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return oauthErrorPage();
  try {
    await exchangeCode(c.env, code, state);
    return c.redirect(`${c.env.APP_BASE_URL}/integration?connected=1`);
  } catch {
    return oauthErrorPage();
  }
});

app.get("/api/integration/status", async (c) => c.json(await connectionStatus(c.env)));
app.post("/api/integration/disconnect", async (c) => {
  await c.env.DB.prepare("DELETE FROM fortnox_connections").run();
  return c.json({ ok: true });
});

const customerSchema = z.object({
  name: z.string().min(1),
  org_number: z.string().optional().default(""),
  email: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  address1: z.string().optional().default(""),
  zip: z.string().optional().default(""),
  city: z.string().optional().default(""),
  payment_terms_days: z.number().int().min(0).max(365).default(30),
  notes: z.string().optional().default("")
});

app.get("/api/customers", async (c) => c.json(await all(c.env.DB, "SELECT * FROM customers ORDER BY created_at DESC")));

app.get("/api/customers/:id", async (c) => {
  const detail = await getCustomerDetail(c.env, c.req.param("id"));
  if (!detail) return c.json({ error: "Customer not found" }, 404);
  return c.json(detail);
});

app.post("/api/customers", zValidator("json", customerSchema), async (c) => {
  const data = c.req.valid("json");
  const customerId = id("cus");
  await c.env.DB.prepare(
    `INSERT INTO customers
      (id,org_number,name,email,phone,address1,zip,city,payment_terms_days,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(customerId, data.org_number, data.name, data.email, data.phone, data.address1, data.zip, data.city, data.payment_terms_days, data.notes).run();
  return c.json(await one(c.env.DB, "SELECT * FROM customers WHERE id=?", customerId), 201);
});

app.post("/api/customers/:id/sync", async (c) => {
  const customer = await one<any>(c.env.DB, "SELECT * FROM customers WHERE id=?", c.req.param("id"));
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const result = await syncCustomerToFortnox(c.env, customer);
  const number = customer.fortnox_customer_number || result.providerCustomerNumber;
  await c.env.DB.prepare(
    "UPDATE customers SET fortnox_customer_number=?, sync_status='SYNCED', last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(number, customer.id).run();
  return c.json({ customer: await one(c.env.DB, "SELECT * FROM customers WHERE id=?", customer.id), fortnox: result.raw });
});

app.post("/api/customers/pull", async (c) => {
  const customers = await pullCustomersFromFortnox(c.env);
  for (const item of customers) {
    const existing = await one<{ id: string }>(c.env.DB, "SELECT id FROM customers WHERE fortnox_customer_number=?", item.providerCustomerNumber);
    if (existing) {
      await c.env.DB.prepare(
        `UPDATE customers SET name=?, org_number=?, email=?, phone=?, address1=?, zip=?, city=?, sync_status='SYNCED',
        last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(item.name, item.orgNumber, item.email, item.phone, item.address1, item.zip, item.city, existing.id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO customers
        (id,fortnox_customer_number,org_number,name,email,phone,address1,zip,city,sync_status,last_synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,'SYNCED',CURRENT_TIMESTAMP)`
      ).bind(id("cus"), item.providerCustomerNumber, item.orgNumber, item.name, item.email, item.phone, item.address1, item.zip, item.city).run();
    }
  }
  return c.json({ imported: customers.length });
});

app.post("/api/customers/:id/stripe-customer", async (c) => {
  return c.json(await createOrReuseStripeCustomer(c.env, c.req.param("id")));
});

app.post("/api/customers/:id/payment-method/setup", async (c) => {
  return c.json(await createPaymentMethodSetupIntent(c.env, c.req.param("id")));
});

app.get("/api/stripe/config", async (c) => {
  const configured = isStripeConfigured(c.env) && isStripePublishableKeyConfigured(c.env);
  return c.json({
    configured,
    publishableKey: configured ? c.env.STRIPE_PUBLISHABLE_KEY : "",
    message: configured ? undefined : "Stripe är inte konfigurerat ännu."
  }, configured ? 200 : 503);
});

app.get("/customer-order/:token/session", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(await getCustomerOrderSessionForToken(c.env, c.req.param("token")));
});

app.get("/customer-order/:token/offer-document", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.html(renderOfferDocument(c.env, await customerOrderOfferDocumentInput(c.env, c.req.param("token"))));
});

app.get("/customer-order/:token/stripe-config", async (c) => {
  c.header("Cache-Control", "private, no-store");
  await getCustomerOrderSessionForToken(c.env, c.req.param("token"));
  const configured = isStripeConfigured(c.env) && isStripePublishableKeyConfigured(c.env);
  return c.json({
    configured,
    publishableKey: configured ? c.env.STRIPE_PUBLISHABLE_KEY : "",
    message: configured ? undefined : "Stripe är inte konfigurerat ännu."
  }, configured ? 200 : 503);
});

app.post("/customer-order/:token/review", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(await markCustomerOrderReviewed(c.env, c.req.param("token")));
});

const customerOrderSignSchema = z.object({
  signer_name: z.string().min(1),
  signer_email: z.string().email()
});

app.post("/customer-order/:token/sign", zValidator("json", customerOrderSignSchema), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const data = c.req.valid("json");
  return c.json(await signCustomerOrder(c.env, c.req.param("token"), {
    signer_name: data.signer_name,
    signer_email: data.signer_email,
    ip_address: c.req.header("cf-connecting-ip") ?? "",
    user_agent: c.req.header("user-agent") ?? ""
  }));
});

app.post("/customer-order/:token/payment-method/setup", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(await createCustomerOrderSetupIntent(c.env, c.req.param("token")));
});

app.post("/customer-order/:token/payment-method/confirm", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(await confirmCustomerOrderPaymentMethod(c.env, c.req.param("token")));
});

app.post("/customer-order/:token/activate", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(await activateCustomerOrder(c.env, c.req.param("token")));
});

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  product_type: z.enum(["ONE_TIME", "SUBSCRIPTION"]),
  active: z.boolean().optional().default(true)
});

const priceSchema = z.object({
  product_id: z.string().min(1),
  amount: z.number().int().min(0),
  currency: z.string().optional().default("SEK"),
  billing_type: z.enum(["ONE_TIME", "RECURRING"]),
  billing_interval: z.enum(["MONTH", "YEAR"]).nullable().optional(),
  vat_percent: z.number().min(0).max(100).optional().default(25),
  active: z.boolean().optional().default(true)
});

app.get("/api/products", async (c) => c.json(await all<any>(
  c.env.DB,
  `SELECT p.*, COALESCE(json_group_array(
      CASE WHEN pr.id IS NULL THEN NULL ELSE json_object(
        'id', pr.id, 'amount', pr.amount, 'currency', pr.currency,
        'billing_type', pr.billing_type, 'billing_interval', pr.billing_interval,
        'vat_percent', pr.vat_percent, 'active', pr.active, 'stripe_price_id', pr.stripe_price_id
      ) END
    ), '[]') prices
   FROM products p
   LEFT JOIN prices pr ON pr.product_id=p.id
   GROUP BY p.id
   ORDER BY p.created_at DESC`
)));

app.post("/api/products", zValidator("json", productSchema), async (c) => {
  return c.json(await createProduct(c.env, c.req.valid("json")), 201);
});

app.post("/api/prices", zValidator("json", priceSchema), async (c) => {
  return c.json(await createPrice(c.env, c.req.valid("json")), 201);
});

app.post("/api/products/seed-test", async (c) => c.json(await seedTestProducts(c.env)));
app.post("/api/products/:id/sync-stripe", async (c) => c.json(await syncProductToStripe(c.env, c.req.param("id"))));
app.post("/api/prices/:id/sync-stripe", async (c) => c.json(await syncPriceToStripe(c.env, c.req.param("id"))));

const subscriptionSchema = z.object({
  customer_id: z.string().min(1),
  start_date: z.string().min(1),
  items: z.array(z.object({
    product_id: z.string().min(1),
    price_id: z.string().min(1),
    quantity: z.number().int().positive()
  })).min(1)
});

app.get("/api/subscriptions", async (c) => c.json(await all<any>(
  c.env.DB,
  `SELECT s.*, c.name customer_name,
     COALESCE(SUM(CASE
       WHEN pr.billing_interval='YEAR' THEN ROUND(si.unit_amount * si.quantity / 12.0)
       ELSE si.unit_amount * si.quantity
     END),0) monthly_amount,
     COALESCE(json_group_array(json_object(
       'product_name', p.name, 'quantity', si.quantity, 'unit_amount', si.unit_amount,
       'billing_interval', pr.billing_interval
     )), '[]') items
   FROM subscriptions s
   JOIN customers c ON c.id=s.customer_id
   LEFT JOIN subscription_items si ON si.subscription_id=s.id
   LEFT JOIN products p ON p.id=si.product_id
   LEFT JOIN prices pr ON pr.id=si.price_id
   GROUP BY s.id
   ORDER BY s.created_at DESC`
)));

app.get("/api/subscriptions/:id", async (c) => {
  const detail = await getSubscriptionDetail(c.env, c.req.param("id"));
  if (!detail) return c.json({ error: "Subscription not found" }, 404);
  return c.json(detail);
});

app.post("/api/subscriptions", zValidator("json", subscriptionSchema), async (c) => {
  return c.json(await createSubscription(c.env, c.req.valid("json")), 201);
});

app.post("/api/subscriptions/:id/activate", async (c) => {
  return c.json(await activateStripeSubscription(c.env, c.req.param("id")));
});

app.post("/api/subscriptions/:id/cancel", async (c) => {
  return c.json(await cancelStripeSubscriptionAtPeriodEnd(c.env, c.req.param("id")));
});

app.post("/api/sales-orders/:id/customer-session", async (c) => {
  return c.json(await createCustomerOrderSession(c.env, c.req.param("id")));
});

const rowSchema = z.object({
  product_id: z.string().optional().nullable(),
  price_id: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().optional().default("st"),
  unit_price: z.number().optional(),
  discount_percent: z.number().min(0).max(100).default(0),
  vat_percent: z.number().default(25),
  article_number: z.string().optional().default(""),
  account_number: z.number().int().optional()
});

const offerSchema = z.object({
  customer_id: z.string(),
  title: z.string().optional().default(""),
  offer_date: z.string(),
  expire_date: z.string().optional().default(""),
  remarks: z.string().optional().default(""),
  rows: z.array(rowSchema).min(1)
});

function moneyToMinor(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}

function rowUnitPriceMinor(row: any): number {
  return Number(row.unit_price_minor ?? moneyToMinor(row.unit_price));
}

function documentRows(rows: any[]): DocumentLine[] {
  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    article_number: row.article_number ?? null,
    quantity: Number(row.quantity ?? 0),
    unit: row.unit ?? "st",
    unit_price_minor: rowUnitPriceMinor(row),
    discount_percent: Number(row.discount_percent ?? 0),
    vat_percent: Number(row.vat_percent ?? 25),
    billing_type: row.billing_type ?? "ONE_TIME",
    billing_interval: row.billing_interval ?? null
  }));
}

async function offerDocumentInput(env: Env, offerId: string, versionNumber?: string | number | null) {
  const offer = await getOfferDetail(env, offerId);
  if (!offer) return null;
  const customer = await one<any>(env.DB, "SELECT * FROM customers WHERE id=?", offer.customer_id);
  return {
    document_number: offer.fortnox_document_number || offer.id,
    title: offer.title || "Offert",
    document_date: offer.offer_date,
    valid_until: offer.expire_date,
    currency: offer.currency ?? "SEK",
    customer: {
      name: customer?.name ?? offer.customer_name,
      org_number: customer?.org_number ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
      address1: customer?.address1 ?? null,
      zip: customer?.zip ?? null,
      city: customer?.city ?? null,
      country: customer?.country ?? "Sverige",
      contact_name: offer.accepted_by_name ?? null
    },
    seller_name: "Webblyftet",
    rows: documentRows(offer.rows ?? []),
    remarks: offer.remarks ?? "",
    version_number: versionNumber ?? offer.versions?.[0]?.version_number ?? null,
    company: webblyftetCompanyProfile(env)
  };
}

async function invoiceDocumentInput(env: Env, invoiceId: string) {
  const invoice = await getInvoiceDetail(env, invoiceId);
  if (!invoice) return null;
  const rows = documentRows(invoice.rows ?? []);
  const subtotal = Number(invoice.subtotal_minor ?? moneyToMinor(invoice.subtotal));
  const vat = Number(invoice.vat_total_minor ?? moneyToMinor(invoice.vat_total));
  const total = Number(invoice.total_minor ?? moneyToMinor(invoice.total));
  const balance = Number(invoice.balance_minor ?? moneyToMinor(invoice.balance ?? invoice.total));
  return {
    document_number: invoice.invoice_number || invoice.fortnox_document_number || invoice.id,
    invoice_date: invoice.invoice_date,
    due_date: invoice.due_date,
    payment_terms_days: 30,
    currency: invoice.currency ?? "SEK",
    customer: {
      name: invoice.customer_name,
      org_number: invoice.customer_org_number ?? null,
      email: invoice.customer_email ?? null,
      phone: invoice.customer_phone ?? null,
      address1: invoice.customer_address1 ?? null,
      zip: invoice.customer_zip ?? null,
      city: invoice.customer_city ?? null,
      country: "Sverige"
    },
    rows,
    subtotal_minor: subtotal,
    vat_total_minor: vat,
    total_minor: total,
    balance_minor: balance,
    roundoff_minor: total - subtotal - vat,
    status: invoice.status,
    source_offer_reference: invoice.source_offer?.title || invoice.source_offer_title || invoice.source_offer_id || null,
    sales_order_reference: invoice.sales_order_id ?? null,
    fortnox_document_number: invoice.fortnox_document_number ?? null,
    seller_name: "Webblyftet",
    company: webblyftetCompanyProfile(env)
  };
}

async function customerOrderOfferDocumentInput(env: Env, token: string) {
  const payload = await getCustomerOrderSessionForToken(env, token) as any;
  const snapshot = payload.snapshot ?? {};
  const offer = snapshot.offer ?? {};
  const customer = snapshot.customer ?? {};
  return {
    document_number: offer.fortnox_document_number || offer.id || payload.id,
    title: offer.title || "Offert",
    document_date: offer.offer_date || snapshot.generated_at?.slice?.(0, 10) || new Date().toISOString().slice(0, 10),
    valid_until: offer.expire_date || payload.expires_at?.slice?.(0, 10) || null,
    currency: snapshot.order?.currency ?? "SEK",
    customer: {
      name: customer.name ?? null,
      org_number: customer.org_number ?? null,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      address1: customer.address1 ?? null,
      zip: customer.zip ?? null,
      city: customer.city ?? null,
      country: customer.country ?? "Sverige",
      contact_name: customer.contact_name ?? null
    },
    seller_name: "Webblyftet",
    rows: documentRows(snapshot.rows ?? []),
    remarks: offer.remarks ?? "",
    version_number: offer.version_number ?? null,
    company: webblyftetCompanyProfile(env),
    signer: {
      name: payload.signer_name ?? null,
      email: payload.signer_email ?? null,
      signed_at: payload.signed_at ?? null,
      status: payload.signed_at ? "Signerad i Finance Test" : "Demo-signering"
    }
  };
}

const contractFlowItemSchema = rowSchema.extend({
  source: z.enum(["PRODUCT_PRICE", "FREE_ROW"]).optional()
});

const contractFlowDraftSchema = z.object({
  company: z.object({
    name: z.string().optional().nullable(),
    org_number: z.string().optional().nullable(),
    address1: z.string().optional().nullable(),
    zip: z.string().optional().nullable(),
    city: z.string().optional().nullable()
  }),
  contact: z.object({
    name: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    phone: z.string().optional().nullable()
  }),
  items: z.array(contractFlowItemSchema)
});

const contractFlowHandoffSchema = z.object({
  source: z.enum(["WEBBLYFTET_PORTAL", "MANUAL"]),
  source_customer_id: z.string().optional().nullable(),
  seller: z.object({
    id: z.string().optional().nullable(),
    name: z.string().optional().nullable()
  }).optional().nullable(),
  meeting: z.object({
    id: z.string().optional().nullable(),
    notes: z.string().optional().nullable()
  }).optional().nullable(),
  company: contractFlowDraftSchema.shape.company,
  contact: contractFlowDraftSchema.shape.contact,
  items: z.array(contractFlowItemSchema)
});

const sendOfferEmailSchema = z.object({
  recipient: z.string().email().optional()
});

app.get("/api/contract-flows", async (c) => c.json(await listContractFlows(c.env)));

app.post("/api/contract-flows", zValidator("json", contractFlowHandoffSchema), async (c) => {
  return c.json(await createContractFlowFromHandoff(c.env, c.req.valid("json")), 201);
});

app.post("/api/contract-flows/simulate", async (c) => {
  return c.json(await createContractFlowFromHandoff(c.env, simulatedContractFlowHandoff()), 201);
});

app.get("/api/contract-flows/:id", async (c) => {
  const flow = await getContractFlow(c.env, c.req.param("id"));
  if (!flow) return c.json({ error: "Contract flow not found" }, 404);
  return c.json(flow);
});

app.put("/api/contract-flows/:id/draft", zValidator("json", contractFlowDraftSchema), async (c) => {
  return c.json(await updateContractFlowDraft(c.env, c.req.param("id"), c.req.valid("json")));
});

app.post("/api/contract-flows/:id/customer-link", async (c) => {
  return c.json(await createContractFlowCustomerLink(c.env, c.req.param("id")));
});

app.post("/api/contract-flows/:id/send-offer-email", zValidator("json", sendOfferEmailSchema), async (c) => {
  return c.json(await sendContractFlowOfferEmail(c.env, c.req.param("id"), c.req.valid("json")));
});

app.get("/api/offers", async (c) => c.json(await all<any>(
  c.env.DB,
  `SELECT o.*, c.name customer_name FROM offers o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`
)));

app.get("/api/offers/:id", async (c) => {
  const offer = await getOfferDetail(c.env, c.req.param("id"));
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  return c.json(offer);
});

app.get("/api/offers/:id/document", async (c) => {
  const input = await offerDocumentInput(c.env, c.req.param("id"));
  if (!input) return c.json({ error: "Offer not found" }, 404);
  if (c.req.query("format") === "email") {
    return c.json({ subject: "Din offert från Webblyftet", body: renderOfferEmailPreview(input) });
  }
  return c.html(renderOfferDocument(c.env, input));
});

app.post("/api/offers", zValidator("json", offerSchema), async (c) => {
  return c.json(await createBusinessOffer(c.env, c.req.valid("json")), 201);
});

app.post("/api/offers/:id/sync", async (c) => {
  const offer = await one<any>(c.env.DB, "SELECT * FROM offers WHERE id=?", c.req.param("id"));
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  const customer = await one<any>(c.env.DB, "SELECT * FROM customers WHERE id=?", offer.customer_id);
  if (!customer?.fortnox_customer_number) return c.json({ error: "Customer must be synced to Fortnox first." }, 409);
  const rows = await all<any>(c.env.DB, "SELECT * FROM offer_rows WHERE offer_id=? ORDER BY sort_order", offer.id);

  const result = await syncOfferToFortnox(c.env, customer.fortnox_customer_number, { ...offer, rows });
  const number = result.providerDocumentNumber;
  await c.env.DB.prepare(
    "UPDATE offers SET fortnox_document_number=?, sync_status='SYNCED', status='SENT', updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(number, offer.id).run();
  return c.json({ fortnox: result.raw, offer: await one(c.env.DB, "SELECT * FROM offers WHERE id=?", offer.id) });
});

app.post("/api/offers/:id/sign-link", async (c) => {
  const offer = await one<any>(c.env.DB, "SELECT id FROM offers WHERE id=?", c.req.param("id"));
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  return c.json(await createOfferAcceptanceToken(c.env, offer.id));
});

app.get("/sign/:token", async (c) => {
  const token = await getOfferForToken(c.env, c.req.param("token"));
  if (!token) return c.text("Ogiltig eller utgången offertlänk.", 404);
  const snapshot = token.snapshot;
  return c.html(renderOfferDocument(c.env, {
    document_number: snapshot.offer.fortnox_document_number || snapshot.offer.id,
    title: snapshot.offer.title || "Offert",
    document_date: snapshot.offer.offer_date,
    valid_until: snapshot.offer.expire_date,
    currency: snapshot.offer.currency ?? "SEK",
    customer: {
      name: snapshot.offer.customer_name,
      contact_name: snapshot.offer.customer_contact_name ?? null,
      email: snapshot.offer.customer_email ?? null,
      org_number: snapshot.offer.customer_org_number ?? null,
      address1: snapshot.offer.customer_address1 ?? null,
      zip: snapshot.offer.customer_zip ?? null,
      city: snapshot.offer.customer_city ?? null,
      country: "Sverige"
    },
    rows: documentRows(snapshot.rows ?? []),
    remarks: snapshot.offer.remarks ?? "",
    version_number: token.version_number,
    test_label: "Finance Test · demo/test-signering",
    acceptFormHtml: `<h2>Acceptera offert</h2><form method="post" class="accept"><div><label>Namn</label><input name="name" required></div><div><label>E-post</label><input type="email" name="email" required></div><label class="check"><input type="checkbox" required> Jag accepterar offerten, priserna och villkorsversionen ovan.</label><button type="submit">Acceptera offert</button></form><p class="fine">Testsignering med audit trail. Detta ar inte BankID eller kvalificerad elektronisk signatur.</p>`
  }));
});

app.post("/sign/:token", async (c) => {
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!name || !email) return c.text("Namn och e-post krävs.", 400);
  await acceptOfferToken(c.env, {
    token: c.req.param("token"),
    accepted_by_name: name,
    accepted_by_email: email,
    ip_address: c.req.header("cf-connecting-ip") ?? "",
    user_agent: c.req.header("user-agent") ?? ""
  });
  return c.html("<h1>Offerten är accepterad</h1><p>Tack. Händelsen har sparats i audit trail.</p>");
});

app.post("/api/offers/:id/create-invoice", async (c) => {
  const invoice = await one<any>(
    c.env.DB,
    `SELECT i.* FROM invoices i
     JOIN sales_orders so ON so.id=i.sales_order_id
     WHERE so.offer_id=?
     ORDER BY i.created_at DESC LIMIT 1`,
    c.req.param("id")
  );
  if (!invoice) return c.json({ error: "Offer must be accepted before an internal invoice exists." }, 409);
  return c.json({ invoice });
});

app.get("/api/invoices", async (c) => c.json(await all<any>(
  c.env.DB,
  `SELECT i.*, c.name customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id ORDER BY i.created_at DESC`
)));

app.get("/api/invoices/:id", async (c) => {
  const detail = await getInvoiceDetail(c.env, c.req.param("id"));
  if (!detail) return c.json({ error: "Invoice not found" }, 404);
  return c.json(detail);
});

app.get("/api/invoices/:id/document", async (c) => {
  const input = await invoiceDocumentInput(c.env, c.req.param("id"));
  if (!input) return c.json({ error: "Invoice not found" }, 404);
  if (c.req.query("format") === "email") {
    return c.json({ subject: "Din faktura från Webblyftet", body: renderInvoiceEmailPreview(input) });
  }
  return c.html(renderInvoiceDocument(c.env, input));
});

app.post("/api/invoices/pull", async (c) => {
  const invoices = await pullInvoicesFromFortnox(c.env);
  for (const item of invoices) {
    const customer = await one<any>(c.env.DB, "SELECT id FROM customers WHERE fortnox_customer_number=?", item.CustomerNumber);
    if (!customer) continue;
    const existing = await one<any>(c.env.DB, "SELECT id FROM invoices WHERE fortnox_document_number=?", item.DocumentNumber);
    if (existing) {
      await c.env.DB.prepare(
        `UPDATE invoices SET status=?, invoice_date=?, due_date=?, total=?, balance=?, booked=?, cancelled=?,
         sync_status='SYNCED', last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(
        item.Cancelled ? "CANCELLED" : (Number(item.Balance ?? 0) <= 0 ? "PAID" : "UNPAID"),
        item.InvoiceDate, item.DueDate, item.Total ?? 0, item.Balance ?? 0, item.Booked ? 1 : 0, item.Cancelled ? 1 : 0, existing.id
      ).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO invoices
        (id,fortnox_document_number,customer_id,status,invoice_date,due_date,total,balance,booked,cancelled,sync_status,last_synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'SYNCED',CURRENT_TIMESTAMP)`
      ).bind(
        id("inv"), item.DocumentNumber, customer.id,
        item.Cancelled ? "CANCELLED" : (Number(item.Balance ?? 0) <= 0 ? "PAID" : "UNPAID"),
        item.InvoiceDate, item.DueDate, item.Total ?? 0, item.Balance ?? 0, item.Booked ? 1 : 0, item.Cancelled ? 1 : 0
      ).run();
    }
  }
  return c.json({ imported: invoices.length });
});

app.post("/api/invoices/:id/sync-fortnox", async (c) => {
  return c.json(await syncInvoiceToFortnox(c.env, c.req.param("id")));
});

app.post("/api/receipts", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const maxBytes = maxReceiptUploadBytes(c.env);
  if (file.size > maxBytes) return c.json({ error: `Max ${Math.floor(maxBytes / 1024 / 1024)} MB` }, 413);
  if (!isAllowedReceiptMimeType(file.type)) return c.json({ error: "Only PDF/JPG/PNG/TIFF allowed" }, 415);

  const receiptId = id("rcp");
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "receipt";
  const key = `receipts/${new Date().toISOString().slice(0,10)}/${receiptId}-${safeName}`;
  await c.env.RECEIPTS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare(
    `INSERT INTO receipts(id,filename,mime_type,r2_key,amount,vat_amount,supplier_name,transaction_date,notes)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    receiptId, file.name, file.type, key,
    Number(form.get("amount") || 0) || null,
    Number(form.get("vat_amount") || 0) || null,
    String(form.get("supplier_name") || ""),
    String(form.get("transaction_date") || ""),
    String(form.get("notes") || "")
  ).run();
  return c.json(await one(c.env.DB, "SELECT * FROM receipts WHERE id=?", receiptId), 201);
});

app.get("/api/receipts", async (c) => c.json(await all(c.env.DB, "SELECT * FROM receipts ORDER BY created_at DESC")));

app.get("/api/receipts/:id/file", async (c) => {
  const receipt = await one<any>(c.env.DB, "SELECT * FROM receipts WHERE id=?", c.req.param("id"));
  if (!receipt) return c.json({ error: "Not found" }, 404);
  const object = await c.env.RECEIPTS.get(receipt.r2_key);
  if (!object) return c.json({ error: "File missing" }, 404);
  const headers = new Headers();
  headers.set("Content-Type", isAllowedReceiptMimeType(receipt.mime_type) ? receipt.mime_type : "application/octet-stream");
  headers.set("Content-Disposition", safeReceiptContentDisposition(String(receipt.filename)));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  return new Response(object.body, { headers });
});

app.post("/api/receipts/:id/push-inbox", async (c) => {
  return c.json(await pushReceiptToFortnoxInbox(c.env, c.req.param("id")));
});

app.get("/api/supplier-invoices", async (c) => c.json(await all(c.env.DB, "SELECT * FROM supplier_invoices ORDER BY created_at DESC")));

app.post("/api/supplier-invoices/pull", async (c) => {
  const rows = await pullSupplierInvoicesFromFortnox(c.env);
  for (const item of rows) {
    const existing = await one<any>(c.env.DB, "SELECT id FROM supplier_invoices WHERE fortnox_document_number=?", item.GivenNumber);
    const values = [
      item.GivenNumber ?? item.InvoiceNumber ?? null,
      item.SupplierNumber ?? null,
      item.SupplierName ?? null,
      item.InvoiceDate ?? null,
      item.DueDate ?? null,
      item.Total ?? 0,
      item.Balance ?? 0,
      item.Booked ? 1 : 0,
      item.Cancelled ? 1 : 0
    ];
    if (existing) {
      await c.env.DB.prepare(
        `UPDATE supplier_invoices SET supplier_number=?,supplier_name=?,invoice_date=?,due_date=?,total=?,balance=?,booked=?,cancelled=?,
        last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(...values.slice(1), existing.id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO supplier_invoices
        (id,fortnox_document_number,supplier_number,supplier_name,invoice_date,due_date,total,balance,booked,cancelled,last_synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
      ).bind(id("sinv"), ...values).run();
    }
  }
  return c.json({ imported: rows.length });
});

app.get("/api/vouchers", async (c) => c.json(await all(c.env.DB, "SELECT * FROM vouchers ORDER BY transaction_date DESC, voucher_number DESC LIMIT 500")));

app.post("/api/vouchers/pull", async (c) => {
  const year = c.req.query("year");
  const series = c.req.query("series") ?? "A";
  if (!year) return c.json({ error: "year query param required, e.g. ?year=1&series=A" }, 400);
  const rows = await pullVouchersFromFortnox(c.env, year, series);
  for (const item of rows) {
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO vouchers
      (id,fortnox_year,series,voucher_number,transaction_date,description,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM vouchers WHERE fortnox_year=? AND series=? AND voucher_number=?),CURRENT_TIMESTAMP))`
    ).bind(
      id("vou"), Number(year), series, item.VoucherNumber, item.TransactionDate, item.Description ?? "", item.ReferenceType ?? "",
      Number(year), series, item.VoucherNumber
    ).run();
  }
  return c.json({ imported: rows.length });
});

app.get("/api/sync-log", async (c) => c.json(await all(c.env.DB, "SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 250")));

app.notFound(async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
