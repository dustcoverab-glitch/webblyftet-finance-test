import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { resetTables, workerEnv } from "./helpers";
import { hasPermission, roleForEmail, rolePermissions, userFromEmail } from "../src/lib/authorization";

function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("x-test-user-email", headers.get("x-test-user-email") ?? "admin@example.test");
  return new Request(`https://finance-test.example${path}`, { ...options, headers });
}

describe("authorization roles and permissions", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("keeps role mapping central and env-driven", () => {
    const env = workerEnv();
    expect(roleForEmail(env, "ADMIN@example.test")).toBe("ADMIN");
    expect(roleForEmail(env, "finance@example.test")).toBe("FINANCE");
    expect(roleForEmail(env, "seller@example.test")).toBe("SELLER");
    expect(roleForEmail(env, "reader@example.test")).toBe("READ_ONLY");
    expect(roleForEmail(env, "unknown@example.test")).toBe("READ_ONLY");
    expect(rolePermissions.ADMIN).toContain("admin.manage");
    expect(rolePermissions.SELLER).not.toContain("fortnox.disconnect");
  });

  it("rejects unauthenticated internal requests before authorization", async () => {
    const response = await worker.fetch(
      new Request("https://finance-test.example/api/customers"),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCESS_REQUIRED" });
  });

  it("allows seller actions but denies finance/admin actions", async () => {
    const sellerEnv = workerEnv({ APP_ENV: "local" });
    const allowed = await worker.fetch(
      request("/api/contract-flows/simulate", {
        method: "POST",
        headers: { "x-test-user-email": "seller@example.test" }
      }),
      sellerEnv,
      createExecutionContext()
    );
    expect(allowed.status).toBe(201);

    const denied = await worker.fetch(
      request("/api/integration/disconnect", {
        method: "POST",
        headers: { "x-test-user-email": "seller@example.test" }
      }),
      sellerEnv,
      createExecutionContext()
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: "FORBIDDEN", required_permission: "fortnox.disconnect" });
  });

  it("allows finance read/write finance actions without admin privileges", async () => {
    const env = workerEnv({ APP_ENV: "local" });
    const invoices = await worker.fetch(
      request("/api/invoices", { headers: { "x-test-user-email": "finance@example.test" } }),
      env,
      createExecutionContext()
    );
    expect(invoices.status).toBe(200);

    const disconnect = await worker.fetch(
      request("/api/integration/disconnect", {
        method: "POST",
        headers: { "x-test-user-email": "finance@example.test" }
      }),
      env,
      createExecutionContext()
    );
    expect(disconnect.status).toBe(403);
  });

  it("denies read-only writes", async () => {
    const response = await worker.fetch(
      request("/api/customers", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user-email": "reader@example.test" },
        body: JSON.stringify({ name: "Read Only AB" })
      }),
      workerEnv({ APP_ENV: "local" }),
      createExecutionContext()
    );
    expect(response.status).toBe(403);
  });

  it("allows admin across tested destructive operations", async () => {
    const response = await worker.fetch(
      request("/api/integration/disconnect", {
        method: "POST",
        headers: { "x-test-user-email": "admin@example.test" }
      }),
      workerEnv({ APP_ENV: "local" }),
      createExecutionContext()
    );
    expect(response.status).toBe(200);

    const admin = userFromEmail(workerEnv(), "admin@example.test");
    expect(hasPermission(admin, "admin.manage")).toBe(true);
  });
});
