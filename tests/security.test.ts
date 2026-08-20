import { describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { workerEnv } from "./helpers";

describe("API health and Access middleware", () => {
  it("allows local development without Cloudflare Access", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/health"),
      workerEnv({ APP_ENV: "local" }),
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, env: "local" });
  });

  it("rejects deployed requests without Cloudflare Access identity headers", async () => {
    const response = await worker.fetch(
      new Request("https://finance-test.example/api/health"),
      workerEnv({ APP_ENV: "test" }),
      createExecutionContext()
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCESS_REQUIRED" });
  });

  it("allows deployed requests with Cloudflare Access identity headers", async () => {
    const request = new Request("https://finance-test.example/api/health", {
      headers: { "cf-access-authenticated-user-email": "tester@example.com" }
    });
    const response = await worker.fetch(request, workerEnv({ APP_ENV: "test" }), createExecutionContext());

    expect(response.status).toBe(200);
  });
});
