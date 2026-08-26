import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { resetTables, workerEnv } from "./helpers";
import { isPublicRoute, redactSensitiveText, sanitizeForLog } from "../src/lib/security";

describe("API health and Access middleware", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetTables();
  });

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
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCESS_REQUIRED" });
  });

  it("rejects spoofed Cloudflare Access identity headers without a verified JWT", async () => {
    const request = new Request("https://finance-test.example/api/health", {
      headers: { "cf-access-authenticated-user-email": "tester@example.com" }
    });
    const response = await worker.fetch(
      request,
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCESS_REQUIRED" });
  });

  it("rejects malformed Cloudflare Access JWTs", async () => {
    const response = await worker.fetch(
      new Request("https://finance-test.example/api/health", {
        headers: { "cf-access-jwt-assertion": "invalid.jwt.value" }
      }),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "ACCESS_JWT_INVALID" });
  });

  it("can explicitly allow an initial workers.dev test deployment without Access", async () => {
    const response = await worker.fetch(
      new Request("https://finance-test.example/api/health"),
      workerEnv({ APP_ENV: "local", REQUIRE_CLOUDFLARE_ACCESS: "false" } as any),
      createExecutionContext()
    );

    expect(response.status).toBe(200);
  });

  it("bypasses Cloudflare Access only for the exact Stripe webhook path and still requires signature", async () => {
    const exact = await worker.fetch(
      new Request("https://finance-test.example/webhooks/stripe", {
        method: "POST",
        body: "{}"
      }),
      workerEnv({ APP_ENV: "test", STRIPE_WEBHOOK_SECRET: "whsec_test" } as any),
      createExecutionContext()
    );
    expect(exact.status).toBe(400);

    const getExact = await worker.fetch(
      new Request("https://finance-test.example/webhooks/stripe", { method: "GET" }),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(getExact.status).toBe(403);

    for (const path of ["/webhooks/stripe/foo", "/webhooks/stripe-test"]) {
      const response = await worker.fetch(
        new Request(`https://finance-test.example${path}`, {
          method: "POST",
          body: "{}"
        }),
        workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
        createExecutionContext()
      );
      expect(response.status).toBe(403);
    }
  });

  it("bypasses Cloudflare Access only for explicitly allowed customer-order routes", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz_1234567890";
    const tokenRoute = await worker.fetch(
      new Request(`https://finance-test.example/customer-order/${token}/session`),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(tokenRoute.status).toBe(404);

    const publicCustomerAsset = await worker.fetch(
      new Request("https://finance-test.example/customer-order-assets/customer-order-test.js"),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );
    expect(publicCustomerAsset.status).not.toBe(403);

    for (const path of [
      "/customer-order-test",
      "/customer-orders/not-a-real-token/session",
      "/customer-order/internal",
      `/customer-order/${token}/admin`,
      "/customer-order/foo/admin",
      "/assets/internal-admin.js",
      "/api/dashboard"
    ]) {
      const response = await worker.fetch(
        new Request(`https://finance-test.example${path}`),
        workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
        createExecutionContext()
      );
      expect(response.status).toBe(403);
    }
  });

  it("classifies public routes by exact method and route shape", () => {
    const token = "abcdefghijklmnopqrstuvwxyz_1234567890";
    expect(isPublicRoute("GET", `/customer-order/${token}`)).toBe(true);
    expect(isPublicRoute("GET", `/customer-order/${token}/session`)).toBe(true);
    expect(isPublicRoute("POST", `/customer-order/${token}/sign`)).toBe(true);
    expect(isPublicRoute("GET", "/customer-order-assets/customer-order.js")).toBe(true);
    expect(isPublicRoute("POST", "/webhooks/stripe")).toBe(true);
    expect(isPublicRoute("POST", "/webhooks/resend")).toBe(true);
    expect(isPublicRoute("GET", `/invoice-documents/${token}`)).toBe(true);

    expect(isPublicRoute("GET", "/webhooks/stripe")).toBe(false);
    expect(isPublicRoute("GET", "/webhooks/stripe/foo")).toBe(false);
    expect(isPublicRoute("GET", "/webhooks/stripe-test")).toBe(false);
    expect(isPublicRoute("GET", "/webhooks/resend")).toBe(false);
    expect(isPublicRoute("POST", "/webhooks/resend/foo")).toBe(false);
    expect(isPublicRoute("GET", "/invoice-documents")).toBe(false);
    expect(isPublicRoute("GET", "/customer-order-test")).toBe(false);
    expect(isPublicRoute("GET", "/customer-order/internal")).toBe(false);
    expect(isPublicRoute("GET", `/customer-order/${token}/admin`)).toBe(false);
    expect(isPublicRoute("GET", "/api/dashboard")).toBe(false);
  });

  it("applies security headers", async () => {
    const response = await worker.fetch(
      new Request("https://finance-test.example/api/health"),
      workerEnv({ APP_ENV: "local" } as any),
      createExecutionContext()
    );

    expect(response.headers.get("content-security-policy")).toContain("https://js.stripe.com");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("requires same-origin validation for mutating Access-protected browser endpoints", async () => {
    const { token, jwks } = await createAccessJwt("test-aud");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(jwks), { status: 200 }));

    const protectedResponse = await worker.fetch(
      new Request("https://finance-test.example/api/products/seed-test", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "cf-access-jwt-assertion": token
        }
      }),
      workerEnv({ APP_ENV: "test", REQUIRE_CLOUDFLARE_ACCESS: "true" } as any),
      createExecutionContext()
    );

    expect(protectedResponse.status).toBe(403);
    await expect(protectedResponse.json()).resolves.toMatchObject({ code: "CSRF_REQUIRED" });
  });

  it("rejects invalid receipt MIME types and oversized uploads", async () => {
    const badType = new FormData();
    badType.set("file", new File(["<svg></svg>"], "../attack.svg", { type: "image/svg+xml" }));
    const badTypeResponse = await worker.fetch(
      new Request("https://finance-test.example/api/receipts", {
        method: "POST",
        headers: { origin: "https://finance-test.example", "x-test-user-email": "admin@example.test" },
        body: badType
      }),
      workerEnv({ APP_ENV: "local", REQUIRE_CLOUDFLARE_ACCESS: "false" } as any),
      createExecutionContext()
    );
    expect(badTypeResponse.status).toBe(415);

    const tooLarge = new FormData();
    tooLarge.set("file", new File(["123456"], "large.pdf", { type: "application/pdf" }));
    const tooLargeResponse = await worker.fetch(
      new Request("https://finance-test.example/api/receipts", {
        method: "POST",
        headers: { origin: "https://finance-test.example", "x-test-user-email": "admin@example.test" },
        body: tooLarge
      }),
      workerEnv({ APP_ENV: "local", MAX_RECEIPT_UPLOAD_BYTES: "5" } as any),
      createExecutionContext()
    );
    expect(tooLargeResponse.status).toBe(413);
  });

  it("redacts secrets from log values", () => {
    const redacted = sanitizeForLog({
      Authorization: "Bearer fnx-token",
      access_token: "secret-access",
      nested: { client_secret: "pi_secret_123", safe: "ok" }
    });
    expect(JSON.stringify(redacted)).not.toContain("fnx-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-access");
    expect(JSON.stringify(redacted)).not.toContain("pi_secret_123");
    expect(redactSensitiveText("sk_test_123 whsec_456 client_secret=pi_secret_789")).not.toContain("sk_test_123");
  });
});

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createAccessJwt(aud: string) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    aud,
    email: "tester@example.com",
    exp: Math.floor(Date.now() / 1000) + 300
  })));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return {
    token: `${header}.${payload}.${base64Url(new Uint8Array(signature))}`,
    jwks: { keys: [publicJwk] }
  };
}
