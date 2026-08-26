import { renderInvoiceDocument, webblyftetCompanyProfile, type DocumentLine, type InvoiceDocumentInput } from "../../documents";
import { encryptString, decryptString, sha256Hex } from "../../lib/crypto";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function moneyToMinor(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}

function rowUnitPriceMinor(row: any): number {
  return Number(row.unit_price_minor ?? moneyToMinor(row.unit_price));
}

export function documentRows(rows: any[]): DocumentLine[] {
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

export async function invoiceDocumentInputForEmail(env: Env, invoiceId: string): Promise<InvoiceDocumentInput & { invoice_id: string; customer_email?: string | null; customer_id?: string | null }> {
  const invoice = await one<any>(
    env.DB,
    `SELECT i.*, c.name customer_name, c.org_number customer_org_number, c.email customer_email,
      c.phone customer_phone, c.address1 customer_address1, c.zip customer_zip, c.city customer_city, c.country customer_country,
      o.title source_offer_title
     FROM invoices i
     JOIN customers c ON c.id=i.customer_id
     LEFT JOIN offers o ON o.id=i.source_offer_id
     WHERE i.id=?`,
    invoiceId
  );
  if (!invoice) throw new PublicAppError(404, "Faktura saknas.");
  const rows = await env.DB.prepare("SELECT * FROM invoice_rows WHERE invoice_id=? ORDER BY sort_order, created_at").bind(invoiceId).all<any>();
  const subtotal = Number(invoice.subtotal_minor ?? moneyToMinor(invoice.subtotal));
  const vat = Number(invoice.vat_total_minor ?? moneyToMinor(invoice.vat_total));
  const total = Number(invoice.total_minor ?? moneyToMinor(invoice.total));
  const balance = Number(invoice.balance_minor ?? moneyToMinor(invoice.balance ?? invoice.total));
  return {
    invoice_id: invoice.id,
    customer_id: invoice.customer_id,
    customer_email: invoice.customer_email ?? null,
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
      country: invoice.customer_country ?? "Sverige"
    },
    rows: documentRows(rows.results),
    subtotal_minor: subtotal,
    vat_total_minor: vat,
    total_minor: total,
    balance_minor: balance,
    roundoff_minor: total - subtotal - vat,
    status: invoice.status,
    source_offer_reference: invoice.source_offer_title || invoice.source_offer_id || null,
    sales_order_reference: invoice.sales_order_id ?? null,
    fortnox_document_number: invoice.fortnox_document_number ?? null,
    seller_name: "Webblyftet",
    company: webblyftetCompanyProfile(env)
  };
}

export async function createOrReuseInvoiceDocumentUrl(env: Env, invoiceId: string): Promise<string> {
  const existing = await one<any>(
    env.DB,
    "SELECT * FROM invoice_document_tokens WHERE invoice_id=? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1",
    invoiceId
  );
  if (existing?.token_enc) {
    const token = await decryptString(existing.token_enc, env.TOKEN_ENCRYPTION_KEY_BASE64);
    return `${env.APP_BASE_URL.replace(/\/+$/, "")}/invoice-documents/${token}`;
  }
  const token = newToken();
  await env.DB.prepare(
    `INSERT INTO invoice_document_tokens(id,invoice_id,token_hash,token_enc,expires_at)
     VALUES (?,?,?,?,datetime('now','+90 days'))
     ON CONFLICT(invoice_id) DO UPDATE SET
       token_hash=excluded.token_hash,
       token_enc=excluded.token_enc,
       expires_at=excluded.expires_at,
       created_at=CURRENT_TIMESTAMP,
       last_used_at=NULL`
  ).bind(id("invtok"), invoiceId, await sha256Hex(token), await encryptString(token, env.TOKEN_ENCRYPTION_KEY_BASE64)).run();
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/invoice-documents/${token}`;
}

export async function renderInvoiceDocumentForToken(env: Env, token: string): Promise<string> {
  const tokenHash = await sha256Hex(token);
  const row = await one<{ invoice_id: string }>(
    env.DB,
    "SELECT invoice_id FROM invoice_document_tokens WHERE token_hash=? AND expires_at > datetime('now')",
    tokenHash
  );
  if (!row) throw new PublicAppError(404, "Fakturalänken är ogiltig eller har gått ut.");
  await env.DB.prepare("UPDATE invoice_document_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE token_hash=?").bind(tokenHash).run();
  return renderInvoiceDocument(env, await invoiceDocumentInputForEmail(env, row.invoice_id));
}
