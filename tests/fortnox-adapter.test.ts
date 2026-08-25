import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { encryptString } from "../src/lib/crypto";
import { PublicAppError } from "../src/lib/app-error";
import { syncCustomerToFortnox, toFortnoxCustomerPayload } from "../src/integrations/fortnox/customers";
import { syncInvoiceToFortnox } from "../src/integrations/fortnox/invoices";
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

  it("creates Fortnox invoices with a stable Finance external reference", async () => {
    await seedInvoice();
    const calls: Array<{ method: string; path: string; search: string; body?: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, body });
      if (init?.method === "POST") return Response.json({ Invoice: { DocumentNumber: "100" } }, { status: 201 });
      return Response.json({ Invoices: [] });
    }));

    const result = await syncInvoiceToFortnox(workerEnv(), "inv_fortnox");

    expect(result).toMatchObject({ providerDocumentNumber: "100", reused: false });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/3/invoices" });
    expect(calls[0].search).toContain("externalinvoicereference1=webblyftet-finance%3Ainv_fortnox");
    expect(calls[1].body.Invoice).toMatchObject({
      ExternalInvoiceReference1: "webblyftet-finance:inv_fortnox",
      YourOrderNumber: "TEST-00001"
    });
    const invoice = await env.DB.prepare("SELECT fortnox_document_number,sync_status FROM invoices WHERE id=?")
      .bind("inv_fortnox")
      .first<any>();
    expect(invoice).toMatchObject({ fortnox_document_number: "100", sync_status: "SYNCED" });
  });

  it("recovers an invoice created remotely before local mapping was stored", async () => {
    await seedInvoice();
    await env.DB.prepare("UPDATE invoices SET sync_status='SYNCING' WHERE id=?").bind("inv_fortnox").run();
    let postCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") postCount += 1;
      if (url.searchParams.get("externalinvoicereference1") === "webblyftet-finance:inv_fortnox") {
        return Response.json({ Invoices: [{ DocumentNumber: "101", ExternalInvoiceReference1: "webblyftet-finance:inv_fortnox" }] });
      }
      return Response.json({ Invoice: { DocumentNumber: "101" } }, { status: 201 });
    }));

    const result = await syncInvoiceToFortnox(workerEnv(), "inv_fortnox");

    expect(result).toMatchObject({ providerDocumentNumber: "101", reused: true, recovered: true });
    expect(postCount).toBe(0);
    const invoice = await env.DB.prepare("SELECT fortnox_document_number,sync_status FROM invoices WHERE id=?")
      .bind("inv_fortnox")
      .first<any>();
    expect(invoice).toMatchObject({ fortnox_document_number: "101", sync_status: "SYNCED" });
  });

  it("does not POST a second invoice while sync is already in progress and no recovery match exists", async () => {
    await seedInvoice();
    await env.DB.prepare("UPDATE invoices SET sync_status='SYNCING' WHERE id=?").bind("inv_fortnox").run();
    let postCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") postCount += 1;
      return Response.json({ Invoices: [] });
    }));

    await expect(syncInvoiceToFortnox(workerEnv(), "inv_fortnox")).rejects.toThrow(/pågår|recovery/);
    expect(postCount).toBe(0);
  });

  it("recovers after a simulated local mapping write failure without creating another remote invoice", async () => {
    await seedInvoice();
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let postCount = 0;
    let failMappingWrite = true;
    vi.spyOn(env.DB, "prepare").mockImplementation(((sql: string) => {
      if (failMappingWrite && sql.includes("SET fortnox_document_number=?")) {
        const statement = originalPrepare(sql);
        return {
          ...statement,
          bind: (...args: unknown[]) => ({
            run: async () => {
              failMappingWrite = false;
              throw new Error("simulated local mapping write failure");
            },
            first: statement.bind(...args).first,
            all: statement.bind(...args).all,
            raw: statement.bind(...args).raw
          })
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    }) as any);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        postCount += 1;
        return Response.json({ Invoice: { DocumentNumber: "102" } }, { status: 201 });
      }
      if (url.searchParams.get("externalinvoicereference1") === "webblyftet-finance:inv_fortnox" && postCount > 0) {
        return Response.json({ Invoices: [{ DocumentNumber: "102", ExternalInvoiceReference1: "webblyftet-finance:inv_fortnox" }] });
      }
      return Response.json({ Invoices: [] });
    }));

    const recovered = await syncInvoiceToFortnox(workerEnv(), "inv_fortnox");
    const retry = await syncInvoiceToFortnox(workerEnv(), "inv_fortnox");

    expect(recovered).toMatchObject({ providerDocumentNumber: "102", reused: true, recovered: true });
    expect(retry).toMatchObject({ providerDocumentNumber: "102", reused: true });
    expect(postCount).toBe(1);
  });
});

async function seedInvoice() {
  await env.DB.prepare(
    `INSERT INTO customers(id,name,fortnox_customer_number,email)
     VALUES (?,?,?,?)`
  ).bind("cus_fortnox_invoice", "Acme AB", "1", "buyer@example.com").run();
  await env.DB.prepare(
    `INSERT INTO invoices(id,customer_id,invoice_number,invoice_type,status,invoice_date,due_date,currency,subtotal,vat_total,total,balance,subtotal_minor,vat_total_minor,total_minor,balance_minor,sync_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind("inv_fortnox", "cus_fortnox_invoice", "TEST-00001", "PROJECT_INVOICE", "DRAFT", "2026-08-24", "2026-09-23", "SEK", 1000, 250, 1250, 1250, 100000, 25000, 125000, 125000, "LOCAL_ONLY").run();
  await env.DB.prepare(
    `INSERT INTO invoice_rows(id,invoice_id,sort_order,description,quantity,unit,unit_price,vat_percent,unit_price_minor,billing_type)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind("irow_fortnox", "inv_fortnox", 0, "Webblyftet Bas", 1, "st", 1000, 25, 100000, "ONE_TIME").run();
}
