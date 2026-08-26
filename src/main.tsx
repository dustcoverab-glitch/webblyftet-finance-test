import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BadgeCheck, BookOpen, CheckCircle2, CircleAlert, Clock3, FileCheck2, FileText, Gauge, PlugZap,
  Package, Plus, ReceiptText, RefreshCw, Repeat, Search, Trash2, Users, WalletCards
} from "lucide-react";
import { api, post } from "./api";
import {
  classifyCustomerOrderLoadError,
  customerOrderRenderFallbackCopy,
  normalizeCustomerOrderView,
  type CustomerOrderLoadStatus
} from "./customer-order/view-model";
import { copyFeedbackText, copyTextToClipboard, type CopyState } from "./lib/clipboard";
import "@fontsource-variable/instrument-sans";
import "./styles.css";

type Customer = {
  id: string; name: string; org_number?: string; email?: string; phone?: string;
  city?: string; fortnox_customer_number?: string; sync_status: string;
};
type Offer = {
  id: string; title: string; customer_name: string; total: number; status: string;
  fortnox_document_number?: string; offer_date: string; sync_status: string;
};
type Invoice = {
  id: string; customer_name: string; customer_id?: string; invoice_number?: string; total: number; balance?: number; status: string;
  fortnox_document_number?: string; due_date?: string; invoice_date?: string; invoice_type?: string; sync_status?: string;
  sales_order_id?: string; source_offer_id?: string; subtotal_minor?: number; vat_total_minor?: number; total_minor?: number; balance_minor?: number;
};
type Product = {
  id: string; name: string; description: string; product_type: string; active: number; prices: string | any[];
};
type ProductPrice = {
  id: string; amount: number; currency: string; billing_type: "ONE_TIME" | "RECURRING";
  billing_interval?: "MONTH" | "YEAR" | null; vat_percent?: number; active?: number; stripe_price_id?: string | null;
};
type Subscription = {
  id: string; customer_name: string; status: string; monthly_amount: number; current_period_end?: string;
  customer_id?: string; stripe_subscription_id?: string; cancel_at_period_end?: number; items: string | any[];
};
type IntegrationStatus = {
  configured?: boolean;
  connected: boolean;
  company_name?: string;
  tenant_id?: string;
  scope?: string;
};
type StripePaymentAction = {
  required?: boolean;
  type?: string;
  client_secret?: string | null;
};
type CustomerOrderSession = {
  id: string;
  status: string;
  expires_at: string;
  reviewed_at?: string | null;
  signed_at?: string | null;
  completed_at?: string | null;
  signer_name?: string | null;
  document_hash: string;
  snapshot: any;
  requirements: {
    signing_required: boolean;
    payment_method_required: boolean;
    activation_required: boolean;
  };
  payment_method?: any;
  invoices: any[];
  subscriptions: any[];
  stripe_configured: boolean;
  activation_error?: string | null;
  payment_action?: StripePaymentAction | null;
};
type OfferEditorRow = {
  id: string;
  price_id: string;
  product_id: string;
  description: string;
  quantity: string;
  unit_price_minor: number;
  discount_percent: string;
  vat_percent: string;
  billing_type: "ONE_TIME" | "RECURRING";
  billing_interval: "MONTH" | "YEAR" | "";
};

function money(value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 0 });
}

function cents(value: number | null | undefined) {
  return money(Number(value ?? 0) / 100);
}

function jsonArray(value: string | any[] | null | undefined) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try { return JSON.parse(value).filter(Boolean); } catch { return []; }
}

function parseMoneyInputToMinor(value: string | number | null | undefined) {
  const normalized = String(value ?? "0").replace(",", ".").trim();
  const match = normalized.match(/^(-?\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return 0;
  const whole = Number(match[1]) * 100;
  const fraction = Number((match[2] ?? "").padEnd(2, "0").slice(0, 2));
  return whole + (whole < 0 ? -fraction : fraction);
}

function minorToInput(value: number) {
  return (value / 100).toFixed(2).replace(/\.00$/, "");
}

function moneyMinor(value: number | null | undefined) {
  return cents(value ?? 0);
}

function newOfferRow(): OfferEditorRow {
  return {
    id: crypto.randomUUID(),
    price_id: "",
    product_id: "",
    description: "",
    quantity: "1",
    unit_price_minor: 0,
    discount_percent: "0",
    vat_percent: "25",
    billing_type: "ONE_TIME",
    billing_interval: ""
  };
}

function lineNetMinor(row: Pick<OfferEditorRow, "quantity" | "unit_price_minor" | "discount_percent">) {
  const quantity = Math.max(0, Math.round(Number(row.quantity || 0) * 10000));
  const discountBasisPoints = Math.max(0, Math.min(10000, Math.round(Number(row.discount_percent || 0) * 100)));
  const gross = Math.round(row.unit_price_minor * quantity / 10000);
  return Math.round(gross * (10000 - discountBasisPoints) / 10000);
}

function lineVatMinor(row: Pick<OfferEditorRow, "quantity" | "unit_price_minor" | "discount_percent" | "vat_percent">) {
  return Math.round(lineNetMinor(row) * Number(row.vat_percent || 0) / 100);
}

function offerTotals(rows: OfferEditorRow[]) {
  const empty = { net: 0, vat: 0, gross: 0 };
  const totals = {
    oneTime: { ...empty },
    recurringMonth: { ...empty },
    recurringYear: { ...empty },
    recurringMonthlyEquivalent: { ...empty }
  };
  for (const row of rows) {
    const net = lineNetMinor(row);
    const vat = lineVatMinor(row);
    const gross = net + vat;
    const bucket = row.billing_type === "RECURRING"
      ? row.billing_interval === "YEAR" ? totals.recurringYear : totals.recurringMonth
      : totals.oneTime;
    bucket.net += net; bucket.vat += vat; bucket.gross += gross;
    if (row.billing_type === "RECURRING") {
      const divisor = row.billing_interval === "YEAR" ? 12 : 1;
      totals.recurringMonthlyEquivalent.net += Math.round(net / divisor);
      totals.recurringMonthlyEquivalent.vat += Math.round(vat / divisor);
      totals.recurringMonthlyEquivalent.gross += Math.round(gross / divisor);
    }
  }
  return totals;
}

function productPriceOptions(products: Product[]) {
  return products.flatMap((product) => jsonArray(product.prices).map((price: ProductPrice) => ({
    product,
    price,
    label: `${product.name} · ${moneyMinor(price.amount)} · ${price.billing_type}${price.billing_interval ? `/${price.billing_interval}` : ""}`
  })));
}

async function stripeJs(publishableKey: string) {
  if (!document.querySelector('script[src="https://js.stripe.com/v3/"]')) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Stripe.js kunde inte laddas."));
      document.head.appendChild(script);
    });
  }
  return (window as any).Stripe(publishableKey);
}

type NavItem = [string, string, React.ComponentType<{ size?: number }>];
type NavGroup = { label: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  { label: "Översikt", items: [["/", "Översikt", Gauge]] },
  { label: "Försäljning", items: [["/contract-flow/new", "Avtalskedja", BadgeCheck], ["/customers", "Kunder", Users], ["/offers", "Offerter", FileCheck2]] },
  { label: "Ekonomi", items: [["/invoices", "Fakturor", FileText], ["/subscriptions", "Abonnemang", Repeat], ["/products", "Produkter & priser", Package]] },
  { label: "Bokföring", items: [["/receipts", "Kvitton", ReceiptText], ["/supplier-invoices", "Leverantörsfakturor", WalletCards], ["/bookkeeping", "Bokföring", BookOpen]] },
  { label: "Integrationer", items: [["/integration", "Fortnox", PlugZap]] }
];

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const current = navGroups.flatMap((group) => group.items).find(([to]) => to === "/" ? location.pathname === "/" : location.pathname.startsWith(to));
  return <div className="shell">
    <aside>
      <div className="brand"><div className="brandMark">W</div><div><strong>Webblyftet</strong><span>Finance</span></div></div>
      <div className="testBadge">TESTMILJÖ</div>
      <nav className="sideNav">{navGroups.map((group) => <div className="navGroup" key={group.label}>
        <span className="navGroupLabel">{group.label}</span>
        {group.items.map(([to, label, Icon]) =>
          <NavLink key={to} to={to} end={to === "/"}><Icon size={17}/><span>{label}</span></NavLink>
        )}
      </div>)}</nav>
      <div className="asideFoot"><strong>Finance Core</strong><small>Cloudflare Worker · D1 · R2</small></div>
    </aside>
    <main>
      <div className="topbar">
        <div className="breadcrumb"><span>Finance</span><span>/</span><strong>{current?.[1] ?? "Arbetsyta"}</strong></div>
        <div className="topbarMeta"><span>Testmiljö</span><span>{new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })}</span></div>
      </div>
      <div className="pageCanvas">{children}</div>
    </main>
  </div>;
}

function PageHead({ title, subtitle, action, eyebrow }: { title: string; subtitle?: string; action?: React.ReactNode; eyebrow?: string }) {
  return <div className="pageHead"><div>{eyebrow && <div className="pageEyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action && <div className="pageActions">{action}</div>}</div>;
}
function Card({ children, className="" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}
function EmptyState({ title, text, action }: { title: string; text?: string; action?: React.ReactNode }) {
  return <div className="emptyState"><CircleAlert size={18}/><div><strong>{title}</strong>{text && <p>{text}</p>}{action}</div></div>;
}
function ErrorNotice({ message, action }: { message: string; action?: React.ReactNode }) {
  return <div className="errorNotice"><CircleAlert size={18}/><div><strong>{message}</strong>{action}</div></div>;
}
function Status({ value }: { value: string }) {
  const normalized = String(value || "UNKNOWN").toUpperCase();
  const good = ["SYNCED","PAID","ACCEPTED","CONNECTED","ACTIVE","SUCCEEDED","OK","READY","EXPORTED"].includes(normalized);
  const warning = ["DRAFT","PENDING","LOCAL_ONLY","WAITING","UNPAID","INCOMPLETE","REQUIRES_ACTION"].includes(normalized);
  const danger = ["FAILED","ERROR","OVERDUE","PAST_DUE","CANCELLED","CREDITED","NOT CONFIGURED"].includes(normalized);
  return <span className={`status ${good ? "good" : ""} ${warning ? "warning" : ""} ${danger ? "dangerStatus" : ""}`}>{value || "UNKNOWN"}</span>;
}

function displayDate(value?: string | null) {
  return value ? value.slice(0, 10) : "—";
}

function displayDateTime(value?: string | null) {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

function invoiceLabel(invoice: Partial<Invoice>) {
  return invoice.invoice_number || invoice.fortnox_document_number || invoice.id || "—";
}

function minorField(row: any, minorKey: string, moneyKey: string) {
  const moneyValue = row?.[moneyKey];
  const moneyAsMinor = moneyValue == null ? null : Math.round(Number(moneyValue) * 100);
  const storedMinor = row?.[minorKey] == null ? null : Number(row[minorKey]);
  if (moneyAsMinor != null && storedMinor != null && Math.abs(moneyAsMinor - storedMinor) > 0) return moneyAsMinor;
  return storedMinor ?? moneyAsMinor ?? 0;
}

function rowTotalMinor(row: any) {
  const unitPrice = row.unit_price_minor ?? parseMoneyInputToMinor(row.unit_price);
  const net = lineNetMinor({
    quantity: String(row.quantity ?? 1),
    unit_price_minor: unitPrice,
    discount_percent: String(row.discount_percent ?? 0)
  });
  return net + Math.round(net * Number(row.vat_percent ?? 0) / 100);
}

function Metric({ label, value, hint, to }: { label: string; value: React.ReactNode; hint?: React.ReactNode; to?: string }) {
  const inner = <><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</>;
  return to ? <Link className="card metricCard clickable" to={to}>{inner}</Link> : <Card className="metricCard">{inner}</Card>;
}

function StatusChain({ status }: { status: string }) {
  const normalized = String(status || "DRAFT").toUpperCase();
  const steps = ["DRAFT", "SENT/SYNCED", "PAID", "OVERDUE", "CREDITED"];
  const activeIndex = normalized === "SYNCED" || normalized === "SENT" || normalized === "UNPAID" ? 1
    : normalized === "PAID" ? 2
    : normalized === "OVERDUE" ? 3
    : normalized === "CREDITED" || normalized === "CANCELLED" ? 4
    : 0;
  return <div className="statusChain">{steps.map((step, index) =>
    <div key={step} className={`statusStep ${index < activeIndex ? "done" : ""} ${index === activeIndex ? "active" : ""}`}>
      <span>{index + 1}</span><strong>{step}</strong>
    </div>
  )}</div>;
}

function InvoiceTimeline({ invoice }: { invoice: any }) {
  const events = [
    { label: "Skapad", time: invoice.created_at, status: "OK" },
    { label: invoice.fortnox_document_number ? "Synkad/skickad" : "Synk saknas", time: invoice.last_synced_at, status: invoice.fortnox_document_number ? "SYNCED" : "PENDING" },
    { label: "Förfallen", time: invoice.status === "OVERDUE" || (invoice.due_date && invoice.due_date < new Date().toISOString().slice(0,10) && !["PAID","CREDITED","CANCELLED"].includes(String(invoice.status).toUpperCase())) ? invoice.due_date : null, status: "OVERDUE" },
    { label: "Betald", time: invoice.payments?.find((payment:any) => payment.status === "SUCCEEDED")?.paid_at || (invoice.status === "PAID" ? invoice.updated_at : null), status: "PAID" }
  ];
  return <div className="timeline">{events.map((event) => <div key={event.label} className={`timelineItem ${event.time ? "filled" : ""}`}>
    <span/><div><strong>{event.label}</strong><small>{event.time ? displayDate(event.time) : "Ingen timestamp"}</small></div>
  </div>)}</div>;
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString("sv-SE", { month: "short" }).replace(".", "");
}

function lastSixMonths() {
  const now = new Date();
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

function MiniTrend({ invoices = [], payments = [] }: { invoices?: any[]; payments?: any[] }) {
  const invoiceMap = new Map(invoices.map((row) => [row.month, Number(row.invoiced_minor ?? 0)]));
  const paymentMap = new Map(payments.map((row) => [row.month, Number(row.paid_minor ?? 0)]));
  const points = lastSixMonths().map((month) => ({
    month,
    invoiced: invoiceMap.get(month) ?? 0,
    paid: paymentMap.get(month) ?? 0
  }));
  const max = Math.max(1, ...points.flatMap((point) => [point.invoiced, point.paid]));
  return <div className="trendPanel">
    <div className="panelHead"><div><h3>Ekonomiöversikt</h3><p>Fakturerat och betalt senaste 6 månaderna</p></div><span>SEK</span></div>
    <div className="trendBars">{points.map((point) => <div className="trendMonth" key={point.month} title={`${monthLabel(point.month)}: fakturerat ${moneyMinor(point.invoiced)}, betalt ${moneyMinor(point.paid)}`}>
      <div className="trendStack">
        <span className="bar invoiced" style={{ height: `${Math.max(4, point.invoiced / max * 100)}%` }} />
        <span className="bar paid" style={{ height: `${Math.max(4, point.paid / max * 100)}%` }} />
      </div>
      <small>{monthLabel(point.month)}</small>
    </div>)}</div>
    <div className="legend"><span><i className="legendInvoiced"/>Fakturerat</span><span><i className="legendPaid"/>Betalt</span></div>
  </div>;
}

function activityTarget(item: any) {
  if (item.entity_type === "invoice") return `/invoices/${item.entity_id}`;
  if (item.entity_type === "offer") return `/offers/${item.entity_id}`;
  if (item.entity_type === "subscription") return `/subscriptions/${item.entity_id}`;
  if (item.entity_type === "customer") return `/customers/${item.entity_id}`;
  return "";
}

function groupSyncAttention(items: any[] = []) {
  const groups = new Map<string, any>();
  for (const item of items) {
    const key = `${item.operation || "SYNC"}:${item.entity_type || "unknown"}:${item.status || "ERROR"}`;
    const timestamp = item.created_at || item.updated_at || "";
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        id: `sync-${item.id || key}`,
        to: "/integration",
        title: item.entity_type === "FORTNOX_INBOX" ? "Fortnox Inbox-fel" : "Integrationsfel",
        operation: item.operation || "SYNC",
        entityType: item.entity_type || "unknown",
        status: "ERROR",
        count: 1,
        latest: timestamp
      });
    } else {
      current.count += 1;
      if (timestamp && (!current.latest || String(timestamp) > String(current.latest))) current.latest = timestamp;
    }
  }
  return Array.from(groups.values()).map((item) => ({
    id: item.id,
    to: item.to,
    title: item.count > 1 ? `${item.title} x ${item.count}` : item.title,
    meta: `${item.operation} · ${item.entityType}${item.count > 1 ? ` · senaste ${displayDateTime(item.latest)}` : ""}`,
    status: item.status
  }));
}

function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => { api("/api/dashboard").then(setData).catch((err) => setError(err.message)); }, []);
  if (error) return <ErrorNotice message={error}/>;
  if (!data) return <EmptyState title="Hämtar översikt" text="Läser Finance Core, Stripe-status och Fortnox-status." />;
  const failedOrPastDue = Number(data.payments?.failed_payments ?? 0) + Number(data.payments?.past_due_subscriptions ?? 0);
  const statusCounts = new Map((data.subscriptionStatus ?? []).map((row:any) => [row.status, Number(row.count ?? 0)]));
  const active = Number(statusCounts.get("ACTIVE") ?? 0);
  const pending = Number(statusCounts.get("PENDING") ?? 0);
  const pastDue = Number(statusCounts.get("PAST_DUE") ?? 0);
  const canceling = Number(data.subscriptions?.cancel_at_period_end ?? 0);
  const subscriptionTotal = Math.max(1, active + pending + pastDue + canceling);
  const attention = [
    ...(data.attention?.invoices ?? []).map((item:any) => ({
      id: `invoice-${item.id}`,
      to: `/invoices/${item.id}`,
      title: item.due_date && item.due_date < new Date().toISOString().slice(0,10) ? "Förfallen faktura" : "Faktura behöver synk",
      meta: `${item.customer_name} · ${invoiceLabel(item)}`,
      status: item.status
    })),
    ...(data.attention?.payments ?? []).map((item:any) => ({
      id: `payment-${item.id}`,
      to: "/subscriptions",
      title: "Misslyckad betalning",
      meta: `${item.customer_name} · ${moneyMinor(item.amount)}`,
      status: item.status
    })),
    ...(data.attention?.subscriptions ?? []).map((item:any) => ({
      id: `subscription-${item.id}`,
      to: `/subscriptions/${item.id}`,
      title: "Subscription past due",
      meta: `${item.customer_name} · ${item.stripe_subscription_id || item.id}`,
      status: item.status
    })),
    ...(data.attention?.orders ?? []).map((item:any) => ({
      id: `order-${item.id}`,
      to: "/customers",
      title: "Order i partial failure",
      meta: `${item.customer_name} · ${item.id}`,
      status: item.status
    })),
    ...groupSyncAttention(data.attention?.sync ?? [])
  ].slice(0, 8);
  const recentActivity = <Card><div className="panelHead"><div><h3>Senaste aktivitet</h3><p>Business, audit och ekonomihändelser</p></div></div>
    <div className="activityList">
      {(data.audit ?? []).slice(0, 8).map((item:any) => {
        const to = activityTarget(item);
        const content = <><FileText size={15}/><div><strong>{item.action}</strong><small>{item.entity_type} · {item.entity_id}</small></div><span>{displayDate(item.created_at)}</span></>;
        return to ? <Link key={item.id} to={to} className="activityRow">{content}</Link> : <div key={item.id} className="activityRow">{content}</div>;
      })}
      {!data.audit?.length && <EmptyState title="Ingen aktivitet ännu" text="När offerter, order, fakturor eller betalningar skapas visas de här." />}
    </div>
  </Card>;
  return <>
    <PageHead title="Översikt" eyebrow="Finance Control Center" subtitle="Operativ testöversikt för kundfordringar, fakturering och abonnemang."
      action={<div className="quickActions"><Link to="/customers" className="button ghost small"><Users size={14}/>Ny kund</Link><Link to="/offers" className="button ghost small"><FileCheck2 size={14}/>Ny offert</Link><Link to="/invoices" className="button ghost small">Fakturor</Link><Link to="/subscriptions" className="button ghost small">Abonnemang</Link></div>} />
    <div className="integrationStrip compact">
      <div><span>Stripe</span><Status value={data.stripe?.configured ? "CONNECTED" : "NOT CONFIGURED"}/></div>
      <div><span>Fortnox</span><Status value={data.connection?.connected ? "CONNECTED" : data.connection?.configured === false ? "NOT CONFIGURED" : "WAITING"}/><small>{data.connection?.company_name || "Ingen bolagsinfo"}</small></div>
      <div><span>Senaste sync</span><strong>{displayDateTime(data.logs?.[0]?.created_at)}</strong></div>
      <div><span>D1/R2</span><Status value="OK"/></div>
    </div>
    <div className="metricGrid">
      <Metric label="Fakturerat projektvärde" value={money(data.projectInvoices?.value)} hint={`${data.projectInvoices?.count ?? 0} projektfakturor`} to="/invoices?filter=project" />
      <Metric label="Utestående kundfordringar" value={moneyMinor(data.receivables?.outstanding_minor)} hint={`${data.receivables?.unpaid_count ?? 0} obetalda`} to="/invoices?filter=outstanding" />
      <Metric label="Aktiv MRR" value={moneyMinor(data.subscriptions?.mrr_minor)} hint={`ARR ${moneyMinor((data.subscriptions?.mrr_minor ?? 0) * 12)}`} to="/subscriptions" />
      <Metric label="Aktiva abonnemang" value={active} hint={`${pending} pending · ${pastDue} past due`} to="/subscriptions" />
      <Metric label="Obetalda/förfallna" value={data.receivables?.overdue_count ?? 0} hint={`${failedOrPastDue} failed/past due payments`} to="/invoices?filter=overdue" />
      <Metric label="Accepterad pipeline" value={money(data.offers?.accepted_value)} hint={`${data.offers?.count ?? 0} offerter totalt`} to="/offers" />
    </div>
    <div className="dashboardFocusGrid">
      <Card className="attentionCard">
        <div className="panelHead"><div><h3>Kräver uppmärksamhet</h3><p>Prioriterade avvikelser i testmiljön</p></div>{attention.length ? <CircleAlert size={18}/> : <CheckCircle2 size={18}/>}</div>
        {attention.length ? <div className="attentionList">{attention.map((item:any) =>
          <Link key={item.id} to={item.to} className="attentionRow"><div><strong>{item.title}</strong><small>{item.meta}</small></div><Status value={item.status}/></Link>
        )}</div> : <div className="goodState"><CheckCircle2 size={18}/><span>Inga akuta avvikelser i testmiljön</span></div>}
      </Card>
      {recentActivity}
    </div>
    <div className="controlGrid">
      <Card><MiniTrend invoices={data.trend?.invoices} payments={data.trend?.payments}/></Card>
      <Card><div className="panelHead"><div><h3>Kundfordringar</h3><p>Cash och receivables</p></div><Clock3 size={18}/></div>
        <div className="cashGrid">
          <Link to="/invoices?filter=outstanding"><span>Totalt utestående</span><strong>{moneyMinor(data.receivables?.outstanding_minor)}</strong></Link>
          <Link to="/invoices?filter=due-soon"><span>Förfaller inom 7 dagar</span><strong>{moneyMinor(data.receivables?.due_soon_minor)}</strong></Link>
          <Link to="/invoices?filter=overdue"><span>Förfallet</span><strong>{moneyMinor(data.receivables?.overdue_minor)}</strong></Link>
          <div><span>Betalt senaste 30 dagar</span><strong>{moneyMinor(data.receivables?.paid_30d_minor)}</strong></div>
        </div>
      </Card>
      <Card><div className="panelHead"><div><h3>Subscription Pulse</h3><p>Statusfördelning och MRR</p></div><Repeat size={18}/></div>
        <div className="pulseBar">
          <Link to="/subscriptions?filter=active" className="pulse active" style={{ flexGrow: Math.max(1, active) }} title={`Active ${active}`}/>
          <Link to="/subscriptions?filter=pending" className="pulse pending" style={{ flexGrow: Math.max(1, pending) }} title={`Pending ${pending}`}/>
          <Link to="/subscriptions?filter=past_due" className="pulse dangerPulse" style={{ flexGrow: Math.max(1, pastDue) }} title={`Past due ${pastDue}`}/>
        </div>
        <div className="pulseStats">
          <Link to="/subscriptions?filter=active"><span>Active</span><strong>{active}</strong></Link>
          <Link to="/subscriptions?filter=pending"><span>Pending</span><strong>{pending}</strong></Link>
          <Link to="/subscriptions?filter=past_due"><span>Past due</span><strong>{pastDue}</strong></Link>
          <div><span>MRR</span><strong>{moneyMinor(data.subscriptions?.mrr_minor)}</strong></div>
        </div>
        <p className="muted">{canceling} avslutas vid periodslut · fördelning viktad på {subscriptionTotal} subscriptions.</p>
      </Card>
      <Card><div className="panelHead"><div><h3>Ekonomiska events</h3><p>Senaste accounting-ready händelserna</p></div><BookOpen size={18}/></div>
        <div className="activityList">
          {(data.events ?? []).slice(0, 8).map((event:any) => <Link key={event.id} to={event.entity_type === "invoice" ? `/invoices/${event.entity_id}` : event.entity_type === "payment" ? "/subscriptions" : "/bookkeeping"} className="activityRow">
            <FileCheck2 size={15}/><div><strong>{event.event_type}</strong><small>{event.entity_type} · {moneyMinor(event.gross_amount)}</small></div><Status value={event.status}/>
          </Link>)}
          {!data.events?.length && <EmptyState title="Inga accounting events" text="Finance Core skapar händelser när fakturor och betalningar uppstår." />}
        </div>
      </Card>
    </div>
  </>;
}

function Customers() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const load = () => api<Customer[]>("/api/customers").then(setRows);
  useEffect(() => { load().catch(console.error); }, []);
  const filtered = rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [row.name, row.org_number, row.email, row.fortnox_customer_number].some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await post("/api/customers", {
      name: f.get("name"), org_number: f.get("org_number"), email: f.get("email"),
      phone: f.get("phone"), address1: f.get("address1"), zip: f.get("zip"), city: f.get("city"),
      payment_terms_days: 30, notes: ""
    });
    setOpen(false); await load();
  }
  return <>
    <PageHead title="Kunder" subtitle="Lokalt kundregister med Fortnox-ID och synkstatus."
      action={<div className="actions"><button className="ghost" onClick={async()=>{await post("/api/customers/pull"); await load();}}><RefreshCw size={16}/>Hämta Fortnox</button><button onClick={()=>setOpen(!open)}>Ny kund</button></div>} />
    {open && <Card><form onSubmit={submit} className="formGrid">
      <input name="name" placeholder="Företagsnamn" required/><input name="org_number" placeholder="Org.nr"/>
      <input name="email" placeholder="E-post"/><input name="phone" placeholder="Telefon"/>
      <input name="address1" placeholder="Adress"/><input name="zip" placeholder="Postnummer"/>
      <input name="city" placeholder="Ort"/><button type="submit">Spara kund</button>
    </form></Card>}
    <Card><div className="tableTools customerTools"><label className="searchBox"><Search size={15}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Sök kund, org.nr, e-post eller Fortnox-ID"/></label></div>
      <table><thead><tr><th>Kund</th><th>Kontakt</th><th>Ort</th><th>Fortnox</th><th></th></tr></thead><tbody>
      {filtered.map(r=><tr key={r.id} className="clickRow" onClick={()=>navigate(`/customers/${r.id}`)}><td><strong>{r.name}</strong><small>{r.org_number}</small></td>
        <td>{r.phone}<small>{r.email}</small></td><td>{r.city}</td><td><Status value={r.sync_status}/><small>{r.fortnox_customer_number}</small></td>
        <td><div className="rowActions"><Link className="button small ghost" to={`/customers/${r.id}`} onClick={(event)=>event.stopPropagation()}>Visa</Link>{!r.fortnox_customer_number && <button className="small" onClick={async(event)=>{event.stopPropagation(); await post(`/api/customers/${r.id}/sync`); await load();}}>Synka</button>}</div></td></tr>)}
      {!filtered.length && <tr><td colSpan={5}><EmptyState title="Inga kunder matchar" text="Rensa sökningen eller skapa en ny testkund." /></td></tr>}
    </tbody></table></Card>
  </>;
}

function CustomerDetail() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [customerOrderLink, setCustomerOrderLink] = useState("");
  const [customerOrderCopyState, setCustomerOrderCopyState] = useState<CopyState>("IDLE");
  const load = () => api<any>(`/api/customers/${id}`).then(setData);
  useEffect(() => { load().catch((err)=>setError(err.message)); }, [id]);
  if (error) return <ErrorNotice message={error}/>;
  if (!data) return <EmptyState title="Hämtar kund" text="Samlar erbjudanden, order, fakturor, subscriptions och payments." />;
  const c = data.customer;
  const metrics = data.metrics ?? {};
  async function createOrderLink(orderId: string) {
    const result = await post<{ url: string; expires_at: string }>(`/api/sales-orders/${orderId}/customer-session`);
    setCustomerOrderLink(result.url);
    setCustomerOrderCopyState("IDLE");
    await load();
  }
  async function copyCustomerOrderLink() {
    setCustomerOrderCopyState(await copyTextToClipboard(customerOrderLink));
  }
  return <>
    <PageHead title={c.name} subtitle="Kunddetalj med offerter, order, fakturor, abonnemang och audit."
      action={<div className="actions"><Link className="button ghost" to={`/payment-method/${c.id}`}>Kortregistrering</Link><button onClick={async()=>{await post(`/api/customers/${c.id}/stripe-customer`); await load();}}>Skapa Stripe Customer</button></div>} />
    <div className="metricGrid">
      <Metric label="Såld engångsomsättning" value={moneyMinor(metrics.one_time_sold_minor)} hint={`${data.orders.length} sales orders`} />
      <Metric label="Aktiv MRR" value={moneyMinor(metrics.active_mrr_minor)} hint={`${metrics.active_subscription_count ?? 0} aktiva abonnemang`} />
      <Metric label="Outstanding invoices" value={moneyMinor(metrics.outstanding_minor)} hint={`${data.invoices.filter((invoice:any)=>!["PAID","CANCELLED","CREDITED"].includes(String(invoice.status).toUpperCase())).length} öppna av ${data.invoices.length}`} />
      <Metric label="Senaste betalning" value={metrics.latest_payment ? moneyMinor(metrics.latest_payment.amount) : "—"} hint={metrics.latest_payment ? `${metrics.latest_payment.status} · ${displayDate(metrics.latest_payment.paid_at || metrics.latest_payment.created_at)}` : "ingen betalning"} />
    </div>
    <Card>
      <h3>Kontakt</h3>
      <div className="infoGrid">
        <div><span>Org.nr</span><strong>{c.org_number || "—"}</strong></div>
        <div><span>E-post</span><strong>{c.email || "—"}</strong></div>
        <div><span>Telefon</span><strong>{c.phone || "—"}</strong></div>
        <div><span>Ort</span><strong>{c.city || "—"}</strong></div>
        <div><span>Fortnox kundnr</span><strong>{c.fortnox_customer_number || "Ej synkad"}</strong></div>
        <div><span>Synkstatus</span><Status value={c.sync_status}/></div>
      </div>
    </Card>
    <div className="twoCol">
      <Card><h3>Offerter</h3><table><thead><tr><th>Offert</th><th>Datum</th><th>Belopp</th><th>Status</th></tr></thead><tbody>
        {data.offers.map((offer:any)=><tr key={offer.id}><td><Link to={`/offers/${offer.id}`}>{offer.title || "Offert"}</Link><small>{offer.id}</small></td><td>{displayDate(offer.offer_date)}</td><td>{money(offer.total)}</td><td><Status value={offer.status}/></td></tr>)}
        {!data.offers.length && <tr><td colSpan={4}><EmptyState title="Inga offerter" text="Skapa en offert när kunden ska få ett kommersiellt förslag." /></td></tr>}
      </tbody></table></Card>
      <Card><h3>Sales orders</h3>{customerOrderLink && <div className="copyNotice"><strong>Kundlänken är redo</strong><input readOnly value={customerOrderLink} onFocus={(event)=>event.currentTarget.select()}/><div className="copyActions"><button className="ghost small" onClick={copyCustomerOrderLink}>Kopiera länk</button><a className="button ghost small" href={customerOrderLink} target="_blank" rel="noopener noreferrer">Öppna kundvy</a></div>{customerOrderCopyState !== "IDLE" && <small>{copyFeedbackText(customerOrderCopyState)}</small>}</div>}<table><thead><tr><th>Order</th><th>Engång</th><th>MRR</th><th>Onboarding</th><th>Status</th><th></th></tr></thead><tbody>
        {data.orders.map((order:any)=>{
          const latestSession = order.customer_order_sessions?.[0];
          return <tr key={order.id}><td>{order.id}<small>{displayDate(order.created_at)}</small></td><td>{moneyMinor(order.one_time_total_minor)}</td><td>{moneyMinor(order.recurring_monthly_minor)}</td><td><Status value={latestSession?.status || "NOT SENT"}/><small>{latestSession ? `Giltig till ${displayDate(latestSession.expires_at)}` : "Ingen kundlänk"}</small></td><td><Status value={order.status}/></td><td><button className="small ghost" onClick={()=>createOrderLink(order.id)}>Skapa kundlänk</button></td></tr>;
        })}
        {!data.orders.length && <tr><td colSpan={6}><EmptyState title="Inga sales orders" text="Sales orders skapas när en offert accepteras." /></td></tr>}
      </tbody></table></Card>
    </div>
    <Card><h3>Fakturor</h3><table><thead><tr><th>Faktura</th><th>Typ</th><th>Förfallo</th><th>Total</th><th>Saldo</th><th>Status</th><th></th></tr></thead><tbody>
      {data.invoices.map((inv:any)=><tr key={inv.id}><td><Link to={`/invoices/${inv.id}`}>{invoiceLabel(inv)}</Link><small>{inv.fortnox_document_number || "Ej Fortnox-synkad"}</small></td><td>{inv.invoice_type || "PROJECT_INVOICE"}</td><td>{displayDate(inv.due_date)}</td><td>{money(inv.total)}</td><td>{money(inv.balance)}</td><td><Status value={inv.status}/></td><td>{!inv.fortnox_document_number && <button className="small" onClick={async()=>{await post(`/api/invoices/${inv.id}/sync-fortnox`); await load();}}>Sync Fortnox</button>}</td></tr>)}
      {!data.invoices.length && <tr><td colSpan={7}><EmptyState title="Inga fakturor" text="Projektfakturor skapas från accepterade offerter." /></td></tr>}
    </tbody></table></Card>
    <div className="twoCol">
      <Card><h3>Abonnemang</h3><table><thead><tr><th>Subscription</th><th>Stripe</th><th>Status</th><th></th></tr></thead><tbody>
        {data.subscriptions.map((s:any)=><tr key={s.id}><td><Link to={`/subscriptions/${s.id}`}>{s.id}</Link><small>{s.offer_id || "utan offertlänk"}</small></td><td>{s.stripe_subscription_id || "Ej Stripe-aktiverad"}</td><td><Status value={s.status}/></td><td><button className="small" onClick={async()=>{await post(`/api/subscriptions/${s.id}/activate`); await load();}}>Aktivera</button></td></tr>)}
        {!data.subscriptions.length && <tr><td colSpan={4}><EmptyState title="Inga abonnemang" text="Recurring-rader i en accepterad offert skapar abonnemang." /></td></tr>}
      </tbody></table></Card>
      <Card><h3>Betalmetoder</h3><table><thead><tr><th>Kort</th><th>Status</th><th>Default</th></tr></thead><tbody>
        {data.payment_methods.map((method:any)=><tr key={method.id}><td>{method.brand || method.type}<small>{method.last4 ? `•••• ${method.last4}` : method.provider_payment_method_id}</small></td><td><Status value={method.status}/></td><td>{method.is_default ? "Ja" : "Nej"}</td></tr>)}
        {!data.payment_methods.length && <tr><td colSpan={3}><EmptyState title="Inga sparade betalmetoder" text="Registrera ett testkort innan subscription activation." action={<Link className="button small ghost" to={`/payment-method/${c.id}`}>Registrera kort</Link>} /></td></tr>}
      </tbody></table></Card>
    </div>
    <div className="twoCol">
      <Card><h3>Payments</h3><table><thead><tr><th>Payment</th><th>Belopp</th><th>Status</th><th>Betald</th></tr></thead><tbody>
        {data.payments.map((payment:any)=><tr key={payment.id}><td>{payment.provider}<small>{payment.provider_payment_id || payment.id}</small></td><td>{moneyMinor(payment.amount)}</td><td><Status value={payment.status}/></td><td>{displayDate(payment.paid_at || payment.created_at)}</td></tr>)}
        {!data.payments.length && <tr><td colSpan={4}><EmptyState title="Inga payments" text="Stripe-webhooks lägger payments här när testbetalningar sker." /></td></tr>}
      </tbody></table></Card>
      <Card><h3>Audit timeline</h3><div className="logList">{data.audit.map((a:any)=><div key={a.id}><span>{a.action}<small>{a.entity_type} · {a.entity_id}</small></span><small>{displayDateTime(a.created_at)}</small></div>)}{!data.audit.length && <EmptyState title="Ingen audit ännu" text="Kundens händelser visas här." />}</div></Card>
    </div>
  </>;
}

function Offers() {
  const [rows, setRows] = useState<Offer[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [open, setOpen] = useState(false);
  const [signLink, setSignLink] = useState<{ offerId: string; url: string; copyState: CopyState } | null>(null);
  const [editorRows, setEditorRows] = useState<OfferEditorRow[]>([newOfferRow()]);
  const load = async () => { setRows(await api("/api/offers")); setCustomers(await api("/api/customers")); setProducts(await api("/api/products")); };
  useEffect(() => { load().catch(console.error); }, []);
  const priceOptions = useMemo(() => productPriceOptions(products), [products]);
  const totals = useMemo(() => offerTotals(editorRows), [editorRows]);
  function updateEditorRow(id: string, patch: Partial<OfferEditorRow>) {
    setEditorRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }
  function selectPrice(id: string, priceId: string) {
    const option = priceOptions.find((item) => item.price.id === priceId);
    if (!option) {
      updateEditorRow(id, { price_id: "", product_id: "", unit_price_minor: 0, billing_type: "ONE_TIME", billing_interval: "", vat_percent: "25" });
      return;
    }
    updateEditorRow(id, {
      price_id: option.price.id,
      product_id: option.product.id,
      description: option.product.name,
      unit_price_minor: Number(option.price.amount ?? 0),
      billing_type: option.price.billing_type,
      billing_interval: option.price.billing_interval ?? "",
      vat_percent: String(option.price.vat_percent ?? 25)
    });
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const payloadRows = editorRows.map((row) => ({
      product_id: row.product_id || null,
      price_id: row.price_id || null,
      description: row.description,
      quantity: Number(row.quantity || 0),
      unit: "st",
      unit_price: row.price_id ? undefined : Number(minorToInput(row.unit_price_minor)),
      discount_percent: Number(row.discount_percent || 0),
      vat_percent: Number(row.vat_percent || 0),
      article_number: ""
    }));
    await post("/api/offers", {
      customer_id: f.get("customer_id"), title: f.get("title"), offer_date: f.get("offer_date"),
      expire_date: f.get("expire_date"), remarks: f.get("remarks"),
      rows: payloadRows
    }); setOpen(false); setEditorRows([newOfferRow()]); await load();
  }
  async function createSignLink(offerId: string) {
    const result:any = await post(`/api/offers/${offerId}/sign-link`);
    setSignLink({ offerId, url: result.url, copyState: "IDLE" });
  }
  async function copySignLink() {
    if (!signLink) return;
    setSignLink({ ...signLink, copyState: await copyTextToClipboard(signLink.url) });
  }
  return <>
    <PageHead title="Offerter" subtitle="Skapa lokalt, synka till Fortnox, acceptera och konvertera till faktura."
      action={<button onClick={()=>setOpen(!open)}>Ny offert</button>} />
    {open && <Card className="offerEditor"><form onSubmit={submit}>
      <div className="formGrid">
        <select name="customer_id" required><option value="">Välj kund</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input name="title" placeholder="Offerttitel" required/>
        <input type="date" name="offer_date" defaultValue={new Date().toISOString().slice(0,10)} required/>
        <input type="date" name="expire_date"/>
      </div>
      <div className="offerRows">
        <div className="offerRow offerRowHead"><span>Produkt/pris eller fri rad</span><span>Beskrivning</span><span>Antal</span><span>Pris exkl. moms</span><span>Rabatt</span><span>Moms</span><span>Typ</span><span>Radtotal</span><span></span></div>
        {editorRows.map((row) => <div className="offerRow" key={row.id}>
          <select value={row.price_id} onChange={(event)=>selectPrice(row.id, event.target.value)}>
            <option value="">Fri rad</option>
            {priceOptions.map((option) => <option key={option.price.id} value={option.price.id}>{option.label}</option>)}
          </select>
          <input value={row.description} onChange={(event)=>updateEditorRow(row.id, { description: event.target.value })} placeholder="Radbeskrivning" required/>
          <input value={row.quantity} onChange={(event)=>updateEditorRow(row.id, { quantity: event.target.value })} type="number" min="0.01" step="0.01" required/>
          <input value={minorToInput(row.unit_price_minor)} onChange={(event)=>updateEditorRow(row.id, { unit_price_minor: parseMoneyInputToMinor(event.target.value) })} type="number" min="0" step="0.01" disabled={Boolean(row.price_id)} required/>
          <input value={row.discount_percent} onChange={(event)=>updateEditorRow(row.id, { discount_percent: event.target.value })} type="number" min="0" max="100" step="0.01"/>
          <input value={row.vat_percent} onChange={(event)=>updateEditorRow(row.id, { vat_percent: event.target.value })} type="number" min="0" max="100" step="0.01"/>
          <div className="rowType"><Status value={row.billing_type}/>{row.billing_interval && <small>{row.billing_interval}</small>}</div>
          <strong>{moneyMinor(lineNetMinor(row) + lineVatMinor(row))}</strong>
          <button type="button" className="small ghost iconOnly" title="Ta bort rad" onClick={()=>setEditorRows((current)=>current.length === 1 ? [newOfferRow()] : current.filter((item)=>item.id !== row.id))}><Trash2 size={15}/></button>
        </div>)}
      </div>
      <div className="offerEditorFoot">
        <button type="button" className="ghost" onClick={()=>setEditorRows((current)=>[...current, newOfferRow()])}><Plus size={16}/>Lägg till rad</button>
        <input name="remarks" placeholder="Kommentar till offerten"/>
        <button type="submit">Skapa offert</button>
      </div>
      <div className="totalsGrid">
        <div className="totalTile"><span>Subtotal engång</span><strong>{moneyMinor(totals.oneTime.net)}</strong><small>Moms {moneyMinor(totals.oneTime.vat)}</small><b>{moneyMinor(totals.oneTime.gross)}</b></div>
        <div className="totalTile"><span>Återkommande / mån</span><strong>{moneyMinor(totals.recurringMonthlyEquivalent.net)}</strong><small>Moms {moneyMinor(totals.recurringMonthlyEquivalent.vat)}</small><b>{moneyMinor(totals.recurringMonthlyEquivalent.gross)}</b></div>
        <div className="totalTile"><span>Årspris återkommande</span><strong>{moneyMinor(totals.recurringMonth.gross * 12 + totals.recurringYear.gross)}</strong><small>Månadsrader annualiserade plus årsintervall</small></div>
      </div>
    </form></Card>}
    {signLink && <Card><div className="copyNotice"><strong>Signeringslänken är redo</strong><input readOnly value={signLink.url} onFocus={(event)=>event.currentTarget.select()}/><div className="copyActions"><button className="ghost small" onClick={copySignLink}>Kopiera länk</button><a className="button ghost small" href={signLink.url} target="_blank" rel="noopener noreferrer">Öppna signering</a></div>{signLink.copyState !== "IDLE" && <small>{copyFeedbackText(signLink.copyState)}</small>}</div></Card>}
    <Card><table><thead><tr><th>Offert</th><th>Kund</th><th>Belopp</th><th>Status</th><th>Fortnox</th><th>Åtgärder</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td><strong>{r.title || "Offert"}</strong><small>{r.offer_date}</small></td><td>{r.customer_name}</td>
      <td>{money(r.total)}</td><td><Status value={r.status}/></td><td>{r.fortnox_document_number || "—"}</td>
      <td><div className="rowActions">
        <Link className="button small ghost" to={`/offers/${r.id}`}>Visa</Link>
        {!r.fortnox_document_number && <button className="small" onClick={async()=>{await post(`/api/offers/${r.id}/sync`); await load();}}>Synka</button>}
        <button className="small ghost" onClick={()=>createSignLink(r.id)}>Signeringslänk</button>
        {r.fortnox_document_number && <button className="small" onClick={async()=>{await post(`/api/offers/${r.id}/create-invoice`); alert("Faktura skapad");}}>→ Faktura</button>}
      </div></td></tr>)}
    </tbody></table></Card>
  </>;
}

function OfferDetail() {
  const { id } = useParams();
  const [offer, setOffer] = useState<any>(null);
  const [acceptLink, setAcceptLink] = useState("");
  const [acceptLinkCopyState, setAcceptLinkCopyState] = useState<CopyState>("IDLE");
  const load = () => api<any>(`/api/offers/${id}`).then(setOffer);
  useEffect(() => { load().catch(console.error); }, [id]);
  if (!offer) return <div>Hämtar…</div>;
  const detailRows = offer.rows.map((row: any) => ({
    ...row,
    unit_price_minor: Number(row.unit_price_minor ?? parseMoneyInputToMinor(row.unit_price)),
    quantity: String(row.quantity),
    discount_percent: String(row.discount_percent ?? 0),
    vat_percent: String(row.vat_percent ?? 25),
    billing_type: row.billing_type ?? "ONE_TIME",
    billing_interval: row.billing_interval ?? ""
  })) as OfferEditorRow[];
  const oneTimeRows = detailRows.filter((row) => row.billing_type === "ONE_TIME");
  const recurringRows = detailRows.filter((row) => row.billing_type === "RECURRING");
  const totals = offerTotals(detailRows);
  const latestOrder = offer.orders?.[0];
  const latestAcceptance = offer.acceptances?.[0];
  async function createAcceptLink() {
    const result:any = await post(`/api/offers/${offer.id}/sign-link`);
    setAcceptLink(result.url);
    setAcceptLinkCopyState("IDLE");
    await load();
  }
  async function copyAcceptLink() {
    setAcceptLinkCopyState(await copyTextToClipboard(acceptLink));
  }
  return <>
    <PageHead title={offer.title || "Offert"} subtitle={`${offer.customer_name} · ${offer.status}`}
      action={<button onClick={createAcceptLink}>Skapa acceptlänk</button>} />
    {acceptLink && <Card><div className="copyNotice"><strong>Acceptlänken är redo</strong><input readOnly value={acceptLink} onFocus={(event)=>event.currentTarget.select()}/><div className="copyActions"><button className="ghost small" onClick={copyAcceptLink}>Kopiera länk</button><a className="button ghost small" href={acceptLink} target="_blank" rel="noopener noreferrer">Öppna signering</a></div>{acceptLinkCopyState !== "IDLE" && <small>{copyFeedbackText(acceptLinkCopyState)}</small>}</div></Card>}
    <div className="metricGrid">
      <Card><span>Engångskostnad</span><strong>{moneyMinor(totals.oneTime.gross)}</strong><small>exkl. moms {moneyMinor(totals.oneTime.net)}</small></Card>
      <Card><span>Återkommande / mån</span><strong>{moneyMinor(totals.recurringMonthlyEquivalent.gross)}</strong><small>månads-ekvivalent inkl. moms</small></Card>
      <Card><span>Acceptans</span><strong>{latestAcceptance ? "Accepterad" : offer.status}</strong><small>{offer.accepted_by_email || "Ingen acceptans ännu"}</small></Card>
      <Card><span>Order</span><strong>{latestOrder?.status ?? "Ej skapad"}</strong><small>{latestOrder?.id ?? "Skapas vid acceptans"}</small></Card>
    </div>
    <Card className="documentPreviewPanel">
      <div className="panelHead"><div><h3>Dokument</h3><p>Förhandsgranska exakt kundens offert och ett Webblyftet-brandat offertmail innan utskick.</p></div></div>
      <div className="documentActions">
        <a className="button ghost" href={`/api/offers/${offer.id}/document`} target="_blank" rel="noreferrer">Förhandsgranska offert</a>
        <a className="button ghost" href={`/api/offers/${offer.id}/document?format=email`} target="_blank" rel="noreferrer">Förhandsgranska mail</a>
        {offer.versions?.[0] && <span className="docVersion">Senaste version: {offer.versions[0].version_number}</span>}
      </div>
    </Card>
    <div className="twoCol">
      <Card><h3>Engångsposter</h3><OfferRowsTable rows={oneTimeRows}/></Card>
      <Card><h3>Abonnemangsposter</h3><OfferRowsTable rows={recurringRows}/></Card>
    </div>
    <div className="twoCol">
      <Card><h3>Totals</h3><div className="summaryList">
        <div><span>Engång subtotal</span><strong>{moneyMinor(totals.oneTime.net)}</strong></div>
        <div><span>Engång moms</span><strong>{moneyMinor(totals.oneTime.vat)}</strong></div>
        <div><span>Engång total</span><strong>{moneyMinor(totals.oneTime.gross)}</strong></div>
        <div><span>Återkommande per månad</span><strong>{moneyMinor(totals.recurringMonthlyEquivalent.gross)}</strong></div>
        <div><span>Återkommande årspris</span><strong>{moneyMinor(totals.recurringMonth.gross * 12 + totals.recurringYear.gross)}</strong></div>
      </div></Card>
      <Card><h3>Statuskedja</h3><div className="summaryList">
        <div><span>Offert</span><Status value={offer.status}/></div>
        <div><span>Acceptans</span><Status value={latestAcceptance ? "ACCEPTED" : "PENDING"}/></div>
        <div><span>Sales order</span><Status value={latestOrder?.status ?? "PENDING"}/></div>
        <div><span>Faktura</span><Status value={latestOrder?.invoices?.[0]?.status ?? "PENDING"}/></div>
        <div><span>Subscription</span><Status value={latestOrder?.subscriptions?.[0]?.status ?? "PENDING"}/></div>
      </div></Card>
    </div>
    <div className="twoCol">
      <Card><h3>Versioner</h3><div className="logList">{offer.versions.map((v:any)=><div key={v.id}><span>Version {v.version_number}</span><strong>{cents(v.total)}</strong></div>)}</div></Card>
      <Card><h3>Orderhistorik</h3><div className="logList">{offer.orders.map((o:any)=><div key={o.id}><span>{o.id}</span><Status value={o.status}/></div>)}</div></Card>
    </div>
    <Card><h3>Audit</h3><div className="logList">{offer.audit.map((a:any)=><div key={a.id}><span>{a.action}</span><small>{a.created_at}</small></div>)}</div></Card>
  </>;
}

function OfferRowsTable({ rows }: { rows: OfferEditorRow[] }) {
  if (!rows.length) return <p className="muted">Inga rader.</p>;
  return <table><thead><tr><th>Rad</th><th>Antal</th><th>Pris</th><th>Rabatt</th><th>Moms</th><th>Total</th></tr></thead><tbody>{rows.map((r:any)=>
    <tr key={r.id}><td>{r.description}<small>{r.product_id || "Fri rad"}</small></td><td>{r.quantity}</td><td>{moneyMinor(r.unit_price_minor)}</td><td>{r.discount_percent}%</td><td>{r.vat_percent}%</td><td><strong>{moneyMinor(lineNetMinor(r) + lineVatMinor(r))}</strong><small>{r.billing_interval || r.billing_type}</small></td></tr>)}</tbody></table>;
}

function flowItemToEditorRow(item: any): OfferEditorRow {
  return {
    id: crypto.randomUUID(),
    price_id: item.price_id || "",
    product_id: item.product_id || "",
    description: item.description || "",
    quantity: String(item.quantity ?? 1),
    unit_price_minor: Number(item.unit_price_minor ?? (item.unit_price ? parseMoneyInputToMinor(item.unit_price) : 0)),
    discount_percent: String(item.discount_percent ?? 0),
    vat_percent: String(item.vat_percent ?? 25),
    billing_type: "ONE_TIME",
    billing_interval: ""
  };
}

function hydrateFlowRows(editorRows: OfferEditorRow[], options: ReturnType<typeof productPriceOptions>) {
  return editorRows.map((row) => {
    if (!row.price_id) return row;
    const option = options.find((item) => item.price.id === row.price_id);
    return option ? {
      ...row,
      description: row.description || option.product.name,
      product_id: option.product.id,
      unit_price_minor: Number(option.price.amount ?? 0),
      billing_type: option.price.billing_type,
      billing_interval: option.price.billing_interval ?? "",
      vat_percent: String(option.price.vat_percent ?? row.vat_percent ?? 25)
    } : row;
  });
}

function editorRowsToPayload(rows: OfferEditorRow[]) {
  return rows.map((row) => ({
    product_id: row.product_id || null,
    price_id: row.price_id || null,
    description: row.description,
    quantity: Number(row.quantity || 0),
    unit: "st",
    unit_price_minor: row.unit_price_minor,
    unit_price: row.price_id ? undefined : Number(minorToInput(row.unit_price_minor)),
    discount_percent: Number(row.discount_percent || 0),
    vat_percent: Number(row.vat_percent || 0),
    article_number: "",
    source: row.price_id ? "PRODUCT_PRICE" : "FREE_ROW"
  }));
}

function ContractFlowNew() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function simulate() {
    setBusy(true); setError("");
    try {
      const flow:any = await post("/api/contract-flows/simulate");
      navigate(`/contract-flow/${flow.id}`);
    } catch (err:any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return <>
    <PageHead title="Avtalskedja" subtitle="Simulerad handoff från säljmöte till kundlänk, signering och subscription."
      action={<button onClick={simulate} disabled={busy}><BadgeCheck size={16}/>Simulera säljmöte</button>} />
    {error && <ErrorNotice message={error}/>}
    <div className="contractHero">
      <div>
        <span className="eyebrow">Sales closing workspace</span>
        <h2>Kunden säger ja. Säljaren startar kedjan.</h2>
        <p>Den här interna vyn simulerar exakt det handoff-kontrakt som stora portalen senare kan skicka, men utan extern integration ännu.</p>
      </div>
      <div className="flowPreview">
        <Status value="INTERNAL"/>
        <strong>Anderssons Bygg AB</strong>
        <small>Webblyftet Bas + Webblyftet Service</small>
      </div>
    </div>
  </>;
}

function ContractFlowWorkspace() {
  const { id } = useParams();
  const [flow, setFlow] = useState<any>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState("");
  const [customerLink, setCustomerLink] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("IDLE");
  const [saving, setSaving] = useState(false);
  const [sendingOffer, setSendingOffer] = useState(false);
  const [company, setCompany] = useState<any>({});
  const [contact, setContact] = useState<any>({});
  const [rows, setRows] = useState<OfferEditorRow[]>([]);
  const priceOptions = useMemo(() => productPriceOptions(products), [products]);
  const totals = useMemo(() => offerTotals(rows), [rows]);
  async function load() {
    const [nextFlow, nextProducts] = await Promise.all([
      api<any>(`/api/contract-flows/${id}`),
      api<Product[]>("/api/products")
    ]);
    const nextOptions = productPriceOptions(nextProducts);
    setFlow(nextFlow); setProducts(nextProducts);
    setCompany(nextFlow.draft.company ?? {});
    setContact(nextFlow.draft.contact ?? {});
    setRows(hydrateFlowRows((nextFlow.draft.items ?? []).map(flowItemToEditorRow), nextOptions));
  }
  useEffect(() => { load().catch((err)=>setError(err.message)); }, [id]);
  useEffect(() => {
    if (!flow?.customer_order_session_id) return;
    const handle = window.setInterval(() => load().catch(()=>{}), 2500);
    return () => window.clearInterval(handle);
  }, [id, flow?.customer_order_session_id]);
  useEffect(() => {
    if (!rows.length || !priceOptions.length) return;
    setRows((current) => hydrateFlowRows(current, priceOptions));
  }, [priceOptions, rows.length]);
  if (error) return <ErrorNotice message={error}/>;
  if (!flow) return <EmptyState title="Hämtar avtalskedja" text="Laddar säljmötet, kund och affärsrader." />;
  const frozen = Boolean(flow.customer_order_session_id);
  const missing = flow.missing ?? [];
  function updateRow(rowId: string, patch: Partial<OfferEditorRow>) {
    setRows((current) => current.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  }
  function selectPrice(rowId: string, priceId: string) {
    const option = priceOptions.find((item) => item.price.id === priceId);
    if (!option) {
      updateRow(rowId, { price_id: "", product_id: "", unit_price_minor: 0, billing_type: "ONE_TIME", billing_interval: "", vat_percent: "25" });
      return;
    }
    updateRow(rowId, {
      price_id: option.price.id,
      product_id: option.product.id,
      description: option.product.name,
      unit_price_minor: Number(option.price.amount ?? 0),
      billing_type: option.price.billing_type,
      billing_interval: option.price.billing_interval ?? "",
      vat_percent: String(option.price.vat_percent ?? 25)
    });
  }
  async function saveDraft() {
    setSaving(true); setError("");
    try {
      const updated:any = await api(`/api/contract-flows/${flow.id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ company, contact, items: editorRowsToPayload(rows) })
      });
      setFlow(updated);
      return true;
    } catch (err:any) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function createLink() {
    setSaving(true); setError("");
    try {
      const saved = await saveDraft();
      if (!saved) return;
      const result:any = await post(`/api/contract-flows/${flow.id}/customer-link`);
      setFlow(result);
      setRows(hydrateFlowRows((result.draft?.items ?? []).map(flowItemToEditorRow), priceOptions));
      const link = result.customer_order_url || "";
      setCustomerLink(link);
      setCopyState("IDLE");
    } catch (err:any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function copyCustomerLink() {
    if (!customerLink) return;
    setCopyState(await copyTextToClipboard(customerLink));
  }
  async function sendOfferEmail() {
    setSendingOffer(true); setError("");
    try {
      const result:any = await post(`/api/contract-flows/${flow.id}/send-offer-email`, { recipient: contact.email || undefined });
      setFlow(result.flow);
      setCustomerLink(result.customer_order_url || customerLink);
    } catch (err:any) {
      setError(err.message);
    } finally {
      setSendingOffer(false);
    }
  }
  const latestOfferEmail = (flow.email_events ?? []).find((event:any)=>event.email_type === "OFFER");
  const latestSentOfferEmail = (flow.email_events ?? []).find((event:any)=>event.email_type === "OFFER" && ["SENT", "DELIVERED", "BOUNCED", "COMPLAINED"].includes(String(event.status)));
  const offerEmailStateText = latestSentOfferEmail?.status === "DELIVERED"
    ? "Levererat"
    : latestSentOfferEmail?.status === "BOUNCED"
      ? "Studsat"
      : latestSentOfferEmail?.status === "COMPLAINED"
        ? "Rapporterat som spam"
        : "Skickat";
  const steps = [
    ["Kunduppgifter", !missing.some((m:any)=>String(m.field).startsWith("company") || String(m.field).startsWith("contact"))],
    ["Offert skapad", Boolean(flow.sales_order_id)],
    ["Offert skickad", Boolean(latestSentOfferEmail)],
    ["Kunden öppnade", Boolean(flow.customer_order_session?.opened_at)],
    ["Signerad", Boolean(flow.customer_order_session?.signed_at)],
    ["Betalmetod registrerad", Boolean(flow.customer_order_session?.payment_method_id) || !flow.subscriptions?.length],
    ["Abonnemang aktiverat", !flow.subscriptions?.length || flow.subscriptions?.some((sub:any)=>String(sub.status).toUpperCase() === "ACTIVE")],
    ["Faktura skapad", Boolean(flow.invoices?.length)],
    ["Faktura skickad", flow.invoices?.some((invoice:any)=>invoice.fortnox_document_number || String(invoice.status).toUpperCase() === "SENT")],
    ["Affären klar", flow.status === "COMPLETED"]
  ] as const;
  return <>
    <PageHead title="Avtalskedja" subtitle={`${flow.seller_name || "Säljare"} · ${flow.meeting_id || "Simulerat möte"}`}
      action={<div className="actions"><Link className="button ghost" to="/contract-flow/new">Ny simulering</Link>{!frozen && <button onClick={createLink} disabled={saving}>Skapa kundlänk</button>}</div>} />
    <div className="contractWorkspace">
      <section className="contractMain">
        {missing.length > 0 && !frozen && <div className="missingBanner"><strong>{missing.length} uppgifter behöver kompletteras</strong>{missing.map((m:any)=><a key={m.field} href={`#${m.field.replace(".", "-")}`}>{m.label}</a>)}</div>}
        <Card className="contractSection">
          <div className="panelHead"><div><h3>Kund</h3><p><Status value={flow.customer_id ? "Befintlig kund hittad" : "Importerad"}/> Prefill kan ändras innan kundlänk skapas.</p></div></div>
          <div className="formGrid">
            <input id="company-name" value={company.name || ""} onChange={(e)=>setCompany({...company, name:e.target.value})} placeholder="Företagsnamn" disabled={frozen}/>
            <input id="company-org_number" value={company.org_number || ""} onChange={(e)=>setCompany({...company, org_number:e.target.value})} placeholder="Org.nr" disabled={frozen}/>
            <input value={company.address1 || ""} onChange={(e)=>setCompany({...company, address1:e.target.value})} placeholder="Adress" disabled={frozen}/>
            <input value={company.zip || ""} onChange={(e)=>setCompany({...company, zip:e.target.value})} placeholder="Postnummer" disabled={frozen}/>
            <input value={company.city || ""} onChange={(e)=>setCompany({...company, city:e.target.value})} placeholder="Ort" disabled={frozen}/>
          </div>
        </Card>
        <Card className="contractSection">
          <h3>Kontaktperson</h3>
          <div className="formGrid">
            <input id="contact-name" value={contact.name || ""} onChange={(e)=>setContact({...contact, name:e.target.value})} placeholder="Namn" disabled={frozen}/>
            <input id="contact-email" value={contact.email || ""} onChange={(e)=>setContact({...contact, email:e.target.value})} placeholder="E-post" disabled={frozen}/>
            <input value={contact.phone || ""} onChange={(e)=>setContact({...contact, phone:e.target.value})} placeholder="Telefon" disabled={frozen}/>
          </div>
        </Card>
        <Card className="contractSection">
          <div className="panelHead"><div><h3>Affär</h3><p>Orderrader fryses när kundlänken skapas.</p></div>{!frozen && <button className="ghost small" onClick={()=>setRows([...rows, newOfferRow()])}><Plus size={15}/>Lägg rad</button>}</div>
          <div className="offerRows compactRows">
            <div className="offerRow offerRowHead"><span>Produkt/pris</span><span>Beskrivning</span><span>Antal</span><span>Pris</span><span>Rabatt</span><span>Moms</span><span>Typ</span><span>Total</span><span></span></div>
            {rows.map((row) => <div className="offerRow" key={row.id}>
              <select value={row.price_id} onChange={(e)=>selectPrice(row.id, e.target.value)} disabled={frozen}><option value="">Fri rad</option>{priceOptions.map((option)=><option key={option.price.id} value={option.price.id}>{option.label}</option>)}</select>
              <input value={row.description} onChange={(e)=>updateRow(row.id, {description:e.target.value})} placeholder="Radbeskrivning" disabled={frozen}/>
              <input value={row.quantity} onChange={(e)=>updateRow(row.id, {quantity:e.target.value})} type="number" min="0.01" step="0.01" disabled={frozen}/>
              <input value={minorToInput(row.unit_price_minor)} onChange={(e)=>updateRow(row.id, {unit_price_minor:parseMoneyInputToMinor(e.target.value)})} type="number" min="0" step="0.01" disabled={frozen || Boolean(row.price_id)}/>
              <input value={row.discount_percent} onChange={(e)=>updateRow(row.id, {discount_percent:e.target.value})} type="number" min="0" max="100" step="0.01" disabled={frozen}/>
              <input value={row.vat_percent} onChange={(e)=>updateRow(row.id, {vat_percent:e.target.value})} type="number" min="0" max="100" step="0.01" disabled={frozen}/>
              <div className="rowType"><Status value={row.billing_type}/><small>{row.billing_interval}</small></div>
              <strong>{moneyMinor(lineNetMinor(row) + lineVatMinor(row))}</strong>
              <button type="button" className="small ghost iconOnly" disabled={frozen} onClick={()=>setRows(rows.length === 1 ? [newOfferRow()] : rows.filter((item)=>item.id !== row.id))}><Trash2 size={15}/></button>
            </div>)}
          </div>
          <div className="totalsGrid stickyTotals">
            <div className="totalTile"><span>Engång</span><strong>{moneyMinor(totals.oneTime.gross)}</strong><small>Moms {moneyMinor(totals.oneTime.vat)}</small></div>
            <div className="totalTile"><span>Recurring / mån</span><strong>{moneyMinor(totals.recurringMonthlyEquivalent.gross)}</strong><small>Moms {moneyMinor(totals.recurringMonthlyEquivalent.vat)}</small></div>
            <div className="totalTile"><span>Recurring / år</span><strong>{moneyMinor(totals.recurringMonth.gross * 12 + totals.recurringYear.gross)}</strong><small>Årlig motsvarighet</small></div>
          </div>
        </Card>
      </section>
      <aside className="contractPanel">
        <Card>
          <h3>Avtalskedja</h3>
          <div className="flowSteps">{steps.map(([label, done])=><div key={label} className={done ? "done" : ""}>{done ? <CheckCircle2 size={16}/> : <Clock3 size={16}/>}<span>{label}</span></div>)}</div>
          <div className="summaryList">
            <div><span>Status</span><Status value={flow.status}/></div>
            <div><span>Kund</span><strong>{flow.customer_name || company.name || "—"}</strong></div>
            <div><span>Order</span><strong>{flow.sales_order_id || "Ej skapad"}</strong></div>
            <div><span>Session</span><strong>{flow.customer_order_session_id || "Ej skapad"}</strong></div>
          </div>
          {(flow.invoices?.length || flow.sales_order_id) && <div className="documentHistory">
            <h4>Dokument</h4>
            {flow.sales_order_id && <Link to={flow.order?.offer_id ? `/offers/${flow.order.offer_id}` : "#"}><FileCheck2 size={15}/><span>{flow.order?.offer_id || "Offert"}</span><Status value={flow.customer_order_session?.signed_at ? "Signerad" : "Skickad"}/></Link>}
            {flow.invoices?.map((invoice:any)=><Link key={invoice.id} to={`/invoices/${invoice.id}`}><FileText size={15}/><span>{invoice.invoice_number || invoice.id}</span><Status value={invoice.status}/></Link>)}
          </div>}
          {customerLink && <div className="copyNotice"><strong>Kundlänken är redo</strong><input readOnly value={customerLink} onFocus={(event)=>event.currentTarget.select()}/><div className="copyActions"><button className="ghost small" onClick={copyCustomerLink}>Kopiera länk</button><a className="button ghost small" href={customerLink} target="_blank" rel="noopener noreferrer">Öppna kundvy</a><button className="ghost small" disabled>Skicka via e-post</button></div>{copyState !== "IDLE" && <small>{copyFeedbackText(copyState)}</small>}</div>}
          {flow.customer_order_session && !customerLink && <div className="copyNotice"><strong>Kundsession finns</strong><small>Sessionen finns redan. Skapa ingen ny session om inte avtalsversionen ändras senare.</small></div>}
          <div className="copyNotice">
            <strong>{latestSentOfferEmail ? `${offerEmailStateText} till ${latestSentOfferEmail.recipient}` : latestOfferEmail?.status === "FAILED" ? "Offertmail misslyckades" : "Offertmail ej skickat"}</strong>
            <small>{latestSentOfferEmail ? `${offerEmailStateText} ${latestSentOfferEmail.delivered_at || latestSentOfferEmail.sent_at || latestSentOfferEmail.created_at}` : latestOfferEmail?.failure_message || "Skicka först när kundlänken och offertversionen är redo."}</small>
            <div className="copyActions"><button className="small" onClick={sendOfferEmail} disabled={sendingOffer || !contact.email}>{sendingOffer ? "Skickar…" : latestSentOfferEmail ? "Skicka igen" : "Skicka offert till kund"}</button></div>
            {latestSentOfferEmail?.provider_message_id && <small>Resend ID: {latestSentOfferEmail.provider_message_id}</small>}
          </div>
        </Card>
        {flow.status === "COMPLETED" && <Card className="successPanel">
          <h3>Affären är klar</h3>
          <div className="flowSteps">
            <div className="done"><CheckCircle2 size={16}/>Avtal signerat</div>
            <div className="done"><CheckCircle2 size={16}/>Betalmetod registrerad</div>
            <div className="done"><CheckCircle2 size={16}/>Abonnemang aktivt</div>
            <div className="done"><CheckCircle2 size={16}/>Projektfaktura {flow.invoices?.length ? "skapad" : "ej relevant"}</div>
          </div>
          <div className="summaryList">
            <div><span>Invoice</span><strong>{flow.invoices?.[0]?.invoice_number || flow.invoices?.[0]?.id || "—"}</strong></div>
            <div><span>Subscription</span><strong>{flow.subscriptions?.[0]?.stripe_subscription_id || flow.subscriptions?.[0]?.id || "—"}</strong></div>
            <div><span>Payment</span><strong>{flow.payments?.[0]?.status || "—"}</strong></div>
          </div>
        </Card>}
      </aside>
    </div>
  </>;
}

function Invoices() {
  const [rows,setRows]=useState<Invoice[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("latest");
  const [error, setError] = useState("");
  const load=()=>api<Invoice[]>("/api/invoices").then(setRows);
  useEffect(()=>{load().catch((err)=>setError(err.message))},[]);
  const filter = searchParams.get("filter") || "all";
  const today = new Date().toISOString().slice(0,10);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const filteredRows = useMemo(() => rows
    .filter((row) => {
      const status = String(row.status || "").toUpperCase();
      const outstanding = !["PAID","CREDITED","CANCELLED"].includes(status) && Number(row.balance ?? row.total ?? 0) > 0;
      if (filter === "draft") return status === "DRAFT";
      if (filter === "outstanding") return outstanding;
      if (filter === "paid") return status === "PAID";
      if (filter === "synced") return Boolean(row.fortnox_document_number);
      if (filter === "unsynced") return !row.fortnox_document_number;
      if (filter === "overdue") return outstanding && Boolean(row.due_date) && String(row.due_date) < today;
      if (filter === "due-soon") return outstanding && Boolean(row.due_date) && String(row.due_date) >= today && String(row.due_date) <= nextWeek;
      if (filter === "project") return row.invoice_type !== "SUBSCRIPTION_INVOICE";
      if (filter === "subscription") return row.invoice_type === "SUBSCRIPTION_INVOICE";
      return true;
    })
    .filter((row) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [invoiceLabel(row), row.customer_name, row.fortnox_document_number].some((value) => String(value ?? "").toLowerCase().includes(needle));
    })
    .sort((a, b) => {
      if (sort === "due") return String(a.due_date || "9999").localeCompare(String(b.due_date || "9999"));
      if (sort === "amount") return Number(b.total ?? 0) - Number(a.total ?? 0);
      if (sort === "balance") return Number(b.balance ?? b.total ?? 0) - Number(a.balance ?? a.total ?? 0);
      if (sort === "status") return String(a.status || "").localeCompare(String(b.status || ""));
      return String(b.invoice_date || b.due_date || "").localeCompare(String(a.invoice_date || a.due_date || ""));
    }), [rows, filter, query, sort, today, nextWeek]);
  const invoiceSummary = filteredRows.reduce((sum, row) => {
    const status = String(row.status || "").toUpperCase();
    const outstanding = !["PAID","CREDITED","CANCELLED"].includes(status) && Number(row.balance ?? row.total ?? 0) > 0;
    sum.total += Math.round(Number(row.total ?? 0) * 100);
    sum.balance += Math.round(Number(row.balance ?? row.total ?? 0) * 100);
    if (outstanding) sum.outstanding += 1;
    if (row.fortnox_document_number) sum.synced += 1;
    return sum;
  }, { total: 0, balance: 0, outstanding: 0, synced: 0 });
  const filters = [
    ["all", "Alla"],
    ["draft", "Draft"],
    ["outstanding", "Utestående"],
    ["paid", "Betalda"],
    ["overdue", "Förfallna"],
    ["synced", "Fortnox"],
    ["unsynced", "Ej synkade"],
    ["project", "Project invoices"],
    ["subscription", "Subscription invoices"]
  ];
  const openInvoice = (invoiceId: string) => navigate(`/invoices/${invoiceId}`);
  const openInvoiceFromKeyboard = (event: React.KeyboardEvent, invoiceId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openInvoice(invoiceId);
    }
  };
  const syncInvoice = async (event: React.MouseEvent, invoiceId: string) => {
    event.stopPropagation();
    await post(`/api/invoices/${invoiceId}/sync-fortnox`);
    await load();
  };
  return <>
    <PageHead title="Fakturor" subtitle="Intern fakturavy med status, saldo och kopplingar till order/offert."
      action={<button className="ghost" onClick={async()=>{await post("/api/invoices/pull"); await load();}}><RefreshCw size={16}/>Synka fakturor</button>}/>
    {error && <ErrorNotice message={error}/>}
    <div className="metricGrid compactMetrics">
      <Metric label="Visade fakturor" value={filteredRows.length} hint={`${invoiceSummary.outstanding} utestående`} />
      <Metric label="Total i urval" value={moneyMinor(invoiceSummary.total)} hint="inkl. moms" />
      <Metric label="Saldo i urval" value={moneyMinor(invoiceSummary.balance)} hint={`${invoiceSummary.synced} Fortnox-synkade`} />
    </div>
    <Card className="invoiceWorkspace">
      <div className="tableTools">
        <label className="searchBox invoiceSearch"><Search size={15}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Sök faktura, kund eller Fortnox-ID"/></label>
        <select value={sort} onChange={(event)=>setSort(event.target.value)} aria-label="Sortera fakturor">
          <option value="latest">Senaste först</option>
          <option value="due">Förfallodatum</option>
          <option value="amount">Högsta belopp</option>
          <option value="balance">Högsta saldo</option>
          <option value="status">Status A-Ö</option>
        </select>
        <div className="filterTabs">{filters.map(([key, label]) =>
          <button key={key} className={`tabButton ${filter === key ? "active" : ""}`} onClick={()=>setSearchParams(key === "all" ? {} : { filter: key })}>{label}</button>
        )}</div>
      </div>
      <div className="invoiceTableWrap"><table className="invoiceTable"><thead><tr><th>#</th><th>Kund</th><th>Typ</th><th>Fakturadatum</th><th>Förfallo</th><th>Total</th><th>Saldo</th><th>Status</th><th>Fortnox</th><th></th></tr></thead><tbody>
      {filteredRows.map(r=><tr key={r.id} className="clickRow" tabIndex={0} role="link" aria-label={`Öppna faktura ${invoiceLabel(r)}`} onClick={()=>openInvoice(r.id)} onKeyDown={(event)=>openInvoiceFromKeyboard(event, r.id)}><td><strong>{invoiceLabel(r)}</strong><small>{r.id}</small></td><td>{r.customer_name}</td><td>{r.invoice_type || "PROJECT_INVOICE"}</td><td>{displayDate(r.invoice_date)}</td><td>{displayDate(r.due_date)}</td><td>{money(r.total)}</td><td>{money(r.balance)}</td><td><Status value={r.status}/></td><td>{r.fortnox_document_number || <span className="muted">Ej synkad</span>}<small>{r.sync_status || "LOCAL_ONLY"}</small></td>
        <td><div className="rowActions"><Link className="button small ghost" to={`/invoices/${r.id}`} onClick={(event)=>event.stopPropagation()}>Visa</Link>{!r.fortnox_document_number && <button className="small" onClick={(event)=>syncInvoice(event, r.id)}>Sync</button>}</div></td></tr>)}
      {!filteredRows.length && <tr><td colSpan={10}><EmptyState title="Inga fakturor matchar" text="Justera filter, sökord eller synka fakturor från Fortnox." /></td></tr>}
    </tbody></table></div>
      <div className="invoiceMobileList">
        {filteredRows.map((r) => <article key={r.id} className="invoiceMobileCard" tabIndex={0} role="link" aria-label={`Öppna faktura ${invoiceLabel(r)}`} onClick={()=>openInvoice(r.id)} onKeyDown={(event)=>openInvoiceFromKeyboard(event, r.id)}>
          <div className="mobileCardHead"><div><strong>{invoiceLabel(r)}</strong><small>{r.customer_name}</small></div><Status value={r.status}/></div>
          <div className="mobileInvoiceGrid">
            <div><span>Total</span><strong>{money(r.total)}</strong></div>
            <div><span>Saldo</span><strong>{money(r.balance)}</strong></div>
            <div><span>Förfallo</span><strong>{displayDate(r.due_date)}</strong></div>
            <div><span>Fortnox</span><strong>{r.fortnox_document_number || "Ej synkad"}</strong><small>{r.sync_status || "LOCAL_ONLY"}</small></div>
          </div>
          <div className="rowActions mobileActions"><Link className="button small ghost" to={`/invoices/${r.id}`} onClick={(event)=>event.stopPropagation()}>Visa</Link>{!r.fortnox_document_number && <button className="small" onClick={(event)=>syncInvoice(event, r.id)}>Sync</button>}</div>
        </article>)}
        {!filteredRows.length && <EmptyState title="Inga fakturor matchar" text="Justera filter, sökord eller synka fakturor från Fortnox." />}
      </div>
    </Card>
  </>;
}

function InvoiceDetail() {
  const { id } = useParams();
  const [invoice, setInvoice] = useState<any>(null);
  const load = () => api<any>(`/api/invoices/${id}`).then(setInvoice);
  useEffect(()=>{load().catch(console.error)},[id]);
  if (!invoice) return <div>Hämtar…</div>;
  const subtotal = minorField(invoice, "subtotal_minor", "subtotal");
  const vat = minorField(invoice, "vat_total_minor", "vat_total");
  const total = minorField(invoice, "total_minor", "total");
  const balance = minorField(invoice, "balance_minor", "balance");
  const paid = Math.max(0, total - balance);
  const roundoff = total - subtotal - vat;
  const accountingReady = invoice.accounting_events?.some((event:any) => ["READY","EXPORTED"].includes(event.status));
  return <>
    <PageHead title={`Faktura ${invoiceLabel(invoice)}`} subtitle={`${invoice.customer_name} · ${invoice.invoice_type || "PROJECT_INVOICE"}`}
      action={<div className="actions"><Link className="button ghost" to={`/customers/${invoice.customer_id}`}>Gå till kund</Link>{invoice.source_offer_id && <Link className="button ghost" to={`/offers/${invoice.source_offer_id}`}>Gå till offert</Link>}{!invoice.fortnox_document_number && <button onClick={async()=>{await post(`/api/invoices/${invoice.id}/sync-fortnox`); await load();}}>Sync Fortnox</button>}</div>} />
    <Card className="invoiceHero">
      <div><span>Fakturanummer</span><strong>{invoiceLabel(invoice)}</strong><small>{invoice.customer_name}</small></div>
      <div><span>Status</span><Status value={invoice.status}/></div>
      <div><span>Total</span><strong>{moneyMinor(total)}</strong></div>
      <div><span>Saldo</span><strong>{moneyMinor(balance)}</strong></div>
    </Card>
    <StatusChain status={invoice.status}/>
    <div className="metricGrid">
      <Metric label="Subtotal" value={moneyMinor(subtotal)} hint="exkl. moms" />
      <Metric label="Moms" value={moneyMinor(vat)} hint="VAT total" />
      <Metric label="Total" value={moneyMinor(total)} hint={invoice.currency || "SEK"} />
      <Metric label="Balance" value={moneyMinor(balance)} hint={invoice.status} />
      <Metric label="Roundoff" value={moneyMinor(roundoff)} hint="Fortnox avrundning / differens" />
    </div>
    <div className="twoCol">
      <Card><h3>Fakturainfo</h3><div className="infoGrid">
        <div><span>Invoice number</span><strong>{invoice.invoice_number || "—"}</strong></div>
        <div><span>Fortnox reference</span><strong>{invoice.fortnox_document_number || "Ej synkad"}</strong></div>
        <div><span>Invoice date</span><strong>{displayDate(invoice.invoice_date)}</strong></div>
        <div><span>Due date</span><strong>{displayDate(invoice.due_date)}</strong></div>
        <div><span>Roundoff</span><strong>{moneyMinor(roundoff)}</strong></div>
        <div><span>Sync status</span><Status value={invoice.sync_status || "LOCAL_ONLY"}/></div>
        <div><span>Accounting event</span><Status value={accountingReady ? "READY" : invoice.accounting_events?.[0]?.status || "PENDING"}/></div>
      </div></Card>
      <Card><h3>Kopplingar</h3><div className="summaryList">
        <div><span>Kund</span><Link to={`/customers/${invoice.customer_id}`}>{invoice.customer_name}</Link></div>
        <div><span>Sales order</span><strong>{invoice.sales_order_id || "—"}</strong></div>
        <div><span>Source offer</span>{invoice.source_offer_id ? <Link to={`/offers/${invoice.source_offer_id}`}>{invoice.source_offer?.title || invoice.source_offer_title || invoice.source_offer_id}</Link> : <strong>—</strong>}</div>
        <div><span>Subscription</span>{invoice.subscriptions?.[0] ? <Link to={`/subscriptions/${invoice.subscriptions[0].id}`}>{invoice.subscriptions[0].stripe_subscription_id || invoice.subscriptions[0].id}</Link> : <strong>—</strong>}</div>
        <div><span>Statuskedja</span><Status value={invoice.status}/></div>
      </div></Card>
    </div>
    <Card className="documentPreviewPanel">
      <div className="panelHead"><div><h3>Fakturadokument</h3><p>Samma Webblyftet-dokumentsystem som offerten, med betalningsuppgifter och testmarkering.</p></div></div>
      <div className="documentActions">
        <a className="button ghost" href={`/api/invoices/${invoice.id}/document`} target="_blank" rel="noreferrer">Visa faktura</a>
        <a className="button ghost" href={`/api/invoices/${invoice.id}/document?format=email`} target="_blank" rel="noreferrer">Förhandsgranska fakturamejl</a>
      </div>
    </Card>
    <Card><h3>Invoice rows</h3><table><thead><tr><th>Rad</th><th>Typ</th><th>Antal</th><th>Pris</th><th>Rabatt</th><th>Moms</th><th>Total</th></tr></thead><tbody>
      {invoice.rows?.map((row:any)=><tr key={row.id}><td>{row.description}<small>{row.product_id || "Fri rad"}</small></td><td>{row.billing_type || "ONE_TIME"}<small>{row.billing_interval || ""}</small></td><td>{row.quantity} {row.unit || ""}</td><td>{moneyMinor(row.unit_price_minor ?? parseMoneyInputToMinor(row.unit_price))}</td><td>{row.discount_percent ?? 0}%</td><td>{row.vat_percent ?? 0}%</td><td><strong>{moneyMinor(rowTotalMinor(row))}</strong></td></tr>)}
      {!invoice.rows?.length && <tr><td colSpan={7} className="muted">Inga fakturarader.</td></tr>}
    </tbody><tfoot><tr><td colSpan={5}></td><td>Subtotal</td><td>{moneyMinor(subtotal)}</td></tr><tr><td colSpan={5}></td><td>VAT</td><td>{moneyMinor(vat)}</td></tr><tr><td colSpan={5}></td><td>Roundoff</td><td>{moneyMinor(roundoff)}</td></tr><tr><td colSpan={5}></td><td>Total</td><td><strong>{moneyMinor(total)}</strong></td></tr><tr><td colSpan={5}></td><td>Paid</td><td>{moneyMinor(paid)}</td></tr><tr><td colSpan={5}></td><td>Outstanding</td><td>{moneyMinor(balance)}</td></tr></tfoot></table></Card>
    <Card><h3>Status timeline</h3><InvoiceTimeline invoice={invoice}/></Card>
    <div className="twoCol">
      <Card><h3>Accounting events</h3><table><thead><tr><th>Event</th><th>Belopp</th><th>Status</th><th>Tid</th></tr></thead><tbody>
        {invoice.accounting_events?.map((event:any)=><tr key={event.id}><td>{event.event_type}<small>{event.id}</small></td><td>{moneyMinor(event.gross_amount)}</td><td><Status value={event.status}/></td><td>{displayDate(event.occurred_at)}</td></tr>)}
        {!invoice.accounting_events?.length && <tr><td colSpan={4} className="muted">Inga accounting events kopplade till fakturan.</td></tr>}
      </tbody></table></Card>
      <Card><h3>Payments</h3><table><thead><tr><th>Provider</th><th>Belopp</th><th>Status</th><th>Betald</th></tr></thead><tbody>
        {invoice.payments?.map((payment:any)=><tr key={payment.id}><td>{payment.provider}<small>{payment.provider_payment_id || payment.id}</small></td><td>{moneyMinor(payment.amount)}</td><td><Status value={payment.status}/></td><td>{displayDate(payment.paid_at || payment.created_at)}</td></tr>)}
        {!invoice.payments?.length && <tr><td colSpan={4} className="muted">Inga payments kopplade till fakturan.</td></tr>}
      </tbody></table></Card>
    </div>
  </>;
}

function SubscriptionDetail() {
  const { id } = useParams();
  const [subscription, setSubscription] = useState<any>(null);
  useEffect(()=>{api<any>(`/api/subscriptions/${id}`).then(setSubscription).catch(console.error)},[id]);
  if (!subscription) return <div>Hämtar…</div>;
  const monthly = subscription.items?.reduce((sum:number, item:any) => {
    const divisor = item.billing_interval === "YEAR" ? 12 : 1;
    return sum + Math.round(Number(item.unit_amount ?? 0) * Number(item.quantity ?? 1) / divisor);
  }, 0) ?? 0;
  return <>
    <PageHead title={`Abonnemang ${subscription.id}`} subtitle={`${subscription.customer_name} · ${subscription.status}`}
      action={<Link className="button ghost" to={`/customers/${subscription.customer_id}`}>Visa kund</Link>} />
    <div className="metricGrid">
      <Metric label="Status" value={<Status value={subscription.status}/>} hint={subscription.stripe_subscription_id ? "Stripe kopplad" : "Ej Stripe-aktiverad"} />
      <Metric label="MRR" value={moneyMinor(monthly)} hint={`ARR ${moneyMinor(monthly * 12)}`} />
      <Metric label="Periodslut" value={displayDate(subscription.current_period_end)} hint={subscription.cancel_at_period_end ? "avslutas vid periodslut" : "aktiv period"} />
      <Metric label="Payments" value={subscription.payments?.length ?? 0} hint="kopplade betalningar" />
    </div>
    <div className="twoCol">
      <Card><h3>Items</h3><table><thead><tr><th>Produkt</th><th>Antal</th><th>Pris</th><th>Intervall</th></tr></thead><tbody>
        {subscription.items?.map((item:any)=><tr key={item.id}><td>{item.product_name || item.product_id}</td><td>{item.quantity}</td><td>{moneyMinor(item.unit_amount)}</td><td>{item.billing_interval || "—"}</td></tr>)}
      </tbody></table></Card>
      <Card><h3>Kopplingar</h3><div className="summaryList">
        <div><span>Kund</span><Link to={`/customers/${subscription.customer_id}`}>{subscription.customer_name}</Link></div>
        <div><span>Source offer</span>{subscription.offer_id ? <Link to={`/offers/${subscription.offer_id}`}>{subscription.source_offer_title || subscription.offer_id}</Link> : <strong>—</strong>}</div>
        <div><span>Sales order</span><strong>{subscription.sales_order_id || "—"}</strong></div>
        <div><span>Stripe subscription</span><strong>{subscription.stripe_subscription_id || "—"}</strong></div>
      </div></Card>
    </div>
    <Card><h3>Payments</h3><table><thead><tr><th>Payment</th><th>Belopp</th><th>Status</th><th>Betald</th></tr></thead><tbody>
      {subscription.payments?.map((payment:any)=><tr key={payment.id}><td>{payment.provider}<small>{payment.provider_payment_id || payment.id}</small></td><td>{moneyMinor(payment.amount)}</td><td><Status value={payment.status}/></td><td>{displayDate(payment.paid_at || payment.created_at)}</td></tr>)}
      {!subscription.payments?.length && <tr><td colSpan={4} className="muted">Inga payments ännu.</td></tr>}
    </tbody></table></Card>
  </>;
}

function Receipts() {
  const [rows,setRows]=useState<any[]>([]);
  const load=()=>api<any[]>("/api/receipts").then(setRows);
  useEffect(()=>{load().catch(console.error)},[]);
  async function upload(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault(); const form=e.currentTarget; const fd=new FormData(form);
    await api("/api/receipts",{method:"POST",body:fd}); form.reset(); await load();
  }
  return <>
    <PageHead title="Kvitton & underlag" subtitle="Originalfilen sparas i R2. Fortnox Inbox används som extern adapter."/>
    <Card><form onSubmit={upload} className="formGrid">
      <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff" required/>
      <input name="supplier_name" placeholder="Leverantör"/><input name="amount" type="number" step="0.01" placeholder="Belopp"/>
      <input name="vat_amount" type="number" step="0.01" placeholder="Moms"/><input name="transaction_date" type="date"/>
      <input name="notes" placeholder="Anteckning"/><button type="submit">Ladda upp</button>
    </form></Card>
    <Card><table><thead><tr><th>Fil</th><th>Leverantör</th><th>Datum</th><th>Belopp</th><th>Status</th><th></th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td>{r.filename}</td><td>{r.supplier_name||"—"}</td><td>{r.transaction_date||"—"}</td><td>{money(r.amount)}</td><td><Status value={r.status}/></td>
      <td><div className="rowActions"><a className="button small ghost" target="_blank" href={`/api/receipts/${r.id}/file`}>Visa</a><button className="small" onClick={async()=>{await post(`/api/receipts/${r.id}/push-inbox`); await load();}}>{r.fortnox_file_id ? "Verifiera Fortnox" : "Skicka Inbox"}</button></div><small>{r.fortnox_inbox_path || "Ej Fortnox"}</small></td></tr>)}
      {!rows.length && <tr><td colSpan={6}><EmptyState title="Inga kvitton eller underlag" text="Ladda upp en PDF eller bild för att spara i R2 och skicka till Fortnox Inbox." /></td></tr>}
    </tbody></table></Card>
  </>;
}

function SupplierInvoices(){
  const [rows,setRows]=useState<any[]>([]);
  const load=()=>api<any[]>("/api/supplier-invoices").then(setRows);
  useEffect(()=>{load().catch(console.error)},[]);
  return <>
    <PageHead title="Leverantörsfakturor" subtitle="Speglas från Fortnox."
      action={<button className="ghost" onClick={async()=>{await post("/api/supplier-invoices/pull"); await load();}}><RefreshCw size={16}/>Hämta</button>}/>
    <Card><table><thead><tr><th>#</th><th>Leverantör</th><th>Fakturadatum</th><th>Förfallo</th><th>Belopp</th><th>Saldo</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td>{r.fortnox_document_number}</td><td>{r.supplier_name||r.supplier_number}</td><td>{r.invoice_date}</td><td>{r.due_date}</td><td>{money(r.total)}</td><td>{money(r.balance)}</td></tr>)}
      {!rows.length && <tr><td colSpan={6}><EmptyState title="Inga leverantörsfakturor i testmiljön" text="Pull fungerar, men Fortnox sandbox saknar leverantörsfakturor ännu." /></td></tr>}
    </tbody></table></Card>
  </>;
}

function Bookkeeping(){
  const [rows,setRows]=useState<any[]>([]);
  const [year,setYear]=useState("1"); const [series,setSeries]=useState("A");
  const load=()=>api<any[]>("/api/vouchers").then(setRows);
  useEffect(()=>{load().catch(console.error)},[]);
  return <>
    <PageHead title="Bokföring" subtitle="Läsbar vy för redovisningsadaptern. Accounting events skapas i Finance Core."/>
    <Card><div className="inlineForm"><input value={year} onChange={e=>setYear(e.target.value)} placeholder="Financial year ID"/>
    <input value={series} onChange={e=>setSeries(e.target.value)} placeholder="Serie"/>
    <button onClick={async()=>{await post(`/api/vouchers/pull?year=${encodeURIComponent(year)}&series=${encodeURIComponent(series)}`); await load();}}>Hämta verifikationer</button></div></Card>
    <Card><table><thead><tr><th>Serie</th><th>#</th><th>Datum</th><th>Beskrivning</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td>{r.series}</td><td>{r.voucher_number}</td><td>{r.transaction_date}</td><td>{r.description}</td></tr>)}
      {!rows.length && <tr><td colSpan={4}><EmptyState title="Inga verifikationer i testmiljön" text="Välj räkenskapsår och serie, eller skapa testdata i Fortnox sandbox." /></td></tr>}
    </tbody></table></Card>
  </>;
}

function Products() {
  const [rows, setRows] = useState<Product[]>([]);
  const [open, setOpen] = useState(false);
  const load = () => api<Product[]>("/api/products").then(setRows);
  useEffect(() => { load().catch(console.error); }, []);
  async function seed() {
    await post("/api/products/seed-test");
    await load();
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const product = await post<any>("/api/products", {
      name: f.get("name"),
      description: f.get("description"),
      product_type: f.get("product_type"),
      active: true
    });
    const billingType = String(f.get("billing_type"));
    await post("/api/prices", {
      product_id: product.id,
      amount: Number(f.get("amount")),
      currency: "SEK",
      billing_type: billingType,
      billing_interval: billingType === "RECURRING" ? f.get("billing_interval") : null,
      vat_percent: Number(f.get("vat_percent") || 25),
      active: true
    });
    setOpen(false);
    await load();
  }
  return <>
    <PageHead title="Produkter & priser" subtitle="Finance Core äger produkt- och prislogiken. Belopp sparas i ören."
      action={<div className="actions"><button className="ghost" onClick={seed}>Skapa testprodukter</button><button onClick={()=>setOpen(!open)}>Ny produkt</button></div>} />
    {open && <Card><form onSubmit={submit} className="formGrid">
      <input name="name" placeholder="Produktnamn" required/><input name="description" placeholder="Beskrivning"/>
      <select name="product_type"><option value="ONE_TIME">ONE_TIME</option><option value="SUBSCRIPTION">SUBSCRIPTION</option></select>
      <input name="amount" type="number" placeholder="Pris i ören" required/>
      <select name="billing_type"><option value="ONE_TIME">ONE_TIME</option><option value="RECURRING">RECURRING</option></select>
      <select name="billing_interval"><option value="MONTH">MONTH</option><option value="YEAR">YEAR</option></select>
      <input name="vat_percent" type="number" defaultValue="25"/><button type="submit">Spara</button>
    </form></Card>}
    <Card><table><thead><tr><th>Produkt</th><th>Typ</th><th>Pris</th><th>Stripe</th><th>Status</th><th></th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.id}><td><strong>{r.name}</strong><small>{r.description}</small></td><td>{r.product_type}</td>
        <td>{jsonArray(r.prices).map((p:any) => <div key={p.id}>{cents(p.amount)} <small>{p.billing_type}{p.billing_interval ? ` / ${p.billing_interval}` : ""}</small></div>)}</td>
        <td>{jsonArray(r.prices).map((p:any) => <small key={p.id}>{p.stripe_price_id || "Ej kopplad"}</small>)}</td>
        <td><Status value={r.active ? "ACTIVE" : "INACTIVE"}/></td>
        <td><div className="rowActions"><button className="small ghost" onClick={async()=>{await post(`/api/products/${r.id}/sync-stripe`); await load();}}>Stripe produkt</button>{jsonArray(r.prices).map((p:any)=><button className="small" key={p.id} onClick={async()=>{await post(`/api/prices/${p.id}/sync-stripe`); await load();}}>Pris</button>)}</div></td></tr>)}
    </tbody></table></Card>
  </>;
}

function Subscriptions() {
  const [rows, setRows] = useState<Subscription[]>([]);
  const [error, setError] = useState<{ customerId?: string; message: string } | null>(null);
  const load = () => api<Subscription[]>("/api/subscriptions").then(setRows);
  useEffect(() => { load().catch(console.error); }, []);
  async function activate(row: Subscription) {
    setError(null);
    try {
      const result = await post<{ payment_action?: StripePaymentAction }>(`/api/subscriptions/${row.id}/activate`);
      if (result.payment_action?.required && result.payment_action.client_secret) {
        const config = await api<{ configured: boolean; publishableKey: string; message?: string }>("/api/stripe/config");
        if (!config.configured) throw new Error(config.message ?? "Stripe är inte konfigurerat ännu.");
        const stripe = await stripeJs(config.publishableKey);
        const confirmation = await stripe.confirmCardPayment(result.payment_action.client_secret);
        if (confirmation.error) throw new Error(confirmation.error.message);
      }
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Kunde inte aktivera abonnemanget.";
      setError({ customerId: row.customer_id, message });
    }
  }
  return <>
    <PageHead title="Abonnemang" subtitle="Core-vy för subscriptions, items och Stripe-status. Ingen checkout ännu."/>
    {error && <Card><p><strong>{error.message.includes("betalmetod") || error.message.includes("Betalmetod") ? "Betalmetod saknas" : error.message}</strong></p>
      {error.customerId && <Link className="button" to={`/payment-method/${error.customerId}`}>Registrera kort</Link>}</Card>}
    <Card><table><thead><tr><th>Kund</th><th>Status</th><th>Produkter/items</th><th>Månadsbelopp</th><th>Nästa periodslut</th><th>Stripe-status</th><th>Åtgärder</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.id}><td><Link to={`/subscriptions/${r.id}`}>{r.customer_name}</Link><small>{r.id}</small></td><td><Status value={r.status}/></td>
        <td>{jsonArray(r.items).map((item:any, index:number) => <div key={index}>{item.product_name} × {item.quantity}<small>{cents(item.unit_amount)} {item.billing_interval || ""}</small></div>)}</td>
        <td>{cents(r.monthly_amount)}</td><td>{r.current_period_end || "—"}</td><td>{r.stripe_subscription_id ? "Kopplad" : "Ej skapad"}</td>
        <td><div className="rowActions">{r.customer_id && <Link className="button small ghost" to={`/payment-method/${r.customer_id}`}>Kort</Link>}
          <button className="small" onClick={()=>activate(r)}>Aktivera</button>
          {r.stripe_subscription_id && !r.cancel_at_period_end && <button className="small ghost" onClick={async()=>{await post(`/api/subscriptions/${r.id}/cancel`); await load();}}>Avsluta periodslut</button>}</div></td></tr>)}
    </tbody></table></Card>
  </>;
}

function PaymentMethodPage() {
  const { customerId } = useParams();
  const [message, setMessage] = useState("");
  useEffect(() => {
    let card: any;
    let stripe: any;
    async function mount() {
      const config = await api<{ configured: boolean; publishableKey: string; message?: string }>("/api/stripe/config");
      if (!config.configured) {
        setMessage(config.message ?? "Stripe är inte konfigurerat ännu.");
        return;
      }
      const session = await post<any>(`/api/customers/${customerId}/payment-method/setup`);
      stripe = await stripeJs(config.publishableKey);
      const elements = stripe.elements();
      card = elements.create("card");
      card.mount("#card-element");
      const form = document.getElementById("card-form");
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        setMessage("Bekräftar kort…");
        const result = await stripe.confirmCardSetup(session.client_secret, { payment_method: { card } });
        if (result.error) setMessage(result.error.message);
        else setMessage(`SetupIntent ${result.setupIntent.status}. Webhooken uppdaterar lokal betalmetod.`);
      });
    }
    mount().catch((error) => setMessage(error.message));
    return () => { card?.unmount?.(); };
  }, [customerId]);
  return <>
    <PageHead title="Kortregistrering" subtitle="Stripe.js Elements körs i browsern; kortdata skickas aldrig genom Workern."/>
    <Card><form id="card-form" className="paymentForm"><div id="card-element"></div><button type="submit">Spara kort</button><p className="muted">{message}</p></form></Card>
  </>;
}

function CustomerOrderRows({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="muted">Inga rader i detta steg.</p>;
  return <div className="customerOrderRows">{rows.map((row, index) => {
    const net = Math.round(Number(row.unit_price_minor ?? 0) * Number(row.quantity ?? 0));
    const vat = Math.round(net * Number(row.vat_percent ?? 0) / 100);
    return <div className="customerOrderLine" key={row.id || `${row.description || "row"}-${index}`}>
      <div><strong>{row.description || "Orderrad"}</strong><small>{row.billing_type || "ONE_TIME"}{row.billing_interval ? ` · ${row.billing_interval}` : ""}</small></div>
      <span>{row.quantity ?? 0} {row.unit || "st"}</span>
      <span>{moneyMinor(row.unit_price_minor)}</span>
      <span>{row.vat_percent ?? 0}% moms</span>
      <strong>{moneyMinor(net + vat)}</strong>
    </div>;
  })}</div>;
}

function CustomerOrderStatusShell({ title, text }: { title: string; text?: string }) {
  return <div className="customerOrderShell">
    <div className="customerOrderBrand"><div className="brandMark">W</div><strong>Webblyftet</strong></div>
    <Card><EmptyState title={title} text={text}/></Card>
  </div>;
}

class CustomerOrderErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("customer_order_render_error", {
      message: error instanceof Error ? error.message : "Unknown render error",
      component_stack: info.componentStack?.slice(0, 2000)
    });
  }

  render() {
    if (this.state.hasError) {
      const copy = customerOrderRenderFallbackCopy();
      return <CustomerOrderStatusShell title={copy.title} text={copy.text}/>;
    }
    return this.props.children;
  }
}

function CustomerOrderPage() {
  const { token } = useParams();
  const [session, setSession] = useState<CustomerOrderSession | null>(null);
  const [message, setMessage] = useState("");
  const [loadStatus, setLoadStatus] = useState<CustomerOrderLoadStatus>("loading");
  const [busy, setBusy] = useState(false);
  const [cardMounted, setCardMounted] = useState(false);
  const [stripeState, setStripeState] = useState<{ stripe?: any; card?: any; clientSecret?: string | null }>({});
  const load = async () => {
    if (!token) {
      setLoadStatus("invalid");
      setMessage("Kundlänken är ogiltig. Kontrollera länken eller kontakta Webblyftet.");
      return;
    }
    try {
      setLoadStatus("loading");
      const nextSession = await api<CustomerOrderSession>(`/customer-order/${token}/session`);
      setSession(nextSession);
      setMessage("");
      setLoadStatus("loaded");
    } catch (error) {
      const classified = classifyCustomerOrderLoadError(error);
      setSession(null);
      setMessage(classified.message);
      setLoadStatus(classified.status);
    }
  };
  useEffect(() => { load(); }, [token]);
  useEffect(() => () => { stripeState.card?.unmount?.(); }, [stripeState.card]);
  if (!session) {
    const title = loadStatus === "invalid"
      ? "Kundlänken är ogiltig"
      : loadStatus === "expired"
        ? "Kundlänken har gått ut"
        : loadStatus === "server_error"
          ? "Ordern kunde inte laddas"
          : "Hämtar order";
    return <CustomerOrderStatusShell title={title} text={message || "Kontrollerar din säkra orderlänk."}/>;
  }

  const view = normalizeCustomerOrderView(session);
  const { customer, offer, totals, oneTimeRows, recurringRows, requirements, invoices, subscriptions, paymentMethod, documentHash } = view;
  const steps = ["Granska", "Signera", "Betalmetod", "Aktivera", "Klart"];
  async function run<T,>(fn: () => Promise<T>) {
    setBusy(true); setMessage("");
    try { return await fn(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Något gick fel."); }
    finally { setBusy(false); }
  }
  async function review() {
    await run(async()=>setSession(await post<CustomerOrderSession>(`/customer-order/${token}/review`)));
  }
  async function sign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async()=>setSession(await post<CustomerOrderSession>(`/customer-order/${token}/sign`, {
      signer_name: form.get("signer_name"),
      signer_email: form.get("signer_email")
    })));
  }
  async function startPaymentMethodSetup() {
    await run(async()=>{
      const config = await api<{ configured: boolean; publishableKey: string; message?: string }>(`/customer-order/${token}/stripe-config`);
      if (!config.configured) throw new Error(config.message ?? "Stripe är inte konfigurerat ännu.");
      const setup = await post<any>(`/customer-order/${token}/payment-method/setup`);
      if (setup.required === false) {
        await load();
        return;
      }
      const stripe = await stripeJs(config.publishableKey);
      const elements = stripe.elements();
      const card = elements.create("card");
      card.mount("#customer-card-element");
      setStripeState({ stripe, card, clientSecret: setup.client_secret });
      setCardMounted(true);
      setMessage("Fyll i testkortet och spara betalmetoden.");
    });
  }
  async function confirmPaymentMethod(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async()=>{
      if (!stripeState.stripe || !stripeState.card || !stripeState.clientSecret) throw new Error("Kortformuläret är inte redo.");
      const result = await stripeState.stripe.confirmCardSetup(stripeState.clientSecret, { payment_method: { card: stripeState.card } });
      if (result.error) throw new Error(result.error.message);
      setSession(await post<CustomerOrderSession>(`/customer-order/${token}/payment-method/confirm`));
      setMessage("Betalmetoden är verifierad.");
    });
  }
  async function activate() {
    await run(async()=>{
      const result = await post<CustomerOrderSession>(`/customer-order/${token}/activate`);
      if (result.payment_action?.required && result.payment_action.client_secret) {
        const config = await api<{ publishableKey: string }>(`/customer-order/${token}/stripe-config`);
        const stripe = await stripeJs(config.publishableKey);
        const confirmation = await stripe.confirmCardPayment(result.payment_action.client_secret);
        if (confirmation.error) throw new Error(confirmation.error.message);
      }
      setSession(result);
    });
  }
  return <div className="customerOrderShell">
    <header className="customerOrderHeader">
      <div className="customerOrderBrand"><div className="brandMark">W</div><div><strong>Webblyftet</strong><span>Orderaktivering</span></div></div>
      <Status value={session.status}/>
    </header>
    <section className="customerOrderHero">
      <div><small>Offert och beställningsunderlag till {customer.name || "kund"}</small><h1>{offer.title || "Din Webblyftet-order"}</h1><p>Granska offert, villkor och orderrader. Därefter signerar du och registrerar testkort för abonnemangsposter.</p></div>
      <div className="customerOrderHash"><span>Dokumenthash</span><code>{documentHash ? `${documentHash.slice(0, 20)}...` : "Saknas"}</code><small>Signerad snapshot är låst.</small></div>
    </section>
    <div className="customerSteps">{steps.map((label, index)=><div key={label} className={`customerStep ${index <= view.currentStep ? "active" : ""}`}><span>{index + 1}</span><strong>{label}</strong></div>)}</div>
    {message && <ErrorNotice message={message}/>}
    <div className="customerOrderGrid">
      <Card className="customerOrderMain">
        <div className="panelHead"><div><h2>Granska offert och order</h2><p>Sammanfattning för signering. Den fullständiga offerten öppnas som printklart dokument.</p></div><a className="button ghost small" href={`/customer-order/${token}/offer-document`} target="_blank" rel="noreferrer">Visa fullständig offert</a></div>
        <div className="customerIdentityGrid">
          <div><span>Kundföretag</span><strong>{customer.name || "—"}</strong><small>{customer.org_number || "Org.nr saknas"}</small></div>
          <div><span>Kontakt</span><strong>{customer.contact_name || customer.name || "—"}</strong><small>{customer.email || "E-post saknas"}</small></div>
          <div><span>Fakturaadress</span><strong>{customer.address1 || "Adress saknas"}</strong><small>{[customer.zip, customer.city].filter(Boolean).join(" ") || "Postort saknas"}</small></div>
          <div><span>Villkor</span><strong>{offer.terms_version || "Demo-standardvillkor"}</strong><small>Finance Test · demo/test-signering</small></div>
        </div>
        <div className="customerTotals">
          <div><span>Engångskostnad</span><strong>{moneyMinor(totals.one_time_total_minor)}</strong><small>Moms {moneyMinor(totals.one_time_vat_minor)}</small></div>
          <div><span>Återkommande / mån</span><strong>{moneyMinor(totals.recurring_monthly_total_minor)}</strong><small>Moms {moneyMinor(totals.recurring_monthly_vat_minor)}</small></div>
          <div><span>Årspris återkommande</span><strong>{moneyMinor(totals.recurring_year_total_minor)}</strong><small>Årlig motsvarighet</small></div>
        </div>
        <h3>Engångsposter</h3><CustomerOrderRows rows={oneTimeRows}/>
        <h3>Abonnemangsposter</h3><CustomerOrderRows rows={recurringRows}/>
        <div className="termsCallout">
          <strong>Viktiga villkor</strong>
          <p>Priser anges exklusive moms om inget annat framgår. Löpande tjänster debiteras enligt vald period och registrerad betalmetod får användas för återkommande debiteringar av avtalade tjänster. Detta är en demo/test-signering i Finance Test.</p>
        </div>
        {!session.reviewed_at && <button disabled={busy} onClick={review}>Jag har granskat ordern</button>}
      </Card>
      <aside className="customerOrderSide">
        <Card>
          <h3>Signering</h3>
          {session.signed_at ? <div className="goodState"><CheckCircle2 size={18}/><span>Signerad av {session.signer_name}</span></div> :
            <form className="paymentForm" onSubmit={sign}>
              <input name="signer_name" placeholder="Namn" required/>
              <input name="signer_email" type="email" placeholder="E-post" defaultValue={customer.email || ""} required/>
              <label className="checkLine"><input type="checkbox" required/> Jag godkänner orderinnehållet ovan.</label>
              <button disabled={busy || !session.reviewed_at} type="submit">Signera order</button>
              {!session.reviewed_at && <small className="muted">Granska ordern först.</small>}
            </form>}
        </Card>
        <Card>
          <h3>Betalmetod</h3>
          {!requirements.payment_method_required ? <div className="goodState"><CheckCircle2 size={18}/><span>{paymentMethod ? `${paymentMethod.brand || "Kort"} •••• ${paymentMethod.last4 || "----"}` : "Ingen betalmetod krävs"}</span></div> :
            <div className="paymentForm">
              {!cardMounted && <button disabled={busy || !session.signed_at} onClick={startPaymentMethodSetup}>Registrera testkort</button>}
              <form onSubmit={confirmPaymentMethod}><div id="customer-card-element" className="stripeCardMount"></div>{cardMounted && <button disabled={busy} type="submit">Spara betalmetod</button>}</form>
            </div>}
        </Card>
        <Card>
          <h3>Aktivera</h3>
          {session.completed_at ? <div className="goodState"><CheckCircle2 size={18}/><span>Ordern är klar</span></div> :
            <button disabled={busy || requirements.signing_required || requirements.payment_method_required} onClick={activate}>Aktivera order</button>}
          <div className="summaryList">
            <div><span>Faktura</span>{invoices[0] ? <a href={`/api/invoices/${invoices[0].id}/document`} target="_blank" rel="noreferrer">{invoices[0].invoice_number || "Visa faktura"}</a> : <Status value="Ej skapad"/>}</div>
            <div><span>Subscription</span><Status value={subscriptions[0]?.status || "Ej aktuellt"}/></div>
            <div><span>Länk giltig till</span><strong>{displayDate(session.expires_at)}</strong></div>
          </div>
        </Card>
      </aside>
    </div>
  </div>;
}

function Integration(){
  const [status,setStatus]=useState<IntegrationStatus|null>(null); const [stripeStatus,setStripeStatus]=useState<any>(null); const [logs,setLogs]=useState<any[]>([]);
  const load=async()=>{setStatus(await api("/api/integration/status"));try{setStripeStatus(await api("/api/stripe/config"));}catch(error){setStripeStatus({configured:false,message:error instanceof Error ? error.message : "Stripe är inte konfigurerat ännu."});}setLogs(await api("/api/sync-log"));};
  useEffect(()=>{load().catch(console.error)},[]);
  const latestSync = logs[0];
  const latestError = logs.find((log) => !log.success);
  return <>
    <PageHead title="Integrationer" subtitle="Operativ status för Fortnox, Stripe och senaste externa API-anrop."
      action={<button className="ghost" onClick={load}><RefreshCw size={16}/>Uppdatera</button>}/>
    <div className="metricGrid compactMetrics">
      <Metric label="Fortnox" value={<Status value={status?.connected ? "CONNECTED" : status?.configured === false ? "NOT CONFIGURED" : "WAITING"}/>} hint={status?.company_name || "Ingen anslutning"} />
      <Metric label="Stripe" value={<Status value={stripeStatus?.configured ? "CONNECTED" : "NOT CONFIGURED"}/>} hint={stripeStatus?.configured ? "Testmode konfigurerat" : stripeStatus?.message || "Saknar credentials"} />
      <Metric label="Senaste sync" value={latestSync ? displayDateTime(latestSync.created_at) : "—"} hint={latestSync ? `${latestSync.operation} · ${latestSync.success ? "OK" : "ERROR"}` : "Ingen logg"} />
    </div>
    {latestError && <ErrorNotice message={`Senaste integrationsfel: ${latestError.operation} ${latestError.endpoint}`} action={<small>{displayDateTime(latestError.created_at)}</small>} />}
    <div className="twoCol">
      <Card><h3>Fortnox</h3>{status?.configured === false ? <>
        <div className="connection"><div className="dot"></div><div><strong>Ej konfigurerad</strong><p>Fortnox Client ID och Client Secret saknas.</p></div></div>
      </> : status?.connected ? <>
        <div className="connection"><div className="dot on"></div><div><strong>{status.company_name||"Fortnox ansluten"}</strong><p>Tenant {status.tenant_id||"—"}</p></div></div>
        <div className="summaryList">
          <div><span>Company</span><strong>{status.company_name || "—"}</strong></div>
          <div><span>Tenant</span><strong>{status.tenant_id || "—"}</strong></div>
          <div><span>Senast uppdaterad</span><strong>{displayDateTime((status as any).updated_at)}</strong></div>
          <div><span>Scopes</span><small>{status.scope}</small></div>
        </div><button className="danger" onClick={async()=>{await post("/api/integration/disconnect"); await load();}}>Koppla från</button>
      </>:<><p>Ingen Fortnox-anslutning finns i testdatabasen.</p><a className="button" href="/auth/fortnox/start"><PlugZap size={16}/>Anslut Fortnox</a></>}</Card>
      <Card><h3>Stripe</h3><div className="connection"><div className={`dot ${stripeStatus?.configured ? "on" : ""}`}></div><div><strong>{stripeStatus?.configured ? "Konfigurerad" : "Ej konfigurerad"}</strong><p>{stripeStatus?.configured ? "Testnycklar finns som Worker secrets." : "Stripe Secret Key och webhook secret saknas."}</p></div></div>
        <div className="summaryList"><div><span>Publishable key</span><strong>{stripeStatus?.configured ? "Test key aktiv" : "—"}</strong></div><div><span>Webhook</span><strong>{stripeStatus?.configured ? "Signering krävs" : "Ej verifierbar"}</strong></div></div></Card>
      <Card><h3>Säkerhetsmodell</h3><ul className="checkList"><li><BadgeCheck size={16}/>Client secret lagras som Worker secret</li><li><BadgeCheck size={16}/>Tokens krypteras AES-GCM i D1</li><li><BadgeCheck size={16}/>OAuth state skyddar mot CSRF</li><li><BadgeCheck size={16}/>Testmiljö separerad från huvudportalen</li></ul></Card>
    </div>
    <Card><h3>API-logg</h3><table><thead><tr><th>Tid</th><th>Operation</th><th>Endpoint</th><th>Status</th></tr></thead><tbody>
      {logs.slice(0,40).map(l=><tr key={l.id}><td>{displayDateTime(l.created_at)}</td><td>{l.operation}</td><td className="mono">{l.endpoint}</td><td><Status value={l.success?"OK":"ERROR"}/><small>{l.http_status}</small></td></tr>)}
      {!logs.length && <tr><td colSpan={4}><EmptyState title="Ingen integrationslogg" text="När Fortnox eller Stripe används visas API-anrop här." /></td></tr>}
    </tbody></table></Card>
  </>;
}

function App(){
  const location = useLocation();
  if (location.pathname.startsWith("/customer-order/")) {
    return <CustomerOrderErrorBoundary><Routes><Route path="/customer-order/:token" element={<CustomerOrderPage/>}/></Routes></CustomerOrderErrorBoundary>;
  }
  return <Layout><Routes>
    <Route path="/" element={<Dashboard/>}/><Route path="/customers" element={<Customers/>}/><Route path="/customers/:id" element={<CustomerDetail/>}/><Route path="/contract-flow/new" element={<ContractFlowNew/>}/><Route path="/contract-flow/:id" element={<ContractFlowWorkspace/>}/><Route path="/offers" element={<Offers/>}/>
    <Route path="/offers/:id" element={<OfferDetail/>}/>
    <Route path="/products" element={<Products/>}/><Route path="/subscriptions" element={<Subscriptions/>}/><Route path="/subscriptions/:id" element={<SubscriptionDetail/>}/>
    <Route path="/payment-method/:customerId" element={<PaymentMethodPage/>}/>
    <Route path="/invoices" element={<Invoices/>}/><Route path="/invoices/:id" element={<InvoiceDetail/>}/><Route path="/receipts" element={<Receipts/>}/>
    <Route path="/supplier-invoices" element={<SupplierInvoices/>}/><Route path="/bookkeeping" element={<Bookkeeping/>}/>
    <Route path="/integration" element={<Integration/>}/>
  </Routes></Layout>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
