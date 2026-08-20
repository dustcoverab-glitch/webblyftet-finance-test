import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import { createOrReuseStripeCustomer } from "../src/integrations/stripe/customers";
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
});
