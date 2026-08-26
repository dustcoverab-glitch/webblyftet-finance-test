import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContractFlowFromHandoff, simulatedContractFlowHandoff } from "../src/core/contract-flow";
import { createPrice, createProduct } from "../src/core/finance";
import { PublicAppError } from "../src/lib/app-error";
import { sendContractFlowOfferEmail } from "../src/integrations/email/offers";
import { ResendEmailProvider } from "../src/integrations/email/provider";
import { processResendWebhook } from "../src/integrations/email/webhooks";
import { sendInvoiceEmail } from "../src/integrations/email/invoices";
import { sendCustomerOrderConfirmationEmail } from "../src/integrations/email/confirmations";
import { createCustomerOrderSession, reconcileCustomerOrderCompletion } from "../src/core/customer-order";
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

  it("reconciles delivered webhooks without moving state backwards", async () => {
    const emailId = await seededOutboundEmail("resend_msg_delivered", "SENT");

    const result = await processResendWebhook(workerEnv(), payload("email.delivered", "resend_msg_delivered"), await svixHeaders("evt_delivered_1", payload("email.delivered", "resend_msg_delivered")));
    await processResendWebhook(workerEnv(), payload("email.sent", "resend_msg_delivered"), await svixHeaders("evt_sent_late_1", payload("email.sent", "resend_msg_delivered")));

    expect(result).toMatchObject({ processed: true, matched: true, status: "DELIVERED" });
    const stored = await env.DB.prepare("SELECT status,delivered_at,last_provider_event_type FROM outbound_email_events WHERE id=?").bind(emailId).first<any>();
    expect(stored.status).toBe("DELIVERED");
    expect(stored.delivered_at).toBeTruthy();
    expect(stored.last_provider_event_type).toBe("email.sent");
  });

  it("marks bounce and complaint outcomes explicitly", async () => {
    await seededOutboundEmail("resend_msg_bounce", "SENT");
    await seededOutboundEmail("resend_msg_complaint", "DELIVERED");

    await processResendWebhook(workerEnv(), payload("email.bounced", "resend_msg_bounce"), await svixHeaders("evt_bounce_1", payload("email.bounced", "resend_msg_bounce")));
    await processResendWebhook(workerEnv(), payload("email.complained", "resend_msg_complaint"), await svixHeaders("evt_complaint_1", payload("email.complained", "resend_msg_complaint")));

    const rows = await env.DB.prepare("SELECT provider_message_id,status FROM outbound_email_events ORDER BY provider_message_id").all<any>();
    expect(rows.results).toEqual([
      expect.objectContaining({ provider_message_id: "resend_msg_bounce", status: "BOUNCED" }),
      expect.objectContaining({ provider_message_id: "resend_msg_complaint", status: "COMPLAINED" })
    ]);
    const alerts = await env.DB.prepare("SELECT event_type, COUNT(*) count FROM operational_events GROUP BY event_type ORDER BY event_type").all<any>();
    expect(alerts.results.map((row) => row.event_type)).toContain("EMAIL_BOUNCED");
    expect(alerts.results.map((row) => row.event_type)).toContain("EMAIL_COMPLAINED");
  });

  it("dedupes webhook replay by provider event id", async () => {
    await seededOutboundEmail("resend_msg_replay", "SENT");
    const body = payload("email.delivered", "resend_msg_replay");
    const headers = await svixHeaders("evt_replay_1", body);

    await processResendWebhook(workerEnv(), body, headers);
    const replay = await processResendWebhook(workerEnv(), body, headers);

    expect(replay).toMatchObject({ duplicate: true });
    const events = await env.DB.prepare("SELECT COUNT(*) count FROM email_provider_events").first<{ count: number }>();
    expect(events?.count).toBe(1);
  });

  it("rejects invalid Resend signatures before state mutation", async () => {
    await seededOutboundEmail("resend_msg_invalid", "SENT");

    await expect(processResendWebhook(workerEnv(), payload("email.delivered", "resend_msg_invalid"), {
      id: "evt_invalid",
      timestamp: String(Math.floor(Date.now() / 1000)),
      signature: "v1,broken"
    })).rejects.toThrow(/signatur/);

    const stored = await env.DB.prepare("SELECT status FROM outbound_email_events WHERE provider_message_id='resend_msg_invalid'").first<any>();
    const providerEvents = await env.DB.prepare("SELECT COUNT(*) count FROM email_provider_events").first<{ count: number }>();
    expect(stored.status).toBe("SENT");
    expect(providerEvents?.count).toBe(0);
  });

  it("sends invoice emails through the provider and supports manual resend", async () => {
    const invoiceId = await seededInvoice();
    const provider = { provider: "RESEND" as const, send: vi.fn()
      .mockResolvedValueOnce({ provider: "RESEND", provider_message_id: "invoice_msg_1" })
      .mockResolvedValueOnce({ provider: "RESEND", provider_message_id: "invoice_msg_2" }) };

    const first = await sendInvoiceEmail(workerEnv(), invoiceId, { provider });
    const reused = await sendInvoiceEmail(workerEnv(), invoiceId, { provider });
    const resent = await sendInvoiceEmail(workerEnv(), invoiceId, { provider, manual: true });

    expect(first.email_event.status).toBe("SENT");
    expect(reused.reused).toBe(true);
    expect(resent.email_event.provider_message_id).toBe("invoice_msg_2");
    expect(provider.send).toHaveBeenCalledTimes(2);
    const tokens = await env.DB.prepare("SELECT COUNT(*) count FROM invoice_document_tokens WHERE invoice_id=?").bind(invoiceId).first<{ count: number }>();
    expect(tokens?.count).toBe(1);
  });

  it("records invoice email failure without removing the invoice", async () => {
    const invoiceId = await seededInvoice();
    const provider = { provider: "RESEND" as const, send: vi.fn().mockRejectedValue(new PublicAppError(503, "provider unavailable")) };

    const result = await sendInvoiceEmail(workerEnv(), invoiceId, { provider });

    expect(result.email_event.status).toBe("FAILED");
    const invoice = await env.DB.prepare("SELECT id FROM invoices WHERE id=?").bind(invoiceId).first<any>();
    expect(invoice.id).toBe(invoiceId);
  });

  it("sends one automatic confirmation per completed customer order", async () => {
    const invoiceId = await seededInvoice();
    const order = await env.DB.prepare("SELECT sales_order_id FROM invoices WHERE id=?").bind(invoiceId).first<any>();
    const session = await createCustomerOrderSession(workerEnv(), order.sales_order_id);
    await env.DB.prepare(
      "UPDATE customer_order_sessions SET status='SIGNED', signed_at=CURRENT_TIMESTAMP, signer_name='Kund', signer_email='buyer@example.test' WHERE id=?"
    ).bind(session.id).run();
    const provider = { provider: "RESEND" as const, send: vi.fn().mockResolvedValue({ provider: "RESEND", provider_message_id: "confirmation_msg_1" }) };

    await sendCustomerOrderConfirmationEmail(workerEnv(), session.id, { provider });
    await sendCustomerOrderConfirmationEmail(workerEnv(), session.id, { provider });

    expect(provider.send).toHaveBeenCalledOnce();
    const emails = await env.DB.prepare("SELECT COUNT(*) count FROM outbound_email_events WHERE email_type='CONFIRMATION' AND delivery_trigger='AUTO'").first<{ count: number }>();
    expect(emails?.count).toBe(1);
  });

  it("does not create another automatic confirmation when completion reconcile is replayed", async () => {
    const invoiceId = await seededInvoice();
    const order = await env.DB.prepare("SELECT sales_order_id FROM invoices WHERE id=?").bind(invoiceId).first<any>();
    const session = await createCustomerOrderSession(workerEnv(), order.sales_order_id);
    await env.DB.prepare("UPDATE customer_order_sessions SET status='SIGNED', signed_at=CURRENT_TIMESTAMP, signer_name='Kund', signer_email='buyer@example.test' WHERE id=?").bind(session.id).run();

    await reconcileCustomerOrderCompletion(workerEnv({ ENABLE_EMAIL_AUTOSEND: "true", RESEND_API_KEY: "" } as any), session.id);
    await reconcileCustomerOrderCompletion(workerEnv({ ENABLE_EMAIL_AUTOSEND: "true", RESEND_API_KEY: "" } as any), session.id);

    const emails = await env.DB.prepare("SELECT COUNT(*) count FROM outbound_email_events WHERE email_type='CONFIRMATION' AND delivery_trigger='AUTO'").first<{ count: number }>();
    expect(emails?.count).toBe(1);
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

function payload(type: string, emailId: string) {
  return JSON.stringify({ type, created_at: "2026-08-26T10:00:00.000Z", data: { email_id: emailId } });
}

async function svixHeaders(id: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = "webhook_test_secret";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return {
    id,
    timestamp,
    signature: `v1,${bytesToBase64(new Uint8Array(signature))}`
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function seededOutboundEmail(providerMessageId: string, status: string) {
  const emailId = `email_${providerMessageId}`;
  await env.DB.prepare(
    `INSERT INTO outbound_email_events(id,recipient,email_type,provider,provider_message_id,status,subject)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(emailId, "buyer@example.test", "OFFER", "RESEND", providerMessageId, status, "Test").run();
  return emailId;
}

async function seededInvoice() {
  await env.DB.prepare("INSERT OR IGNORE INTO customers(id,name,email) VALUES (?,?,?)")
    .bind("cus_email_invoice", "Mailkund AB", "buyer@example.test").run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO offers(id,customer_id,title,offer_date,subtotal,vat_total,total)
     VALUES (?,?,?,?,?,?,?)`
  ).bind("off_email_invoice", "cus_email_invoice", "Mailoffert", "2026-08-26", 1000, 250, 1250).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO offer_versions(id,offer_id,version_number,snapshot_json,subtotal,vat_total,total)
     VALUES (?,?,?,?,?,?,?)`
  ).bind("ov_email_invoice", "off_email_invoice", 1, JSON.stringify({ rows: [] }), 100000, 25000, 125000).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sales_orders(id,offer_id,offer_version_id,customer_id,status,one_time_total_minor,recurring_monthly_minor)
     VALUES (?,?,?,?,?,?,?)`
  ).bind("sord_email_invoice", "off_email_invoice", "ov_email_invoice", "cus_email_invoice", "READY", 125000, 0).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO invoices(id,customer_id,source_offer_id,sales_order_id,invoice_number,invoice_type,status,invoice_date,due_date,currency,subtotal,vat_total,total,balance,subtotal_minor,vat_total_minor,total_minor,balance_minor)
     VALUES (?,?,?,?,?,'PROJECT_INVOICE','DRAFT','2026-08-26','2026-09-25','SEK',?,?,?,?,?,?,?,?)`
  ).bind("inv_email_invoice", "cus_email_invoice", "off_email_invoice", "sord_email_invoice", "TEST-00099", 1000, 250, 1250, 1250, 100000, 25000, 125000, 125000).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO invoice_rows(id,invoice_id,sort_order,description,quantity,unit,unit_price,vat_percent,unit_price_minor,billing_type)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind("irow_email_invoice", "inv_email_invoice", 0, "Webblyftet Bas", 1, "st", 1000, 25, 100000, "ONE_TIME").run();
  return "inv_email_invoice";
}
