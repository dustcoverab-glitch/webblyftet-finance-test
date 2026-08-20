import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { all, id, one } from "./lib/db";
import { errorJson, oauthErrorPage } from "./lib/errors";
import { escapeHtml } from "./lib/html";
import { calculate } from "./lib/calculations";
import {
  createPrice,
  createProduct,
  createSubscription,
  seedTestProducts
} from "./core/finance";
import {
  connectionStatus,
  createAuthUrl,
  exchangeCode,
  uploadInboxFile
} from "./integrations/fortnox/client";
import { syncCustomerToFortnox, pullCustomersFromFortnox } from "./integrations/fortnox/customers";
import { createInvoiceFromFortnoxOffer, syncOfferToFortnox } from "./integrations/fortnox/offers";
import { pullInvoicesFromFortnox } from "./integrations/fortnox/invoices";
import { pullSupplierInvoicesFromFortnox, pullVouchersFromFortnox } from "./integrations/fortnox/accounting";
import { createOrReuseStripeCustomer } from "./integrations/stripe/customers";
import { createPaymentMethodSetupIntent } from "./integrations/stripe/subscriptions";
import { constructStripeWebhookEvent, processStripeEvent } from "./integrations/stripe/webhooks";
import { requireCloudflareAccess } from "./lib/security";
import { sha256Hex } from "./lib/crypto";

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

const rowSchema = z.object({
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
  const offer = await one<any>(c.env.DB, "SELECT * FROM offers WHERE id=?", c.req.param("id"));
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  const rows = await all<any>(c.env.DB, "SELECT * FROM offer_rows WHERE offer_id=? ORDER BY sort_order", offer.id);
  return c.json({ ...offer, rows });
});

app.post("/api/offers", zValidator("json", offerSchema), async (c) => {
  const data = c.req.valid("json");
  const offerId = id("off");
  const totals = calculate(data.rows);
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO offers
      (id,customer_id,title,offer_date,expire_date,remarks,subtotal,vat_total,total)
      VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(offerId, data.customer_id, data.title, data.offer_date, data.expire_date, data.remarks, totals.subtotal, totals.vatTotal, totals.total),
    ...data.rows.map((row, index) =>
      c.env.DB.prepare(
        `INSERT INTO offer_rows
        (id,offer_id,sort_order,article_number,description,quantity,unit,unit_price,discount_percent,vat_percent,account_number)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id("orow"), offerId, index, row.article_number, row.description, row.quantity, row.unit, row.unit_price, row.discount_percent, row.vat_percent, row.account_number ?? null)
    )
  ];
  await c.env.DB.batch(statements);
  return c.json({ id: offerId, ...totals }, 201);
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
  const token = crypto.randomUUID() + crypto.randomUUID();
  const hash = await sha256Hex(token);
  await c.env.DB.prepare("UPDATE offers SET signature_token_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(hash, offer.id).run();
  return c.json({ url: `${c.env.APP_BASE_URL}/sign/${token}` });
});

app.get("/sign/:token", async (c) => {
  const hash = await sha256Hex(c.req.param("token"));
  const offer = await one<any>(
    c.env.DB,
    `SELECT o.id,o.title,o.total,o.offer_date,o.expire_date,o.status,c.name customer_name
     FROM offers o JOIN customers c ON c.id=o.customer_id WHERE o.signature_token_hash=?`,
    hash
  );
  if (!offer) return c.text("Ogiltig eller utgången offertlänk.", 404);
  const title = escapeHtml(offer.title || "Offert");
  const customerName = escapeHtml(offer.customer_name);
  const status = escapeHtml(offer.status);
  const amount = escapeHtml(Number(offer.total).toLocaleString("sv-SE"));
  return c.html(`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Acceptera offert</title><style>body{font-family:system-ui;background:#f4f2ee;color:#171717;max-width:720px;margin:50px auto;padding:24px}
  .card{background:white;border:1px solid #ddd7cf;border-radius:18px;padding:32px}.amount{font-size:34px;font-weight:750}
  input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0 14px;border:1px solid #bbb;border-radius:9px}
  button{padding:13px 20px;background:#171717;color:#fff;border:0;border-radius:9px;font-weight:650}</style></head><body>
  <div class="card"><small>WEBBLYFTET · TEST</small><h1>${title}</h1>
  <p>Kund: ${customerName}</p><p class="amount">${amount} kr</p>
  <p>Status: ${status}</p>
  <form method="post"><label>Namn</label><input name="name" required>
  <label>E-post</label><input type="email" name="email" required>
  <label><input type="checkbox" required style="width:auto"> Jag accepterar offerten och villkoren.</label><br><br>
  <button type="submit">Acceptera offert</button></form>
  <p><small>Testsignering med audit trail. Detta är inte BankID eller kvalificerad elektronisk signatur.</small></p></div></body></html>`);
});

app.post("/sign/:token", async (c) => {
  const hash = await sha256Hex(c.req.param("token"));
  const offer = await one<any>(c.env.DB, "SELECT id,status FROM offers WHERE signature_token_hash=?", hash);
  if (!offer) return c.text("Ogiltig offertlänk.", 404);
  if (offer.status === "ACCEPTED") return c.text("Offerten är redan accepterad.", 409);
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!name || !email) return c.text("Namn och e-post krävs.", 400);
  await c.env.DB.prepare(
    `UPDATE offers SET status='ACCEPTED', accepted_at=CURRENT_TIMESTAMP, accepted_by_name=?, accepted_by_email=?,
    acceptance_ip=?, acceptance_user_agent=?, signature_token_hash=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).bind(name, email, c.req.header("cf-connecting-ip") ?? "", c.req.header("user-agent") ?? "", offer.id).run();
  return c.html("<h1>Offerten är accepterad</h1><p>Tack. Händelsen har sparats i audit trail.</p>");
});

app.post("/api/offers/:id/create-invoice", async (c) => {
  const offer = await one<any>(c.env.DB, "SELECT * FROM offers WHERE id=?", c.req.param("id"));
  if (!offer) return c.json({ error: "Offer not found" }, 404);
  if (!offer.fortnox_document_number) return c.json({ error: "Offer must be synced to Fortnox first." }, 409);

  // Fortnox supports creating invoice directly from an offer when the relevant permission is enabled.
  const result = await createInvoiceFromFortnoxOffer(c.env, offer.fortnox_document_number);

  const invoice = result.Invoice ?? result;
  const invoiceId = id("inv");
  await c.env.DB.prepare(
    `INSERT INTO invoices
    (id,fortnox_document_number,customer_id,source_offer_id,status,invoice_date,due_date,total,balance,booked,sync_status,last_synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'SYNCED',CURRENT_TIMESTAMP)`
  ).bind(
    invoiceId,
    invoice.DocumentNumber ?? null,
    offer.customer_id,
    offer.id,
    "CREATED",
    invoice.InvoiceDate ?? new Date().toISOString().slice(0,10),
    invoice.DueDate ?? null,
    invoice.Total ?? offer.total,
    invoice.Balance ?? invoice.Total ?? offer.total,
    invoice.Booked ? 1 : 0
  ).run();
  return c.json({ invoiceId, fortnox: result });
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
