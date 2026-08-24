import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import { acceptOfferToken, createOffer, createOfferAcceptanceToken } from "../src/core/business-flow";
import {
  activateCustomerOrder,
  confirmCustomerOrderPaymentMethod,
  createCustomerOrderSession,
  createCustomerOrderSetupIntent,
  getCustomerOrderSessionForToken,
  markCustomerOrderReviewed,
  signCustomerOrder
} from "../src/core/customer-order";
import { createPrice, createProduct } from "../src/core/finance";
import { resetTables, workerEnv } from "./helpers";

describe("Customer order onboarding", () => {
  beforeEach(async () => {
    await resetTables();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates high-entropy hash-at-rest links and rejects expired tokens", async () => {
    const order = await seedAcceptedOrder();
    const link = await createCustomerOrderSession(workerEnv(), order.id);
    expect(link.url).toContain("/customer-order/");

    const token = link.url.split("/customer-order/")[1];
    expect(token.length).toBeGreaterThanOrEqual(43);
    const row = await env.DB.prepare("SELECT token_hash FROM customer_order_sessions WHERE id=?").bind(link.id).first<{ token_hash: string }>();
    expect(row?.token_hash).toBeTruthy();
    expect(row?.token_hash).not.toContain(token);

    const payload = await getCustomerOrderSessionForToken(workerEnv(), token);
    expect(payload.snapshot.order.id).toBe(order.id);

    await env.DB.prepare("UPDATE customer_order_sessions SET expires_at=? WHERE id=?")
      .bind("2020-01-01T00:00:00.000Z", link.id)
      .run();
    await expect(getCustomerOrderSessionForToken(workerEnv(), token)).rejects.toThrow(/ogiltig|gått ut/i);
  });

  it("keeps the signed order snapshot immutable even if the sales order rows change later", async () => {
    const order = await seedAcceptedOrder();
    const link = await createCustomerOrderSession(workerEnv(), order.id);
    const token = link.url.split("/customer-order/")[1];
    const first = await getCustomerOrderSessionForToken(workerEnv(), token);
    await env.DB.prepare("UPDATE sales_order_items SET description=? WHERE sales_order_id=?")
      .bind("Ändrad efter länk", order.id)
      .run();
    const second = await getCustomerOrderSessionForToken(workerEnv(), token);
    expect(second.document_hash).toBe(first.document_hash);
    expect(second.snapshot.rows[0].description).toBe(first.snapshot.rows[0].description);
  });

  it("tracks review and basic acceptance signing with audit evidence", async () => {
    const order = await seedAcceptedOrder();
    const link = await createCustomerOrderSession(workerEnv(), order.id);
    const token = link.url.split("/customer-order/")[1];
    const reviewed = await markCustomerOrderReviewed(workerEnv(), token);
    expect(reviewed.status).toBe("REVIEWED");
    const signed = await signCustomerOrder(workerEnv(), token, {
      signer_name: "Kund Signerare",
      signer_email: "buyer@example.com",
      ip_address: "203.0.113.5",
      user_agent: "vitest"
    });
    expect(signed.status).toBe("SIGNED");
    expect(signed.signer_name).toBe("Kund Signerare");
    const session = await env.DB.prepare("SELECT signing_provider,evidence_reference FROM customer_order_sessions WHERE id=?")
      .bind(link.id)
      .first<{ signing_provider: string; evidence_reference: string }>();
    expect(session?.signing_provider).toBe("BASIC_ACCEPTANCE");
    expect(session?.evidence_reference).toContain("basic-acceptance");
  });

  it("requires signing and verified Stripe payment method before recurring activation", async () => {
    const order = await seedAcceptedOrder();
    const link = await createCustomerOrderSession(workerEnv(), order.id);
    const token = link.url.split("/customer-order/")[1];
    await expect(createCustomerOrderSetupIntent(workerEnv(), token)).rejects.toThrow(/signeras/);
    await signCustomerOrder(workerEnv(), token, { signer_name: "Kund", signer_email: "buyer@example.com" });

    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const body = url.includes("/v1/customers")
        ? { id: "cus_stripe_customer_order", object: "customer" }
        : url.includes("/v1/setup_intents/seti_customer_order")
          ? {
              id: "seti_customer_order",
              object: "setup_intent",
              status: "succeeded",
              client_secret: "seti_secret_redacted",
              payment_method: {
                id: "pm_customer_order",
                object: "payment_method",
                type: "card",
                card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }
              }
            }
          : {
              id: "seti_customer_order",
              object: "setup_intent",
              status: "requires_payment_method",
              client_secret: "seti_secret_redacted"
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const setup = await createCustomerOrderSetupIntent(workerEnv(), token);
    expect(setup).toMatchObject({ setup_intent_id: "seti_customer_order" });
    const confirmed = await confirmCustomerOrderPaymentMethod(workerEnv(), token);
    expect(confirmed.payment_method).toMatchObject({ brand: "visa", last4: "4242" });
    expect(calls.some((url) => url.includes("/v1/setup_intents/seti_customer_order"))).toBe(true);
  });

  it("completes one-time-only orders without touching Stripe subscription activation", async () => {
    const order = await seedAcceptedOrder({ recurring: false });
    const link = await createCustomerOrderSession(workerEnv(), order.id);
    const token = link.url.split("/customer-order/")[1];
    await signCustomerOrder(workerEnv(), token, { signer_name: "Kund", signer_email: "buyer@example.com" });
    const completed = await activateCustomerOrder(workerEnv(), token);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.requirements.payment_method_required).toBe(false);
  });

  it("allows only the exact customer-order public prefix without opening api routes", async () => {
    const order = await seedAcceptedOrder();
    const link = await createCustomerOrderSession(workerEnv(), order.id);
    const token = link.url.split("/customer-order/")[1];
    const publicResponse = await worker.fetch(
      new Request(`https://finance-test.example/customer-order/${token}/session`),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(publicResponse.status).toBe(200);

    for (const path of ["/customer-order-test", "/api/dashboard"]) {
      const protectedResponse = await worker.fetch(
        new Request(`https://finance-test.example${path}`),
        workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
        createExecutionContext()
      );
      expect(protectedResponse.status).toBe(403);
    }
  });
});

async function seedAcceptedOrder(options: { recurring?: boolean } = {}) {
  await env.DB.prepare("INSERT INTO customers(id,name,email) VALUES (?,?,?)")
    .bind("cus_customer_order", "Webblyftet E2E Test AB", "buyer@example.com")
    .run();
  const project = await createProduct(workerEnv(), { name: "Projekt", product_type: "ONE_TIME" });
  const projectPrice = await createPrice(workerEnv(), { product_id: project!.id, amount: 100000, billing_type: "ONE_TIME" });
  const rows: any[] = [{ price_id: projectPrice!.id, quantity: 1 }];
  if (options.recurring !== false) {
    const service = await createProduct(workerEnv(), { name: "Service", product_type: "SUBSCRIPTION" });
    const servicePrice = await createPrice(workerEnv(), { product_id: service!.id, amount: 25000, billing_type: "RECURRING", billing_interval: "MONTH" });
    rows.push({ price_id: servicePrice!.id, quantity: 1 });
  }
  const offer = await createOffer(workerEnv(), {
    customer_id: "cus_customer_order",
    title: "Customer order onboarding",
    offer_date: "2026-08-24",
    rows
  });
  const link = await createOfferAcceptanceToken(workerEnv(), offer!.id);
  return acceptOfferToken(workerEnv(), {
    token: link.token,
    accepted_by_name: "Intern accept",
    accepted_by_email: "seller@example.com"
  }) as Promise<any>;
}
