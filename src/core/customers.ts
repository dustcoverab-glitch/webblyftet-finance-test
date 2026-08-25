import { audit } from "./finance";
import { id, one } from "../lib/db";

export type CustomerMatchInput = {
  source?: string | null;
  source_customer_id?: string | null;
  name?: string | null;
  org_number?: string | null;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  zip?: string | null;
  city?: string | null;
};

export function normalizeOrgNumber(value?: string | null): string | null {
  const normalized = String(value ?? "").trim().replace(/[\s-]+/g, "").toUpperCase();
  return normalized || null;
}

export function normalizeEmail(value?: string | null): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

export async function findMatchingCustomer(env: Env, input: CustomerMatchInput) {
  if (input.source && input.source_customer_id) {
    const bySource = await one<any>(
      env.DB,
      `SELECT c.*
       FROM contract_flows f
       JOIN customers c ON c.id=f.customer_id
       WHERE f.source=? AND f.source_customer_id=? AND f.customer_id IS NOT NULL
       ORDER BY f.created_at DESC LIMIT 1`,
      input.source,
      input.source_customer_id
    );
    if (bySource) return { customer: bySource, strategy: "source_customer_id" as const };
  }

  const normalizedOrg = normalizeOrgNumber(input.org_number);
  if (normalizedOrg) {
    const byOrg = await one<any>(
      env.DB,
      "SELECT * FROM customers WHERE REPLACE(REPLACE(UPPER(TRIM(COALESCE(org_number,''))), '-', ''), ' ', '')=? ORDER BY updated_at DESC LIMIT 1",
      normalizedOrg
    );
    if (byOrg) return { customer: byOrg, strategy: "org_number" as const };
  }

  const normalizedEmail = normalizeEmail(input.email);
  if (normalizedEmail) {
    const byEmail = await one<any>(
      env.DB,
      "SELECT * FROM customers WHERE LOWER(TRIM(COALESCE(email,'')))=? ORDER BY updated_at DESC LIMIT 1",
      normalizedEmail
    );
    if (byEmail) return { customer: byEmail, strategy: "email" as const };
  }

  return { customer: null, strategy: null };
}

export async function createOrReuseCustomer(env: Env, input: CustomerMatchInput) {
  const normalized = {
    org_number: normalizeOrgNumber(input.org_number),
    email: normalizeEmail(input.email)
  };
  const matched = await findMatchingCustomer(env, input);
  if (matched.customer) return { customer: matched.customer, strategy: matched.strategy, created: false };

  const customerId = id("cus");
  const insert = await env.DB.prepare(
    `INSERT INTO customers(id,name,org_number,email,phone,address1,zip,city,sync_status)
     SELECT ?,?,?,?,?,?,?,?,'LOCAL_ONLY'
     WHERE NOT EXISTS (
       SELECT 1 FROM customers
       WHERE (? IS NOT NULL AND REPLACE(REPLACE(UPPER(TRIM(COALESCE(org_number,''))), '-', ''), ' ', '')=?)
          OR (? IS NOT NULL AND LOWER(TRIM(COALESCE(email,'')))=?)
     )`
  ).bind(
    customerId,
    String(input.name ?? "").trim(),
    normalized.org_number,
    normalized.email,
    input.phone ? String(input.phone).trim() : null,
    input.address1 ? String(input.address1).trim() : null,
    input.zip ? String(input.zip).trim() : null,
    input.city ? String(input.city).trim() : null,
    normalized.org_number,
    normalized.org_number,
    normalized.email,
    normalized.email
  ).run();

  if ((insert.meta.changes ?? 0) === 1) {
    const created = await one<any>(env.DB, "SELECT * FROM customers WHERE id=?", customerId);
    await audit(env, "SYSTEM", null, "CUSTOMER_CREATED", "customer", customerId, null, {
      org_number: normalized.org_number,
      email: normalized.email
    });
    return { customer: created, strategy: "created" as const, created: true };
  }

  const afterRace = await findMatchingCustomer(env, { ...input, org_number: normalized.org_number, email: normalized.email });
  return { customer: afterRace.customer, strategy: afterRace.strategy ?? "race_reuse", created: false };
}
