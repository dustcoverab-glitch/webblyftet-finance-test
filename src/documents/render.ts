import { escapeHtml } from "../lib/html";
import type { CompanyProfile } from "./company-profile";
import { webblyftetCompanyProfile } from "./company-profile";
import { documentTotals, formatMinor, lineGrossMinor, lineNetMinor, lineVatMinor, type DocumentLine } from "./money";
import { offerScopeForRows } from "./scope";
import { demoOfferTerms, type DocumentTerms } from "./terms";

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
  signer?: {
    name?: string | null;
    email?: string | null;
    title?: string | null;
    signed_at?: string | null;
    status?: string | null;
  };
};

export type InvoiceDocumentInput = {
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

type DocumentKind = "offer" | "invoice";

function addressBlock(customer: CustomerInfo): string {
  const lines = [
    customer.name,
    customer.org_number ? `Org.nr ${customer.org_number}` : "",
    customer.address1,
    [customer.zip, customer.city].filter(Boolean).join(" "),
    customer.country,
    customer.contact_name ? `Kontakt: ${customer.contact_name}` : "",
    customer.email,
    customer.phone
  ].filter(Boolean);
  return lines.length ? lines.map((line) => escapeHtml(line)).join("<br>") : "Uppgift saknas";
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

export function humanDocumentNumber(kind: DocumentKind, raw: string | null | undefined, date?: string | null): string {
  const value = String(raw ?? "").trim();
  const year = /^\d{4}/.test(String(date ?? "")) ? String(date).slice(0, 4) : String(new Date().getFullYear());
  const prefix = kind === "invoice" ? "INV" : "OFF";
  if (new RegExp(`^${prefix}-\\d{4}-\\d{4,}$`, "i").test(value)) return value.toUpperCase();
  const numeric = value.match(/\d+/g)?.join("").slice(-4);
  const sequence = numeric && Number(numeric) > 0 ? Number(numeric) : checksum(value || `${prefix}-${year}`);
  return `${prefix}-${year}-${String(sequence).padStart(4, "0")}`;
}

function humanReference(raw: string | null | undefined, date?: string | null): string {
  const value = String(raw ?? "").trim();
  if (!value) return "Ej angiven";
  if (/^off[_-]/i.test(value)) return humanDocumentNumber("offer", value, date);
  if (/^(inv|test)[_-]/i.test(value)) return humanDocumentNumber("invoice", value, date);
  const year = /^\d{4}/.test(String(date ?? "")) ? String(date).slice(0, 4) : String(new Date().getFullYear());
  if (/^sord[_-]/i.test(value)) return `ORDER-${year}-${String(checksum(value)).padStart(4, "0")}`;
  return value;
}

function checksum(value: string) {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) sum = (sum * 31 + value.charCodeAt(index)) % 10000;
  return sum || 1;
}

function billingLabel(row: DocumentLine) {
  if (row.billing_type === "RECURRING") return row.billing_interval === "YEAR" ? "Löpande / år" : "Löpande / mån";
  return "Engång";
}

function recurringAnnualNetMinor(rows: DocumentLine[]): number {
  return rows
    .filter((row) => row.billing_type === "RECURRING")
    .reduce((sum, row) => sum + (row.billing_interval === "YEAR" ? lineNetMinor(row) : lineNetMinor(row) * 12), 0);
}

function recurringAnnualVatMinor(rows: DocumentLine[]): number {
  return rows
    .filter((row) => row.billing_type === "RECURRING")
    .reduce((sum, row) => sum + (row.billing_interval === "YEAR" ? lineVatMinor(row) : lineVatMinor(row) * 12), 0);
}

function documentCss() {
  return `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#12233f;background:#eef2f8}*{box-sizing:border-box}body{margin:0}.docShell{max-width:980px;margin:0 auto;padding:28px 16px 72px}.docPage{position:relative;background:#fff;color:#12233f;min-height:1120px;margin:0 auto 28px;padding:34px 42px 56px;border:1px solid #d8e0ec;box-shadow:0 18px 60px rgba(18,35,63,.10)}.docPage:last-child{margin-bottom:0}.docTop{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:start;border-bottom:2px solid #12233f;padding-bottom:16px;margin-bottom:18px}.wordmark{display:flex;align-items:center;gap:10px;font-size:25px;font-weight:900;letter-spacing:0}.wordmark span{display:inline-grid;place-items:center;width:34px;height:34px;background:#1d4ed8;color:#fff;border-radius:3px}.docKicker,.docMetaLabel,.miniLabel{color:#51617a;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.docKind{text-align:right}.docKind h1{font-size:36px;line-height:1;margin:6px 0 0;letter-spacing:0}.docMeta{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 18px}.docMeta div,.docPanel{border-top:1px solid #cbd6e4;padding-top:10px}.docMeta strong,.docPanel strong{display:block;margin-top:4px;font-size:15px}.addresses{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:18px 0 22px}.addressText{line-height:1.38;margin:6px 0 0;color:#273957}.heroTitle{margin:12px 0 6px;font-size:23px;letter-spacing:0}.intro{font-size:14px;line-height:1.36;color:#344761;max-width:720px}.sectionTitle{font-size:16px;margin:18px 0 8px;break-after:avoid}.docTable{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}.docTable th{text-align:left;color:#51617a;font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #aebbd0;padding:7px 6px}.docTable td{border-bottom:1px solid #e4e9f1;padding:8px 6px;vertical-align:top;break-inside:avoid}.docTable tr{break-inside:avoid}.docTable small{display:block;color:#607089;margin-top:3px}.number{text-align:right;white-space:nowrap}.summaryBlock{display:grid;grid-template-columns:1fr 280px;gap:20px;margin-top:18px;align-items:start}.summaryLines{border-top:2px solid #12233f;padding-top:8px}.summaryLines div{display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid #dce4ef;padding:6px 0}.summaryLines .totalLine{font-size:17px;font-weight:900;color:#0f2f67;border-bottom:2px solid #1d4ed8}.noteBlock{border-left:3px solid #1d4ed8;padding:4px 0 4px 14px;color:#344761;line-height:1.55}.scopeGrid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px}.bullets{margin:8px 0 0;padding-left:18px;line-height:1.36;color:#273957}.bullets li{margin:3px 0;break-inside:avoid}.processGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 18px}.processStep{border:1px solid #d8e0ec;padding:10px;break-inside:avoid}.processStep span{display:inline-grid;place-items:center;width:22px;height:22px;background:#1d4ed8;color:#fff;font-size:12px;font-weight:900;margin-bottom:8px}.processStep p{margin:4px 0 0;color:#43536d;font-size:11px;line-height:1.34}.termsIntro{border-left:3px solid #1d4ed8;padding-left:12px;margin:4px 0 12px;color:#344761}.termsList{columns:3;column-gap:18px}.termItem{break-inside:avoid;margin:0 0 5px;padding:0 0 5px;border-bottom:1px solid #e4e9f1}.termItem h3{font-size:10.5px;margin:0 0 2px}.termItem p{font-size:8.8px;line-height:1.24;margin:0;color:#354761}.approvalGrid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:12px}.approvalGrid div{border-top:1px solid #cbd6e4;padding-top:8px;min-height:54px}.paymentBox{display:grid;grid-template-columns:1fr 220px;gap:24px;background:#f7f9fc;border:1px solid #d8e0ec;padding:14px;margin-top:18px}.paymentTotal{background:#12233f;color:#fff;padding:16px}.paymentTotal span{color:#a9c7ff}.paymentTotal strong{display:block;font-size:22px;margin-top:4px}.fine{font-size:11px;color:#607089;line-height:1.45}.docFooter{position:absolute;left:42px;right:42px;bottom:24px;display:flex;justify-content:space-between;gap:14px;border-top:1px solid #d8e0ec;padding-top:10px;color:#607089;font-size:10.5px}.acceptBlock{margin-top:20px;border:1px solid #d8e0ec;padding:14px}.acceptBlock h2{margin-top:0}.acceptBlock input{width:100%;border:1px solid #cbd6e4;padding:10px;margin:4px 0 10px}.acceptBlock button{background:#12233f;color:#fff;border:0;padding:11px 14px;font-weight:800}.check{display:block;margin:8px 0 12px}.mutedRow{color:#607089}.pageBreak{break-after:page;page-break-after:always}.noBreak{break-inside:avoid}.technicalRef{color:#607089;font-size:10px;margin-top:5px}.invoicePage{min-height:1040px}@media(max-width:760px){.docShell{padding:0;background:#fff}.docPage{min-height:auto;margin:0 0 16px;padding:24px 18px 72px;border:0;box-shadow:none}.docTop,.addresses,.summaryBlock,.paymentBox{display:block}.docKind{text-align:left;margin-top:14px}.docMeta,.scopeGrid,.processGrid,.approvalGrid{grid-template-columns:1fr}.termsList{columns:1}.docTable{font-size:12px}.docTable th:nth-child(4),.docTable td:nth-child(4),.docTable th:nth-child(6),.docTable td:nth-child(6){display:none}.number{text-align:left}.docFooter{left:18px;right:18px}}@page{size:A4;margin:16mm 14mm}@media print{body{background:#fff}.docShell{max-width:none;padding:0}.docPage{width:auto;min-height:calc(297mm - 32mm);height:auto;margin:0;padding:0 0 18mm;border:0;box-shadow:none;break-after:page;page-break-after:always}.docPage:last-child{break-after:auto;page-break-after:auto}.docFooter{left:0;right:0;bottom:0}.acceptBlock{display:none}.sectionTitle,.heroTitle{break-after:avoid}.docTable tr,.termItem,.processStep,.docPanel{break-inside:avoid}}`;
}

function renderRows(rows: DocumentLine[], currency: string) {
  if (!rows.length) return "";
  return rows.map((row) => `<tr>
    <td style="width:32%"><strong>${escapeHtml(row.description)}</strong><small>${escapeHtml(row.article_number || billingLabel(row))}</small></td>
    <td>${escapeHtml(String(row.quantity))} ${escapeHtml(row.unit || "st")}</td>
    <td class="number">${formatMinor(row.unit_price_minor, currency)}</td>
    <td class="number">${escapeHtml(String(row.discount_percent ?? 0))}%</td>
    <td class="number">${escapeHtml(String(row.vat_percent ?? 0))}%</td>
    <td class="number">${formatMinor(lineNetMinor(row), currency)}</td>
    <td class="number"><strong>${formatMinor(lineGrossMinor(row), currency)}</strong></td>
  </tr>`).join("");
}

function renderRowsTable(title: string, rows: DocumentLine[], currency: string) {
  if (!rows.length) return "";
  return `<h3 class="sectionTitle">${escapeHtml(title)}</h3>
    <table class="docTable">
      <thead><tr><th>Beskrivning</th><th>Antal</th><th class="number">À-pris</th><th class="number">Rabatt</th><th class="number">Moms</th><th class="number">Netto</th><th class="number">Belopp</th></tr></thead>
      <tbody>${renderRows(rows, currency)}</tbody>
    </table>`;
}

function docHeader(kind: string, displayNumber: string, rawNumber: string, company: CompanyProfile, label: string) {
  return `<header class="docTop">
    <div><div class="wordmark"><span>W</span>${escapeHtml(company.brand_name)}</div><p class="fine">${escapeHtml(company.legal_name)} · ${escapeHtml(label)}</p></div>
    <div class="docKind"><small>${escapeHtml(kind)}</small><h1>${escapeHtml(displayNumber)}</h1><p class="technicalRef">Intern referens: ${escapeHtml(rawNumber)}</p></div>
  </header>`;
}

function footer(page: string, reference: string, company: CompanyProfile) {
  return `<footer class="docFooter"><span>${escapeHtml(company.brand_name)} · ${escapeHtml(company.website)}</span><span>${escapeHtml(page)} · Ref ${escapeHtml(reference)}</span></footer>`;
}

function renderShell(kind: string, title: string, body: string): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(kind)} ${escapeHtml(title)}</title><style>${documentCss()}</style></head><body><main class="docShell">${body}</main></body></html>`;
}

function list(items: string[]) {
  return `<ul class="bullets">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderOfferDocument(env: Env, input: OfferDocumentInput): string {
  const company = input.company ?? webblyftetCompanyProfile(env);
  const terms = input.terms ?? demoOfferTerms;
  const currency = input.currency ?? "SEK";
  const displayNumber = humanDocumentNumber("offer", input.document_number, input.document_date);
  const oneTimeRows = input.rows.filter((row) => row.billing_type !== "RECURRING");
  const recurringRows = input.rows.filter((row) => row.billing_type === "RECURRING");
  const totals = documentTotals(input.rows);
  const scope = offerScopeForRows(input.rows);
  const reference = `${displayNumber}${input.version_number ? ` v${input.version_number}` : ""}`;
  const oneTimeSummary = oneTimeRows.length ? `
    <div><span>Engång netto</span><strong>${formatMinor(totals.oneTime.net, currency)}</strong></div>
    <div><span>Moms engång</span><strong>${formatMinor(totals.oneTime.vat, currency)}</strong></div>
    <div class="totalLine"><span>Engång totalt inkl. moms</span><strong>${formatMinor(totals.oneTime.gross, currency)}</strong></div>` : "";
  const recurringSummary = recurringRows.length ? `
    <div><span>Recurring/mån exkl. moms</span><strong>${formatMinor(totals.recurringMonthly.net, currency)}</strong></div>
    <div><span>Recurring/mån inkl. moms</span><strong>${formatMinor(totals.recurringMonthly.gross, currency)}</strong></div>
    <div><span>Recurring/år inkl. moms</span><strong>${formatMinor(totals.recurringAnnual.gross, currency)}</strong></div>` : "";

  const page1 = `<article class="docPage pageBreak">
    ${docHeader("OFFERT", displayNumber, input.document_number, company, input.test_label ?? "Demo/test-offert")}
    <section class="docMeta noBreak">
      <div><span class="docMetaLabel">Offertdatum</span><strong>${escapeHtml(input.document_date)}</strong></div>
      <div><span class="docMetaLabel">Giltig till</span><strong>${escapeHtml(input.valid_until || "Ej angivet")}</strong></div>
      <div><span class="docMetaLabel">Version</span><strong>${escapeHtml(input.version_number ?? "Draft")}</strong></div>
      <div><span class="docMetaLabel">Säljare</span><strong>${escapeHtml(input.seller_name || "Webblyftet")}</strong></div>
    </section>
    <section class="addresses noBreak"><div class="docPanel"><span class="docMetaLabel">Från</span><p class="addressText">${companyBlock(company)}</p></div><div class="docPanel"><span class="docMetaLabel">Till</span><p class="addressText">${addressBlock(input.customer)}</p></div></section>
    <h2 class="heroTitle">${escapeHtml(input.title || `Offert för ${input.customer.name || "kund"}`)}</h2>
    <p class="intro">Tack för möjligheten att lämna offert. Nedan sammanfattas föreslagen lösning, investering och löpande tjänster för ${escapeHtml(input.customer.name || "ert företag")}.</p>
    ${renderRowsTable("Engångstjänster", oneTimeRows, currency)}
    ${renderRowsTable("Löpande tjänster", recurringRows, currency)}
    <section class="summaryBlock noBreak">
      <div class="noteBlock"><span class="docMetaLabel">Särskilda villkor / noteringar</span><p>${escapeHtml(input.remarks || "Inga särskilda villkor angivna för denna offert.")}</p></div>
      <div class="summaryLines">${oneTimeSummary}${recurringSummary}</div>
    </section>
    ${footer("Sida 1 av 3", reference, company)}
  </article>`;

  const page2 = `<article class="docPage pageBreak">
    ${docHeader("OFFERT", displayNumber, input.document_number, company, "Omfattning och leverans")}
    <h2 class="heroTitle">Omfattning och leverans</h2>
    <section class="docPanel noBreak"><span class="docMetaLabel">Sammanfattning av uppdraget</span><p class="intro">${escapeHtml(scope.assignmentSummary)}</p></section>
    <section class="scopeGrid">
      ${scope.baselineItems.length ? `<div class="docPanel"><h3 class="sectionTitle">${escapeHtml(scope.baselineTitle)}</h3>${list(scope.baselineItems)}</div>` : ""}
      ${scope.serviceItems.length ? `<div class="docPanel"><h3 class="sectionTitle">${escapeHtml(scope.serviceTitle)}</h3>${list(scope.serviceItems)}</div>` : ""}
    </section>
    <h3 class="sectionTitle">Projektprocess</h3>
    <section class="processGrid">${scope.processSteps.map((step, index) => `<div class="processStep"><span>${index + 1}</span><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.body)}</p></div>`).join("")}</section>
    <section class="scopeGrid">
      <div class="docPanel"><h3 class="sectionTitle">Kundens förutsättningar</h3>${list(scope.customerResponsibilities)}</div>
      <div class="docPanel"><h3 class="sectionTitle">Normalt inte inkluderat om inget annat avtalats</h3>${list(scope.exclusions)}</div>
    </section>
    ${footer("Sida 2 av 3", reference, company)}
  </article>`;

  const signerName = input.signer?.name || input.customer.contact_name || "";
  const page3 = `<article class="docPage">
    ${docHeader("OFFERT", displayNumber, input.document_number, company, "Villkor och förutsättningar")}
    <h2 class="heroTitle">Villkor och förutsättningar</h2>
    <p class="termsIntro"><strong>Villkorsversion: ${escapeHtml(terms.version)}</strong><br>${escapeHtml(terms.label)} Dessa villkor är demo-villkor och ska juridiskt granskas innan production.</p>
    <section class="termsList">${terms.sections.map((section, index) => `<div class="termItem"><h3>${index + 1}. ${escapeHtml(section.title)}</h3><p>${escapeHtml(section.body)}</p></div>`).join("")}</section>
    <section class="docPanel noBreak">
      <h3 class="sectionTitle">Godkännande</h3>
      <p class="intro">Genom digital signering i Finance Test bekräftar kunden att offertens omfattning, priser och villkor har granskats och accepterats. Riktig BankID-signering kommer senare.</p>
      <div class="approvalGrid">
        <div><span class="miniLabel">Kundföretag</span><strong>${escapeHtml(input.customer.name || "")}</strong></div>
        <div><span class="miniLabel">Kontaktperson</span><strong>${escapeHtml(signerName || "Ej signerad")}</strong></div>
        <div><span class="miniLabel">Titel/roll</span><strong>${escapeHtml(input.signer?.title || "Ej angiven")}</strong></div>
        <div><span class="miniLabel">Datum</span><strong>${escapeHtml(input.signer?.signed_at ? input.signer.signed_at.slice(0, 10) : "")}</strong></div>
        <div><span class="miniLabel">Signeringsstatus</span><strong>${escapeHtml(input.signer?.status || "Demo-signering")}</strong></div>
      </div>
    </section>
    ${input.acceptFormHtml ? `<section class="acceptBlock">${input.acceptFormHtml}</section>` : ""}
    ${footer("Sida 3 av 3", reference, company)}
  </article>`;

  return renderShell("Offert", displayNumber, `${page1}${page2}${page3}`);
}

export function renderInvoiceDocument(env: Env, input: InvoiceDocumentInput): string {
  const company = input.company ?? webblyftetCompanyProfile(env);
  const currency = input.currency ?? "SEK";
  const displayNumber = humanDocumentNumber("invoice", input.document_number, input.invoice_date);
  const roundoff = input.roundoff_minor ?? input.total_minor - input.subtotal_minor - input.vat_total_minor;
  const body = `<article class="docPage invoicePage">
    ${docHeader("FAKTURA", displayNumber, input.document_number, company, "Finance Test faktura")}
    <section class="docMeta noBreak">
      <div><span class="docMetaLabel">Fakturadatum</span><strong>${escapeHtml(input.invoice_date)}</strong></div>
      <div><span class="docMetaLabel">Förfallodatum</span><strong>${escapeHtml(input.due_date || "Ej angivet")}</strong></div>
      <div><span class="docMetaLabel">Betalningsvillkor</span><strong>${escapeHtml(input.payment_terms_days ?? company.payment_terms_days)} dagar</strong></div>
      <div><span class="docMetaLabel">Status</span><strong>${escapeHtml(input.status || "DRAFT")}</strong></div>
    </section>
    <section class="addresses noBreak"><div class="docPanel"><span class="docMetaLabel">Från</span><p class="addressText">${companyBlock(company)}</p></div><div class="docPanel"><span class="docMetaLabel">Till</span><p class="addressText">${addressBlock(input.customer)}</p></div></section>
    <section class="docMeta noBreak">
      <div><span class="docMetaLabel">Kundnummer</span><strong>${escapeHtml(input.customer.org_number || "Ej angivet")}</strong></div>
      <div><span class="docMetaLabel">Order/offertreferens</span><strong>${escapeHtml(humanReference(input.sales_order_reference || input.source_offer_reference, input.invoice_date))}</strong></div>
      <div><span class="docMetaLabel">Fortnox</span><strong>${escapeHtml(input.fortnox_document_number || "Ej synkad")}</strong></div>
      <div><span class="docMetaLabel">Säljare/referens</span><strong>${escapeHtml(input.seller_name || "Webblyftet")}</strong></div>
    </section>
    ${renderRowsTable("Fakturarader", input.rows, currency)}
    <section class="paymentBox noBreak">
      <div><span class="docMetaLabel">Betalningsinformation</span><p class="addressText">Förfallodatum: ${escapeHtml(input.due_date || "Ej angivet")}<br>OCR/referens: ${escapeHtml(displayNumber)}<br>Bankgiro: ${escapeHtml(company.bankgiro)}${company.iban ? `<br>IBAN: ${escapeHtml(company.iban)}` : ""}${company.bic ? `<br>BIC: ${escapeHtml(company.bic)}` : ""}</p><p class="fine">Testuppgifter i Finance Test. Använd inte som skarpa betalningsuppgifter.</p></div>
      <div class="paymentTotal"><span>Att betala</span><strong>${formatMinor(input.balance_minor, currency)}</strong><small>Förfaller ${escapeHtml(input.due_date || "ej angivet")}</small></div>
    </section>
    <section class="summaryBlock noBreak">
      <div class="noteBlock"><span class="docMetaLabel">Dokumentstatus</span><p>${escapeHtml(input.status || "DRAFT")} · Fortnox ${escapeHtml(input.fortnox_document_number || "ej synkad")} · Finance Test</p></div>
      <div class="summaryLines">
        <div><span>Subtotal</span><strong>${formatMinor(input.subtotal_minor, currency)}</strong></div>
        <div><span>Moms</span><strong>${formatMinor(input.vat_total_minor, currency)}</strong></div>
        <div><span>Avrundning</span><strong>${formatMinor(roundoff, currency)}</strong></div>
        <div class="totalLine"><span>Att betala</span><strong>${formatMinor(input.balance_minor, currency)}</strong></div>
      </div>
    </section>
    ${footer("Sida 1 av 1", displayNumber, company)}
  </article>`;
  return renderShell("Faktura", displayNumber, body);
}

export function renderOfferEmailPreview(input: OfferDocumentInput): string {
  const currency = input.currency ?? "SEK";
  const totals = documentTotals(input.rows);
  const displayNumber = humanDocumentNumber("offer", input.document_number, input.document_date);
  const recurringAnnualNet = recurringAnnualNetMinor(input.rows);
  const recurringAnnualVat = recurringAnnualVatMinor(input.rows);
  return `Din offert från Webblyftet\n\nHej ${input.customer.contact_name || input.customer.name || ""},\n\nTack för ett trevligt möte. Här är en sammanfattning av lösningen vi har gått igenom.\n\nKundföretag: ${input.customer.name || "-"}\nOffert: ${displayNumber}\nGiltig till: ${input.valid_until || "-"}\nEngångskostnad: ${formatMinor(totals.oneTime.net, currency)} exkl. moms\nMoms engång: ${formatMinor(totals.oneTime.vat, currency)}\nÅterkommande per månad: ${formatMinor(totals.recurringMonthly.net, currency)} exkl. moms\nMoms per månad: ${formatMinor(totals.recurringMonthly.vat, currency)}\nÅterkommande årspris: ${formatMinor(recurringAnnualNet, currency)} exkl. moms\nMoms per år: ${formatMinor(recurringAnnualVat, currency)}\n\nCTA: Granska och godkänn offerten\nSekundärt: Visa fullständig offert\n\nDetta är ett Finance Test-demo-mail.`;
}

export function renderOfferEmail(input: OfferDocumentInput, customerOrderUrl: string): { subject: string; html: string; text: string } {
  const company = input.company ?? webblyftetCompanyProfile({} as Env);
  const currency = input.currency ?? "SEK";
  const totals = documentTotals(input.rows);
  const recurringAnnualNet = recurringAnnualNetMinor(input.rows);
  const recurringAnnualVat = recurringAnnualVatMinor(input.rows);
  const displayNumber = humanDocumentNumber("offer", input.document_number, input.document_date);
  const contact = input.customer.contact_name || input.customer.name || "";
  const subject = `Din offert från ${company.brand_name}: ${input.title || displayNumber}`;
  const rowSummary = input.rows.map((row) => `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #e2e8f0"><strong>${escapeHtml(row.description)}</strong><br><span style="color:#51617a">${escapeHtml(row.billing_type === "RECURRING" ? "Återkommande" : "Engång")} · ${escapeHtml(String(row.quantity))} ${escapeHtml(row.unit || "st")}</span></td>
    <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right"><strong>${formatMinor(lineNetMinor(row), currency)}</strong><br><span style="color:#51617a">exkl. moms · moms ${formatMinor(lineVatMinor(row), currency)}</span></td>
  </tr>`).join("");
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#eef2f8;color:#12233f;font-family:Inter,Arial,sans-serif">
    <main style="max-width:720px;margin:0 auto;padding:28px 16px">
      <section style="background:#fff;border:1px solid #d8e0ec;padding:30px">
        <div style="font-size:24px;font-weight:900;margin-bottom:18px"><span style="display:inline-block;background:#1d4ed8;color:#fff;border-radius:3px;padding:6px 10px;margin-right:8px">W</span>${escapeHtml(company.brand_name)}</div>
        <p>Hej ${escapeHtml(contact)},</p>
        <p>Tack för ett trevligt möte. Här är offerten för ${escapeHtml(input.customer.name || "ert företag")}.</p>
        <table style="width:100%;border-collapse:collapse;margin:22px 0">
          <tr><td style="color:#51617a">Offert</td><td style="text-align:right"><strong>${escapeHtml(displayNumber)}</strong></td></tr>
          <tr><td style="color:#51617a">Offertdatum</td><td style="text-align:right">${escapeHtml(input.document_date)}</td></tr>
          <tr><td style="color:#51617a">Giltig till</td><td style="text-align:right">${escapeHtml(input.valid_until || "-")}</td></tr>
        </table>
        <table style="width:100%;border-collapse:collapse">${rowSummary || `<tr><td>Inga rader.</td></tr>`}</table>
        <section style="margin:22px 0;padding:16px;background:#f7f9fc;border-left:3px solid #1d4ed8">
          <div>Engångskostnad exkl. moms: <strong>${formatMinor(totals.oneTime.net, currency)}</strong></div>
          <div style="color:#51617a;font-size:13px">Moms engång: <strong>${formatMinor(totals.oneTime.vat, currency)}</strong></div>
          <div style="margin-top:8px">Återkommande per månad exkl. moms: <strong>${formatMinor(totals.recurringMonthly.net, currency)}</strong></div>
          <div style="color:#51617a;font-size:13px">Moms per månad: <strong>${formatMinor(totals.recurringMonthly.vat, currency)}</strong></div>
          <div style="margin-top:8px">Återkommande årspris exkl. moms: <strong>${formatMinor(recurringAnnualNet, currency)}</strong></div>
          <div style="color:#51617a;font-size:13px">Moms per år: <strong>${formatMinor(recurringAnnualVat, currency)}</strong></div>
        </section>
        <p><a href="${escapeHtml(customerOrderUrl)}" style="display:inline-block;background:#12233f;color:#fff;text-decoration:none;border-radius:3px;padding:12px 16px;font-weight:800">Granska och godkänn offerten</a></p>
        <p style="color:#51617a;font-size:13px;line-height:1.5">Detta är ett testmail från Finance Test. Om knappen inte fungerar kan du kopiera länken: ${escapeHtml(customerOrderUrl)}</p>
      </section>
    </main>
  </body></html>`;
  const text = [
    `Din offert från ${company.brand_name}`,
    "",
    `Hej ${contact},`,
    "",
    `Kundföretag: ${input.customer.name || "-"}`,
    `Offert: ${displayNumber}`,
    `Offertdatum: ${input.document_date}`,
    `Giltig till: ${input.valid_until || "-"}`,
    `Engångskostnad: ${formatMinor(totals.oneTime.net, currency)} exkl. moms`,
    `Moms engång: ${formatMinor(totals.oneTime.vat, currency)}`,
    `Återkommande per månad: ${formatMinor(totals.recurringMonthly.net, currency)} exkl. moms`,
    `Moms per månad: ${formatMinor(totals.recurringMonthly.vat, currency)}`,
    `Återkommande årspris: ${formatMinor(recurringAnnualNet, currency)} exkl. moms`,
    `Moms per år: ${formatMinor(recurringAnnualVat, currency)}`,
    "",
    "Granska och godkänn offerten:",
    customerOrderUrl
  ].join("\n");
  return { subject, html, text };
}

export function renderInvoiceEmailPreview(input: InvoiceDocumentInput): string {
  const currency = input.currency ?? "SEK";
  const displayNumber = humanDocumentNumber("invoice", input.document_number, input.invoice_date);
  return `Din faktura från Webblyftet\n\nHej ${input.customer.contact_name || input.customer.name || ""},\n\nHär kommer en sammanfattning av fakturan.\n\nFakturanummer: ${displayNumber}\nFakturadatum: ${input.invoice_date}\nFörfallodatum: ${input.due_date || "-"}\nBelopp att betala: ${formatMinor(input.balance_minor, currency)}\n\nCTA: Visa faktura\n\nDetta är ett Finance Test-demo-mail.`;
}

export function renderInvoiceEmail(input: InvoiceDocumentInput, invoiceUrl: string): { subject: string; html: string; text: string } {
  const company = input.company ?? webblyftetCompanyProfile({} as Env);
  const currency = input.currency ?? "SEK";
  const displayNumber = humanDocumentNumber("invoice", input.document_number, input.invoice_date);
  const contact = input.customer.contact_name || input.customer.name || "";
  const subject = `Din faktura från ${company.brand_name}: ${displayNumber}`;
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#eef2f8;color:#12233f;font-family:Inter,Arial,sans-serif">
    <main style="max-width:720px;margin:0 auto;padding:28px 16px">
      <section style="background:#fff;border:1px solid #d8e0ec;padding:30px">
        <div style="font-size:24px;font-weight:900;margin-bottom:18px"><span style="display:inline-block;background:#1d4ed8;color:#fff;border-radius:3px;padding:6px 10px;margin-right:8px">W</span>${escapeHtml(company.brand_name)}</div>
        <p>Hej ${escapeHtml(contact)},</p>
        <p>Här kommer fakturan för ${escapeHtml(input.customer.name || "ert företag")}.</p>
        <table style="width:100%;border-collapse:collapse;margin:22px 0">
          <tr><td style="color:#51617a;padding:4px 0">Fakturanummer</td><td style="text-align:right"><strong>${escapeHtml(displayNumber)}</strong></td></tr>
          <tr><td style="color:#51617a;padding:4px 0">Fakturadatum</td><td style="text-align:right">${escapeHtml(input.invoice_date)}</td></tr>
          <tr><td style="color:#51617a;padding:4px 0">Förfallodatum</td><td style="text-align:right">${escapeHtml(input.due_date || "-")}</td></tr>
          <tr><td style="color:#51617a;padding:4px 0">Att betala</td><td style="text-align:right"><strong>${formatMinor(input.balance_minor, currency)}</strong></td></tr>
        </table>
        <p><a href="${escapeHtml(invoiceUrl)}" style="display:inline-block;background:#12233f;color:#fff;text-decoration:none;border-radius:3px;padding:12px 16px;font-weight:800">Visa faktura</a></p>
        <p style="color:#51617a;font-size:13px;line-height:1.5">Detta är ett testmail från Finance Test. Om knappen inte fungerar kan du kopiera länken: ${escapeHtml(invoiceUrl)}</p>
      </section>
    </main>
  </body></html>`;
  const text = [
    `Din faktura från ${company.brand_name}`,
    "",
    `Hej ${contact},`,
    "",
    `Kundföretag: ${input.customer.name || "-"}`,
    `Fakturanummer: ${displayNumber}`,
    `Fakturadatum: ${input.invoice_date}`,
    `Förfallodatum: ${input.due_date || "-"}`,
    `Belopp att betala: ${formatMinor(input.balance_minor, currency)}`,
    "",
    "Visa faktura:",
    invoiceUrl
  ].join("\n");
  return { subject, html, text };
}

export function renderConfirmationEmail(input: {
  company?: CompanyProfile;
  customer_name?: string | null;
  contact_name?: string | null;
  order_reference?: string | null;
  offer_reference?: string | null;
  signed_at?: string | null;
  subscription_active?: boolean;
  invoice_numbers?: string[];
}): { subject: string; html: string; text: string } {
  const company = input.company ?? webblyftetCompanyProfile({} as Env);
  const customer = input.customer_name || "ert företag";
  const contact = input.contact_name || customer;
  const subject = `Bekräftelse från ${company.brand_name}`;
  const invoiceText = input.invoice_numbers?.length ? input.invoice_numbers.join(", ") : "Ingen engångsfaktura i detta flöde";
  const subscriptionText = input.subscription_active ? "Abonnemanget är aktivt." : "Inget aktivt abonnemang i detta flöde.";
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#eef2f8;color:#12233f;font-family:Inter,Arial,sans-serif">
    <main style="max-width:720px;margin:0 auto;padding:28px 16px">
      <section style="background:#fff;border:1px solid #d8e0ec;padding:30px">
        <div style="font-size:24px;font-weight:900;margin-bottom:18px"><span style="display:inline-block;background:#1d4ed8;color:#fff;border-radius:3px;padding:6px 10px;margin-right:8px">W</span>${escapeHtml(company.brand_name)}</div>
        <p>Hej ${escapeHtml(contact)},</p>
        <p>Vi bekräftar att beställningen för ${escapeHtml(customer)} är klar i Finance Test.</p>
        <ul>
          <li>Order: ${escapeHtml(input.order_reference || "-")}</li>
          <li>Offert: ${escapeHtml(input.offer_reference || "-")}</li>
          <li>Signering: ${escapeHtml(input.signed_at || "Klar")}</li>
          <li>${escapeHtml(subscriptionText)}</li>
          <li>Faktura: ${escapeHtml(invoiceText)}</li>
        </ul>
        <p style="color:#51617a;font-size:13px;line-height:1.5">Detta är en testbekräftelse från Finance Test.</p>
      </section>
    </main>
  </body></html>`;
  const text = [
    `Bekräftelse från ${company.brand_name}`,
    "",
    `Hej ${contact},`,
    "",
    `Beställningen för ${customer} är klar i Finance Test.`,
    `Order: ${input.order_reference || "-"}`,
    `Offert: ${input.offer_reference || "-"}`,
    `Signering: ${input.signed_at || "Klar"}`,
    subscriptionText,
    `Faktura: ${invoiceText}`
  ].join("\n");
  return { subject, html, text };
}
