import { fortnoxRequest } from "./client";
import { PublicAppError } from "../../lib/app-error";
import { one } from "../../lib/db";

export async function pullInvoicesFromFortnox(env: Env) {
  const result = await fortnoxRequest<any>(env, "/invoices?limit=500", { method: "GET" });
  return result.Invoices ?? [];
}

function financeInvoiceReference(invoiceId: string): string {
  return `webblyftet-finance:${invoiceId}`;
}

function fortnoxDocumentNumber(result: any): string | null {
  return result?.Invoice?.DocumentNumber != null
    ? String(result.Invoice.DocumentNumber)
    : result?.DocumentNumber != null
      ? String(result.DocumentNumber)
      : null;
}

async function findFortnoxInvoiceByFinanceReference(env: Env, invoiceId: string): Promise<{ documentNumber: string; raw: any } | null> {
  const reference = financeInvoiceReference(invoiceId);
  const result = await fortnoxRequest<any>(
    env,
    `/invoices?externalinvoicereference1=${encodeURIComponent(reference)}&limit=10`,
    { method: "GET" }
  );
  const invoices = Array.isArray(result.Invoices) ? result.Invoices : [];
  const match = invoices.find((invoice: any) => String(invoice.ExternalInvoiceReference1 ?? "") === reference) ?? (invoices.length === 1 ? invoices[0] : null);
  const documentNumber = match?.DocumentNumber != null ? String(match.DocumentNumber) : null;
  return documentNumber ? { documentNumber, raw: match } : null;
}

async function markInvoiceSynced(env: Env, invoiceId: string, documentNumber: string) {
  const update = await env.DB.prepare(
    `UPDATE invoices
     SET fortnox_document_number=?, sync_status='SYNCED', last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND (fortnox_document_number IS NULL OR fortnox_document_number=?)
  `
  ).bind(documentNumber, invoiceId, documentNumber).run();
  const saved = await one<any>(env.DB, "SELECT fortnox_document_number FROM invoices WHERE id=?", invoiceId);
  if ((update.meta.changes ?? 0) !== 1 || saved?.fortnox_document_number !== documentNumber) {
    throw new PublicAppError(409, "Fortnox invoice mapping kunde inte sparas utan konflikt.");
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,after_json)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(crypto.randomUUID(), "FORTNOX", null, "INVOICE_SYNCED_TO_FORTNOX", "invoice", invoiceId, JSON.stringify({ fortnox_document_number: documentNumber })).run();
}

export async function syncInvoiceToFortnox(env: Env, invoiceId: string) {
  const invoice = await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", invoiceId);
  if (!invoice) throw new PublicAppError(404, "Fakturan hittades inte.");
  if (invoice.fortnox_document_number) return { providerDocumentNumber: invoice.fortnox_document_number, reused: true };
  const recovered = await findFortnoxInvoiceByFinanceReference(env, invoice.id);
  if (recovered) {
    await markInvoiceSynced(env, invoice.id, recovered.documentNumber);
    return { providerDocumentNumber: recovered.documentNumber, reused: true, recovered: true, raw: recovered.raw };
  }
  const customer = await one<any>(env.DB, "SELECT * FROM customers WHERE id=?", invoice.customer_id);
  if (!customer?.fortnox_customer_number) throw new PublicAppError(409, "Kunden saknar Fortnox Customer Number.");
  const rows = await env.DB.prepare("SELECT * FROM invoice_rows WHERE invoice_id=? ORDER BY sort_order").bind(invoice.id).all<any>();
  const claim = await env.DB.prepare(
    `UPDATE invoices
     SET sync_status='SYNCING', updated_at=CURRENT_TIMESTAMP
     WHERE id=?
       AND fortnox_document_number IS NULL
       AND sync_status IN ('LOCAL_ONLY','FAILED','RECOVERY_REQUIRED')
  `
  ).bind(invoice.id).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const current = await one<any>(env.DB, "SELECT fortnox_document_number,sync_status FROM invoices WHERE id=?", invoice.id);
    if (current?.fortnox_document_number) return { providerDocumentNumber: current.fortnox_document_number, reused: true };
    throw new PublicAppError(409, "Fakturasync pågår redan eller kräver manuell recovery.");
  }
  try {
    const result = await fortnoxRequest<any>(env, "/invoices", {
      method: "POST",
      json: {
        Invoice: {
          CustomerNumber: customer.fortnox_customer_number,
          InvoiceDate: invoice.invoice_date,
          DueDate: invoice.due_date || undefined,
          Remarks: invoice.remarks || undefined,
          ExternalInvoiceReference1: financeInvoiceReference(invoice.id),
          YourOrderNumber: invoice.invoice_number || invoice.id,
          InvoiceRows: rows.results.map((row) => ({
            ArticleNumber: row.article_number || undefined,
            Description: row.description,
            DeliveredQuantity: row.quantity,
            Unit: row.unit || undefined,
            Price: row.unit_price,
            VAT: row.vat_percent,
            AccountNumber: row.account_number || undefined
          }))
        }
      }
    });
    const documentNumber = fortnoxDocumentNumber(result);
    if (!documentNumber) {
      await env.DB.prepare("UPDATE invoices SET sync_status='RECOVERY_REQUIRED', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(invoice.id).run();
      throw new PublicAppError(502, "Fortnox skapade fakturan men returnerade inget DocumentNumber.");
    }
    await markInvoiceSynced(env, invoice.id, documentNumber);
    return { providerDocumentNumber: documentNumber, reused: false, raw: result };
  } catch (error) {
    const recoveredAfterError = await findFortnoxInvoiceByFinanceReference(env, invoice.id).catch(() => null);
    if (recoveredAfterError) {
      await markInvoiceSynced(env, invoice.id, recoveredAfterError.documentNumber);
      return { providerDocumentNumber: recoveredAfterError.documentNumber, reused: true, recovered: true, raw: recoveredAfterError.raw };
    }
    await env.DB.prepare(
      "UPDATE invoices SET sync_status='FAILED', updated_at=CURRENT_TIMESTAMP WHERE id=? AND fortnox_document_number IS NULL"
    ).bind(invoice.id).run();
    throw error;
  }
}

export async function syncPaymentToFortnox() {
  throw new Error("Direct Finance Core payment export to Fortnox is not implemented yet.");
}
