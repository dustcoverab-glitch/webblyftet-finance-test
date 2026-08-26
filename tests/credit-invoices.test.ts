import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createFullCreditInvoice } from "../src/core/credit-invoices";
import { syncCreditInvoiceToFortnox } from "../src/integrations/fortnox/credit-invoices";
import { encryptString } from "../src/lib/crypto";
import { resetTables, testKey, workerEnv } from "./helpers";

describe("credit invoices", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await resetTables();
    await seedInvoice();
  });

  it("creates a full credit invoice with immutable original, VAT reversal and accounting event", async () => {
    const result = await createFullCreditInvoice(workerEnv(), "inv_original", "Felaktig testfaktura");
    expect(result.reused).toBe(false);
    expect(result.credit_invoice).toMatchObject({
      invoice_number: "KTEST-00001",
      invoice_type: "CREDIT_INVOICE",
      original_invoice_id: "inv_original",
      total_minor: -125000,
      vat_total_minor: -25000
    });

    const original = await env.DB.prepare("SELECT status,total_minor,credited_by_invoice_id FROM invoices WHERE id='inv_original'").first<any>();
    const rows = await env.DB.prepare("SELECT quantity,unit_price_minor,vat_percent FROM invoice_rows WHERE invoice_id='inv_original'").all<any>();
    const creditRows = await env.DB.prepare("SELECT unit_price_minor,vat_percent,description FROM invoice_rows WHERE invoice_id=?")
      .bind(result.credit_invoice.id).all<any>();
    const accounting = await env.DB.prepare("SELECT event_type,net_amount,vat_amount,gross_amount FROM accounting_events WHERE entity_id=?")
      .bind(result.credit_invoice.id).first<any>();

    expect(original).toMatchObject({ status: "CREDITED", total_minor: 125000, credited_by_invoice_id: result.credit_invoice.id });
    expect(rows.results[0]).toMatchObject({ quantity: 1, unit_price_minor: 100000, vat_percent: 25 });
    expect(creditRows.results[0]).toMatchObject({ unit_price_minor: -100000, vat_percent: 25 });
    expect(accounting).toMatchObject({ event_type: "INVOICE_CREDITED", net_amount: -100000, vat_amount: -25000, gross_amount: -125000 });
  });

  it("is idempotent for full credit creation", async () => {
    const first = await createFullCreditInvoice(workerEnv(), "inv_original");
    const second = await createFullCreditInvoice(workerEnv(), "inv_original");
    const count = await env.DB.prepare("SELECT COUNT(*) count FROM invoices WHERE invoice_type='CREDIT_INVOICE'").first<{ count: number }>();
    expect(second).toMatchObject({ reused: true });
    expect(second.credit_invoice.id).toBe(first.credit_invoice.id);
    expect(count?.count).toBe(1);
  });

  it("prepares Fortnox credit invoice sync through the debit invoice credit endpoint", async () => {
    await env.DB.prepare(
      `INSERT INTO fortnox_connections(id,tenant_id,access_token_enc,token_expires_at,scope)
       VALUES (?,?,?,?,?)`
    ).bind("fnx_credit", "tenant-1", await encryptString("access-token", testKey()), new Date(Date.now() + 600_000).toISOString(), "invoice").run();
    const credit = await createFullCreditInvoice(workerEnv(), "inv_original");
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      return Response.json({ Invoice: { DocumentNumber: "101", CreditInvoiceReference: "101" } }, { status: 200 });
    }));

    const result = await syncCreditInvoiceToFortnox(workerEnv(), credit.credit_invoice.id);
    expect(result).toMatchObject({ providerDocumentNumber: "101", reused: false });
    expect(calls).toEqual([{ method: "PUT", path: "/3/invoices-v2/100/credit" }]);
  });
});

async function seedInvoice() {
  await env.DB.prepare("INSERT INTO customers(id,name,email) VALUES (?,?,?)")
    .bind("cus_credit", "Credit AB", "finance@example.test")
    .run();
  await env.DB.prepare(
    `INSERT INTO invoices(id,customer_id,invoice_number,invoice_type,status,currency,subtotal,vat_total,total,balance,subtotal_minor,vat_total_minor,total_minor,balance_minor,fortnox_document_number)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind("inv_original", "cus_credit", "TEST-00001", "PROJECT_INVOICE", "SYNCED", "SEK", 1000, 250, 1250, 1250, 100000, 25000, 125000, 125000, "100").run();
  await env.DB.prepare(
    `INSERT INTO invoice_rows(id,invoice_id,sort_order,description,quantity,unit,unit_price,unit_price_minor,discount_percent,vat_percent,account_number,billing_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind("irow_original", "inv_original", 0, "Webblyftet Bas", 1, "st", 1000, 100000, 0, 25, 3041, "ONE_TIME").run();
}
