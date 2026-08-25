import { createAccountingEvent, subscriptionMonthlyAmount } from "./finance";
import { PublicAppError } from "../lib/app-error";
import { sha256Hex } from "../lib/crypto";
import { id, one } from "../lib/db";
import { WEBBLYFTET_TERMS_VERSION } from "../documents/terms";

export type OfferInputRow = {
  product_id?: string | null;
  price_id?: string | null;
  article_number?: string | null;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  unit_price?: number | null;
  discount_percent?: number;
  vat_percent?: number;
  account_number?: number | null;
};

export type CreateOfferInput = {
  customer_id: string;
  title?: string | null;
  offer_date: string;
  expire_date?: string | null;
  remarks?: string | null;
  rows: OfferInputRow[];
};

type SnapshotRow = {
  id: string;
  product_id: string | null;
  price_id: string | null;
  article_number: string | null;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  unit_price_minor: number;
  discount_percent: number;
  vat_percent: number;
  account_number: number | null;
  billing_type: "ONE_TIME" | "RECURRING";
  billing_interval: "MONTH" | "YEAR" | null;
};

function moneyToMinor(value: number): number {
  return Math.round(Number(value) * 100);
}

function minorToMoney(value: number): number {
  return Math.round(value) / 100;
}

function calculateMinor(rows: SnapshotRow[]) {
  let subtotal = 0;
  let vatTotal = 0;
  for (const row of rows) {
    const gross = row.unit_price_minor * row.quantity;
    const net = Math.round(gross * (1 - row.discount_percent / 100));
    subtotal += net;
    vatTotal += Math.round(net * (row.vat_percent / 100));
  }
  return { subtotal, vatTotal, total: subtotal + vatTotal };
}

export async function createOffer(env: Env, input: CreateOfferInput) {
  if (!input.rows.length) throw new PublicAppError(400, "Offerten kräver minst en rad.");
  const rows = await normalizeOfferRows(env, input.rows);
  const totals = calculateMinor(rows);
  const offerId = id("off");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO offers
        (id,customer_id,title,offer_date,expire_date,remarks,subtotal,vat_total,total)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      offerId,
      input.customer_id,
      input.title ?? "",
      input.offer_date,
      input.expire_date ?? "",
      input.remarks ?? "",
      minorToMoney(totals.subtotal),
      minorToMoney(totals.vatTotal),
      minorToMoney(totals.total)
    ),
    ...rows.map((row, index) => env.DB.prepare(
      `INSERT INTO offer_rows
        (id,offer_id,sort_order,article_number,description,quantity,unit,unit_price,discount_percent,vat_percent,account_number,product_id,price_id,billing_type,billing_interval)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      row.id,
      offerId,
      index,
      row.article_number,
      row.description,
      row.quantity,
      row.unit,
      row.unit_price,
      row.discount_percent,
      row.vat_percent,
      row.account_number,
      row.product_id,
      row.price_id,
      row.billing_type,
      row.billing_interval
    ))
  ]);
  await audit(env, "OFFER_CREATED", "offer", offerId, null, { ...input, rows });
  return getOfferDetail(env, offerId);
}

async function normalizeOfferRows(env: Env, rows: OfferInputRow[]): Promise<SnapshotRow[]> {
  const normalized: SnapshotRow[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.quantity) || row.quantity <= 0) throw new PublicAppError(400, "Quantity måste vara positiv.");
    if (row.price_id) {
      const price = await one<any>(
        env.DB,
        `SELECT pr.*, p.name product_name, p.product_type, p.active product_active
         FROM prices pr JOIN products p ON p.id=pr.product_id
         WHERE pr.id=?`,
        row.price_id
      );
      if (!price || price.active !== 1 || price.product_active !== 1) throw new PublicAppError(400, "Pris eller produkt är inte aktiv.");
      if (row.product_id && row.product_id !== price.product_id) throw new PublicAppError(400, "Pris och produkt matchar inte.");
      normalized.push({
        id: id("orow"),
        product_id: price.product_id,
        price_id: price.id,
        article_number: row.article_number ?? null,
        description: row.description || price.product_name,
        quantity: row.quantity,
        unit: row.unit ?? "st",
        unit_price: minorToMoney(price.amount),
        unit_price_minor: price.amount,
        discount_percent: row.discount_percent ?? 0,
        vat_percent: row.vat_percent ?? price.vat_percent ?? 25,
        account_number: row.account_number ?? null,
        billing_type: price.billing_type,
        billing_interval: price.billing_interval
      });
    } else {
      const unitPrice = Number(row.unit_price ?? 0);
      normalized.push({
        id: id("orow"),
        product_id: row.product_id ?? null,
        price_id: null,
        article_number: row.article_number ?? null,
        description: row.description || "Fri rad",
        quantity: row.quantity,
        unit: row.unit ?? "st",
        unit_price: unitPrice,
        unit_price_minor: moneyToMinor(unitPrice),
        discount_percent: row.discount_percent ?? 0,
        vat_percent: row.vat_percent ?? 25,
        account_number: row.account_number ?? null,
        billing_type: "ONE_TIME",
        billing_interval: null
      });
    }
  }
  return normalized;
}

export async function createOfferVersion(env: Env, offerId: string) {
  const detail = await getOfferDetail(env, offerId);
  if (!detail) throw new PublicAppError(404, "Offerten hittades inte.");
  const version = await one<{ version_number: number }>(
    env.DB,
    "SELECT COALESCE(MAX(version_number),0)+1 version_number FROM offer_versions WHERE offer_id=?",
    offerId
  );
  const snapshotRows = detail.rows.map((row: any) => ({
    id: row.id,
    product_id: row.product_id ?? null,
    price_id: row.price_id ?? null,
    article_number: row.article_number ?? null,
    description: row.description,
    quantity: Number(row.quantity),
    unit: row.unit ?? null,
    unit_price: Number(row.unit_price),
    unit_price_minor: moneyToMinor(Number(row.unit_price)),
    discount_percent: Number(row.discount_percent ?? 0),
    vat_percent: Number(row.vat_percent ?? 25),
    account_number: row.account_number ?? null,
    billing_type: row.billing_type ?? "ONE_TIME",
    billing_interval: row.billing_interval ?? null
  })) as SnapshotRow[];
  const totals = calculateMinor(snapshotRows);
  const snapshot = {
    offer: {
      id: detail.id,
      customer_id: detail.customer_id,
      customer_name: detail.customer_name,
      customer_org_number: detail.customer_org_number ?? null,
      customer_email: detail.customer_email ?? null,
      customer_phone: detail.customer_phone ?? null,
      customer_address1: detail.customer_address1 ?? null,
      customer_zip: detail.customer_zip ?? null,
      customer_city: detail.customer_city ?? null,
      customer_country: detail.customer_country ?? "SE",
      title: detail.title,
      offer_date: detail.offer_date,
      expire_date: detail.expire_date,
      currency: detail.currency ?? "SEK",
      remarks: detail.remarks,
      terms_version: WEBBLYFTET_TERMS_VERSION
    },
    rows: snapshotRows,
    totals
  };
  const versionId = id("over");
  await env.DB.prepare(
    `INSERT INTO offer_versions(id,offer_id,version_number,snapshot_json,subtotal,vat_total,total)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(versionId, offerId, version?.version_number ?? 1, JSON.stringify(snapshot), totals.subtotal, totals.vatTotal, totals.total).run();
  await audit(env, "OFFER_VERSION_CREATED", "offer", offerId, null, { version_id: versionId, version_number: version?.version_number ?? 1 });
  return one<any>(env.DB, "SELECT * FROM offer_versions WHERE id=?", versionId);
}

export async function createOfferAcceptanceToken(env: Env, offerId: string) {
  const version = await createOfferVersion(env, offerId);
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    "UPDATE offer_acceptance_tokens SET status='CANCELLED', used_at=CURRENT_TIMESTAMP WHERE offer_id=? AND status IN ('ACTIVE','PROCESSING')"
  ).bind(offerId).run();
  const tokenId = id("otkn");
  await env.DB.prepare(
    `INSERT INTO offer_acceptance_tokens(id,offer_id,offer_version_id,token_hash,expires_at,status)
     VALUES (?,?,?,?,?,'ACTIVE')`
  ).bind(tokenId, offerId, version!.id, tokenHash, new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString()).run();
  await env.DB.prepare("UPDATE offers SET status='SENT', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(offerId).run();
  await audit(env, "OFFER_ACCEPTANCE_LINK_CREATED", "offer", offerId, null, { offer_version_id: version!.id });
  return { token, url: `${env.APP_BASE_URL.replace(/\/+$/, "")}/sign/${token}`, version };
}

export async function getOfferForToken(env: Env, token: string) {
  const tokenHash = await sha256Hex(token);
  const row = await one<any>(
    env.DB,
    `SELECT t.*, v.snapshot_json, v.version_number
     FROM offer_acceptance_tokens t JOIN offer_versions v ON v.id=t.offer_version_id
     WHERE t.token_hash=?`,
    tokenHash
  );
  if (!row || row.status !== "ACTIVE" || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot_json) };
}

export async function acceptOfferToken(env: Env, input: {
  token: string;
  accepted_by_name: string;
  accepted_by_email: string;
  ip_address?: string | null;
  user_agent?: string | null;
}) {
  const tokenHash = await sha256Hex(input.token);
  const token = await one<any>(
    env.DB,
    `SELECT t.*, v.snapshot_json, v.version_number, o.customer_id
     FROM offer_acceptance_tokens t
     JOIN offer_versions v ON v.id=t.offer_version_id
     JOIN offers o ON o.id=t.offer_id
     WHERE t.token_hash=?`,
    tokenHash
  );
  if (!token || token.status === "USED" || token.status === "CANCELLED" || token.used_at || new Date(token.expires_at).getTime() <= Date.now()) {
    if (token && token.status !== "USED" && new Date(token.expires_at).getTime() <= Date.now()) {
      await env.DB.prepare("UPDATE offer_acceptance_tokens SET status='EXPIRED' WHERE id=? AND status!='USED'").bind(token.id).run();
    }
    throw new PublicAppError(404, "Ogiltig eller utgången offertlänk.");
  }
  const latest = await one<{ id: string }>(
    env.DB,
    `SELECT offer_version_id id FROM offer_acceptance_tokens
     WHERE offer_id=? AND status IN ('ACTIVE','PROCESSING')
     ORDER BY created_at DESC LIMIT 1`,
    token.offer_id
  );
  if (latest?.id !== token.offer_version_id) throw new PublicAppError(409, "Offertlänken har ersatts av en nyare version.");

  if (token.status === "ACTIVE") {
    const claim = await env.DB.prepare(
      "UPDATE offer_acceptance_tokens SET status='PROCESSING' WHERE id=? AND status='ACTIVE'"
    ).bind(token.id).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      const claimed = await one<any>(env.DB, "SELECT status FROM offer_acceptance_tokens WHERE id=?", token.id);
      if (claimed?.status !== "PROCESSING") throw new PublicAppError(409, "Offertlänken är redan använd.");
    }
  }

  const snapshotHash = await sha256Hex(token.snapshot_json);
  const acceptanceId = id("oacc");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO offer_acceptances
      (id,offer_id,offer_version_id,customer_id,accepted_by_name,accepted_by_email,accepted_at,ip_address,user_agent,snapshot_hash,metadata_json)
     VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?)`
  ).bind(
    acceptanceId,
    token.offer_id,
    token.offer_version_id,
    token.customer_id,
    input.accepted_by_name,
    input.accepted_by_email,
    input.ip_address ?? "",
    input.user_agent ?? "",
    snapshotHash,
    JSON.stringify({ version_number: token.version_number })
  ).run();
  const acceptance = await one<any>(env.DB, "SELECT * FROM offer_acceptances WHERE offer_version_id=?", token.offer_version_id);
  if (!acceptance) throw new PublicAppError(500, "Offertacceptans kunde inte sparas.");
  await env.DB.prepare(
    `UPDATE offers SET status='ACCEPTED', accepted_at=CURRENT_TIMESTAMP, accepted_by_name=?, accepted_by_email=?,
     acceptance_ip=?, acceptance_user_agent=?, signature_token_hash=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).bind(input.accepted_by_name, input.accepted_by_email, input.ip_address ?? "", input.user_agent ?? "", token.offer_id).run();
  await env.DB.prepare("UPDATE offer_acceptance_tokens SET status='USED', used_at=CURRENT_TIMESTAMP WHERE id=?").bind(token.id).run();
  await audit(env, "OFFER_ACCEPTED", "offer", token.offer_id, null, { acceptance_id: acceptance.id, offer_version_id: token.offer_version_id });
  return createSalesOrderFromAcceptance(env, acceptance.id);
}

export async function createSalesOrderFromAcceptance(env: Env, acceptanceId: string) {
  return ensureSalesOrderFromAcceptance(env, acceptanceId);
}

export async function ensureSalesOrderFromAcceptance(env: Env, acceptanceId: string) {
  const acceptance = await one<any>(
    env.DB,
    `SELECT a.*, v.snapshot_json FROM offer_acceptances a JOIN offer_versions v ON v.id=a.offer_version_id WHERE a.id=?`,
    acceptanceId
  );
  if (!acceptance) throw new PublicAppError(404, "Acceptance saknas.");
  const snapshot = JSON.parse(acceptance.snapshot_json) as { rows: SnapshotRow[]; offer: any; totals: any };
  const existing = await one<any>(env.DB, "SELECT * FROM sales_orders WHERE acceptance_id=?", acceptanceId);
  const oneTimeRows = snapshot.rows.filter((row) => row.billing_type === "ONE_TIME");
  const recurringRows = snapshot.rows.filter((row) => row.billing_type === "RECURRING");
  const oneTimeTotal = calculateMinor(oneTimeRows).total;
  const recurringMonthly = subscriptionMonthlyAmount(recurringRows.map((row) => ({
    unit_amount: row.unit_price_minor,
    quantity: row.quantity,
    billing_interval: row.billing_interval
  })));
  const orderId = existing?.id ?? id("sord");
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO sales_orders(id,offer_id,offer_version_id,acceptance_id,customer_id,status,currency,one_time_total_minor,recurring_monthly_minor)
       VALUES (?,?,?,?,?,'PROVISIONING',?,?,?)`
    ).bind(orderId, acceptance.offer_id, acceptance.offer_version_id, acceptance.id, acceptance.customer_id, snapshot.offer.currency ?? "SEK", oneTimeTotal, recurringMonthly).run();
    await audit(env, "SALES_ORDER_CREATED", "sales_order", orderId, null, { acceptance_id: acceptanceId });
  } else {
    await env.DB.prepare(
      `UPDATE sales_orders
       SET status='PROVISIONING', one_time_total_minor=?, recurring_monthly_minor=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(oneTimeTotal, recurringMonthly, orderId).run();
  }
  try {
    await ensureOrderItems(env, orderId, snapshot.rows);
    const invoice = oneTimeRows.length ? await createInternalInvoiceFromSalesOrder(env, orderId) : null;
    if (invoice) await ensureInvoiceAccountingEvent(env, invoice.id);
    if (recurringRows.length) await createPendingSubscriptionFromSalesOrder(env, orderId);
    await env.DB.prepare("UPDATE sales_orders SET status='READY', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(orderId).run();
  } catch (error) {
    await env.DB.prepare("UPDATE sales_orders SET status='PARTIAL_FAILURE', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(orderId).run();
    throw error;
  }
  return getSalesOrder(env, orderId);
}

export async function ensureOrderItems(env: Env, salesOrderId: string, snapshotRows?: SnapshotRow[]) {
  let rows = snapshotRows;
  if (!rows) {
    const order = await one<any>(env.DB, "SELECT acceptance_id FROM sales_orders WHERE id=?", salesOrderId);
    if (!order) throw new PublicAppError(404, "Order saknas.");
    const acceptance = await one<any>(
      env.DB,
      `SELECT v.snapshot_json FROM offer_acceptances a JOIN offer_versions v ON v.id=a.offer_version_id WHERE a.id=?`,
      order.acceptance_id
    );
    if (!acceptance) throw new PublicAppError(404, "Acceptance saknas.");
    rows = (JSON.parse(acceptance.snapshot_json) as { rows: SnapshotRow[] }).rows;
  }
  for (const row of rows) {
    const existing = await one<any>(
      env.DB,
      "SELECT id FROM sales_order_items WHERE sales_order_id=? AND offer_row_id=?",
      salesOrderId,
      row.id
    );
    if (existing) continue;
    await env.DB.prepare(
      `INSERT INTO sales_order_items
        (id,sales_order_id,offer_row_id,product_id,price_id,description,quantity,unit,unit_price_minor,vat_percent,billing_type,billing_interval)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id("soit"), salesOrderId, row.id, row.product_id, row.price_id, row.description, row.quantity, row.unit, row.unit_price_minor, row.vat_percent, row.billing_type, row.billing_interval).run();
  }
}

export async function createInternalInvoiceFromSalesOrder(env: Env, salesOrderId: string) {
  const existing = await one<any>(env.DB, "SELECT * FROM invoices WHERE sales_order_id=?", salesOrderId);
  if (existing) {
    await ensureInvoiceAccountingEvent(env, existing.id);
    return existing;
  }
  const order = await one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", salesOrderId);
  if (!order) throw new PublicAppError(404, "Order saknas.");
  const rows = await env.DB.prepare(
    "SELECT * FROM sales_order_items WHERE sales_order_id=? AND billing_type='ONE_TIME' ORDER BY created_at"
  ).bind(salesOrderId).all<any>();
  if (!rows.results.length) return null;
  const totals = calculateMinor(rows.results.map((row: any) => ({
    ...row,
    id: row.id,
    unit_price: minorToMoney(row.unit_price_minor),
    discount_percent: 0,
    account_number: null
  })));
  const invoiceId = id("inv");
  const invoiceNumber = await reserveInvoiceNumber(env);
  const invoiceDate = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoices
        (id,customer_id,source_offer_id,sales_order_id,invoice_number,invoice_type,status,invoice_date,due_date,currency,subtotal,vat_total,total,balance,subtotal_minor,vat_total_minor,total_minor,balance_minor)
       VALUES (?,?,?,?,?,'PROJECT_INVOICE',?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(invoiceId, order.customer_id, order.offer_id, salesOrderId, invoiceNumber, "DRAFT", invoiceDate, due, order.currency, minorToMoney(totals.subtotal), minorToMoney(totals.vatTotal), minorToMoney(totals.total), minorToMoney(totals.total), totals.subtotal, totals.vatTotal, totals.total, totals.total),
    ...rows.results.map((row: any, index: number) => env.DB.prepare(
      `INSERT INTO invoice_rows
        (id,invoice_id,sort_order,description,quantity,unit,unit_price,vat_percent,product_id,price_id,billing_type,billing_interval,unit_price_minor)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id("irow"), invoiceId, index, row.description, row.quantity, row.unit, minorToMoney(row.unit_price_minor), row.vat_percent, row.product_id, row.price_id, row.billing_type, row.billing_interval, row.unit_price_minor))
  ]);
  await ensureInvoiceAccountingEvent(env, invoiceId);
  await audit(env, "INVOICE_CREATED", "invoice", invoiceId, null, { sales_order_id: salesOrderId });
  return one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", invoiceId);
}

export async function ensureInvoiceAccountingEvent(env: Env, invoiceId: string) {
  const invoice = await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", invoiceId);
  if (!invoice) throw new PublicAppError(404, "Faktura saknas.");
  return createAccountingEvent(env, {
    event_type: "INVOICE_CREATED",
    entity_type: "invoice",
    entity_id: invoiceId,
    currency: invoice.currency,
    net_amount: invoice.subtotal_minor ?? moneyToMinor(Number(invoice.subtotal ?? 0)),
    vat_amount: invoice.vat_total_minor ?? moneyToMinor(Number(invoice.vat_total ?? 0)),
    gross_amount: invoice.total_minor ?? moneyToMinor(Number(invoice.total ?? 0)),
    payload: {
      accounting_semantics: "SALE",
      invoice_id: invoiceId,
      customer_id: invoice.customer_id,
      invoice_type: invoice.invoice_type ?? "PROJECT_INVOICE"
    }
  });
}

export async function createPendingSubscriptionFromSalesOrder(env: Env, salesOrderId: string) {
  const existing = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE sales_order_id=?", salesOrderId);
  if (existing) return existing;
  const order = await one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", salesOrderId);
  if (!order) throw new PublicAppError(404, "Order saknas.");
  const rows = await env.DB.prepare(
    "SELECT * FROM sales_order_items WHERE sales_order_id=? AND billing_type='RECURRING' ORDER BY created_at"
  ).bind(salesOrderId).all<any>();
  if (!rows.results.length) return null;
  const subscriptionId = id("sub");
  const start = new Date().toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions(id,customer_id,status,currency,start_date,current_period_start,sales_order_id,offer_id,offer_version_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(subscriptionId, order.customer_id, "PENDING", order.currency, start, start, salesOrderId, order.offer_id, order.offer_version_id),
    ...rows.results.map((row: any) => env.DB.prepare(
      `INSERT INTO subscription_items(id,subscription_id,product_id,price_id,quantity,unit_amount)
       VALUES (?,?,?,?,?,?)`
    ).bind(id("sitem"), subscriptionId, row.product_id, row.price_id, row.quantity, row.unit_price_minor))
  ]);
  await audit(env, "SUBSCRIPTION_PENDING_CREATED", "subscription", subscriptionId, null, { sales_order_id: salesOrderId });
  return one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
}

async function reserveInvoiceNumber(env: Env): Promise<string> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO document_sequences(name,prefix,next_number) VALUES ('TEST_INVOICE','TEST-',1)"
  ).run();
  const sequence = await one<{ prefix: string; reserved: number }>(
    env.DB,
    `UPDATE document_sequences
     SET next_number=next_number+1, updated_at=CURRENT_TIMESTAMP
     WHERE name='TEST_INVOICE'
     RETURNING prefix, next_number - 1 reserved`
  );
  if (!sequence) throw new PublicAppError(500, "Fakturanummerserie saknas.");
  return `${sequence.prefix}${String(sequence.reserved).padStart(5, "0")}`;
}

export async function getOfferDetail(env: Env, offerId: string) {
  const offer = await one<any>(
    env.DB,
    `SELECT o.*, c.name customer_name, c.org_number customer_org_number, c.email customer_email,
      c.phone customer_phone, c.address1 customer_address1, c.zip customer_zip, c.city customer_city,
      c.country customer_country
     FROM offers o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`,
    offerId
  );
  if (!offer) return null;
  const [rows, versions, acceptances, orders, auditRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM offer_rows WHERE offer_id=? ORDER BY sort_order").bind(offerId).all<any>(),
    env.DB.prepare("SELECT * FROM offer_versions WHERE offer_id=? ORDER BY version_number DESC").bind(offerId).all<any>(),
    env.DB.prepare("SELECT * FROM offer_acceptances WHERE offer_id=? ORDER BY accepted_at DESC").bind(offerId).all<any>(),
    env.DB.prepare("SELECT * FROM sales_orders WHERE offer_id=? ORDER BY created_at DESC").bind(offerId).all<any>(),
    env.DB.prepare("SELECT * FROM audit_log WHERE entity_type='offer' AND entity_id=? ORDER BY created_at DESC").bind(offerId).all<any>()
  ]);
  const ordersWithStatus = await Promise.all(orders.results.map(async (order: any) => {
    const [invoices, subscriptions] = await Promise.all([
      env.DB.prepare("SELECT id,invoice_number,fortnox_document_number,status,total,due_date FROM invoices WHERE sales_order_id=? ORDER BY created_at").bind(order.id).all<any>(),
      env.DB.prepare("SELECT id,status,stripe_subscription_id,current_period_end FROM subscriptions WHERE sales_order_id=? ORDER BY created_at").bind(order.id).all<any>()
    ]);
    return { ...order, invoices: invoices.results, subscriptions: subscriptions.results };
  }));
  return { ...offer, rows: rows.results, versions: versions.results, acceptances: acceptances.results, orders: ordersWithStatus, audit: auditRows.results };
}

export async function getSalesOrder(env: Env, orderId: string) {
  const order = await one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", orderId);
  if (!order) return null;
  const [items, invoices, subscriptions] = await Promise.all([
    env.DB.prepare("SELECT * FROM sales_order_items WHERE sales_order_id=? ORDER BY created_at").bind(orderId).all<any>(),
    env.DB.prepare("SELECT * FROM invoices WHERE sales_order_id=? ORDER BY created_at").bind(orderId).all<any>(),
    env.DB.prepare("SELECT * FROM subscriptions WHERE sales_order_id=? ORDER BY created_at").bind(orderId).all<any>()
  ]);
  return { ...order, items: items.results, invoices: invoices.results, subscriptions: subscriptions.results };
}

export async function getInvoiceDetail(env: Env, invoiceId: string) {
  const invoice = await one<any>(
    env.DB,
    `SELECT i.*, c.name customer_name, c.email customer_email, c.org_number customer_org_number,
      c.phone customer_phone, c.address1 customer_address1, c.zip customer_zip,
      c.city customer_city, o.title source_offer_title
     FROM invoices i
     JOIN customers c ON c.id=i.customer_id
     LEFT JOIN offers o ON o.id=i.source_offer_id
     WHERE i.id=?`,
    invoiceId
  );
  if (!invoice) return null;
  const [rows, salesOrder, sourceOffer, subscriptions, accountingEvents, payments, auditRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM invoice_rows WHERE invoice_id=? ORDER BY sort_order").bind(invoiceId).all<any>(),
    invoice.sales_order_id
      ? one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", invoice.sales_order_id)
      : Promise.resolve(null),
    invoice.source_offer_id
      ? one<any>(env.DB, "SELECT id,title,status,total,offer_date,expire_date FROM offers WHERE id=?", invoice.source_offer_id)
      : Promise.resolve(null),
    invoice.sales_order_id
      ? env.DB.prepare("SELECT id,status,stripe_subscription_id FROM subscriptions WHERE sales_order_id=? ORDER BY created_at DESC").bind(invoice.sales_order_id).all<any>()
      : Promise.resolve({ results: [] }),
    env.DB.prepare("SELECT * FROM accounting_events WHERE entity_type='invoice' AND entity_id=? ORDER BY occurred_at DESC, created_at DESC").bind(invoiceId).all<any>(),
    env.DB.prepare("SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at DESC").bind(invoiceId).all<any>(),
    env.DB.prepare("SELECT * FROM audit_log WHERE entity_type='invoice' AND entity_id=? ORDER BY created_at DESC LIMIT 50").bind(invoiceId).all<any>()
  ]);
  return {
    ...invoice,
    rows: rows.results,
    sales_order: salesOrder,
    source_offer: sourceOffer,
    subscriptions: subscriptions.results,
    accounting_events: accountingEvents.results,
    payments: payments.results,
    audit: auditRows.results
  };
}

export async function getSubscriptionDetail(env: Env, subscriptionId: string) {
  const subscription = await one<any>(
    env.DB,
    `SELECT s.*, c.name customer_name, c.email customer_email, c.org_number customer_org_number,
      o.title source_offer_title
     FROM subscriptions s
     JOIN customers c ON c.id=s.customer_id
     LEFT JOIN offers o ON o.id=s.offer_id
     WHERE s.id=?`,
    subscriptionId
  );
  if (!subscription) return null;
  const [items, payments, accountingEvents, auditRows, salesOrder] = await Promise.all([
    env.DB.prepare(
      `SELECT si.*, p.name product_name, pr.billing_type, pr.billing_interval, pr.vat_percent
       FROM subscription_items si
       LEFT JOIN products p ON p.id=si.product_id
       LEFT JOIN prices pr ON pr.id=si.price_id
       WHERE si.subscription_id=?
       ORDER BY si.created_at`
    ).bind(subscriptionId).all<any>(),
    env.DB.prepare("SELECT * FROM payments WHERE subscription_id=? ORDER BY created_at DESC").bind(subscriptionId).all<any>(),
    env.DB.prepare("SELECT * FROM accounting_events WHERE entity_type='payment' AND entity_id IN (SELECT id FROM payments WHERE subscription_id=?) ORDER BY occurred_at DESC, created_at DESC").bind(subscriptionId).all<any>(),
    env.DB.prepare("SELECT * FROM audit_log WHERE entity_type='subscription' AND entity_id=? ORDER BY created_at DESC LIMIT 50").bind(subscriptionId).all<any>(),
    subscription.sales_order_id
      ? one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", subscription.sales_order_id)
      : Promise.resolve(null)
  ]);
  return {
    ...subscription,
    items: items.results,
    payments: payments.results,
    accounting_events: accountingEvents.results,
    audit: auditRows.results,
    sales_order: salesOrder
  };
}

export async function getCustomerDetail(env: Env, customerId: string) {
  const customer = await one<any>(env.DB, "SELECT * FROM customers WHERE id=?", customerId);
  if (!customer) return null;
  const [offers, orders, orderSessions, invoices, subscriptions, paymentMethods, payments, auditRows, revenue, mrr, outstanding] = await Promise.all([
    env.DB.prepare("SELECT * FROM offers WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<any>(),
    env.DB.prepare("SELECT * FROM sales_orders WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<any>(),
    env.DB.prepare("SELECT id,sales_order_id,status,expires_at,reviewed_at,signed_at,completed_at,created_at FROM customer_order_sessions WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<any>(),
    env.DB.prepare("SELECT * FROM invoices WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<any>(),
    env.DB.prepare("SELECT * FROM subscriptions WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<any>(),
    env.DB.prepare("SELECT * FROM payment_methods WHERE customer_id=? ORDER BY is_default DESC, updated_at DESC").bind(customerId).all<any>(),
    env.DB.prepare("SELECT * FROM payments WHERE customer_id=? ORDER BY created_at DESC").bind(customerId).all<any>(),
    env.DB.prepare(
      `SELECT * FROM audit_log
       WHERE entity_id=?
          OR entity_id IN (SELECT id FROM offers WHERE customer_id=?)
          OR entity_id IN (SELECT id FROM offer_acceptances WHERE customer_id=?)
          OR entity_id IN (SELECT id FROM sales_orders WHERE customer_id=?)
          OR entity_id IN (SELECT id FROM invoices WHERE customer_id=?)
          OR entity_id IN (SELECT id FROM subscriptions WHERE customer_id=?)
          OR entity_id IN (SELECT id FROM payments WHERE customer_id=?)
          OR entity_id IN (SELECT id FROM payment_methods WHERE customer_id=?)
       ORDER BY created_at DESC LIMIT 100`
    ).bind(customerId, customerId, customerId, customerId, customerId, customerId, customerId, customerId).all<any>()
    ,
    one<{ one_time_sold_minor: number }>(
      env.DB,
      "SELECT COALESCE(SUM(one_time_total_minor),0) one_time_sold_minor FROM sales_orders WHERE customer_id=?",
      customerId
    ),
    one<{ active_subscription_count: number; active_mrr_minor: number }>(
      env.DB,
      `SELECT COUNT(DISTINCT s.id) active_subscription_count,
        COALESCE(SUM(CASE WHEN pr.billing_interval='YEAR' THEN ROUND(si.unit_amount * si.quantity / 12.0) ELSE si.unit_amount * si.quantity END),0) active_mrr_minor
       FROM subscriptions s
       LEFT JOIN subscription_items si ON si.subscription_id=s.id
       LEFT JOIN prices pr ON pr.id=si.price_id
       WHERE s.customer_id=? AND s.status='ACTIVE'`,
      customerId
    ),
    one<{ outstanding_minor: number }>(
      env.DB,
      `SELECT COALESCE(SUM(COALESCE(balance_minor, ROUND(COALESCE(balance,total) * 100))),0) outstanding_minor
       FROM invoices
       WHERE customer_id=? AND cancelled=0 AND status NOT IN ('PAID','CREDITED','CANCELLED')`,
      customerId
    )
  ]);
  return {
    customer,
    metrics: {
      one_time_sold_minor: revenue?.one_time_sold_minor ?? 0,
      active_mrr_minor: mrr?.active_mrr_minor ?? 0,
      active_subscription_count: mrr?.active_subscription_count ?? 0,
      outstanding_minor: outstanding?.outstanding_minor ?? 0,
      latest_payment: payments.results[0] ?? null
    },
    offers: offers.results,
    orders: orders.results.map((order: any) => ({
      ...order,
      customer_order_sessions: orderSessions.results.filter((session: any) => session.sales_order_id === order.id)
    })),
    invoices: invoices.results,
    subscriptions: subscriptions.results,
    payment_methods: paymentMethods.results,
    payments: payments.results,
    audit: auditRows.results
  };
}

async function audit(env: Env, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await env.DB.prepare(
    `INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,before_json,after_json)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id("aud"), "SYSTEM", null, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
}
