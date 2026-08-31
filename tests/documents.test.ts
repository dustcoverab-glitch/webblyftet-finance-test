import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import { createOffer, createOfferAcceptanceToken } from "../src/core/business-flow";
import {
  WEBBLYFTET_TERMS_VERSION,
  documentTotals,
  humanDocumentNumber,
  renderInvoiceDocument,
  renderOfferDocument,
  renderOfferEmail,
  renderOfferEmailPreview
} from "../src/documents";
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
    const normalizedBody = body.replace(/\u00a0/g, " ");
    expect(body).toContain("Din offert från Webblyftet");
    expect(body).toContain("Anderssons Bygg AB");
    expect(normalizedBody).toContain("Återkommande per månad: 295 kr exkl. moms");
    expect(normalizedBody).toContain("Moms per månad: 74 kr");
    expect(normalizedBody).not.toContain("Återkommande per månad: 369 kr inkl. moms");
    expect(body).toContain("CTA: Granska och godkänn offerten");
  });

  it("renders offer emails with ex VAT prices as the primary customer amounts", () => {
    const message = renderOfferEmail({
      document_number: "OFF-2026-002",
      title: "Webblyftet Bas och Service",
      document_date: "2026-08-31",
      valid_until: "2026-09-14",
      customer: { name: "Anderssons Bygg AB", contact_name: "Anders" },
      rows: [
        { description: "Webblyftet Bas", quantity: 1, unit_price_minor: 799500, vat_percent: 25, billing_type: "ONE_TIME" },
        { description: "Webblyftet Service", quantity: 1, unit_price_minor: 29500, vat_percent: 25, billing_type: "RECURRING", billing_interval: "MONTH" }
      ]
    }, "https://example.test/customer-order/token");
    const normalizedHtml = message.html.replace(/\u00a0/g, " ");
    const normalizedText = message.text.replace(/\u00a0/g, " ");

    expect(message.html).toContain("Engångskostnad exkl. moms");
    expect(normalizedHtml).toContain("7 995 kr");
    expect(message.html).toContain("Återkommande per månad exkl. moms");
    expect(normalizedHtml).toContain("295 kr");
    expect(message.html).toContain("Moms per månad");
    expect(message.html).not.toContain("Engångskostnad inkl. moms");
    expect(normalizedHtml).not.toContain("9 994 kr");
    expect(normalizedText).toContain("Engångskostnad: 7 995 kr exkl. moms");
    expect(normalizedText).toContain("Återkommande per månad: 295 kr exkl. moms");
    expect(normalizedText).not.toContain("inkl. moms");
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
      balance_minor: 999375,
      sales_order_reference: "sord_c649cfa3-e1f9-400d-9a76-a7ceb16dbd59"
    });
    expect(html).toContain("FAKTURA");
    expect(html).toContain("Bankgiro: 000-0000 (test)");
    expect(html).toContain("Testuppgifter i Finance Test");
    expect(html).toContain("INV-2026-0001");
    expect(html).toContain("ORDER-2026-");
    expect(html).not.toContain("sord_c649cfa3-e1f9-400d-9a76-a7ceb16dbd59");
  });

  it("renders a deterministic three-page premium offer with scope, terms and special notes", () => {
    const html = renderOfferDocument(workerEnv(), {
      document_number: "off_82ad8cad-965e-456b-ad67-59d9c57b0851",
      title: "Webblyftet Bas och Service",
      document_date: "2026-08-24",
      valid_until: "2026-09-07",
      version_number: 3,
      seller_name: "Webblyftet",
      customer: {
        name: "Anderssons Bygg AB",
        org_number: "559900-1234",
        email: "kontakt@example.test",
        address1: "Byggvägen 12",
        zip: "582 22",
        city: "Linköping"
      },
      remarks: "Särskild leveranstid enligt säljmötet.",
      rows: [
        { description: "Webblyftet Bas", quantity: 1, unit_price_minor: 799500, vat_percent: 25, billing_type: "ONE_TIME" },
        { description: "Webblyftet Service", quantity: 1, unit_price_minor: 29500, vat_percent: 25, billing_type: "RECURRING", billing_interval: "MONTH" }
      ]
    });

    expect(html.match(/class="docPage/g)).toHaveLength(3);
    expect(html).toContain("Sida 1 av 3");
    expect(html).toContain("Sida 2 av 3");
    expect(html).toContain("Sida 3 av 3");
    expect(html).toContain("Omfattning och leverans");
    expect(html).toContain("Detta ingår i Webblyftet Bas");
    expect(html).toContain("Webblyftet Service");
    expect(html).toContain(WEBBLYFTET_TERMS_VERSION);
    expect(html).toContain("Särskild leveranstid enligt säljmötet.");
    expect(html).toContain("OFF-2026-0851");
    expect(html).not.toContain("off_82ad8cad-965e-456b-ad67-59d9c57b0851</h1>");
  });

  it("renders optional missing address and phone fields without crashing layout", () => {
    const html = renderOfferDocument(workerEnv(), {
      document_number: "OFF-2026-0124",
      title: "Offert utan komplett adress",
      document_date: "2026-08-24",
      customer: {},
      rows: [{ description: "Webblyftet Bas", quantity: 1, unit_price_minor: 10000, vat_percent: 25, billing_type: "ONE_TIME" }]
    });
    expect(html).toContain("Offert utan komplett adress");
    expect(html).toContain("Uppgift saknas");
  });

  it("hides irrelevant commercial summaries for one-time-only and recurring-only offers", () => {
    const oneTime = renderOfferDocument(workerEnv(), {
      document_number: "OFF-2026-0002",
      title: "Endast projekt",
      document_date: "2026-08-24",
      customer: { name: "Kund AB" },
      rows: [{ description: "Webblyftet Bas", quantity: 1, unit_price_minor: 10000, vat_percent: 25, billing_type: "ONE_TIME" }]
    });
    const recurring = renderOfferDocument(workerEnv(), {
      document_number: "OFF-2026-0003",
      title: "Endast service",
      document_date: "2026-08-24",
      customer: { name: "Kund AB" },
      rows: [{ description: "Webblyftet Service", quantity: 1, unit_price_minor: 29500, vat_percent: 25, billing_type: "RECURRING", billing_interval: "MONTH" }]
    });
    expect(oneTime).not.toContain("Recurring/mån");
    expect(oneTime).not.toContain("Löpande tjänster</h3>");
    expect(recurring).not.toContain("Engång netto");
    expect(recurring).not.toContain("Engångstjänster</h3>");
  });

  it("formats human-friendly document numbers without exposing UUID-style IDs as primary numbers", () => {
    expect(humanDocumentNumber("offer", "off_82ad8cad-965e-456b-ad67-59d9c57b0851", "2026-08-24")).toBe("OFF-2026-0851");
    expect(humanDocumentNumber("invoice", "TEST-00015", "2026-08-24")).toBe("INV-2026-0015");
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
    expect(html).toContain(WEBBLYFTET_TERMS_VERSION);
  });

  it("renders immutable signed offer version economics even if live offer rows change later", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email) VALUES (?,?,?)")
      .bind("cus_immutable_doc", "Immutable Kund AB", "buyer@example.com")
      .run();
    const offer = await createOffer(workerEnv(), {
      customer_id: "cus_immutable_doc",
      title: "Immutable offert",
      offer_date: "2026-08-24",
      remarks: "Villkor frysta i snapshot.",
      rows: [{ description: "Originalrad", quantity: 1, unit_price: 1000, vat_percent: 25 }]
    });
    const link = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    await env.DB.prepare("UPDATE offer_rows SET description=?, unit_price=? WHERE offer_id=?")
      .bind("Ändrad rad", 9999, offer!.id)
      .run();
    const response = await worker.fetch(
      new Request(link.url),
      workerEnv({ APP_ENV: "local", REQUIRE_CLOUDFLARE_ACCESS: "false" } as any),
      createExecutionContext()
    );
    const html = await response.text();
    const compactHtml = html.replace(/\s|\u00a0/g, "");
    expect(html).toContain("Originalrad");
    expect(compactHtml).toContain("1250kr");
    expect(html).not.toContain("Ändrad rad");
  });
});
