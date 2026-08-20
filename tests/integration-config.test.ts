import { describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { createAuthUrl } from "../src/integrations/fortnox/client";
import { workerEnv } from "./helpers";

describe("optional external integration configuration", () => {
  it("reports Fortnox as unconfigured without blocking integration status", async () => {
    const response = await worker.fetch(
      new Request("https://finance.example/api/integration/status", {
        headers: { "cf-access-authenticated-user-email": "tester@example.com" }
      }),
      workerEnv({ APP_ENV: "test", FORTNOX_CLIENT_ID: "", FORTNOX_CLIENT_SECRET: "" } as any),
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
});
