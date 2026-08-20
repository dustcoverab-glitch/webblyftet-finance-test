import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { all, id, one } from "./lib/db";
import { errorJson, oauthErrorPage } from "./lib/errors";
import { escapeHtml } from "./lib/html";
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
  getOfferDetail,
  getOfferForToken
} from "./core/business-flow";
import {
  connectionStatus,
  createAuthUrl,
  exchangeCode,
  uploadInboxFile
} from "./integrations/fortnox/client";
import { syncCustomerToFortnox, pullCustomersFromFortnox } from "./integrations/fortnox/customers";
import { syncOfferToFortnox } from "./integrations/fortnox/offers";
import { pullInvoicesFromFortnox, syncInvoiceToFortnox } from "./integrations/fortnox/invoices";
import { pullSupplierInvoicesFromFortnox, pullVouchersFromFortnox } from "./integrations/fortnox/accounting";
import { createOrReuseStripeCustomer } from "./integrations/stripe/customers";
import {
  activateStripeSubscription,
  cancelStripeSubscriptionAtPeriodEnd,
  createPaymentMethodSetupIntent,
  syncPriceToStripe,
  syncProductToStripe
} from "./integrations/stripe/subscriptions";
import { constructStripeWebhookEvent, processStripeEvent } from "./integrations/stripe/webhooks";
import { requireCloudflareAccess } from "./lib/security";
import { isStripeConfigured, isStripePublishableKeyConfigured } from "./lib/config";

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => errorJson(c, error));
app.use("*", requireCloudflareAccess());

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV, now: new Date().toISOString() }));

app.post("/webhooks/stripe", async (c) => {
  const rawBody = await c.req.text();
  const event = await constructStripeWebhookEvent(c.env, rawBody, c.req.header("stripe-signature") ?? null);
  return c.json(await processStripeEvent(c.env, event));
});

app.get("/api/dashboard", async (c) => {
  const [customers, offers, invoices, receipts, logs, connection] = await Promise.all([
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) count FROM customers"),
    one<{ count: number; value: number }>(c.env.DB, "SELECT COUNT(*) count, COALESCE(SUM(total),0) value FROM offers"),
    one<{ count: number; value: number; outstanding: number }>(
      c.env.DB,
      "SELECT COUNT(*) count, COALESCE(SUM(total),0) value, COALESCE(SUM(COALESCE(balance,total)),0) outstanding FROM invoices WHERE cancelled=0"
    ),
    one<{ count: number }>(c.env.DB, "SELECT COUNT(*) count FROM receipts"),
    all<any>(c.env.DB, "SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 10"),
    connectionStatus(c.env)
  ]);
  return c.json({ customers, offers, invoices, receipts, logs, connection });
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
  const number = result.providerCustomerNumber;
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

app.post("/api/subscriptions", zValidator("json", subscriptionSchema), async (c) => {
  return c.json(await createSubscription(c.env, c.req.valid("json")), 201);
});

app.post("/api/subscriptions/:id/activate", async (c) => {
  return c.json(await activateStripeSubscription(c.env, c.req.param("id")));
});

app.post("/api/subscriptions/:id/cancel", async (c) => {
  return c.json(await cancelStripeSubscriptionAtPeriodEnd(c.env, c.req.param("id")));
});

const rowSchema = z.object({
  product_id: z.string().optional().nullable(),
  price_id: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().optional().default("st"),
  unit_price: z.number(),
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

app.get("/api/offers", async (c) => c.json(await all<any>(
  c.env.DB,
  `SELECT o.*, c.name customer_name FROM offers o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`
)));

app.get("/api/offers/:id", async (c) => {
  const offer = await getOfferDetail(c.env, c.req.param("id"));
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  return c.json(offer);
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
  const money = (minor: number) => escapeHtml((minor / 100).toLocaleString("sv-SE", { style: "currency", currency: snapshot.offer.currency ?? "SEK" }));
  const rowNet = (row: any) => Math.round(row.unit_price_minor * Number(row.quantity) * (1 - Number(row.discount_percent ?? 0) / 100));
  const rowVat = (row: any) => Math.round(rowNet(row) * (Number(row.vat_percent ?? 0) / 100));
  const oneTimeRows = snapshot.rows.filter((row: any) => row.billing_type === "ONE_TIME");
  const recurringRows = snapshot.rows.filter((row: any) => row.billing_type === "RECURRING");
  const sum = (rows: any[], fn: (row: any) => number) => rows.reduce((total, row) => total + fn(row), 0);
  const oneTimeNet = sum(oneTimeRows, rowNet);
  const oneTimeVat = sum(oneTimeRows, rowVat);
  const recurringMonthlyNet = sum(recurringRows, (row) => Math.round(rowNet(row) / (row.billing_interval === "YEAR" ? 12 : 1)));
  const recurringMonthlyVat = sum(recurringRows, (row) => Math.round(rowVat(row) / (row.billing_interval === "YEAR" ? 12 : 1)));
  const title = escapeHtml(snapshot.offer.title || "Offert");
  const customerName = escapeHtml(snapshot.offer.customer_name);
  const remarks = escapeHtml(snapshot.offer.remarks || "");
  const validUntil = escapeHtml(snapshot.offer.expire_date || "Ej angivet");
  const rowsHtml = (rows: any[]) => rows.map((row: any) => `<tr><td><strong>${escapeHtml(row.description)}</strong><small>${escapeHtml(row.billing_type)}${row.billing_interval ? ` / ${escapeHtml(row.billing_interval)}` : ""}</small></td><td>${escapeHtml(String(row.quantity))}</td><td>${money(row.unit_price_minor)}</td><td>${escapeHtml(String(row.discount_percent ?? 0))}%</td><td>${escapeHtml(String(row.vat_percent ?? 0))}%</td><td>${money(rowNet(row) + rowVat(row))}</td></tr>`).join("");
  return c.html(`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Acceptera offert</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17221f;background:#f5f4f0}body{margin:0}.shell{max-width:980px;margin:0 auto;padding:34px 18px 48px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:26px}.mark{width:42px;height:42px;border-radius:10px;background:#d4f36b;display:grid;place-items:center;font-weight:900}.brand span{display:block;color:#69736f;font-size:13px;margin-top:2px}.hero{background:#17221f;color:#fff;border-radius:18px;padding:30px;margin-bottom:18px}.hero small{color:#d4f36b;font-weight:750;letter-spacing:.12em}.hero h1{font-size:38px;line-height:1.05;margin:12px 0 10px}.hero p{color:#ccd5d0;margin:0}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}.tile,.card{background:#fff;border:1px solid #dddcd6;border-radius:14px;padding:18px}.tile span{display:block;color:#6d7671;font-size:12px}.tile strong{font-size:24px;display:block;margin-top:8px}.card{margin-bottom:18px}.card h2{font-size:18px;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;border-bottom:1px solid #e9e7e0;padding:11px 8px;vertical-align:top}td small{display:block;color:#73807a;margin-top:3px}.note{color:#59645f;line-height:1.55}.accept{display:grid;grid-template-columns:1fr 1fr;gap:12px}.accept label{font-weight:650;font-size:13px}.accept input{width:100%;box-sizing:border-box;padding:12px;margin:7px 0 14px;border:1px solid #cfd1cb;border-radius:9px}.check{grid-column:1/-1;color:#3d4843}.check input{width:auto;margin-right:8px}button{padding:13px 18px;background:#17221f;color:#fff;border:0;border-radius:9px;font-weight:750;cursor:pointer}.fine{color:#6d7671;font-size:12px;line-height:1.5}@media(max-width:760px){.summary,.accept{grid-template-columns:1fr}.hero h1{font-size:30px}table{font-size:12px}}</style></head><body>
  <main class="shell"><div class="brand"><div class="mark">W</div><div><strong>Webblyftet</strong><span>Finance Test · Offertacceptans</span></div></div>
  <section class="hero"><small>OFFERT · VERSION ${escapeHtml(String(token.version_number))}</small><h1>${title}</h1><p>Kund: ${customerName} · Giltig till: ${validUntil}</p></section>
  <section class="summary"><div class="tile"><span>Engångskostnad inkl. moms</span><strong>${money(oneTimeNet + oneTimeVat)}</strong></div><div class="tile"><span>Återkommande per månad inkl. moms</span><strong>${money(recurringMonthlyNet + recurringMonthlyVat)}</strong></div><div class="tile"><span>Total moms engång</span><strong>${money(oneTimeVat)}</strong></div></section>
  <section class="card"><h2>Engångsposter</h2><table><thead><tr><th>Rad</th><th>Antal</th><th>Pris</th><th>Rabatt</th><th>Moms</th><th>Total</th></tr></thead><tbody>${rowsHtml(oneTimeRows) || `<tr><td colspan="6">Inga engångsposter.</td></tr>`}</tbody></table></section>
  <section class="card"><h2>Abonnemangsposter</h2><table><thead><tr><th>Rad</th><th>Antal</th><th>Pris</th><th>Rabatt</th><th>Moms</th><th>Total</th></tr></thead><tbody>${rowsHtml(recurringRows) || `<tr><td colspan="6">Inga abonnemangsposter.</td></tr>`}</tbody></table></section>
  ${remarks ? `<section class="card"><h2>Kommentar</h2><p class="note">${remarks}</p></section>` : ""}
  <section class="card"><h2>Acceptera offert</h2><form method="post" class="accept"><div><label>Namn</label><input name="name" required></div>
  <div><label>E-post</label><input type="email" name="email" required></div>
  <label class="check"><input type="checkbox" required> Jag accepterar offerten och villkoren.</label>
  <button type="submit">Acceptera offert</button></form>
  <p class="fine">Testsignering med audit trail. Detta är inte BankID eller kvalificerad elektronisk signatur.</p></section></main></body></html>`);
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
  if (file.size > 10 * 1024 * 1024) return c.json({ error: "Max 10 MB" }, 413);
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff"]);
  if (!allowed.has(file.type)) return c.json({ error: "Only PDF/JPG/PNG/TIFF allowed" }, 415);

  const receiptId = id("rcp");
  const key = `receipts/${new Date().toISOString().slice(0,10)}/${receiptId}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
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
  object.writeHttpMetadata(headers);
  headers.set("Content-Disposition", `inline; filename="${String(receipt.filename).replace(/["\r\n]/g, "_")}"`);
  return new Response(object.body, { headers });
});

app.post("/api/receipts/:id/push-inbox", async (c) => {
  const receipt = await one<any>(c.env.DB, "SELECT * FROM receipts WHERE id=?", c.req.param("id"));
  if (!receipt) return c.json({ error: "Not found" }, 404);
  const object = await c.env.RECEIPTS.get(receipt.r2_key);
  if (!object?.body) return c.json({ error: "File missing" }, 404);

  const blob = await new Response(object.body).blob();
  const file = new File([blob], receipt.filename, { type: receipt.mime_type });
  const result = await uploadInboxFile(c.env, file, "Inbox_v");
  const fileId = result.File?.Id ?? null;
  await c.env.DB.prepare(
    "UPDATE receipts SET fortnox_file_id=?, status='INBOX_UPLOADED', updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(fileId, receipt.id).run();
  return c.json({ receipt_id: receipt.id, fortnox: result });
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
