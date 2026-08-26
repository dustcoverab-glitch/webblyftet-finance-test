import { PublicAppError } from "../../lib/app-error";
import { one } from "../../lib/db";
import { fortnoxRequest } from "./client";

export async function syncCreditInvoiceToFortnox(env: Env, creditInvoiceId: string) {
  const credit = await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", creditInvoiceId);
  if (!credit) throw new PublicAppError(404, "Kreditfakturan hittades inte.");
  if (credit.invoice_type !== "CREDIT_INVOICE" || !credit.original_invoice_id) {
    throw new PublicAppError(409, "Endast kreditfakturor kan synkas via kreditflödet.");
  }
  if (credit.fortnox_document_number) return { providerDocumentNumber: credit.fortnox_document_number, reused: true };
  const original = await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", credit.original_invoice_id);
  if (!original?.fortnox_document_number) {
    throw new PublicAppError(409, "Originalfakturan måste vara synkad till Fortnox innan kreditfaktura kan skapas.");
  }
  const result = await fortnoxRequest<any>(env, `/invoices-v2/${encodeURIComponent(original.fortnox_document_number)}/credit`, {
    method: "PUT",
    body: JSON.stringify({ Invoice: {} })
  });
  const documentNumber = result?.Invoice?.DocumentNumber || result?.Invoice?.CreditInvoiceReference;
  if (!documentNumber) throw new PublicAppError(502, "Fortnox returnerade inget kreditfakturanummer.");
  await env.DB.prepare(
    `UPDATE invoices
     SET fortnox_document_number=?, sync_status='SYNCED', last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND fortnox_document_number IS NULL`
  ).bind(String(documentNumber), creditInvoiceId).run();
  return { providerDocumentNumber: String(documentNumber), reused: false };
}
