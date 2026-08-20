import { fortnoxRequest } from "./client";
import { PublicAppError } from "../../lib/app-error";
import { one } from "../../lib/db";

export async function pullInvoicesFromFortnox(env: Env) {
  const result = await fortnoxRequest<any>(env, "/invoices?limit=500", { method: "GET" });
  return result.Invoices ?? [];
}

export async function syncInvoiceToFortnox(env: Env, invoiceId: string) {
  const invoice = await one<any>(env.DB, "SELECT * FROM invoices WHERE id=?", invoiceId);
  if (!invoice) throw new PublicAppError(404, "Fakturan hittades inte.");
  if (invoice.fortnox_document_number) return { providerDocumentNumber: invoice.fortnox_document_number, reused: true };
  const customer = await one<any>(env.DB, "SELECT * FROM customers WHERE id=?", invoice.customer_id);
  if (!customer?.fortnox_customer_number) throw new PublicAppError(409, "Kunden saknar Fortnox Customer Number.");
  const rows = await env.DB.prepare("SELECT * FROM invoice_rows WHERE invoice_id=? ORDER BY sort_order").bind(invoice.id).all<any>();
  const result = await fortnoxRequest<any>(env, "/invoices", {
    method: "POST",
    json: {
      Invoice: {
        CustomerNumber: customer.fortnox_customer_number,
        InvoiceDate: invoice.invoice_date,
        DueDate: invoice.due_date || undefined,
        Remarks: invoice.remarks || undefined,
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
  const documentNumber = result.Invoice?.DocumentNumber ?? result.DocumentNumber ?? null;
  await env.DB.prepare(
    `UPDATE invoices
     SET fortnox_document_number=?, sync_status='SYNCED', last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).bind(documentNumber, invoice.id).run();
  await env.DB.prepare(
    `INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,after_json)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(crypto.randomUUID(), "FORTNOX", null, "INVOICE_SYNCED_TO_FORTNOX", "invoice", invoice.id, JSON.stringify({ fortnox_document_number: documentNumber })).run();
  return { providerDocumentNumber: documentNumber, reused: false, raw: result };
}

export async function syncPaymentToFortnox() {
  throw new Error("Direct Finance Core payment export to Fortnox is not implemented yet.");
}
