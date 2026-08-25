import { audit } from "../../core/finance";
import { createContractFlowCustomerLink, getContractFlow } from "../../core/contract-flow";
import { customerOrderSessionUrl } from "../../core/customer-order";
import {
  renderOfferEmail,
  webblyftetCompanyProfile,
  type DocumentLine,
  type OfferDocumentInput
} from "../../documents";
import { isEmailConfigured } from "../../lib/config";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { emailProvider, type EmailProvider } from "./provider";

type SendOfferEmailOptions = {
  recipient?: string | null;
  provider?: EmailProvider;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function moneyToMinor(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}

function rowUnitPriceMinor(row: any): number {
  return Number(row.unit_price_minor ?? moneyToMinor(row.unit_price));
}

function documentRows(rows: any[]): DocumentLine[] {
  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    article_number: row.article_number ?? null,
    quantity: Number(row.quantity ?? 0),
    unit: row.unit ?? "st",
    unit_price_minor: rowUnitPriceMinor(row),
    discount_percent: Number(row.discount_percent ?? 0),
    vat_percent: Number(row.vat_percent ?? 25),
    billing_type: row.billing_type ?? "ONE_TIME",
    billing_interval: row.billing_interval ?? null
  }));
}

function failureCode(error: unknown): string {
  if (error instanceof PublicAppError) return error.publicMessage.split(":")[0].slice(0, 80) || "PROVIDER_ERROR";
  return "PROVIDER_ERROR";
}

function failureMessage(error: unknown): string {
  if (error instanceof PublicAppError) return error.publicMessage;
  if (error instanceof Error) return error.message;
  return "E-post kunde inte skickas.";
}

async function offerDocumentInputForVersion(env: Env, offerId: string, versionId: string): Promise<OfferDocumentInput> {
  const offer = await one<any>(
    env.DB,
    `SELECT o.*, c.name customer_name, c.org_number customer_org_number, c.email customer_email,
      c.phone customer_phone, c.address1 customer_address1, c.zip customer_zip, c.city customer_city,
      c.country customer_country, v.version_number
     FROM offers o
     JOIN customers c ON c.id=o.customer_id
     JOIN offer_versions v ON v.id=? AND v.offer_id=o.id
     WHERE o.id=?`,
    versionId,
    offerId
  );
  if (!offer) throw new PublicAppError(404, "Offertversion saknas.");
  const rows = await env.DB.prepare("SELECT * FROM offer_rows WHERE offer_id=? ORDER BY sort_order").bind(offerId).all<any>();
  return {
    document_number: offer.fortnox_document_number || offer.id,
    title: offer.title || "Offert",
    document_date: offer.offer_date,
    valid_until: offer.expire_date,
    currency: offer.currency ?? "SEK",
    customer: {
      name: offer.customer_name,
      org_number: offer.customer_org_number ?? null,
      email: offer.customer_email ?? null,
      phone: offer.customer_phone ?? null,
      address1: offer.customer_address1 ?? null,
      zip: offer.customer_zip ?? null,
      city: offer.customer_city ?? null,
      country: offer.customer_country ?? "Sverige",
      contact_name: offer.accepted_by_name ?? null
    },
    seller_name: "Webblyftet",
    rows: documentRows(rows.results),
    remarks: offer.remarks ?? "",
    version_number: offer.version_number,
    company: webblyftetCompanyProfile(env)
  };
}

export async function latestContractFlowEmail(env: Env, flowId: string) {
  return one<any>(
    env.DB,
    `SELECT * FROM outbound_email_events
     WHERE contract_flow_id=?
     ORDER BY created_at DESC LIMIT 1`,
    flowId
  );
}

export async function sendContractFlowOfferEmail(env: Env, flowId: string, options: SendOfferEmailOptions = {}) {
  const initialFlow = await getContractFlow(env, flowId);
  if (!initialFlow) throw new PublicAppError(404, "Avtalskedjan saknas.");
  const recipient = String(options.recipient ?? initialFlow.draft?.contact?.email ?? initialFlow.customer_email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(recipient)) throw new PublicAppError(400, "Mottagarens e-postadress är inte giltig.");
  if (!isEmailConfigured(env)) throw new PublicAppError(503, "E-post är inte konfigurerat ännu.");

  const flow = initialFlow.customer_order_session_id ? initialFlow : await createContractFlowCustomerLink(env, flowId);
  if (!flow?.sales_order_id || !flow.customer_order_session_id) {
    throw new PublicAppError(409, "Kundlänk måste kunna skapas innan offertmail skickas.");
  }
  const order = await one<any>(env.DB, "SELECT * FROM sales_orders WHERE id=?", flow.sales_order_id);
  if (!order?.offer_id || !order.offer_version_id) throw new PublicAppError(409, "Ordern saknar immutable offertversion.");
  const version = await one<any>(env.DB, "SELECT id FROM offer_versions WHERE id=? AND offer_id=?", order.offer_version_id, order.offer_id);
  if (!version) throw new PublicAppError(409, "Orderns offertversion saknas.");
  const customerOrderUrl = flow.customer_order_url || await customerOrderSessionUrl(env, flow.customer_order_session_id);
  const input = await offerDocumentInputForVersion(env, order.offer_id, order.offer_version_id);
  const message = renderOfferEmail(input, customerOrderUrl);
  const eventId = id("email");
  await env.DB.prepare(
    `INSERT INTO outbound_email_events
      (id,recipient,email_type,provider,contract_flow_id,customer_order_session_id,offer_id,status,subject)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(eventId, recipient, "OFFER", "RESEND", flowId, flow.customer_order_session_id, order.offer_id, "PENDING", message.subject).run();

  try {
    const result = await (options.provider ?? emailProvider(env)).send({
      ...message,
      to: recipient,
      type: "OFFER",
      idempotencyKey: eventId,
      tags: [
        { name: "type", value: "offer" },
        { name: "contract_flow_id", value: flowId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) }
      ]
    });
    await env.DB.prepare(
      `UPDATE outbound_email_events
       SET status='SENT', provider_message_id=?, sent_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(result.provider_message_id, eventId).run();
    await env.DB.batch([
      env.DB.prepare("UPDATE offers SET status='SENT', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('DRAFT','READY','SENT')").bind(order.offer_id),
      env.DB.prepare("UPDATE contract_flows SET status='OFFER_SENT', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('DRAFT','READY','OFFER_READY','CUSTOMER_LINK_CREATED')").bind(flowId)
    ]);
    await audit(env, "SYSTEM", null, "OFFER_EMAIL_SENT", "contract_flow", flowId, null, {
      recipient,
      outbound_email_event_id: eventId,
      provider: result.provider,
      provider_message_id: result.provider_message_id,
      customer_order_session_id: flow.customer_order_session_id,
      offer_id: order.offer_id
    });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE outbound_email_events
       SET status='FAILED', failed_at=CURRENT_TIMESTAMP, failure_code=?, failure_message=?
       WHERE id=?`
    ).bind(failureCode(error), failureMessage(error), eventId).run();
    throw error;
  }

  return {
    email_event: await one<any>(env.DB, "SELECT * FROM outbound_email_events WHERE id=?", eventId),
    flow: await getContractFlow(env, flowId),
    customer_order_url: customerOrderUrl
  };
}
