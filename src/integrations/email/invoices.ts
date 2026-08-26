import { renderInvoiceEmail } from "../../documents";
import { isEmailConfigured } from "../../lib/config";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { audit } from "../../core/finance";
import { createOrReuseInvoiceDocumentUrl, EMAIL_RE, invoiceDocumentInputForEmail } from "./documents";
import { emailProvider, type EmailProvider } from "./provider";

type SendInvoiceEmailOptions = {
  recipient?: string | null;
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

export async function latestInvoiceEmail(env: Env, invoiceId: string) {
  return one<any>(
    env.DB,
     `SELECT * FROM outbound_email_events
     WHERE invoice_id=? AND email_type='INVOICE'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    invoiceId
  );
}

export async function sendInvoiceEmail(env: Env, invoiceId: string, options: SendInvoiceEmailOptions = {}) {
  const existingAuto = !options.manual ? await one<any>(
    env.DB,
     `SELECT * FROM outbound_email_events
     WHERE invoice_id=? AND email_type='INVOICE' AND delivery_trigger='AUTO'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    invoiceId
  ) : null;
  if (existingAuto && existingAuto.status !== "FAILED") return { email_event: existingAuto, reused: true };

  const input = await invoiceDocumentInputForEmail(env, invoiceId);
  const recipient = String(options.recipient ?? input.customer_email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(recipient)) throw new PublicAppError(400, "Mottagarens e-postadress är inte giltig.");
  const eventId = id("email");
  const trigger = options.manual ? "MANUAL" : "AUTO";
  if (!isEmailConfigured(env)) {
    await env.DB.prepare(
      `INSERT INTO outbound_email_events(id,recipient,email_type,provider,invoice_id,status,subject,failure_code,failure_message,failed_at,delivery_trigger)
       VALUES (?,?,?,?,?,'FAILED',?,?,?,CURRENT_TIMESTAMP,?)`
    ).bind(eventId, recipient, "INVOICE", "RESEND", invoiceId, "Din faktura från Webblyftet", "EMAIL_CONFIG_REQUIRED", "E-post är inte konfigurerat ännu.", trigger).run();
    return { email_event: await one<any>(env.DB, "SELECT * FROM outbound_email_events WHERE id=?", eventId), reused: false };
  }
  const invoiceUrl = await createOrReuseInvoiceDocumentUrl(env, invoiceId);
  const message = renderInvoiceEmail(input, invoiceUrl);
  await env.DB.prepare(
    `INSERT INTO outbound_email_events(id,recipient,email_type,provider,invoice_id,status,subject,delivery_trigger)
     VALUES (?,?,?,?,?,'PENDING',?,?)`
  ).bind(eventId, recipient, "INVOICE", "RESEND", invoiceId, message.subject, trigger).run();
  try {
    const result = await (options.provider ?? emailProvider(env)).send({
      ...message,
      to: recipient,
      type: "INVOICE",
      idempotencyKey: eventId,
      tags: [
        { name: "type", value: "invoice" },
        { name: "invoice_id", value: invoiceId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) }
      ]
    });
    await env.DB.prepare(
      `UPDATE outbound_email_events SET status='SENT', provider_message_id=?, sent_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(result.provider_message_id, eventId).run();
    await audit(env, "SYSTEM", null, "INVOICE_EMAIL_SENT", "invoice", invoiceId, null, {
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
