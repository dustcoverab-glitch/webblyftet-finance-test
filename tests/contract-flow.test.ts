import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import {
  createContractFlowCustomerLink,
  createContractFlowFromHandoff,
  getContractFlow,
  simulatedContractFlowHandoff,
  updateContractFlowDraft
} from "../src/core/contract-flow";
import { signCustomerOrder } from "../src/core/customer-order";
import { sendContractFlowOfferEmail } from "../src/integrations/email/offers";
import { createPrice, createProduct } from "../src/core/finance";
import { resetTables, workerEnv } from "./helpers";

describe("Contract flow handoff", () => {
  beforeEach(async () => {
    await resetTables();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a seller workflow from the handoff contract and matches existing customers by org number", async () => {
    const prices = await seedContractProducts();
    await env.DB.prepare("INSERT INTO customers(id,name,org_number,email) VALUES (?,?,?,?)")
      .bind("cus_existing_contract", "Anderssons Bygg AB", "559900-1234", "old@example.test")
      .run();

    const flow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      items: [
        { price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" },
        { price_id: prices.servicePriceId, quantity: 1, description: "Webblyftet Service" }
      ]
    });

    expect(flow?.customer_id).toBe("cus_existing_contract");
    expect(flow?.status).toBe("DRAFT");
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE entity_id=? ORDER BY created_at").bind(flow!.id).all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toContain("CONTRACT_FLOW_CREATED");
    expect(audit.results.map((row) => row.action)).toContain("CUSTOMER_MATCHED");
  });

  it("blocks customer link creation until required customer and row information is complete", async () => {
    const flow = await createContractFlowFromHandoff(workerEnv(), {
      source: "MANUAL",
      company: { name: "Saknar Mail AB" },
      contact: { name: "Köpare", email: "" },
      items: []
    });

    expect(flow?.status).toBe("CUSTOMER_INCOMPLETE");
    await expect(createContractFlowCustomerLink(workerEnv(), flow!.id)).rejects.toThrow(/uppgifter behöver kompletteras/);

    const prices = await seedContractProducts();
    const ready = await updateContractFlowDraft(workerEnv(), flow!.id, {
      company: { name: "Saknar Mail AB" },
      contact: { name: "Köpare", email: "buyer@example.test" },
      items: [{ price_id: prices.servicePriceId, quantity: 1, description: "Service" }]
    });
    expect(ready?.status).toBe("READY");
  });

  it("freezes a signing package through the verified customer-order implementation", async () => {
    const prices = await seedContractProducts();
    const flow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      items: [
        { price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" },
        { price_id: prices.servicePriceId, quantity: 1, description: "Webblyftet Service" }
      ]
    });

    const linked = await createContractFlowCustomerLink(workerEnv(), flow!.id);
    expect(linked?.status).toBe("CUSTOMER_LINK_CREATED");
    expect(linked?.sales_order_id).toMatch(/^sord_/);
    expect(linked?.customer_order_session_id).toMatch(/^cord_/);
    expect((linked as any).customer_order_url).toContain("/customer-order/");
    const order = await env.DB.prepare("SELECT status,acceptance_id FROM sales_orders WHERE id=?")
      .bind(linked!.sales_order_id)
      .first<any>();
    const offer = await env.DB.prepare("SELECT status,accepted_at FROM offers WHERE id=?")
      .bind(linked!.order.offer_id)
      .first<any>();
    expect(order).toMatchObject({ status: "PREPARED", acceptance_id: null });
    expect(offer).toMatchObject({ status: "READY", accepted_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM offer_acceptances").first<{ count: number }>()).toMatchObject({ count: 0 });

    await expect(updateContractFlowDraft(workerEnv(), flow!.id, {
      company: { name: "Ändrad AB" },
      contact: { name: "Köpare", email: "buyer@example.test" },
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Ny rad" }]
    })).rejects.toThrow(/Kundlänk är redan skapad/);

    const session = await env.DB.prepare("SELECT signing_snapshot_json FROM customer_order_sessions WHERE id=?")
      .bind(linked!.customer_order_session_id)
      .first<{ signing_snapshot_json: string }>();
    const snapshot = JSON.parse(session!.signing_snapshot_json);
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[0].unit_price_minor).toBe(799500);
    expect(snapshot.rows[1].unit_price_minor).toBe(29500);
    expect(snapshot.totals.one_time_total_minor).toBe(999375);
    expect(snapshot.totals.recurring_monthly_total_minor).toBe(36875);
  });

  it("does not accept an offer when a customer link is created, emailed, or opened", async () => {
    const prices = await seedContractProducts();
    const flow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      items: [
        { price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" },
        { price_id: prices.servicePriceId, quantity: 1, description: "Webblyftet Service" }
      ]
    });
    const linked = await createContractFlowCustomerLink(workerEnv(), flow!.id);
    await sendContractFlowOfferEmail(workerEnv(), flow!.id, {
      provider: { provider: "RESEND", send: async () => ({ provider: "RESEND", provider_message_id: "email_contract_semantics" }) }
    });
    const token = String((linked as any).customer_order_url).split("/customer-order/")[1];
    const opened = await worker.fetch(
      new Request(`https://finance-test.example/customer-order/${token}/session`),
      workerEnv(),
      createExecutionContext()
    );
    expect(opened.status).toBe(200);

    const [offer, order, acceptance, currentFlow] = await Promise.all([
      env.DB.prepare("SELECT status,accepted_at FROM offers").first<any>(),
      env.DB.prepare("SELECT status,acceptance_id FROM sales_orders").first<any>(),
      env.DB.prepare("SELECT COUNT(*) count FROM offer_acceptances").first<{ count: number }>(),
      getContractFlow(workerEnv(), flow!.id)
    ]);
    expect(offer).toMatchObject({ status: "SENT", accepted_at: null });
    expect(order).toMatchObject({ status: "PREPARED", acceptance_id: null });
    expect(acceptance?.count).toBe(0);
    expect(currentFlow?.status).toBe("OFFER_SENT");
  });

  it("accepts only after customer signing and then confirms the sales order", async () => {
    const prices = await seedContractProducts();
    const flow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      items: [
        { price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" },
        { price_id: prices.servicePriceId, quantity: 1, description: "Webblyftet Service" }
      ]
    });
    const linked = await createContractFlowCustomerLink(workerEnv(), flow!.id);
    const token = String((linked as any).customer_order_url).split("/customer-order/")[1];

    await signCustomerOrder(workerEnv(), token, {
      signer_name: "Anders Andersson",
      signer_email: "anders@example.com",
      ip_address: "127.0.0.1",
      user_agent: "vitest"
    });

    const [offer, order, session, acceptance, currentFlow] = await Promise.all([
      env.DB.prepare("SELECT status,accepted_by_email,accepted_at FROM offers").first<any>(),
      env.DB.prepare("SELECT status,acceptance_id FROM sales_orders").first<any>(),
      env.DB.prepare("SELECT status,signed_at,document_hash,signing_snapshot_json FROM customer_order_sessions").first<any>(),
      env.DB.prepare("SELECT accepted_by_email,snapshot_hash FROM offer_acceptances").first<any>(),
      getContractFlow(workerEnv(), flow!.id)
    ]);
    expect(offer.status).toBe("ACCEPTED");
    expect(offer.accepted_at).toBeTruthy();
    expect(order.status).toBe("READY");
    expect(order.acceptance_id).toMatch(/^oacc_/);
    expect(session.status).toBe("SIGNED");
    expect(session.signed_at).toBeTruthy();
    expect(session.document_hash).toBeTruthy();
    expect(JSON.parse(session.signing_snapshot_json).offer.terms_version).toBeTruthy();
    expect(acceptance.accepted_by_email).toBe("anders@example.com");
    expect(acceptance.snapshot_hash).toBeTruthy();
    expect(currentFlow?.status).toBe("SALES_ORDER_CONFIRMED");
  });

  it("keeps customer-order snapshots immutable when seller creates a new version in a new flow", async () => {
    const prices = await seedContractProducts();
    const firstFlow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      source_customer_id: "version-demo",
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" }]
    });
    const firstLink = await createContractFlowCustomerLink(workerEnv(), firstFlow!.id);
    const firstToken = String((firstLink as any).customer_order_url).split("/customer-order/")[1];

    const secondFlow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      source_customer_id: "version-demo",
      items: [{ price_id: prices.projectPriceId, quantity: 2, description: "Webblyftet Bas x2" }]
    });
    const secondLink = await createContractFlowCustomerLink(workerEnv(), secondFlow!.id);

    await signCustomerOrder(workerEnv(), firstToken, { signer_name: "Old Buyer", signer_email: "old@example.test" });

    const firstSession = await env.DB.prepare("SELECT signing_snapshot_json FROM customer_order_sessions WHERE id=?")
      .bind(firstLink!.customer_order_session_id)
      .first<any>();
    const secondSession = await env.DB.prepare("SELECT signing_snapshot_json FROM customer_order_sessions WHERE id=?")
      .bind(secondLink!.customer_order_session_id)
      .first<any>();
    expect(JSON.parse(firstSession.signing_snapshot_json).rows[0].quantity).toBe(1);
    expect(JSON.parse(secondSession.signing_snapshot_json).rows[0].quantity).toBe(2);
    const acceptedOrder = await env.DB.prepare("SELECT offer_version_id FROM sales_orders WHERE id=?").bind(firstLink!.sales_order_id).first<any>();
    const newOrder = await env.DB.prepare("SELECT acceptance_id,offer_version_id FROM sales_orders WHERE id=?").bind(secondLink!.sales_order_id).first<any>();
    expect(newOrder.acceptance_id).toBeNull();
    expect(acceptedOrder.offer_version_id).not.toBe(newOrder.offer_version_id);
  });

  it("keeps repeated contract-flow reads side-effect free", async () => {
    const prices = await seedContractProducts();
    const flow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" }]
    });
    await createContractFlowCustomerLink(workerEnv(), flow!.id);
    const before = await env.DB.prepare("SELECT status,updated_at FROM contract_flows WHERE id=?").bind(flow!.id).first<any>();
    const auditBefore = await env.DB.prepare("SELECT COUNT(*) count FROM audit_log").first<{ count: number }>();
    await getContractFlow(workerEnv(), flow!.id);
    await getContractFlow(workerEnv(), flow!.id);
    const after = await env.DB.prepare("SELECT status,updated_at FROM contract_flows WHERE id=?").bind(flow!.id).first<any>();
    const auditAfter = await env.DB.prepare("SELECT COUNT(*) count FROM audit_log").first<{ count: number }>();
    expect(after).toEqual(before);
    expect(auditAfter?.count).toBe(auditBefore?.count);
  });

  it("reuses customers by normalized org number and email fallback", async () => {
    const prices = await seedContractProducts();
    const byOrg = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      source_customer_id: null,
      company: { ...simulatedContractFlowHandoff().company, org_number: "559900-1234" },
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Bas" }]
    });
    const byOrgVariant = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      source_customer_id: null,
      company: { ...simulatedContractFlowHandoff().company, org_number: " 559900 1234 " },
      contact: { ...simulatedContractFlowHandoff().contact, email: "other@example.test" },
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Bas" }]
    });
    await Promise.all([
      createContractFlowCustomerLink(workerEnv(), byOrg!.id),
      createContractFlowCustomerLink(workerEnv(), byOrgVariant!.id)
    ]);

    const byEmail = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      source_customer_id: null,
      company: { ...simulatedContractFlowHandoff().company, name: "Email Match AB", org_number: "" },
      contact: { ...simulatedContractFlowHandoff().contact, email: " BUYER@EXAMPLE.TEST " },
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Bas" }]
    });
    const byEmailVariant = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      source_customer_id: null,
      company: { ...simulatedContractFlowHandoff().company, name: "Email Match Again AB", org_number: "" },
      contact: { ...simulatedContractFlowHandoff().contact, email: "buyer@example.test" },
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Bas" }]
    });
    await createContractFlowCustomerLink(workerEnv(), byEmail!.id);
    await createContractFlowCustomerLink(workerEnv(), byEmailVariant!.id);

    const customers = await env.DB.prepare("SELECT COUNT(*) count FROM customers").first<{ count: number }>();
    const flows = await env.DB.prepare("SELECT customer_id FROM contract_flows ORDER BY created_at").all<any>();
    expect(customers?.count).toBe(2);
    expect(flows.results[0].customer_id).toBe(flows.results[1].customer_id);
    expect(flows.results[2].customer_id).toBe(flows.results[3].customer_id);
  });

  it("reuses the existing customer-order session when customer link creation is retried", async () => {
    const prices = await seedContractProducts();
    const flow = await createContractFlowFromHandoff(workerEnv(), {
      ...simulatedContractFlowHandoff(),
      items: [
        { price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" },
        { price_id: prices.servicePriceId, quantity: 1, description: "Webblyftet Service" }
      ]
    });

    const first = await createContractFlowCustomerLink(workerEnv(), flow!.id);
    const second = await createContractFlowCustomerLink(workerEnv(), flow!.id);

    expect(first?.customer_order_session_id).toBe(second?.customer_order_session_id);
    expect((first as any).customer_order_url).toContain("/customer-order/");
    expect((second as any).customer_order_url).toBeUndefined();
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS count FROM customer_order_sessions WHERE sales_order_id=?")
      .bind(first!.sales_order_id)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(1);
  });

  it("keeps contract-flow routes internal while customer-order remains public", async () => {
    const protectedResponse = await worker.fetch(
      new Request("https://finance-test.example/contract-flow/new"),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(protectedResponse.status).toBe(403);

    const apiResponse = await worker.fetch(
      new Request("https://finance-test.example/api/contract-flows"),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(apiResponse.status).toBe(403);

    const publicPrefixResponse = await worker.fetch(
      new Request("https://finance-test.example/customer-order/not-real-token-123456789/session"),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(publicPrefixResponse.status).toBe(404);
  });
});

async function seedContractProducts() {
  const project = await createProduct(workerEnv(), { name: "Webblyftet Bas", product_type: "ONE_TIME" });
  const projectPrice = await createPrice(workerEnv(), { product_id: project!.id, amount: 799500, billing_type: "ONE_TIME" });
  const service = await createProduct(workerEnv(), { name: "Webblyftet Service", product_type: "SUBSCRIPTION" });
  const servicePrice = await createPrice(workerEnv(), { product_id: service!.id, amount: 29500, billing_type: "RECURRING", billing_interval: "MONTH" });
  return { projectPriceId: projectPrice!.id, servicePriceId: servicePrice!.id };
}
