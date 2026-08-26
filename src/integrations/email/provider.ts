import { emailFrom, emailFromName, emailReplyTo, resendApiKey } from "../../lib/config";
import { id } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { stringifyLogValue } from "../../lib/security";
import { emitOperationalAlert } from "../../lib/operations";

export type EmailType = "OFFER" | "INVOICE" | "CONFIRMATION";
export type EmailDeliveryStatus = "PENDING" | "SENT" | "DELIVERED" | "BOUNCED" | "COMPLAINED" | "FAILED";
export type EmailProviderName = "RESEND";
export type EmailDeliveryTrigger = "AUTO" | "MANUAL";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  type: EmailType;
  idempotencyKey: string;
  tags?: Array<{ name: string; value: string }>;
};

export type EmailSendResult = {
  provider: EmailProviderName;
  provider_message_id: string;
};

export interface EmailProvider {
  readonly provider: EmailProviderName;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

function formatFrom(name: string, address: string): string {
  const safeName = name.replace(/[<>\r\n"]/g, "").trim();
  return safeName ? `${safeName} <${address}>` : address;
}

type ResendErrorBody = {
  name?: string;
  message?: string;
  error?: string;
};

export class ResendEmailProvider implements EmailProvider {
  readonly provider = "RESEND" as const;

  constructor(private readonly env: Env) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const payload = {
      from: formatFrom(emailFromName(this.env), emailFrom(this.env)),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: emailReplyTo(this.env),
      tags: message.tags
    };
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey(this.env)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json<any>().catch(() => ({}));
    await this.env.DB.prepare(
      `INSERT INTO sync_log(id,direction,entity_type,entity_id,operation,endpoint,http_status,success,request_json,response_json,error_message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id("sync"),
      "OUTBOUND",
      "EMAIL",
      null,
      "POST",
      "https://api.resend.com/emails",
      response.status,
      response.ok ? 1 : 0,
      stringifyLogValue({
        provider: this.provider,
        type: message.type,
        to: message.to,
        subject: message.subject,
        has_html: Boolean(message.html),
        has_text: Boolean(message.text),
        tags: message.tags
      }),
      stringifyLogValue(body),
      response.ok ? null : String((body as ResendErrorBody).name ?? (body as ResendErrorBody).error ?? `HTTP ${response.status}`)
    ).run();
    if (!response.ok) {
      const errorCode = String((body as ResendErrorBody).name ?? (body as ResendErrorBody).error ?? `HTTP_${response.status}`);
      const errorMessage = String((body as ResendErrorBody).message ?? "Resend accepterade inte meddelandet.");
      await emitOperationalAlert(this.env, {
        event_type: "EMAIL_SEND_FAILED",
        severity: "ERROR",
        message: "Resend email delivery request failed",
        provider: this.provider,
        dedupe_key: `EMAIL_SEND_FAILED:${message.type}:${message.to}:${errorCode}`,
        details: {
          type: message.type,
          to: message.to,
          subject: message.subject,
          status: response.status,
          error_code: errorCode,
          error_message: errorMessage,
          tags: message.tags
        }
      }).catch(() => undefined);
      throw new PublicAppError(response.status >= 400 && response.status < 600 ? response.status : 502, `${errorCode}: ${errorMessage}`);
    }
    const messageId = String(body?.id ?? "");
    if (!messageId) throw new PublicAppError(502, "Resend returnerade inget message ID.");
    return { provider: this.provider, provider_message_id: messageId };
  }
}

export function emailProvider(env: Env): EmailProvider {
  return new ResendEmailProvider(env);
}
