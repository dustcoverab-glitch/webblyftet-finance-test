import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import {
  BadgeCheck, BookOpen, Building2, FileCheck2, FileText, Gauge, PlugZap,
  Package, ReceiptText, RefreshCw, Repeat, Send, Users, WalletCards
} from "lucide-react";
import { api, post } from "./api";
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
  id: string; customer_name: string; total: number; balance?: number; status: string;
  fortnox_document_number?: string; due_date?: string;
};
type Product = {
  id: string; name: string; description: string; product_type: string; active: number; prices: string | any[];
};
type Subscription = {
  id: string; customer_name: string; status: string; monthly_amount: number; current_period_end?: string;
  stripe_subscription_id?: string; items: string | any[];
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

const nav = [
  ["/", "Översikt", Gauge],
  ["/customers", "Kunder", Users],
  ["/products", "Produkter & priser", Package],
  ["/subscriptions", "Abonnemang", Repeat],
  ["/offers", "Offerter", FileCheck2],
  ["/invoices", "Fakturor", FileText],
  ["/receipts", "Kvitton", ReceiptText],
  ["/supplier-invoices", "Leverantörsfakturor", WalletCards],
  ["/bookkeeping", "Bokföring", BookOpen],
  ["/integration", "Fortnox", PlugZap],
] as const;

function Layout({ children }: { children: React.ReactNode }) {
  return <div className="shell">
    <aside>
      <div className="brand"><div className="brandMark">W</div><div><strong>Webblyftet</strong><span>Finance Test</span></div></div>
      <div className="testBadge">TESTMILJÖ</div>
      <nav>{nav.map(([to, label, Icon]) =>
        <NavLink key={to} to={to} end={to === "/"}><Icon size={18}/><span>{label}</span></NavLink>
      )}</nav>
      <div className="asideFoot">Finance Core + integrations<br/><small>Cloudflare Worker + D1 + R2</small></div>
    </aside>
    <main>{children}</main>
  </div>;
}

function PageHead({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="pageHead"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}
function Card({ children, className="" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}
function Status({ value }: { value: string }) {
  const good = ["SYNCED","PAID","ACCEPTED","CONNECTED","ACTIVE","SUCCEEDED","OK"].includes(value);
  return <span className={`status ${good ? "good" : ""}`}>{value}</span>;
}

function Dashboard() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/api/dashboard").then(setData).catch(console.error); }, []);
  if (!data) return <div>Hämtar…</div>;
  return <>
    <PageHead title="Finance Control" subtitle="Separat Finance Core med Stripe och Fortnox som adapters." />
    <div className="metricGrid">
      <Card><span>Kunder</span><strong>{data.customers?.count ?? 0}</strong></Card>
      <Card><span>Offerter</span><strong>{data.offers?.count ?? 0}</strong><small>{money(data.offers?.value)}</small></Card>
      <Card><span>Fakturor</span><strong>{data.invoices?.count ?? 0}</strong><small>{money(data.invoices?.value)}</small></Card>
      <Card><span>Utestående</span><strong>{money(data.invoices?.outstanding)}</strong></Card>
    </div>
    <div className="twoCol">
      <Card><h3>Fortnox</h3><div className="connection">
        <div className={`dot ${data.connection?.connected ? "on" : ""}`}></div>
        <div><strong>{data.connection?.connected ? data.connection.company_name || "Ansluten" : "Inte ansluten"}</strong>
        <p>{data.connection?.connected ? "OAuth/service account aktiv" : "Anslut från integrationssidan."}</p></div>
      </div></Card>
      <Card><h3>Senaste synk</h3><div className="logList">{data.logs?.slice(0,6).map((l:any)=>
        <div key={l.id}><span>{l.operation} {l.entity_type}</span><Status value={l.success ? "OK" : "ERROR"}/></div>
      )}</div></Card>
    </div>
  </>;
}

function Customers() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const load = () => api<Customer[]>("/api/customers").then(setRows);
  useEffect(() => { load().catch(console.error); }, []);
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
    <Card><table><thead><tr><th>Kund</th><th>Kontakt</th><th>Ort</th><th>Fortnox</th><th></th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td><strong>{r.name}</strong><small>{r.org_number}</small></td>
        <td>{r.phone}<small>{r.email}</small></td><td>{r.city}</td><td><Status value={r.sync_status}/><small>{r.fortnox_customer_number}</small></td>
        <td>{!r.fortnox_customer_number && <button className="small" onClick={async()=>{await post(`/api/customers/${r.id}/sync`); await load();}}>Synka</button>}</td></tr>)}
    </tbody></table></Card>
  </>;
}

function Offers() {
  const [rows, setRows] = useState<Offer[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const load = async () => { setRows(await api("/api/offers")); setCustomers(await api("/api/customers")); };
  useEffect(() => { load().catch(console.error); }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await post("/api/offers", {
      customer_id: f.get("customer_id"), title: f.get("title"), offer_date: f.get("offer_date"),
      expire_date: f.get("expire_date"), remarks: f.get("remarks"),
      rows: [{ description: f.get("description"), quantity: Number(f.get("quantity")), unit:"st",
        unit_price: Number(f.get("unit_price")), discount_percent: Number(f.get("discount_percent") || 0),
        vat_percent: 25, article_number:"" }]
    }); setOpen(false); await load();
  }
  return <>
    <PageHead title="Offerter" subtitle="Skapa lokalt, synka till Fortnox, acceptera och konvertera till faktura."
      action={<button onClick={()=>setOpen(!open)}>Ny offert</button>} />
    {open && <Card><form onSubmit={submit} className="formGrid">
      <select name="customer_id" required><option value="">Välj kund</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <input name="title" placeholder="Offerttitel" required/><input type="date" name="offer_date" defaultValue={new Date().toISOString().slice(0,10)} required/>
      <input type="date" name="expire_date"/><input name="description" placeholder="Tjänst / radbeskrivning" required/>
      <input name="quantity" type="number" step="0.01" defaultValue="1" required/><input name="unit_price" type="number" step="0.01" placeholder="Pris exkl. moms" required/>
      <input name="discount_percent" type="number" defaultValue="0" placeholder="Rabatt %"/><input name="remarks" placeholder="Kommentar"/>
      <button type="submit">Skapa offert</button>
    </form></Card>}
    <Card><table><thead><tr><th>Offert</th><th>Kund</th><th>Belopp</th><th>Status</th><th>Fortnox</th><th>Åtgärder</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td><strong>{r.title || "Offert"}</strong><small>{r.offer_date}</small></td><td>{r.customer_name}</td>
      <td>{money(r.total)}</td><td><Status value={r.status}/></td><td>{r.fortnox_document_number || "—"}</td>
      <td><div className="rowActions">
        {!r.fortnox_document_number && <button className="small" onClick={async()=>{await post(`/api/offers/${r.id}/sync`); await load();}}>Synka</button>}
        <button className="small ghost" onClick={async()=>{const d:any=await post(`/api/offers/${r.id}/sign-link`); await navigator.clipboard.writeText(d.url); alert("Signeringslänk kopierad");}}>Signeringslänk</button>
        {r.fortnox_document_number && <button className="small" onClick={async()=>{await post(`/api/offers/${r.id}/create-invoice`); alert("Faktura skapad");}}>→ Faktura</button>}
      </div></td></tr>)}
    </tbody></table></Card>
  </>;
}

function Invoices() {
  const [rows,setRows]=useState<Invoice[]>([]);
  const load=()=>api<Invoice[]>("/api/invoices").then(setRows);
  useEffect(()=>{load().catch(console.error)},[]);
  return <>
    <PageHead title="Fakturor" subtitle="Fortnox är system of record. Status speglas tillbaka hit."
      action={<button className="ghost" onClick={async()=>{await post("/api/invoices/pull"); await load();}}><RefreshCw size={16}/>Synka fakturor</button>}/>
    <Card><table><thead><tr><th>#</th><th>Kund</th><th>Belopp</th><th>Saldo</th><th>Förfallo</th><th>Status</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td>{r.fortnox_document_number||"—"}</td><td>{r.customer_name}</td><td>{money(r.total)}</td><td>{money(r.balance)}</td><td>{r.due_date||"—"}</td><td><Status value={r.status}/></td></tr>)}
    </tbody></table></Card>
  </>;
}

function Receipts() {
  const [rows,setRows]=useState<any[]>([]);
  const load=()=>api<any[]>("/api/receipts").then(setRows);
  useEffect(()=>{load().catch(console.error)},[]);
  async function upload(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault(); const fd=new FormData(e.currentTarget);
    await api("/api/receipts",{method:"POST",body:fd}); (e.currentTarget as HTMLFormElement).reset(); await load();
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
      <td><a className="button small ghost" target="_blank" href={`/api/receipts/${r.id}/file`}>Visa</a></td></tr>)}
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
    <Card><table><thead><tr><th>Produkt</th><th>Typ</th><th>Pris</th><th>Stripe</th><th>Status</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.id}><td><strong>{r.name}</strong><small>{r.description}</small></td><td>{r.product_type}</td>
        <td>{jsonArray(r.prices).map((p:any) => <div key={p.id}>{cents(p.amount)} <small>{p.billing_type}{p.billing_interval ? ` / ${p.billing_interval}` : ""}</small></div>)}</td>
        <td>{jsonArray(r.prices).map((p:any) => <small key={p.id}>{p.stripe_price_id || "Ej kopplad"}</small>)}</td>
        <td><Status value={r.active ? "ACTIVE" : "INACTIVE"}/></td></tr>)}
    </tbody></table></Card>
  </>;
}

function Subscriptions() {
  const [rows, setRows] = useState<Subscription[]>([]);
  const load = () => api<Subscription[]>("/api/subscriptions").then(setRows);
  useEffect(() => { load().catch(console.error); }, []);
  return <>
    <PageHead title="Abonnemang" subtitle="Core-vy för subscriptions, items och Stripe-status. Ingen checkout ännu."/>
    <Card><table><thead><tr><th>Kund</th><th>Status</th><th>Produkter/items</th><th>Månadsbelopp</th><th>Nästa periodslut</th><th>Stripe-status</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.id}><td>{r.customer_name}</td><td><Status value={r.status}/></td>
        <td>{jsonArray(r.items).map((item:any, index:number) => <div key={index}>{item.product_name} × {item.quantity}<small>{cents(item.unit_amount)} {item.billing_interval || ""}</small></div>)}</td>
        <td>{cents(r.monthly_amount)}</td><td>{r.current_period_end || "—"}</td><td>{r.stripe_subscription_id ? "Kopplad" : "Ej skapad"}</td></tr>)}
    </tbody></table></Card>
  </>;
}

function Integration(){
  const [status,setStatus]=useState<any>(null); const [logs,setLogs]=useState<any[]>([]);
  const load=async()=>{setStatus(await api("/api/integration/status"));setLogs(await api("/api/sync-log"));};
  useEffect(()=>{load().catch(console.error)},[]);
  return <>
    <PageHead title="Fortnox-integration" subtitle="OAuth2 service account, scopes och synklogg."/>
    <div className="twoCol">
      <Card><h3>Anslutning</h3>{status?.connected ? <>
        <div className="connection"><div className="dot on"></div><div><strong>{status.company_name||"Fortnox ansluten"}</strong><p>Tenant {status.tenant_id||"—"}</p></div></div>
        <p className="muted">{status.scope}</p><button className="danger" onClick={async()=>{await post("/api/integration/disconnect"); await load();}}>Koppla från</button>
      </>:<><p>Ingen Fortnox-anslutning finns i testdatabasen.</p><a className="button" href="/auth/fortnox/start"><PlugZap size={16}/>Anslut Fortnox</a></>}</Card>
      <Card><h3>Säkerhetsmodell</h3><ul className="checkList"><li><BadgeCheck size={16}/>Client secret lagras som Worker secret</li><li><BadgeCheck size={16}/>Tokens krypteras AES-GCM i D1</li><li><BadgeCheck size={16}/>OAuth state skyddar mot CSRF</li><li><BadgeCheck size={16}/>Testmiljö separerad från huvudportalen</li></ul></Card>
    </div>
    <Card><h3>API-logg</h3><table><thead><tr><th>Tid</th><th>Operation</th><th>Endpoint</th><th>Status</th></tr></thead><tbody>
      {logs.slice(0,40).map(l=><tr key={l.id}><td>{l.created_at}</td><td>{l.operation}</td><td className="mono">{l.endpoint}</td><td><Status value={l.success?"OK":"ERROR"}/></td></tr>)}
    </tbody></table></Card>
  </>;
}

function App(){
  return <Layout><Routes>
    <Route path="/" element={<Dashboard/>}/><Route path="/customers" element={<Customers/>}/><Route path="/offers" element={<Offers/>}/>
    <Route path="/products" element={<Products/>}/><Route path="/subscriptions" element={<Subscriptions/>}/>
    <Route path="/invoices" element={<Invoices/>}/><Route path="/receipts" element={<Receipts/>}/>
    <Route path="/supplier-invoices" element={<SupplierInvoices/>}/><Route path="/bookkeeping" element={<Bookkeeping/>}/>
    <Route path="/integration" element={<Integration/>}/>
  </Routes></Layout>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
