import { renderConfirmationEmail, webblyftetCompanyProfile } from "../../documents";
import { isEmailConfigured } from "../../lib/config";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { audit } from "../../core/finance";
import { EMAIL_RE } from "./documents";
import { emailProvider, type EmailProvider } from "./provider";

type SendConfirmationEmailOptions = {
  provider?: EmailProvider;
  manual?: boolean;
};

function failureCode(error: unknown): string {
  if (error instanceof PublicAppError) return error.publicMessage.split(":")[0].slice(0, 80) || "PROVIDER_ERROR";
  return "PROVIDER_ERROR";
}

function failureMessage(error: unknown): string {
  if (error instanceof PublicAppError) return error.publicMessage;
  if (error instanceof Error) return error.message;
  return "E-post kunde inte skickas.";
}

export async function latestConfirmationEmail(env: Env, sessionId: string) {
  return one<any>(
    env.DB,
     `SELECT * FROM outbound_email_events
     WHERE customer_order_session_id=? AND email_type='CONFIRMATION'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    sessionId
  );
}

export async function sendCustomerOrderConfirmationEmail(env: Env, sessionId: string, options: SendConfirmationEmailOptions = {}) {
  const existingAuto = !options.manual ? await one<any>(
    env.DB,
     `SELECT * FROM outbound_email_events
     WHERE customer_order_session_id=? AND email_type='CONFIRMATION' AND delivery_trigger='AUTO'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    sessionId
  ) : null;
  if (existingAuto) return { email_event: existingAuto, reused: true };

  const session = await one<any>(
    env.DB,
    `SELECT cos.*, so.id sales_order_id, so.offer_id, so.status sales_order_status,
      c.id customer_id, c.name customer_name, c.email customer_email,
      o.title offer_title
     FROM customer_order_sessions cos
     JOIN sales_orders so ON so.id=cos.sales_order_id
     JOIN customers c ON c.id=cos.customer_id
     LEFT JOIN offers o ON o.id=so.offer_id
     WHERE cos.id=?`,
    sessionId
  );
  if (!session) throw new PublicAppError(404, "Kundorder saknas.");
  const recipient = String(session.signer_email ?? session.customer_email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(recipient)) throw new PublicAppError(400, "Mottagarens e-postadress är inte giltig.");

  const [subscriptions, invoices] = await Promise.all([
    env.DB.prepare("SELECT status FROM subscriptions WHERE sales_order_id=?").bind(session.sales_order_id).all<any>(),
    env.DB.prepare("SELECT invoice_number FROM invoices WHERE sales_order_id=? ORDER BY created_at").bind(session.sales_order_id).all<any>()
  ]);
  const message = renderConfirmationEmail({
    company: webblyftetCompanyProfile(env),
    customer_name: session.customer_name,
    contact_name: session.signer_name ?? session.customer_name,
    order_reference: session.sales_order_id,
    offer_reference: session.offer_title ?? session.offer_id,
    signed_at: session.signed_at,
    subscription_active: subscriptions.results.some((row: any) => String(row.status).toUpperCase() === "ACTIVE"),
    invoice_numbers: invoices.results.map((row: any) => row.invoice_number).filter(Boolean)
  });
  const eventId = id("email");
  const trigger = options.manual ? "MANUAL" : "AUTO";
  if (!isEmailConfigured(env)) {
    await env.DB.prepare(
      `INSERT INTO outbound_email_events(id,recipient,email_type,provider,customer_order_session_id,contract_flow_id,status,subject,failure_code,failure_message,failed_at,delivery_trigger)
       VALUES (?,?,?,?,?,(SELECT id FROM contract_flows WHERE customer_order_session_id=? ORDER BY created_at DESC LIMIT 1),'FAILED',?,?,?,CURRENT_TIMESTAMP,?)`
    ).bind(eventId, recipient, "CONFIRMATION", "RESEND", sessionId, sessionId, message.subject, "EMAIL_CONFIG_REQUIRED", "E-post är inte konfigurerat ännu.", trigger).run();
    return { email_event: await one<any>(env.DB, "SELECT * FROM outbound_email_events WHERE id=?", eventId), reused: false };
  }
  await env.DB.prepare(
    `INSERT INTO outbound_email_events(id,recipient,email_type,provider,customer_order_session_id,contract_flow_id,status,subject,delivery_trigger)
     VALUES (?,?,?,?,?,(SELECT id FROM contract_flows WHERE customer_order_session_id=? ORDER BY created_at DESC LIMIT 1),'PENDING',?,?)`
  ).bind(eventId, recipient, "CONFIRMATION", "RESEND", sessionId, sessionId, message.subject, trigger).run();
  try {
    const result = await (options.provider ?? emailProvider(env)).send({
      ...message,
      to: recipient,
      type: "CONFIRMATION",
      idempotencyKey: eventId,
      tags: [
        { name: "type", value: "confirmation" },
        { name: "customer_order_session_id", value: sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) }
      ]
    });
    await env.DB.prepare("UPDATE outbound_email_events SET status='SENT', provider_message_id=?, sent_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(result.provider_message_id, eventId).run();
    await audit(env, "SYSTEM", null, "CUSTOMER_ORDER_CONFIRMATION_EMAIL_SENT", "customer_order_session", sessionId, null, {
      recipient,
      outbound_email_event_id: eventId,
      provider_message_id: result.provider_message_id
    });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE outbound_email_events SET status='FAILED', failed_at=CURRENT_TIMESTAMP, failure_code=?, failure_message=? WHERE id=?`
    ).bind(failureCode(error), failureMessage(error), eventId).run();
    if (options.manual) throw error;
  }
  return { email_event: await one<any>(env.DB, "SELECT * FROM outbound_email_events WHERE id=?", eventId), reused: false };
}
