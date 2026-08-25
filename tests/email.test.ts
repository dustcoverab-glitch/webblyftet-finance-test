import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContractFlowFromHandoff, simulatedContractFlowHandoff } from "../src/core/contract-flow";
import { createPrice, createProduct } from "../src/core/finance";
import { PublicAppError } from "../src/lib/app-error";
import { sendContractFlowOfferEmail } from "../src/integrations/email/offers";
import { ResendEmailProvider } from "../src/integrations/email/provider";
import { resetTables, workerEnv } from "./helpers";
import mainSource from "../src/main.tsx?raw";

describe("Resend offer email delivery", () => {
  beforeEach(async () => {
    await resetTables();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks an offer email SENT only after provider acceptance", async () => {
    const flow = await contractFlow();
    const provider = { provider: "RESEND" as const, send: vi.fn().mockResolvedValue({ provider: "RESEND", provider_message_id: "email_accepted_1" }) };

    const result = await sendContractFlowOfferEmail(workerEnv(), flow.id, { provider });

    expect(provider.send).toHaveBeenCalledOnce();
    expect(result.email_event.status).toBe("SENT");
    expect(result.email_event.provider_message_id).toBe("email_accepted_1");
    expect(result.customer_order_url).toContain("/customer-order/");
    const stored = await env.DB.prepare("SELECT COUNT(*) count FROM outbound_email_events WHERE status='SENT'").first<{ count: number }>();
    expect(stored?.count).toBe(1);
  });

  it("marks an offer email FAILED when the provider rejects it", async () => {
    const flow = await contractFlow();
    const provider = { provider: "RESEND" as const, send: vi.fn().mockRejectedValue(new PublicAppError(403, "validation_error: domain is not verified")) };

    await expect(sendContractFlowOfferEmail(workerEnv(), flow.id, { provider })).rejects.toThrow(/domain is not verified/);

    const stored = await env.DB.prepare("SELECT status,failure_code,failure_message,provider_message_id FROM outbound_email_events").first<any>();
    expect(stored.status).toBe("FAILED");
    expect(stored.failure_code).toBe("validation_error");
    expect(stored.failure_message).toContain("domain is not verified");
    expect(stored.provider_message_id).toBeNull();
  });

  it("fails closed when Resend is not configured", async () => {
    const flow = await contractFlow();
    await expect(sendContractFlowOfferEmail(workerEnv({ RESEND_API_KEY: "" } as any), flow.id)).rejects.toThrow(/E-post är inte konfigurerat/);
    const stored = await env.DB.prepare("SELECT COUNT(*) count FROM outbound_email_events").first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it("does not call provider for invalid email", async () => {
    const flow = await contractFlow({ contact: { name: "Köpare", email: "not-an-email" } });
    const provider = { provider: "RESEND" as const, send: vi.fn() };

    await expect(sendContractFlowOfferEmail(workerEnv(), flow.id, { provider })).rejects.toThrow(/e-postadress är inte giltig/);

    expect(provider.send).not.toHaveBeenCalled();
  });

  it("creates a new email event on resend without creating another customer session", async () => {
    const flow = await contractFlow();
    const provider = { provider: "RESEND" as const, send: vi.fn()
      .mockResolvedValueOnce({ provider: "RESEND", provider_message_id: "email_1" })
      .mockResolvedValueOnce({ provider: "RESEND", provider_message_id: "email_2" }) };

    await sendContractFlowOfferEmail(workerEnv(), flow.id, { provider });
    await sendContractFlowOfferEmail(workerEnv(), flow.id, { provider });

    const events = await env.DB.prepare("SELECT provider_message_id,status FROM outbound_email_events ORDER BY created_at").all<any>();
    expect(events.results.map((event) => event.provider_message_id).sort()).toEqual(["email_1", "email_2"]);
    const sessions = await env.DB.prepare("SELECT COUNT(*) count FROM customer_order_sessions").first<{ count: number }>();
    expect(sessions?.count).toBe(1);
  });

  it("does not base the seller UI sent state on customer session existence", () => {
    expect(mainSource).toContain("Boolean(latestSentOfferEmail)");
    expect(mainSource).not.toContain("[\"Offert skickad\", Boolean(flow.customer_order_session_id)]");
  });
});

describe("ResendEmailProvider", () => {
  beforeEach(async () => {
    await resetTables();
    vi.unstubAllGlobals();
  });

  it("calls the Resend HTTPS API without logging secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "Authorization": "Bearer test-resend-key",
        "Content-Type": "application/json",
        "Idempotency-Key": "email_test"
      });
      return Response.json({ id: "resend_msg_1" });
    }));

    const result = await new ResendEmailProvider(workerEnv()).send({
      to: "buyer@example.test",
      subject: "Test",
      html: "<p>Hej</p>",
      text: "Hej",
      type: "OFFER",
      idempotencyKey: "email_test"
    });

    expect(result.provider_message_id).toBe("resend_msg_1");
    const log = await env.DB.prepare("SELECT request_json,response_json FROM sync_log WHERE entity_type='EMAIL'").first<any>();
    expect(log.request_json).toContain("buyer@example.test");
    expect(log.request_json).not.toContain("test-resend-key");
    expect(log.response_json).toContain("resend_msg_1");
  });
});

async function contractFlow(overrides: Partial<ReturnType<typeof simulatedContractFlowHandoff>> = {}) {
  const prices = await seedContractProducts();
  return createContractFlowFromHandoff(workerEnv(), {
    ...simulatedContractFlowHandoff(),
    ...overrides,
    items: [
      { price_id: prices.projectPriceId, quantity: 1, description: "Webblyftet Bas" },
      { price_id: prices.servicePriceId, quantity: 1, description: "Webblyftet Service" }
    ]
  }) as Promise<any>;
}

async function seedContractProducts() {
  const project = await createProduct(workerEnv(), { name: "Webblyftet Bas", product_type: "ONE_TIME" });
  const projectPrice = await createPrice(workerEnv(), { product_id: project!.id, amount: 799500, billing_type: "ONE_TIME" });
  const service = await createProduct(workerEnv(), { name: "Webblyftet Service", product_type: "SUBSCRIPTION" });
  const servicePrice = await createPrice(workerEnv(), { product_id: service!.id, amount: 29500, billing_type: "RECURRING", billing_interval: "MONTH" });
  return { projectPriceId: projectPrice!.id, servicePriceId: servicePrice!.id };
}
