import { resendWebhookSecret } from "../../lib/config";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { emitOperationalAlert } from "../../lib/operations";
import { stringifyLogValue } from "../../lib/security";

type ResendWebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: Record<string, any>;
};

const TERMINAL = new Set(["BOUNCED", "COMPLAINED", "FAILED"]);

function padBase64(input: string): string {
  return input + "=".repeat((4 - (input.length % 4)) % 4);
}

function bytesFromBase64(input: string): Uint8Array {
  const binary = atob(padBase64(input.replace(/-/g, "+").replace(/_/g, "/")));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function signatures(header: string): Uint8Array[] {
  return header.split(/\s+/).flatMap((entry) => {
    const parts = entry.split(",");
    const value = parts.length === 2 && parts[0] === "v1" ? parts[1] : parts[parts.length - 1];
    try {
      return [bytesFromBase64(value)];
    } catch {
      return [];
    }
  });
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function verifyResendSignature(env: Env, rawBody: string, headers: ResendWebhookHeaders): Promise<void> {
  if (!headers.id || !headers.timestamp || !headers.signature) throw new PublicAppError(400, "Resend webhook-signatur saknas.");
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    throw new PublicAppError(400, "Resend webhook timestamp är ogiltig.");
  }
  const secret = resendWebhookSecret(env).replace(/^whsec_/, "");
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(bytesFromBase64(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signedPayload = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload)));
  if (!signatures(headers.signature).some((candidate) => timingSafeEqual(candidate, expected))) {
    throw new PublicAppError(400, "Resend webhook-signatur är ogiltig.");
  }
}

function messageId(event: ResendEvent): string | null {
  const data = event.data ?? {};
  return String(data.email_id ?? data.id ?? data.email?.id ?? "").trim() || null;
}

function nextStatus(current: string | null | undefined, eventType: string): string | null {
  const normalized = String(current ?? "PENDING").toUpperCase();
  if (eventType === "email.sent") return normalized === "PENDING" ? "SENT" : null;
  if (eventType === "email.delivered") return TERMINAL.has(normalized) ? null : "DELIVERED";
  if (eventType === "email.bounced") return "BOUNCED";
  if (eventType === "email.complained") return "COMPLAINED";
  if (eventType === "email.failed") return "FAILED";
  if (eventType === "email.delivery_delayed") return normalized === "PENDING" ? "SENT" : null;
  return null;
}

async function alertForEvent(env: Env, eventType: string, email: any, providerEventId: string, payload: ResendEvent): Promise<void> {
  const map: Record<string, { event_type: "EMAIL_BOUNCED" | "EMAIL_COMPLAINED" | "EMAIL_DELIVERY_DELAYED" | "EMAIL_SEND_FAILED"; severity: "WARNING" | "ERROR" | "CRITICAL"; message: string }> = {
    "email.bounced": { event_type: "EMAIL_BOUNCED", severity: "ERROR", message: "Resend email bounced" },
    "email.complained": { event_type: "EMAIL_COMPLAINED", severity: "CRITICAL", message: "Resend email complained" },
    "email.delivery_delayed": { event_type: "EMAIL_DELIVERY_DELAYED", severity: "WARNING", message: "Resend email delivery delayed" },
    "email.failed": { event_type: "EMAIL_SEND_FAILED", severity: "ERROR", message: "Resend email failed" }
  };
  const item = map[eventType];
  if (!item) return;
  await emitOperationalAlert(env, {
    ...item,
    provider: "RESEND",
    provider_event_id: providerEventId,
    contract_flow_id: email.contract_flow_id,
    invoice_id: email.invoice_id,
    dedupe_key: `${item.event_type}:${email.id}:${eventType}`,
    details: {
      outbound_email_event_id: email.id,
      provider_message_id: email.provider_message_id,
      recipient: email.recipient,
      type: email.email_type,
      resend_event_type: eventType,
      data: payload.data ?? {}
    }
  });
}

export async function processResendWebhook(env: Env, rawBody: string, headers: ResendWebhookHeaders) {
  await verifyResendSignature(env, rawBody, headers);
  const event = JSON.parse(rawBody) as ResendEvent;
  const eventType = String(event.type ?? "");
  const providerEventId = headers.id!;
  const providerMessageId = messageId(event);
  const allowed = new Set(["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed", "email.delivery_delayed"]);
  if (!allowed.has(eventType)) return { ignored: true, event_type: eventType };

  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO email_provider_events(id,provider,provider_event_id,provider_message_id,event_type,payload_json)
     VALUES (?,?,?,?,?,?)`
  ).bind(id("epvt"), "RESEND", providerEventId, providerMessageId, eventType, stringifyLogValue(event)).run();
  if ((insert.meta.changes ?? 0) === 0) return { duplicate: true, event_type: eventType };
  if (!providerMessageId) {
    await emitOperationalAlert(env, {
      event_type: "EMAIL_WEBHOOK_ERROR",
      severity: "WARNING",
      message: "Resend webhook saknade provider message id",
      provider: "RESEND",
      provider_event_id: providerEventId,
      dedupe_key: `EMAIL_WEBHOOK_ERROR:${providerEventId}`,
      details: { event_type: eventType }
    });
    return { processed: true, matched: false, event_type: eventType };
  }
  const email = await one<any>(env.DB, "SELECT * FROM outbound_email_events WHERE provider='RESEND' AND provider_message_id=?", providerMessageId);
  if (!email) {
    await emitOperationalAlert(env, {
      event_type: "EMAIL_WEBHOOK_ERROR",
      severity: "WARNING",
      message: "Resend webhook kunde inte matchas mot outbound email",
      provider: "RESEND",
      provider_event_id: providerEventId,
      dedupe_key: `EMAIL_WEBHOOK_ERROR:${providerMessageId}`,
      details: { provider_message_id: providerMessageId, event_type: eventType }
    });
    return { processed: true, matched: false, event_type: eventType };
  }
  const status = nextStatus(email.status, eventType);
  const eventAt = event.created_at ?? new Date().toISOString();
  if (status) {
    await env.DB.prepare(
      `UPDATE outbound_email_events
       SET status=?,
         delivered_at=CASE WHEN ?='DELIVERED' THEN COALESCE(delivered_at,?) ELSE delivered_at END,
         bounced_at=CASE WHEN ?='BOUNCED' THEN COALESCE(bounced_at,?) ELSE bounced_at END,
         complained_at=CASE WHEN ?='COMPLAINED' THEN COALESCE(complained_at,?) ELSE complained_at END,
         failed_at=CASE WHEN ?='FAILED' THEN COALESCE(failed_at,?) ELSE failed_at END,
         failure_code=CASE WHEN ? IN ('BOUNCED','COMPLAINED','FAILED') THEN ? ELSE failure_code END,
         last_provider_event_id=?,
         last_provider_event_type=?,
         last_provider_event_at=?
       WHERE id=?`
    ).bind(
      status,
      status, eventAt,
      status, eventAt,
      status, eventAt,
      status, eventAt,
      status, eventType,
      providerEventId,
      eventType,
      eventAt,
      email.id
    ).run();
  } else {
    await env.DB.prepare(
      "UPDATE outbound_email_events SET last_provider_event_id=?, last_provider_event_type=?, last_provider_event_at=? WHERE id=?"
    ).bind(providerEventId, eventType, eventAt, email.id).run();
  }
  await alertForEvent(env, eventType, email, providerEventId, event);
  return { processed: true, matched: true, event_type: eventType, status: status ?? email.status };
}
