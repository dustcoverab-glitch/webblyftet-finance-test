import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import { createPrice, createProduct, createSubscription } from "../src/core/finance";
import { createOrReuseStripeCustomer } from "../src/integrations/stripe/customers";
import { createPaymentMethodSetupIntent } from "../src/integrations/stripe/subscriptions";
import { processStripeEvent } from "../src/integrations/stripe/webhooks";
import { resetTables, workerEnv } from "./helpers";

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Stripe integration foundation", () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses existing Stripe Customer without creating a duplicate", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email,stripe_customer_id) VALUES (?,?,?,?)")
      .bind("cus_test", "Acme AB", "finance@example.com", "cus_stripe_existing")
      .run();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await createOrReuseStripeCustomer(workerEnv(), "cus_test");

    expect(result).toEqual({ stripe_customer_id: "cus_stripe_existing", reused: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("verifies Stripe webhook signatures and records events once", async () => {
    const event = {
      id: "evt_test_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test_1",
          object: "payment_intent",
          amount: 29500,
          amount_received: 29500,
          currency: "sek",
          created: 1787241600,
          metadata: {}
        }
      }
    };
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex("test-webhook-secret", `${timestamp}.${raw}`);
    const response = await worker.fetch(new Request("https://finance.example/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": `t=${timestamp},v1=${signature}`,
        "content-type": "application/json"
      },
      body: raw
    }), workerEnv({ APP_ENV: "test", STRIPE_WEBHOOK_SECRET: "test-webhook-secret" }), {} as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ received: true, duplicate: false });

    const duplicate = await processStripeEvent(workerEnv(), event as any);
    expect(duplicate).toMatchObject({ received: true, duplicate: true });
  });

  it("marks failed webhook processing as FAILED, retries it, then treats processed duplicates as no-op", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_test", "Acme AB").run();
    await env.DB.prepare("DROP TABLE accounting_events").run();
    const event = {
      id: "evt_retry_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_retry_1",
          object: "payment_intent",
          amount: 29500,
          amount_received: 29500,
          currency: "sek",
          created: 1787241600,
          latest_charge: "ch_retry_1",
          metadata: { webblyftet_customer_id: "cus_test" }
        }
      }
    };

    await expect(processStripeEvent(workerEnv(), event as any)).rejects.toThrow();
    const failed = await env.DB.prepare("SELECT status FROM integration_events WHERE provider_event_id=?").bind("evt_retry_1").first<{ status: string }>();
    expect(failed?.status).toBe("FAILED");

    await env.DB.prepare(
      `CREATE TABLE accounting_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        currency TEXT NOT NULL,
        net_amount INTEGER NOT NULL,
        vat_amount INTEGER NOT NULL,
        gross_amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();
    await env.DB.prepare(
      "CREATE UNIQUE INDEX idx_accounting_events_unique ON accounting_events(event_type, entity_type, entity_id)"
    ).run();

    await expect(processStripeEvent(workerEnv(), event as any)).resolves.toMatchObject({ received: true, duplicate: false });
    const processed = await env.DB.prepare("SELECT status FROM integration_events WHERE provider_event_id=?").bind("evt_retry_1").first<{ status: string }>();
    const duplicate = await processStripeEvent(workerEnv(), event as any);
    const accounting = await env.DB.prepare("SELECT payload_json FROM accounting_events LIMIT 1").first<{ payload_json: string }>();
    expect(processed?.status).toBe("PROCESSED");
    expect(duplicate).toMatchObject({ received: true, duplicate: true });
    expect(JSON.parse(accounting!.payload_json)).toMatchObject({ accounting_semantics: "SETTLEMENT" });
  });

  it("creates one local SetupIntent session and reuses it on retry", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,stripe_customer_id) VALUES (?,?,?)")
      .bind("cus_test", "Acme AB", "cus_stripe_test")
      .run();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "seti_test_1",
      object: "setup_intent",
      client_secret: "seti_secret_1",
      status: "requires_payment_method"
    }), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_test" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await createPaymentMethodSetupIntent(workerEnv({ STRIPE_SECRET_KEY: "test-placeholder" }), "cus_test");
    const second = await createPaymentMethodSetupIntent(workerEnv({ STRIPE_SECRET_KEY: "test-placeholder" }), "cus_test");

    expect(first.setup_session_id).toBe(second.setup_session_id);
    expect(second.reused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("syncs Stripe subscription status only for a known local subscription", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_test", "Acme AB").run();
    const product = await createProduct(workerEnv(), { name: "Service", product_type: "SUBSCRIPTION" });
    const price = await createPrice(workerEnv(), { product_id: product!.id, amount: 29500, billing_type: "RECURRING", billing_interval: "MONTH" });
    const subscription = await createSubscription(workerEnv(), {
      customer_id: "cus_test",
      start_date: "2026-08-20",
      items: [{ product_id: product!.id, price_id: price!.id, quantity: 1 }]
    });

    await processStripeEvent(workerEnv(), {
      id: "evt_subscription_sync",
      object: "event",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_stripe_1",
          object: "subscription",
          status: "active",
          current_period_start: 1787241600,
          current_period_end: 1789920000,
          cancel_at_period_end: false,
          metadata: { webblyftet_subscription_id: subscription!.id }
        }
      }
    } as any);

    await processStripeEvent(workerEnv(), {
      id: "evt_subscription_unknown",
      object: "event",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_stripe_unknown",
          object: "subscription",
          status: "active",
          metadata: {}
        }
      }
    } as any);

    const row = await env.DB.prepare("SELECT stripe_subscription_id,status,current_period_start,current_period_end FROM subscriptions WHERE id=?")
      .bind(subscription!.id)
      .first<any>();
    const count = await env.DB.prepare("SELECT COUNT(*) count FROM subscriptions").first<{ count: number }>();

    expect(row).toMatchObject({
      stripe_subscription_id: "sub_stripe_1",
      status: "ACTIVE",
      current_period_start: "2026-08-20T16:00:00.000Z",
      current_period_end: "2026-09-20T16:00:00.000Z"
    });
    expect(count?.count).toBe(1);
  });
});
