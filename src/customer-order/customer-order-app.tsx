import React, { useEffect, useState } from "react";
import { Route, Routes, useParams } from "react-router-dom";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { api, post } from "../api";
import {
  classifyCustomerOrderLoadError,
  customerOrderRenderFallbackCopy,
  normalizeCustomerOrderView,
  type CustomerOrderLoadStatus
} from "./view-model";

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

function moneyMinor(value: number | null | undefined) {
  return (Number(value ?? 0) / 100).toLocaleString("sv-SE", {
    style: "currency",
    currency: "SEK",
    maximumFractionDigits: 0
  });
}

function displayDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString("sv-SE") : "-";
}

function Status({ value }: { value: string }) {
  const normalized = String(value || "").toUpperCase();
  const good = ["ACTIVE", "PAID", "SUCCEEDED", "SIGNED", "COMPLETED", "CREATED"].includes(normalized);
  return <span className={`status ${good ? "good" : ""}`}>{value || "-"}</span>;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

function EmptyState({ title, text }: { title: string; text?: string }) {
  return <div className="emptyState"><CircleAlert size={18}/><div><strong>{title}</strong>{text && <p>{text}</p>}</div></div>;
}

function ErrorNotice({ message }: { message: string }) {
  return <div className="errorNotice"><CircleAlert size={18}/><div><strong>{message}</strong></div></div>;
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

  async function run<T>(fn: () => Promise<T>) {
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
          <div><span>Kundföretag</span><strong>{customer.name || "-"}</strong><small>{customer.org_number || "Org.nr saknas"}</small></div>
          <div><span>Kontakt</span><strong>{customer.contact_name || customer.name || "-"}</strong><small>{customer.email || "E-post saknas"}</small></div>
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

export function CustomerOrderApp() {
  return <CustomerOrderErrorBoundary>
    <Routes>
      <Route path="/customer-order/:token/*" element={<CustomerOrderPage/>}/>
    </Routes>
  </CustomerOrderErrorBoundary>;
}
