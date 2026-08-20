import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import { createPrice, createProduct, createSubscription } from "../src/core/finance";
import { createOrReuseStripeCustomer } from "../src/integrations/stripe/customers";
import { createPaymentMethodSetupIntent } from "../src/integrations/stripe/subscriptions";
import { processStripeEvent, recordIntegrationEvent } from "../src/integrations/stripe/webhooks";
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

  it("fails safely when Stripe webhook secret is not configured", async () => {
    const response = await worker.fetch(new Request("https://finance.example/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": "t=1787241600,v1=not-a-real-signature",
        "content-type": "application/json"
      },
      body: "{}"
    }), workerEnv({ APP_ENV: "test", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" } as any), {} as ExecutionContext);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "Stripe är inte konfigurerat ännu." });
  });

  it("reports Stripe as unconfigured without blocking the app", async () => {
    const response = await worker.fetch(
      new Request("https://finance.example/api/stripe/config", {
        headers: { "cf-access-authenticated-user-email": "tester@example.com" }
      }),
      workerEnv({ APP_ENV: "test", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" } as any),
      {} as ExecutionContext
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      message: "Stripe är inte konfigurerat ännu."
    });
  });

  it("claims concurrent deliveries so only one processor may continue", async () => {
    const event = {
      id: "evt_claim_race",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_claim_race", object: "payment_intent", metadata: {} } }
    };

    const claims = await Promise.all([
      recordIntegrationEvent(workerEnv(), event as any),
      recordIntegrationEvent(workerEnv(), event as any)
    ]);

    expect(claims.filter((claim) => !claim.duplicate)).toHaveLength(1);
    expect(claims.filter((claim) => claim.duplicate)).toHaveLength(1);
    const row = await env.DB.prepare("SELECT status FROM integration_events WHERE provider_event_id=?")
      .bind("evt_claim_race")
      .first<{ status: string }>();
    expect(row?.status).toBe("PROCESSING");
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

  it("creates one local SetupIntent session and retrieves the existing intent on retry without storing client_secret", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,stripe_customer_id) VALUES (?,?,?)")
      .bind("cus_test", "Acme AB", "cus_stripe_test")
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      return new Response(JSON.stringify({
        id: "seti_test_1",
        object: "setup_intent",
        client_secret: method === "POST" ? "seti_secret_created" : "seti_secret_retrieved",
        status: method === "POST" ? "requires_payment_method" : "requires_action"
      }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await createPaymentMethodSetupIntent(workerEnv({ STRIPE_SECRET_KEY: "test-placeholder" }), "cus_test");
    const second = await createPaymentMethodSetupIntent(workerEnv({ STRIPE_SECRET_KEY: "test-placeholder" }), "cus_test");

    expect(first.setup_session_id).toBe(second.setup_session_id);
    expect(second.reused).toBe(true);
    expect(second.client_secret).toBe("seti_secret_retrieved");
    const methods = fetchMock.mock.calls.map(([input, init]) => init?.method ?? (input instanceof Request ? input.method : "GET"));
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    expect(methods.filter((method) => method === "GET")).toHaveLength(1);

    const columns = await env.DB.prepare("PRAGMA table_info(payment_method_setup_sessions)").all<{ name: string }>();
    const session = await env.DB.prepare("SELECT * FROM payment_method_setup_sessions LIMIT 1").first<Record<string, unknown>>();
    const serializedLogs = JSON.stringify(await Promise.all([
      env.DB.prepare("SELECT * FROM audit_log").all(),
      env.DB.prepare("SELECT * FROM integration_events").all(),
      env.DB.prepare("SELECT * FROM sync_log").all()
    ]));
    expect(columns.results.map((column) => column.name)).not.toContain("client_secret");
    expect(JSON.stringify(session)).not.toContain("seti_secret");
    expect(serializedLogs).not.toContain("seti_secret");
    expect(session?.status).toBe("REQUIRES_ACTION");
  });

  it("reuses active SetupIntent sessions for requires_action and processing, but creates a new one after expiry", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,stripe_customer_id) VALUES (?,?,?)")
      .bind("cus_setup_reuse", "Acme AB", "cus_stripe_reuse")
      .run();
    await env.DB.prepare(
      `INSERT INTO payment_method_setup_sessions(id,customer_id,stripe_customer_id,stripe_setup_intent_id,status,expires_at)
       VALUES (?,?,?,?,?,?)`
    ).bind("pmsetup_action", "cus_setup_reuse", "cus_stripe_reuse", "seti_action", "REQUIRES_ACTION", "2099-01-01T00:00:00.000Z").run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const id = url.includes("seti_processing") ? "seti_processing" : method === "POST" ? "seti_created_after_expiry" : "seti_action";
      const status = id === "seti_processing" ? "processing" : id === "seti_action" ? "requires_action" : "requires_payment_method";
      return new Response(JSON.stringify({
        id,
        object: "setup_intent",
        client_secret: `${id}_secret`,
        status
      }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const action = await createPaymentMethodSetupIntent(workerEnv(), "cus_setup_reuse");
    expect(action).toMatchObject({ setup_session_id: "pmsetup_action", setup_intent_id: "seti_action", reused: true });

    await env.DB.prepare("UPDATE payment_method_setup_sessions SET status='PROCESSING', stripe_setup_intent_id=? WHERE id=?")
      .bind("seti_processing", "pmsetup_action")
      .run();
    const processing = await createPaymentMethodSetupIntent(workerEnv(), "cus_setup_reuse");
    expect(processing).toMatchObject({ setup_session_id: "pmsetup_action", setup_intent_id: "seti_processing", reused: true });

    await env.DB.prepare("UPDATE payment_method_setup_sessions SET expires_at=? WHERE id=?")
      .bind("2020-01-01T00:00:00.000Z", "pmsetup_action")
      .run();
    const fresh = await createPaymentMethodSetupIntent(workerEnv(), "cus_setup_reuse");
    expect(fresh.setup_session_id).not.toBe("pmsetup_action");
    expect(fresh).toMatchObject({ setup_intent_id: "seti_created_after_expiry", reused: false });
  });

  it("payment-method setup endpoint ensures Stripe Customer before creating SetupIntent", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email) VALUES (?,?,?)")
      .bind("cus_setup_page", "Acme AB", "buyer@example.com")
      .run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/v1/customers")
        ? { id: "cus_created_by_setup", object: "customer" }
        : {
            id: "seti_page",
            object: "setup_intent",
            client_secret: "seti_page_secret",
            status: "requires_payment_method"
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://finance.example/api/customers/cus_setup_page/payment-method/setup", {
      method: "POST"
    }), workerEnv(), {} as ExecutionContext);
    const body = await response.json<any>();
    const customer = await env.DB.prepare("SELECT stripe_customer_id FROM customers WHERE id=?")
      .bind("cus_setup_page")
      .first<{ stripe_customer_id: string }>();

    expect(response.status).toBe(200);
    expect(body.setup_intent_id).toBe("seti_page");
    expect(customer?.stripe_customer_id).toBe("cus_created_by_setup");
  });

  it("moves a failed PaymentIntent to succeeded on a later verified succeeded event and ignores a late failure", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_test", "Acme AB").run();

    await processStripeEvent(workerEnv(), {
      id: "evt_pi_failed_first",
      object: "event",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_lifecycle",
          object: "payment_intent",
          amount: 29500,
          amount_received: 0,
          currency: "sek",
          created: 1787241600,
          latest_charge: "ch_failed_first",
          metadata: { webblyftet_customer_id: "cus_test" }
        }
      }
    } as any);
    let payment = await env.DB.prepare("SELECT id,status FROM payments WHERE provider_payment_id=?")
      .bind("pi_lifecycle")
      .first<{ id: string; status: string }>();
    let accountingCount = await env.DB.prepare("SELECT COUNT(*) count FROM accounting_events").first<{ count: number }>();
    expect(payment?.status).toBe("FAILED");
    expect(accountingCount?.count).toBe(0);

    await processStripeEvent(workerEnv(), {
      id: "evt_pi_succeeded_later",
      object: "event",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_lifecycle",
          object: "payment_intent",
          amount: 29500,
          amount_received: 29500,
          currency: "sek",
          created: 1787241600,
          latest_charge: "ch_succeeded_later",
          metadata: { webblyftet_customer_id: "cus_test" }
        }
      }
    } as any);
    payment = await env.DB.prepare("SELECT id,status FROM payments WHERE provider_payment_id=?")
      .bind("pi_lifecycle")
      .first<{ id: string; status: string }>();
    accountingCount = await env.DB.prepare("SELECT COUNT(*) count FROM accounting_events").first<{ count: number }>();
    expect(payment?.status).toBe("SUCCEEDED");
    expect(accountingCount?.count).toBe(1);

    await processStripeEvent(workerEnv(), {
      id: "evt_pi_failed_late",
      object: "event",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_lifecycle",
          object: "payment_intent",
          amount: 29500,
          amount_received: 0,
          currency: "sek",
          created: 1787241600,
          latest_charge: "ch_failed_late",
          metadata: { webblyftet_customer_id: "cus_test" }
        }
      }
    } as any);
    payment = await env.DB.prepare("SELECT id,status FROM payments WHERE provider_payment_id=?")
      .bind("pi_lifecycle")
      .first<{ id: string; status: string }>();
    accountingCount = await env.DB.prepare("SELECT COUNT(*) count FROM accounting_events").first<{ count: number }>();
    expect(payment?.status).toBe("SUCCEEDED");
    expect(accountingCount?.count).toBe(1);
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
