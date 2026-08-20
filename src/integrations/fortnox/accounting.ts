import { fortnoxRequest } from "./client";

export async function pullSupplierInvoicesFromFortnox(env: Env) {
  const result = await fortnoxRequest<any>(env, "/supplierinvoices?limit=500", { method: "GET" });
  return result.SupplierInvoices ?? [];
}

export async function pullVouchersFromFortnox(env: Env, year: string, series: string) {
  const result = await fortnoxRequest<any>(
    env,
    `/vouchers/sublist/${encodeURIComponent(series)}?financialyear=${encodeURIComponent(year)}&limit=500`,
    { method: "GET" }
  );
  return result.Vouchers ?? [];
}
