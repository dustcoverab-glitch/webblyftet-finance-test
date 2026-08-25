import { escapeHtml } from "../lib/html";
import type { CompanyProfile } from "./company-profile";
import { webblyftetCompanyProfile } from "./company-profile";
import { demoOfferTerms, type DocumentTerms } from "./terms";
import { documentTotals, formatMinor, lineGrossMinor, lineNetMinor, lineVatMinor, type DocumentLine } from "./money";

type CustomerInfo = {
  name?: string | null;
  org_number?: string | null;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  contact_name?: string | null;
};

export type OfferDocumentInput = {
  document_number: string;
  title: string;
  document_date: string;
  valid_until?: string | null;
  currency?: string | null;
  customer: CustomerInfo;
  seller_name?: string | null;
  rows: DocumentLine[];
  remarks?: string | null;
  version_number?: number | string | null;
  terms?: DocumentTerms;
  company?: CompanyProfile;
  acceptFormHtml?: string;
  test_label?: string;
};

type InvoiceDocumentInput = {
  document_number: string;
  invoice_date: string;
  due_date?: string | null;
  payment_terms_days?: number | null;
  currency?: string | null;
  customer: CustomerInfo;
  rows: DocumentLine[];
  subtotal_minor: number;
  vat_total_minor: number;
  total_minor: number;
  balance_minor: number;
  roundoff_minor?: number;
  status?: string | null;
  source_offer_reference?: string | null;
  sales_order_reference?: string | null;
  fortnox_document_number?: string | null;
  seller_name?: string | null;
  company?: CompanyProfile;
};

function addressBlock(customer: CustomerInfo): string {
  return [
    customer.name,
    customer.org_number ? `Org.nr ${customer.org_number}` : "",
    customer.address1,
    [customer.zip, customer.city].filter(Boolean).join(" "),
    customer.country,
    customer.contact_name ? `Kontakt: ${customer.contact_name}` : "",
    customer.email,
    customer.phone
  ].filter(Boolean).map(escapeHtml).join("<br>");
}

function companyBlock(company: CompanyProfile): string {
  return [
    company.legal_name,
    `Org.nr ${company.org_number}`,
    `VAT ${company.vat_number}`,
    company.address1,
    `${company.zip} ${company.city}`,
    company.country,
    company.email,
    company.phone,
    company.website
  ].filter(Boolean).map(escapeHtml).join("<br>");
}

function documentCss() {
  return `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17221f;background:#f4f3ef}body{margin:0}.docShell{max-width:1040px;margin:0 auto;padding:34px 18px 60px}.docPage{background:#fff;border:1px solid #deddd7;box-shadow:0 18px 60px rgba(23,34,31,.08);padding:44px}.docTop{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #17221f;padding-bottom:24px}.wordmark{font-size:26px;font-weight:900;letter-spacing:.02em}.wordmark span{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:8px;background:#d4f36b;margin-right:10px}.docKind{text-align:right}.docKind small{display:block;color:#68736e;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.docKind h1{font-size:42px;line-height:1;margin:8px 0 0}.docMeta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:26px 0}.docMeta div,.addressCard,.summaryCard,.termsBox,.paymentBox{border:1px solid #e4e3dd;background:#fbfbf8;border-radius:10px;padding:14px}.docMeta span,.addressCard span,.summaryCard span,.paymentBox span{display:block;color:#68736e;font-size:12px;font-weight:750;text-transform:uppercase}.docMeta strong,.summaryCard strong,.paymentBox strong{display:block;margin-top:6px;font-size:18px}.addresses{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}.addressCard p{line-height:1.55;margin:8px 0 0}.sectionTitle{font-size:18px;margin:30px 0 10px}.docTable{width:100%;border-collapse:collapse;font-size:14px}.docTable th{text-align:left;color:#68736e;font-size:12px;text-transform:uppercase;border-bottom:1px solid #d9d8d2;padding:10px 8px}.docTable td{border-bottom:1px solid #ecebe6;padding:13px 8px;vertical-align:top}.docTable small{display:block;color:#737d78;margin-top:3px}.number{text-align:right;white-space:nowrap}.summaries{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-top:24px}.summaryGrid{display:grid;gap:8px}.summaryGrid div{display:flex;justify-content:space-between;gap:16px}.highlight{background:#17221f!important;color:#fff!important;border-color:#17221f!important}.highlight span{color:#d4f36b}.termsGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.termsBox p{margin:5px 0 0;line-height:1.45;color:#4e5a55}.fine{font-size:12px;color:#69736f;line-height:1.5}.docFooter{display:flex;justify-content:space-between;gap:14px;border-top:1px solid #e6e5df;margin-top:30px;padding-top:18px;color:#69736f;font-size:12px}@media(max-width:760px){.docPage{padding:24px}.docTop,.addresses,.summaries{display:block}.docKind{text-align:left;margin-top:18px}.docMeta,.termsGrid{grid-template-columns:1fr}.docTable{font-size:12px}.number{text-align:left}.docTable th:nth-child(4),.docTable td:nth-child(4){display:none}}@media print{body{background:#fff}.docShell{padding:0}.docPage{border:0;box-shadow:none}.acceptBlock{display:none}}`;
}

function renderRows(rows: DocumentLine[], currency: string) {
  if (!rows.length) return `<tr><td colspan="7">Inga rader.</td></tr>`;
  return rows.map((row) => `<tr>
    <td><strong>${escapeHtml(row.description)}</strong><small>${escapeHtml(row.article_number || (row.billing_type === "RECURRING" ? "Lopande tjanst" : "Engangstjanst"))}</small></td>
    <td>${escapeHtml(String(row.quantity))} ${escapeHtml(row.unit || "st")}</td>
    <td class="number">${formatMinor(row.unit_price_minor, currency)}</td>
    <td class="number">${escapeHtml(String(row.discount_percent ?? 0))}%</td>
    <td class="number">${escapeHtml(String(row.vat_percent ?? 0))}%</td>
    <td class="number">${formatMinor(lineNetMinor(row), currency)}</td>
    <td class="number"><strong>${formatMinor(lineGrossMinor(row), currency)}</strong></td>
  </tr>`).join("");
}

function renderShell(kind: string, title: string, body: string, company: CompanyProfile): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(kind)} ${escapeHtml(title)}</title><style>${documentCss()}</style></head><body><main class="docShell"><article class="docPage">${body}<footer class="docFooter"><span>${escapeHtml(company.brand_name)} · ${escapeHtml(company.website)}</span><span>Finance Test · demo/testdata</span></footer></article></main></body></html>`;
}

export function renderOfferDocument(env: Env, input: OfferDocumentInput): string {
  const company = input.company ?? webblyftetCompanyProfile(env);
  const terms = input.terms ?? demoOfferTerms;
  const currency = input.currency ?? "SEK";
  const oneTimeRows = input.rows.filter((row) => row.billing_type !== "RECURRING");
  const recurringRows = input.rows.filter((row) => row.billing_type === "RECURRING");
  const totals = documentTotals(input.rows);
  const body = `
    <header class="docTop"><div><div class="wordmark"><span>W</span>${escapeHtml(company.brand_name)}</div><p class="fine">${escapeHtml(company.legal_name)} · ${escapeHtml(input.test_label ?? "Demo/test-offert")}</p></div><div class="docKind"><small>OFFERT</small><h1>${escapeHtml(input.document_number)}</h1></div></header>
    <section class="docMeta">
      <div><span>Offertdatum</span><strong>${escapeHtml(input.document_date)}</strong></div>
      <div><span>Giltig till</span><strong>${escapeHtml(input.valid_until || "Ej angivet")}</strong></div>
      <div><span>Version</span><strong>${escapeHtml(input.version_number ?? "Draft")}</strong></div>
      <div><span>Saljare</span><strong>${escapeHtml(input.seller_name || "Webblyftet")}</strong></div>
    </section>
    <section class="addresses"><div class="addressCard"><span>Fran</span><p>${companyBlock(company)}</p></div><div class="addressCard"><span>Till</span><p>${addressBlock(input.customer) || "Kunduppgifter saknas"}</p></div></section>
    <h2 class="sectionTitle">${escapeHtml(input.title)}</h2>
    <h3 class="sectionTitle">Engangstjanster</h3><table class="docTable"><thead><tr><th>Beskrivning</th><th>Antal</th><th class="number">A-pris</th><th class="number">Rabatt</th><th class="number">Moms</th><th class="number">Netto</th><th class="number">Total</th></tr></thead><tbody>${renderRows(oneTimeRows, currency)}</tbody></table>
    <h3 class="sectionTitle">Lopande tjanster</h3><table class="docTable"><thead><tr><th>Beskrivning</th><th>Antal</th><th class="number">A-pris</th><th class="number">Rabatt</th><th class="number">Moms</th><th class="number">Netto</th><th class="number">Total</th></tr></thead><tbody>${renderRows(recurringRows, currency)}</tbody></table>
    <section class="summaries"><div class="termsBox"><span>Kommentar</span><p>${escapeHtml(input.remarks || "Tack for mojligheten att lamna offert. Granska priser, omfattning och villkor innan digital accept.")}</p></div><div class="summaryGrid">
      <div><span>Engang netto</span><strong>${formatMinor(totals.oneTime.net, currency)}</strong></div>
      <div><span>Moms engang</span><strong>${formatMinor(totals.oneTime.vat, currency)}</strong></div>
      <div class="summaryCard highlight"><span>Engang totalt inkl. moms</span><strong>${formatMinor(totals.oneTime.gross, currency)}</strong></div>
      <div><span>Aterkommande per manad inkl. moms</span><strong>${formatMinor(totals.recurringMonthly.gross, currency)}</strong></div>
      <div><span>Aterkommande arspris inkl. moms</span><strong>${formatMinor(totals.recurringAnnual.gross, currency)}</strong></div>
    </div></section>
    <h3 class="sectionTitle">Villkor</h3><p class="fine">Villkorsversion: ${escapeHtml(terms.version)}. Dessa ar demo-standardvillkor och ska ersattas av juridiskt slutgranskade produktionsvillkor innan skarp anvandning.</p>
    <section class="termsGrid">${terms.sections.map((section) => `<div class="termsBox"><strong>${escapeHtml(section.title)}</strong><p>${escapeHtml(section.body)}</p></div>`).join("")}</section>
    ${input.acceptFormHtml ? `<section class="termsBox acceptBlock">${input.acceptFormHtml}</section>` : ""}
  `;
  return renderShell("Offert", input.document_number, body, company);
}

export function renderInvoiceDocument(env: Env, input: InvoiceDocumentInput): string {
  const company = input.company ?? webblyftetCompanyProfile(env);
  const currency = input.currency ?? "SEK";
  const roundoff = input.roundoff_minor ?? input.total_minor - input.subtotal_minor - input.vat_total_minor;
  const body = `
    <header class="docTop"><div><div class="wordmark"><span>W</span>${escapeHtml(company.brand_name)}</div><p class="fine">${escapeHtml(company.legal_name)} · Finance Test faktura</p></div><div class="docKind"><small>FAKTURA</small><h1>${escapeHtml(input.document_number)}</h1></div></header>
    <section class="docMeta">
      <div><span>Fakturadatum</span><strong>${escapeHtml(input.invoice_date)}</strong></div>
      <div><span>Forfallodatum</span><strong>${escapeHtml(input.due_date || "Ej angivet")}</strong></div>
      <div><span>Betalningsvillkor</span><strong>${escapeHtml(input.payment_terms_days ?? company.payment_terms_days)} dagar</strong></div>
      <div><span>Status</span><strong>${escapeHtml(input.status || "DRAFT")}</strong></div>
    </section>
    <section class="addresses"><div class="addressCard"><span>Avsandare</span><p>${companyBlock(company)}</p></div><div class="addressCard"><span>Mottagare</span><p>${addressBlock(input.customer) || "Kunduppgifter saknas"}</p></div></section>
    <section class="docMeta">
      <div><span>Orderreferens</span><strong>${escapeHtml(input.sales_order_reference || "Ej angiven")}</strong></div>
      <div><span>Offertreferens</span><strong>${escapeHtml(input.source_offer_reference || "Ej angiven")}</strong></div>
      <div><span>Fortnox</span><strong>${escapeHtml(input.fortnox_document_number || "Ej synkad")}</strong></div>
      <div><span>Saljare</span><strong>${escapeHtml(input.seller_name || "Webblyftet")}</strong></div>
    </section>
    <h3 class="sectionTitle">Fakturarader</h3><table class="docTable"><thead><tr><th>Beskrivning</th><th>Antal</th><th class="number">A-pris</th><th class="number">Rabatt</th><th class="number">Moms</th><th class="number">Netto</th><th class="number">Total</th></tr></thead><tbody>${renderRows(input.rows, currency)}</tbody></table>
    <section class="summaries"><div class="paymentBox"><span>Betalningsinformation</span><strong>Att betala: ${formatMinor(input.balance_minor, currency)}</strong><p>Forfallodatum: ${escapeHtml(input.due_date || "Ej angivet")}<br>Betalningsreferens/OCR: ${escapeHtml(input.document_number)}<br>Bankgiro: ${escapeHtml(company.bankgiro)}${company.iban ? `<br>IBAN: ${escapeHtml(company.iban)}` : ""}${company.bic ? `<br>BIC: ${escapeHtml(company.bic)}` : ""}</p><p class="fine">Testuppgifter i Finance Test. Anvand inte som skarpa betalningsuppgifter.</p></div><div class="summaryGrid">
      <div><span>Summa exkl. moms</span><strong>${formatMinor(input.subtotal_minor, currency)}</strong></div>
      <div><span>Moms</span><strong>${formatMinor(input.vat_total_minor, currency)}</strong></div>
      <div><span>Avrundning</span><strong>${formatMinor(roundoff, currency)}</strong></div>
      <div class="summaryCard highlight"><span>Att betala</span><strong>${formatMinor(input.balance_minor, currency)}</strong></div>
    </div></section>
  `;
  return renderShell("Faktura", input.document_number, body, company);
}

export function renderOfferEmailPreview(input: OfferDocumentInput): string {
  const currency = input.currency ?? "SEK";
  const totals = documentTotals(input.rows);
  return `Din offert fran Webblyftet\n\nHej ${input.customer.contact_name || input.customer.name || ""},\n\nTack for ett trevligt mote. Har ar en sammanfattning av losningen vi har gatt igenom.\n\nKundforetag: ${input.customer.name || "-"}\nOffert: ${input.document_number}\nGiltig till: ${input.valid_until || "-"}\nEngangskostnad: ${formatMinor(totals.oneTime.gross, currency)} inkl. moms\nAterkommande per manad: ${formatMinor(totals.recurringMonthly.gross, currency)} inkl. moms\nAterkommande arspris: ${formatMinor(totals.recurringAnnual.gross, currency)} inkl. moms\n\nCTA: Granska och godkann offerten\nSekundart: Visa offert / PDF nar PDF-generation ar aktiverad\n\nDetta ar ett Finance Test-demo-mail.`;
}

export function renderOfferEmail(input: OfferDocumentInput, customerOrderUrl: string): { subject: string; html: string; text: string } {
  const company = input.company ?? webblyftetCompanyProfile({} as Env);
  const currency = input.currency ?? "SEK";
  const totals = documentTotals(input.rows);
  const contact = input.customer.contact_name || input.customer.name || "";
  const subject = `Din offert från ${company.brand_name}: ${input.title || input.document_number}`;
  const rowSummary = input.rows.map((row) => `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #e7e5df"><strong>${escapeHtml(row.description)}</strong><br><span style="color:#66736d">${escapeHtml(row.billing_type === "RECURRING" ? "Återkommande" : "Engång")} · ${escapeHtml(String(row.quantity))} ${escapeHtml(row.unit || "st")}</span></td>
    <td style="padding:10px 0;border-bottom:1px solid #e7e5df;text-align:right"><strong>${formatMinor(lineGrossMinor(row), currency)}</strong></td>
  </tr>`).join("");
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#f4f3ef;color:#17221f;font-family:Inter,Arial,sans-serif">
    <main style="max-width:720px;margin:0 auto;padding:28px 16px">
      <section style="background:#fff;border:1px solid #deddd7;border-radius:12px;padding:28px">
        <div style="font-size:24px;font-weight:900;margin-bottom:18px"><span style="display:inline-block;background:#d4f36b;border-radius:8px;padding:6px 10px;margin-right:8px">W</span>${escapeHtml(company.brand_name)}</div>
        <p>Hej ${escapeHtml(contact)},</p>
        <p>Tack för ett trevligt möte. Här är offerten för ${escapeHtml(input.customer.name || "ert företag")}.</p>
        <table style="width:100%;border-collapse:collapse;margin:22px 0">
          <tr><td style="color:#66736d">Offert</td><td style="text-align:right"><strong>${escapeHtml(input.document_number)}</strong></td></tr>
          <tr><td style="color:#66736d">Offertdatum</td><td style="text-align:right">${escapeHtml(input.document_date)}</td></tr>
          <tr><td style="color:#66736d">Giltig till</td><td style="text-align:right">${escapeHtml(input.valid_until || "-")}</td></tr>
        </table>
        <table style="width:100%;border-collapse:collapse">${rowSummary || `<tr><td>Inga rader.</td></tr>`}</table>
        <section style="margin:22px 0;padding:16px;background:#f8f8f4;border-radius:10px">
          <div>Engångskostnad inkl. moms: <strong>${formatMinor(totals.oneTime.gross, currency)}</strong></div>
          <div>Återkommande per månad inkl. moms: <strong>${formatMinor(totals.recurringMonthly.gross, currency)}</strong></div>
          <div>Återkommande årspris inkl. moms: <strong>${formatMinor(totals.recurringAnnual.gross, currency)}</strong></div>
        </section>
        <p><a href="${escapeHtml(customerOrderUrl)}" style="display:inline-block;background:#17221f;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-weight:800">Granska och godkänn offerten</a></p>
        <p style="color:#66736d;font-size:13px;line-height:1.5">Detta är ett testmail från Finance Test. Om knappen inte fungerar kan du kopiera länken: ${escapeHtml(customerOrderUrl)}</p>
      </section>
    </main>
  </body></html>`;
  const text = [
    `Din offert från ${company.brand_name}`,
    "",
    `Hej ${contact},`,
    "",
    `Kundföretag: ${input.customer.name || "-"}`,
    `Offert: ${input.document_number}`,
    `Offertdatum: ${input.document_date}`,
    `Giltig till: ${input.valid_until || "-"}`,
    `Engångskostnad: ${formatMinor(totals.oneTime.gross, currency)} inkl. moms`,
    `Återkommande per månad: ${formatMinor(totals.recurringMonthly.gross, currency)} inkl. moms`,
    `Återkommande årspris: ${formatMinor(totals.recurringAnnual.gross, currency)} inkl. moms`,
    "",
    "Granska och godkänn offerten:",
    customerOrderUrl
  ].join("\n");
  return { subject, html, text };
}

export function renderInvoiceEmailPreview(input: InvoiceDocumentInput): string {
  const currency = input.currency ?? "SEK";
  return `Din faktura fran Webblyftet\n\nHej ${input.customer.contact_name || input.customer.name || ""},\n\nHar kommer en sammanfattning av fakturan.\n\nFakturanummer: ${input.document_number}\nFakturadatum: ${input.invoice_date}\nForfallodatum: ${input.due_date || "-"}\nBelopp att betala: ${formatMinor(input.balance_minor, currency)}\n\nCTA: Visa faktura\n\nDetta ar ett Finance Test-demo-mail.`;
}
