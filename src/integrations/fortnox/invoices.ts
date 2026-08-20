import { fortnoxRequest } from "./client";

export async function pullInvoicesFromFortnox(env: Env) {
  const result = await fortnoxRequest<any>(env, "/invoices?limit=500", { method: "GET" });
  return result.Invoices ?? [];
}

export async function syncInvoiceToFortnox() {
  throw new Error("Direct Finance Core invoice export to Fortnox is not implemented yet.");
}

export async function syncPaymentToFortnox() {
  throw new Error("Direct Finance Core payment export to Fortnox is not implemented yet.");
}
