import { fortnoxRequest } from "./client";
import type { FortnoxCustomerPayload } from "./types";

export type FinanceCustomerForFortnox = {
  name: string;
  org_number?: string | null;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
};

export function toFortnoxCustomerPayload(customer: FinanceCustomerForFortnox): FortnoxCustomerPayload {
  return {
    Customer: {
      Name: customer.name,
      OrganisationNumber: customer.org_number || undefined,
      Email: customer.email || undefined,
      Phone1: customer.phone || undefined,
      Address1: customer.address1 || undefined,
      ZipCode: customer.zip || undefined,
      City: customer.city || undefined,
      CountryCode: customer.country || "SE"
    }
  };
}

export async function syncCustomerToFortnox(env: Env, customer: FinanceCustomerForFortnox) {
  const result = await fortnoxRequest<any>(env, "/customers", {
    method: "POST",
    json: toFortnoxCustomerPayload(customer)
  });
  return {
    providerCustomerNumber: result.Customer?.CustomerNumber ?? null,
    raw: result
  };
}

export async function pullCustomersFromFortnox(env: Env) {
  const result = await fortnoxRequest<any>(env, "/customers?limit=500", { method: "GET" });
  return (result.Customers ?? []).map((item: any) => ({
    providerCustomerNumber: item.CustomerNumber,
    name: item.Name ?? "",
    orgNumber: item.OrganisationNumber ?? "",
    email: item.Email ?? "",
    phone: item.Phone1 ?? "",
    address1: item.Address1 ?? "",
    zip: item.ZipCode ?? "",
    city: item.City ?? ""
  }));
}
