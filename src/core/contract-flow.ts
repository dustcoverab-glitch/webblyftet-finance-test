import { acceptOfferToken, createOffer, createOfferAcceptanceToken, type OfferInputRow } from "./business-flow";
import { audit } from "./finance";
import { createCustomerOrderSession } from "./customer-order";
import { PublicAppError } from "../lib/app-error";
import { id, one } from "../lib/db";

export type ContractFlowStatus =
  | "DRAFT"
  | "CUSTOMER_INCOMPLETE"
  | "READY"
  | "CUSTOMER_LINK_CREATED"
  | "CUSTOMER_OPENED"
  | "SIGNED"
  | "PAYMENT_METHOD_ADDED"
  | "ACTIVATING"
  | "COMPLETED"
  | "CANCELLED";

export type ContractFlowHandoff = {
  source: "WEBBLYFTET_PORTAL" | "MANUAL";
  source_customer_id?: string | null;
  seller?: {
    id?: string | null;
    name?: string | null;
  } | null;
  meeting?: {
    id?: string | null;
    notes?: string | null;
  } | null;
  company: {
    name?: string | null;
    org_number?: string | null;
    address1?: string | null;
    zip?: string | null;
    city?: string | null;
  };
  contact: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  items: Array<OfferInputRow & {
    source?: "PRODUCT_PRICE" | "FREE_ROW";
  }>;
};

type ContractFlowDraft = {
  company: ContractFlowHandoff["company"];
  contact: ContractFlowHandoff["contact"];
  items: ContractFlowHandoff["items"];
};

function clean(value?: string | null) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

function flowStatusFromSession(session?: any | null): ContractFlowStatus | null {
  if (!session) return null;
  const status = String(session.status ?? "").toUpperCase();
  if (status === "COMPLETED") return "COMPLETED";
  if (session.payment_method_id || status === "PAYMENT_METHOD_READY") return "PAYMENT_METHOD_ADDED";
  if (session.signed_at || status === "SIGNED") return "SIGNED";
  if (session.opened_at) return "CUSTOMER_OPENED";
  return "CUSTOMER_LINK_CREATED";
}

function validateDraft(draft: ContractFlowDraft) {
  const missing: Array<{ field: string; label: string }> = [];
  if (!clean(draft.company.name)) missing.push({ field: "company.name", label: "Företagsnamn" });
  if (!clean(draft.contact.name)) missing.push({ field: "contact.name", label: "Kontaktperson" });
  if (!clean(draft.contact.email)) missing.push({ field: "contact.email", label: "E-post" });
  if (!draft.items?.length) missing.push({ field: "items", label: "Minst en orderrad" });
  return missing;
}

async function matchCustomer(env: Env, payload: ContractFlowHandoff) {
  if (payload.source_customer_id) {
    const bySource = await one<any>(
      env.DB,
      "SELECT c.* FROM contract_flows f JOIN customers c ON c.id=f.customer_id WHERE f.source=? AND f.source_customer_id=? AND f.customer_id IS NOT NULL ORDER BY f.created_at DESC LIMIT 1",
      payload.source,
      payload.source_customer_id
    );
    if (bySource) return { customer: bySource, strategy: "source_customer_id" };
  }
  const orgNumber = clean(payload.company.org_number);
  if (orgNumber) {
    const byOrg = await one<any>(env.DB, "SELECT * FROM customers WHERE org_number=? ORDER BY updated_at DESC LIMIT 1", orgNumber);
    if (byOrg) return { customer: byOrg, strategy: "org_number" };
  }
  return { customer: null, strategy: null };
}

export function simulatedContractFlowHandoff(): ContractFlowHandoff {
  return {
    source: "MANUAL",
    source_customer_id: "demo-meet-anderssons-bygg",
    seller: { id: "seller-demo", name: "Herman Wisen" },
    meeting: {
      id: `meet-demo-${new Date().toISOString().slice(0, 10)}`,
      notes: "Kunden sade ja under säljmötet. Demo av avtalskedja."
    },
    company: {
      name: "Anderssons Bygg AB",
      org_number: "559900-1234",
      address1: "Byggvägen 12",
      zip: "582 22",
      city: "Linköping"
    },
    contact: {
      name: "Anders Andersson",
      email: "anders@example.com",
      phone: "0701234567"
    },
    items: [
      {
        price_id: "price_877c853b-5466-4731-940d-9d3247497c01",
        description: "Webblyftet Bas",
        quantity: 1,
        discount_percent: 0,
        vat_percent: 25,
        source: "PRODUCT_PRICE"
      },
      {
        price_id: "price_1b736b4b-376b-42ac-b00b-49a1485cf200",
        description: "Webblyftet Service",
        quantity: 1,
        discount_percent: 0,
        vat_percent: 25,
        source: "PRODUCT_PRICE"
      }
    ]
  };
}

export async function createContractFlowFromHandoff(env: Env, payload: ContractFlowHandoff) {
  if (env.APP_ENV === "production" && payload.source === "MANUAL") {
    throw new PublicAppError(403, "Simulerad avtalskedja får inte skapas i production.");
  }
  const matched = await matchCustomer(env, payload);
  const draft: ContractFlowDraft = {
    company: payload.company,
    contact: payload.contact,
    items: payload.items ?? []
  };
  const flowId = id("cflow");
  const missing = validateDraft(draft);
  const status: ContractFlowStatus = missing.length ? "CUSTOMER_INCOMPLETE" : "DRAFT";
  await env.DB.prepare(
    `INSERT INTO contract_flows
      (id,customer_id,source,source_customer_id,seller_name,seller_id,meeting_id,status,notes,handoff_json,draft_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    flowId,
    matched.customer?.id ?? null,
    payload.source,
    clean(payload.source_customer_id),
    clean(payload.seller?.name),
    clean(payload.seller?.id),
    clean(payload.meeting?.id),
    status,
    clean(payload.meeting?.notes),
    JSON.stringify(payload),
    JSON.stringify(draft)
  ).run();
  await audit(env, "SYSTEM", null, "CONTRACT_FLOW_CREATED", "contract_flow", flowId, null, { source: payload.source, source_customer_id: payload.source_customer_id ?? null });
  if (matched.customer) {
    await audit(env, "SYSTEM", null, "CUSTOMER_MATCHED", "contract_flow", flowId, null, { customer_id: matched.customer.id, strategy: matched.strategy });
  }
  return getContractFlow(env, flowId);
}

export async function listContractFlows(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT f.*, c.name customer_name
     FROM contract_flows f
     LEFT JOIN customers c ON c.id=f.customer_id
     ORDER BY f.created_at DESC
     LIMIT 50`
  ).all<any>();
  return rows.results;
}

export async function getContractFlow(env: Env, flowId: string) {
  const flow = await one<any>(
    env.DB,
    `SELECT f.*, c.name customer_name, c.org_number customer_org_number, c.email customer_email
     FROM contract_flows f
     LEFT JOIN customers c ON c.id=f.customer_id
     WHERE f.id=?`,
    flowId
  );
  if (!flow) return null;
  const draft = JSON.parse(flow.draft_json) as ContractFlowDraft;
  const handoff = JSON.parse(flow.handoff_json) as ContractFlowHandoff;
  const [order, session, invoices, subscriptions, payments, events, emailEvents, auditRows] = await Promise.all([
    flow.sales_order_id ? one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", flow.sales_order_id) : null,
    flow.customer_order_session_id ? one<any>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", flow.customer_order_session_id) : null,
    flow.sales_order_id ? env.DB.prepare("SELECT * FROM invoices WHERE sales_order_id=? ORDER BY created_at").bind(flow.sales_order_id).all<any>() : Promise.resolve({ results: [] }),
    flow.sales_order_id ? env.DB.prepare("SELECT * FROM subscriptions WHERE sales_order_id=? ORDER BY created_at").bind(flow.sales_order_id).all<any>() : Promise.resolve({ results: [] }),
    flow.sales_order_id ? env.DB.prepare("SELECT * FROM payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE sales_order_id=?) ORDER BY created_at DESC").bind(flow.sales_order_id).all<any>() : Promise.resolve({ results: [] }),
    flow.sales_order_id ? env.DB.prepare("SELECT * FROM accounting_events WHERE entity_id IN (SELECT id FROM payments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE sales_order_id=?)) ORDER BY created_at DESC").bind(flow.sales_order_id).all<any>() : Promise.resolve({ results: [] }),
    env.DB.prepare("SELECT * FROM outbound_email_events WHERE contract_flow_id=? ORDER BY created_at DESC LIMIT 20").bind(flowId).all<any>(),
    env.DB.prepare("SELECT * FROM audit_log WHERE entity_id=? OR metadata_json LIKE ? ORDER BY created_at DESC LIMIT 20").bind(flowId, `%${flowId}%`).all<any>()
  ]);
  const derivedStatus = flowStatusFromSession(session);
  if (derivedStatus && derivedStatus !== flow.status) {
    await env.DB.prepare(
      "UPDATE contract_flows SET status=?, completed_at=CASE WHEN ?='COMPLETED' THEN COALESCE(completed_at,CURRENT_TIMESTAMP) ELSE completed_at END, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(derivedStatus, derivedStatus, flowId).run();
    flow.status = derivedStatus;
    if (derivedStatus === "COMPLETED") {
      await audit(env, "SYSTEM", null, "CONTRACT_FLOW_COMPLETED", "contract_flow", flowId, null, { customer_order_session_id: flow.customer_order_session_id });
    }
  }
  return {
    ...flow,
    draft,
    handoff,
    missing: validateDraft(draft),
    order,
    customer_order_session: session,
    invoices: invoices.results,
    subscriptions: subscriptions.results,
    payments: payments.results,
    accounting_events: events.results,
    email_events: emailEvents.results,
    audit: auditRows.results
  };
}

export async function updateContractFlowDraft(env: Env, flowId: string, draft: ContractFlowDraft) {
  const flow = await one<any>(env.DB, "SELECT * FROM contract_flows WHERE id=?", flowId);
  if (!flow) throw new PublicAppError(404, "Avtalskedjan saknas.");
  if (flow.customer_order_session_id) throw new PublicAppError(409, "Kundlänk är redan skapad. Skapa en ny avtalsversion för ändringar.");
  const merged = { ...JSON.parse(flow.draft_json), ...draft };
  const missing = validateDraft(merged);
  await env.DB.prepare(
    "UPDATE contract_flows SET draft_json=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(JSON.stringify(merged), missing.length ? "CUSTOMER_INCOMPLETE" : "READY", flowId).run();
  if (!missing.length) await audit(env, "SYSTEM", null, "CONTRACT_FLOW_READY", "contract_flow", flowId, null, {});
  return getContractFlow(env, flowId);
}

async function ensureCustomerForFlow(env: Env, flow: any, draft: ContractFlowDraft) {
  if (flow.customer_id) {
    await env.DB.prepare(
      `UPDATE customers SET name=?, org_number=?, email=?, phone=?, address1=?, zip=?, city=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(
      clean(draft.company.name),
      clean(draft.company.org_number),
      clean(draft.contact.email),
      clean(draft.contact.phone),
      clean(draft.company.address1),
      clean(draft.company.zip),
      clean(draft.company.city),
      flow.customer_id
    ).run();
    await audit(env, "SYSTEM", null, "CUSTOMER_COMPLETED", "customer", flow.customer_id, null, { contract_flow_id: flow.id });
    return flow.customer_id;
  }
  const matched = await matchCustomer(env, { ...JSON.parse(flow.handoff_json), company: draft.company, contact: draft.contact, items: draft.items });
  if (matched.customer) return matched.customer.id;
  const customerId = id("cus");
  await env.DB.prepare(
    `INSERT INTO customers(id,name,org_number,email,phone,address1,zip,city,sync_status)
     VALUES (?,?,?,?,?,?,?,?,'LOCAL_ONLY')`
  ).bind(
    customerId,
    clean(draft.company.name),
    clean(draft.company.org_number),
    clean(draft.contact.email),
    clean(draft.contact.phone),
    clean(draft.company.address1),
    clean(draft.company.zip),
    clean(draft.company.city)
  ).run();
  await audit(env, "SYSTEM", null, "CUSTOMER_COMPLETED", "customer", customerId, null, { contract_flow_id: flow.id });
  return customerId;
}

export async function createContractFlowCustomerLink(env: Env, flowId: string) {
  const flow = await one<any>(env.DB, "SELECT * FROM contract_flows WHERE id=?", flowId);
  if (!flow) throw new PublicAppError(404, "Avtalskedjan saknas.");
  if (flow.customer_order_session_id) {
    const session = await one<any>(env.DB, "SELECT * FROM customer_order_sessions WHERE id=?", flow.customer_order_session_id);
    if (!session) throw new PublicAppError(409, "Kopplad kundsession saknas.");
    return getContractFlow(env, flowId);
  }
  const draft = JSON.parse(flow.draft_json) as ContractFlowDraft;
  const missing = validateDraft(draft);
  if (missing.length) throw new PublicAppError(400, `${missing.length} uppgifter behöver kompletteras.`);
  const customerId = await ensureCustomerForFlow(env, flow, draft);
  const offer = await createOffer(env, {
    customer_id: customerId,
    title: `Avtal ${draft.company.name ?? ""}`.trim(),
    offer_date: today(),
    expire_date: plusDays(14),
    remarks: flow.notes ?? "",
    rows: draft.items
  });
  if (!offer) throw new PublicAppError(500, "Offert kunde inte skapas.");
  const token = await createOfferAcceptanceToken(env, offer.id);
  const order = await acceptOfferToken(env, {
    token: token.token,
    accepted_by_name: clean(draft.contact.name) ?? "Säljare",
    accepted_by_email: clean(draft.contact.email) ?? "",
    ip_address: "contract-flow",
    user_agent: "contract-flow"
  });
  const session = await createCustomerOrderSession(env, order.id);
  await env.DB.prepare(
    `UPDATE contract_flows
     SET customer_id=?, sales_order_id=?, customer_order_session_id=?, status='CUSTOMER_LINK_CREATED', updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).bind(customerId, order.id, session.id, flowId).run();
  await audit(env, "SYSTEM", null, "CUSTOMER_LINK_CREATED", "contract_flow", flowId, null, {
    customer_id: customerId,
    sales_order_id: order.id,
    customer_order_session_id: session.id
  });
  const detail = await getContractFlow(env, flowId);
  return { ...detail, customer_order_url: session.url };
}
