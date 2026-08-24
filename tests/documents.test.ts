import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import { createOffer, createOfferAcceptanceToken } from "../src/core/business-flow";
import { documentTotals, renderInvoiceDocument, renderOfferDocument, renderOfferEmailPreview } from "../src/documents";
import { resetTables, workerEnv } from "./helpers";

describe("Webblyftet document system", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("calculates offer document totals from minor-unit rows", () => {
    const totals = documentTotals([
      { description: "Webblyftet Bas", quantity: 1, unit_price_minor: 799500, discount_percent: 0, vat_percent: 25, billing_type: "ONE_TIME" },
      { description: "Webblyftet Service", quantity: 1, unit_price_minor: 29500, discount_percent: 0, vat_percent: 25, billing_type: "RECURRING", billing_interval: "MONTH" }
    ]);
    expect(totals.oneTime).toMatchObject({ net: 799500, vat: 199875, gross: 999375 });
    expect(totals.recurringMonthly).toMatchObject({ net: 29500, vat: 7375, gross: 36875 });
    expect(totals.recurringAnnual.gross).toBe(442500);
  });

  it("escapes dynamic customer and row values in offer HTML", () => {
    const html = renderOfferDocument(workerEnv(), {
      document_number: "OFF-TEST",
      title: "<script>alert(1)</script>",
      document_date: "2026-08-24",
      valid_until: "2026-09-07",
      customer: { name: "Acme <AB>", email: "buyer@example.com" },
      rows: [{ description: "Rad <img src=x>", quantity: 1, unit_price_minor: 10000, vat_percent: 25, billing_type: "ONE_TIME" }]
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Acme &lt;AB&gt;");
    expect(html).toContain("Rad &lt;img src=x&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("includes versioned demo terms and branded email summary", () => {
    const body = renderOfferEmailPreview({
      document_number: "OFF-2026-001",
      title: "Webblyftet",
      document_date: "2026-08-24",
      valid_until: "2026-09-07",
      customer: { name: "Anderssons Bygg AB", contact_name: "Anders" },
      rows: [{ description: "Webblyftet Service", quantity: 1, unit_price_minor: 29500, vat_percent: 25, billing_type: "RECURRING", billing_interval: "MONTH" }]
    });
    expect(body).toContain("Din offert fran Webblyftet");
    expect(body).toContain("Anderssons Bygg AB");
    expect(body).toContain("CTA: Granska och godkann offerten");
  });

  it("renders invoice payment information without leaking production bank data", () => {
    const html = renderInvoiceDocument(workerEnv(), {
      document_number: "TEST-00001",
      invoice_date: "2026-08-24",
      due_date: "2026-09-23",
      customer: { name: "Webblyftet E2E Test AB" },
      rows: [{ description: "Webblyftet Bas", quantity: 1, unit_price_minor: 799500, vat_percent: 25, billing_type: "ONE_TIME" }],
      subtotal_minor: 799500,
      vat_total_minor: 199875,
      total_minor: 999375,
      balance_minor: 999375
    });
    expect(html).toContain("FAKTURA");
    expect(html).toContain("Bankgiro: 000-0000 (test)");
    expect(html).toContain("Testuppgifter i Finance Test");
  });

  it("serves the public sign page through the shared premium offer renderer", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email,org_number,address1,zip,city) VALUES (?,?,?,?,?,?,?)")
      .bind("cus_doc", "Webblyftet E2E Test AB", "buyer@example.com", "559900-1234", "Testgatan 3", "582 22", "Linkoping")
      .run();
    const offer = await createOffer(workerEnv(), {
      customer_id: "cus_doc",
      title: "Demo <Offert>",
      offer_date: "2026-08-24",
      rows: [{ description: "Premium <rad>", quantity: 1, unit_price: 1000, vat_percent: 25 }]
    });
    const link = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    const response = await worker.fetch(
      new Request(link.url),
      workerEnv({ APP_ENV: "local", REQUIRE_CLOUDFLARE_ACCESS: "false" } as any),
      createExecutionContext()
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("OFFERT");
    expect(html).toContain("Demo &lt;Offert&gt;");
    expect(html).toContain("Premium &lt;rad&gt;");
    expect(html).toContain("WEBBLYFTET-DEMO-TERMS-2026-08-24");
  });
});
