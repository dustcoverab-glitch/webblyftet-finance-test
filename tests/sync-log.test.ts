import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { fortnoxRequest } from "../src/lib/fortnox";
import { encryptString } from "../src/lib/crypto";
import { resetTables, testKey, workerEnv } from "./helpers";

describe("Fortnox sync logging", () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("does not persist Authorization headers or tokens in sync_log", async () => {
    const token = "secret-access-token";
    const tokenEnc = await encryptString(token, testKey());
    await env.DB.prepare(
      `INSERT INTO fortnox_connections
        (id, tenant_id, access_token_enc, refresh_token_enc, token_expires_at, scope)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind("fnx_test", "tenant-1", tokenEnc, null, new Date(Date.now() + 600_000).toISOString(), "customer").run();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        ErrorInformation: {
          message: "Nope",
          access_token: token,
          Authorization: `Bearer ${token}`
        }
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    await expect(fortnoxRequest(workerEnv(), "/customers", { method: "GET" })).rejects.toThrow(/Referens:/);

    const row = await env.DB.prepare(
      "SELECT request_json, response_json, error_message FROM sync_log ORDER BY created_at DESC LIMIT 1"
    ).first<{ request_json: string | null; response_json: string | null; error_message: string | null }>();

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[REDACTED]");
  });
});
