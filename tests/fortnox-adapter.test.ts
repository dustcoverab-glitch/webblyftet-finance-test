import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { encryptString } from "../src/lib/crypto";
import { PublicAppError } from "../src/lib/app-error";
import { syncCustomerToFortnox, toFortnoxCustomerPayload } from "../src/integrations/fortnox/customers";
import { toFortnoxOfferPayload } from "../src/integrations/fortnox/offers";
import { resetTables, testKey, workerEnv } from "./helpers";

describe("Fortnox adapter mapping", () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await resetTables();
    await env.DB.prepare(
      `INSERT INTO fortnox_connections
        (id, tenant_id, access_token_enc, refresh_token_enc, token_expires_at, scope)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "fnx_test",
      "tenant-1",
      await encryptString("access-token", testKey()),
      null,
      new Date(Date.now() + 600_000).toISOString(),
      "customer"
    ).run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("maps Finance Core customer shape to Fortnox customer payload", () => {
    expect(toFortnoxCustomerPayload({
      name: "Acme AB",
      org_number: "559000-0000",
      email: "finance@example.com",
      country: "SE"
    })).toEqual({
      Customer: {
        Name: "Acme AB",
        OrganisationNumber: "559000-0000",
        Email: "finance@example.com",
        CountryCode: "SE"
      }
    });
  });

  it("maps offers without leaking Fortnox response format into callers", () => {
    expect(toFortnoxOfferPayload("1", {
      offer_date: "2026-08-20",
      rows: [{
        description: "Webblyftet Bas",
        quantity: 1,
        unit_price: 7995,
        discount_percent: 0,
        vat_percent: 25
      }]
    }).Offer.OfferRows[0]).toMatchObject({
      Description: "Webblyftet Bas",
      DeliveredQuantity: 1,
      Price: 7995,
      VAT: 25
    });
  });

  it("creates a Fortnox customer when no mapping exists", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      return Response.json({ Customer: { CustomerNumber: "1" } }, { status: 201 });
    }));

    const result = await syncCustomerToFortnox(workerEnv(), { name: "Acme AB", org_number: "559000-0000" });

    expect(result.providerCustomerNumber).toBe("1");
    expect(calls).toEqual([{ method: "POST", path: "/3/customers" }]);
  });

  it("updates the mapped Fortnox customer on retry", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      return Response.json({ Customer: { CustomerNumber: "1" } });
    }));

    const result = await syncCustomerToFortnox(workerEnv(), {
      name: "Acme AB",
      org_number: "559000-0000",
      fortnox_customer_number: "1"
    });

    expect(result.providerCustomerNumber).toBe("1");
    expect(calls).toEqual([
      { method: "GET", path: "/3/customers/1" },
      { method: "PUT", path: "/3/customers/1" }
    ]);
  });

  it("keeps the same CustomerNumber on repeated retries", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ Customer: { CustomerNumber: "2" } });
    }));

    const customer = { name: "Acme AB", fortnox_customer_number: "1" };
    const first = await syncCustomerToFortnox(workerEnv(), customer);
    const second = await syncCustomerToFortnox(workerEnv(), customer);

    expect(first.providerCustomerNumber).toBe("1");
    expect(second.providerCustomerNumber).toBe("1");
    expect(methods).toEqual(["GET", "PUT", "GET", "PUT"]);
  });

  it("fails in a controlled way when the mapped customer is missing remotely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { ErrorInformation: { Message: "Customer not found" } },
      { status: 404 }
    )));

    await expect(syncCustomerToFortnox(workerEnv(), {
      name: "Acme AB",
      fortnox_customer_number: "missing"
    })).rejects.toMatchObject({
      status: 409,
      publicMessage: "Mapped Fortnox customer not found"
    } satisfies Partial<PublicAppError>);
  });

  it("does not replace the local mapping with a new remote number on retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return Response.json({ Customer: { CustomerNumber: init?.method === "PUT" ? "999" : "1" } });
    }));

    const result = await syncCustomerToFortnox(workerEnv(), {
      name: "Acme AB",
      fortnox_customer_number: "1"
    });

    expect(result.providerCustomerNumber).toBe("1");
  });
});
