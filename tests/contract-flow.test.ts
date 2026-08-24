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

    await expect(updateContractFlowDraft(workerEnv(), flow!.id, {
      company: { name: "Ändrad AB" },
      contact: { name: "Köpare", email: "buyer@example.test" },
      items: [{ price_id: prices.projectPriceId, quantity: 1, description: "Ny rad" }]
    })).rejects.toThrow(/Kundlänk är redan skapad/);

    const session = await env.DB.prepare("SELECT signing_snapshot_json FROM customer_order_sessions WHERE id=?")
      .bind(linked!.customer_order_session_id)
      .first<{ signing_snapshot_json: string }>();
    expect(JSON.parse(session!.signing_snapshot_json).rows).toHaveLength(2);
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
      new Request("https://finance-test.example/customer-order/not-real/session"),
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
