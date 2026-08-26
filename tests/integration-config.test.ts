import { describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { createAuthUrl } from "../src/integrations/fortnox/client";
import { isStripeConfigured, isStripePublishableKeyConfigured, validateProductionGuards } from "../src/lib/config";
import { workerEnv } from "./helpers";

describe("optional external integration configuration", () => {
  it("reports Fortnox as unconfigured without blocking integration status", async () => {
    const response = await worker.fetch(
      new Request("https://finance.example/api/integration/status", {
        headers: { "x-test-user-email": "admin@example.test" }
      }),
      workerEnv({ APP_ENV: "local", FORTNOX_CLIENT_ID: "", FORTNOX_CLIENT_SECRET: "" } as any),
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      connected: false
    });
  });

  it("returns a controlled Fortnox error when OAuth starts before credentials exist", async () => {
    await expect(createAuthUrl(workerEnv({
      FORTNOX_CLIENT_ID: "",
      FORTNOX_CLIENT_SECRET: ""
    } as any))).rejects.toThrow("Fortnox är inte konfigurerat ännu.");
  });

  it("rejects Stripe live keys in test environment", () => {
    expect(() => isStripeConfigured(workerEnv({
      APP_ENV: "test",
      STRIPE_SECRET_KEY: "sk_live_accidental"
    } as any))).toThrow("Stripe live-nyckel får inte användas i testmiljön.");

    expect(() => isStripePublishableKeyConfigured(workerEnv({
      APP_ENV: "test",
      STRIPE_PUBLISHABLE_KEY: "pk_live_accidental"
    } as any))).toThrow("Stripe live publishable key får inte användas i testmiljön.");
  });

  it("fails closed on obvious demo/test production configuration", () => {
    expect(() => validateProductionGuards(workerEnv({
      APP_ENV: "production",
      APP_BASE_URL: "https://webblyftet-finance.example",
      STRIPE_SECRET_KEY: "sk_test_accidental",
      STRIPE_PUBLISHABLE_KEY: "pk_test_accidental",
      EMAIL_FROM: "onboarding@resend.dev",
      WEBBLYFTET_LEGAL_NAME: "Webblyftet Finance Test AB (demo)",
      WEBBLYFTET_ORG_NUMBER: "559999-0000",
      WEBBLYFTET_VAT_NUMBER: "SE559999000001",
      WEBBLYFTET_ADDRESS1: "Testgatan 1",
      WEBBLYFTET_BANKGIRO: "000-0000 (test)"
    } as any))).toThrow(/Production config blockerad/);
  });
});
