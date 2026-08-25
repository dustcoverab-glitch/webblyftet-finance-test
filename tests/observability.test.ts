import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTables, workerEnv } from "./helpers";
import { emitOperationalAlert, operationalHealth } from "../src/lib/operations";
import { ResendEmailProvider } from "../src/integrations/email/provider";

describe("operational observability", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetTables();
  });

  it("stores provider failures with correlation IDs and redacted details", async () => {
    const env = workerEnv();
    await emitOperationalAlert(env, {
      event_type: "FORTNOX_SYNC_FAILED",
      severity: "ERROR",
      message: "Fortnox request failed",
      customer_id: "cus_123",
      invoice_id: "inv_123",
      provider: "FORTNOX",
      provider_event_id: "doc_123",
      details: {
        authorization: "Bearer secret-token",
        client_secret: "must-not-persist",
        safe: "kept"
      }
    });

    const row = await env.DB.prepare("SELECT * FROM operational_events WHERE event_type='FORTNOX_SYNC_FAILED'").first<any>();
    expect(row.customer_id).toBe("cus_123");
    expect(row.invoice_id).toBe("inv_123");
    expect(row.provider_event_id).toBe("doc_123");
    expect(row.details_json).not.toContain("secret-token");
    expect(row.details_json).not.toContain("must-not-persist");
    expect(row.details_json).toContain("kept");
  });

  it("dedupes repeated provider errors instead of flooding unresolved events", async () => {
    const env = workerEnv();
    for (let i = 0; i < 2; i += 1) {
      await emitOperationalAlert(env, {
        event_type: "STRIPE_WEBHOOK_ERROR",
        severity: "ERROR",
        message: "Stripe webhook failed",
        provider: "STRIPE",
        provider_event_id: "evt_repeat",
        dedupe_key: "stripe:evt_repeat",
        details: { attempt: i + 1 }
      });
    }

    const rows = await env.DB.prepare("SELECT * FROM operational_events WHERE dedupe_key='stripe:evt_repeat'").all<any>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].occurrence_count).toBe(2);
  });

  it("records Resend provider failure as EMAIL_SEND_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "validation_error", message: "Bearer resend-secret rejected" }), { status: 403 })
    );
    const env = workerEnv();
    const provider = new ResendEmailProvider(env);

    await expect(provider.send({
      to: "customer@example.test",
      subject: "Din offert",
      html: "<p>Hej</p>",
      text: "Hej",
      type: "OFFER",
      idempotencyKey: "email-test"
    })).rejects.toThrow("validation_error");

    const event = await env.DB.prepare("SELECT * FROM operational_events WHERE event_type='EMAIL_SEND_FAILED'").first<any>();
    expect(event.severity).toBe("ERROR");
    expect(event.provider).toBe("RESEND");
    expect(event.details_json).toContain("customer@example.test");
    expect(event.details_json).not.toContain("resend-secret");
  });

  it("provides a compact operational health read model", async () => {
    const env = workerEnv();
    await emitOperationalAlert(env, {
      event_type: "STRIPE_PAYMENT_FAILED",
      severity: "ERROR",
      message: "Stripe payment failed",
      provider: "STRIPE",
      subscription_id: "sub_123"
    });

    const health = await operationalHealth(env);
    expect(health.latest.unresolved_recent_errors).toBe(1);
    expect(health.open[0]).toMatchObject({ event_type: "STRIPE_PAYMENT_FAILED", subscription_id: "sub_123" });
  });
});
