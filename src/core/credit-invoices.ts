import { createAccountingEvent } from "./finance";
import { PublicAppError } from "../lib/app-error";
import { id, one } from "../lib/db";
import { minorToMoney, moneyToMinor } from "../lib/money";

async function reserveCreditInvoiceNumber(env: Env): Promise<string> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO document_sequences(name,prefix,next_number) VALUES ('TEST_CREDIT_INVOICE','KTEST-',1)"
  ).run();
  const sequence = await one<{ prefix: string; reserved: number }>(
    env.DB,
    `UPDATE document_sequences
     SET next_number=next_number+1, updated_at=CURRENT_TIMESTAMP
     WHERE name='TEST_CREDIT_INVOICE'
     RETURNING prefix, next_number - 1 reserved`
  );
  if (!sequence) throw new PublicAppError(500, "Kreditfakturanummerserie saknas.");
  return `${sequence.prefix}${String(sequence.reserved).padStart(5, "0")}`;
}

export async function createFullCreditInvoice(env: Env, originalInvoiceId: string, reason = "Full kreditering") {
  const original = await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", originalInvoiceId);
  if (!original) throw new PublicAppError(404, "Originalfakturan hittades inte.");
  if (original.invoice_type === "CREDIT_INVOICE" || original.original_invoice_id) {
    throw new PublicAppError(409, "En kreditfaktura kan inte krediteras i detta flöde.");
  }
  const existing = await one<any>(
    env.DB,
    `SELECT i.*
     FROM credit_invoices ci
     JOIN invoices i ON i.id=ci.credit_invoice_id
     WHERE ci.original_invoice_id=?`,
    originalInvoiceId
  );
  if (existing) return { credit_invoice: existing, reused: true };

  const rows = await env.DB.prepare("SELECT * FROM invoice_rows WHERE invoice_id=? ORDER BY sort_order").bind(originalInvoiceId).all<any>();
  if (!rows.results.length) throw new PublicAppError(409, "Originalfakturan saknar rader.");
  const creditInvoiceId = id("inv");
  const creditNumber = await reserveCreditInvoiceNumber(env);
  const subtotalMinor = -Math.abs(Number(original.subtotal_minor ?? moneyToMinor(Number(original.subtotal ?? 0))));
  const vatMinor = -Math.abs(Number(original.vat_total_minor ?? moneyToMinor(Number(original.vat_total ?? 0))));
  const totalMinor = -Math.abs(Number(original.total_minor ?? moneyToMinor(Number(original.total ?? 0))));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoices
        (id,customer_id,source_offer_id,sales_order_id,invoice_number,invoice_type,status,invoice_date,due_date,currency,
         remarks,subtotal,vat_total,total,balance,subtotal_minor,vat_total_minor,total_minor,balance_minor,original_invoice_id,credit_reason,credit_type,fortnox_credit_invoice_reference)
       VALUES (?,?,?,?,?,'CREDIT_INVOICE','DRAFT',date('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      creditInvoiceId,
      original.customer_id,
      original.source_offer_id ?? null,
      original.sales_order_id ?? null,
      creditNumber,
      original.due_date ?? null,
      original.currency ?? "SEK",
      reason,
      minorToMoney(subtotalMinor),
      minorToMoney(vatMinor),
      minorToMoney(totalMinor),
      minorToMoney(totalMinor),
      subtotalMinor,
      vatMinor,
      totalMinor,
      totalMinor,
      originalInvoiceId,
      reason,
      "FULL",
      original.fortnox_document_number ?? null
    ),
    ...rows.results.map((row: any, index: number) => env.DB.prepare(
      `INSERT INTO invoice_rows
        (id,invoice_id,sort_order,article_number,description,quantity,unit,unit_price,discount_percent,vat_percent,account_number,product_id,price_id,billing_type,billing_interval,unit_price_minor)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id("irow"),
      creditInvoiceId,
      index,
      row.article_number ?? null,
      `Kreditering: ${row.description}`,
      row.quantity,
      row.unit ?? null,
      -Math.abs(Number(row.unit_price ?? 0)),
      Number(row.discount_percent ?? 0),
      Number(row.vat_percent ?? 25),
      row.account_number ?? null,
      row.product_id ?? null,
      row.price_id ?? null,
      row.billing_type ?? "ONE_TIME",
      row.billing_interval ?? null,
      -Math.abs(Number(row.unit_price_minor ?? moneyToMinor(Number(row.unit_price ?? 0))))
    )),
    env.DB.prepare("UPDATE invoices SET credited_by_invoice_id=?, status='CREDITED', updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(creditInvoiceId, originalInvoiceId),
    env.DB.prepare("INSERT INTO credit_invoices(id,original_invoice_id,credit_invoice_id,credit_reason) VALUES (?,?,?,?)")
      .bind(id("cred"), originalInvoiceId, creditInvoiceId, reason)
  ]);
  await createAccountingEvent(env, {
    event_type: "INVOICE_CREDITED",
    entity_type: "invoice",
    entity_id: creditInvoiceId,
    currency: original.currency ?? "SEK",
    net_amount: subtotalMinor,
    vat_amount: vatMinor,
    gross_amount: totalMinor,
    payload: {
      accounting_semantics: "FULL_CREDIT_REVERSAL",
      original_invoice_id: originalInvoiceId,
      credit_invoice_id: creditInvoiceId,
      credit_type: "FULL"
    }
  });
  return {
    credit_invoice: await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", creditInvoiceId),
    reused: false
  };
}
