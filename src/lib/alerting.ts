import { adminAlertEmail, emailFrom, emailFromName, emailReplyTo, isEmailConfigured, resendApiKey } from "./config";
import { id, one } from "./db";

export function shouldNotifyOperationalEvent(event: { event_type: string; severity: string; occurrence_count?: number | null }): boolean {
  if (event.severity === "CRITICAL") return true;
  if (event.event_type === "STRIPE_WEBHOOK_ERROR") return true;
  if (event.event_type === "WORKER_UNHANDLED_ERROR") return true;
  if (event.event_type === "FORTNOX_SYNC_FAILED" && ["ERROR", "CRITICAL"].includes(event.severity)) return true;
  if (event.event_type === "STRIPE_PAYMENT_FAILED" && Number(event.occurrence_count ?? 1) >= 2) return true;
  return false;
}

function formatFrom(name: string, address: string): string {
  const safeName = name.replace(/[<>\r\n"]/g, "").trim();
  return safeName ? `${safeName} <${address}>` : address;
}

export async function notifyOperationalEvent(env: Env, operationalEventId: string) {
  const event = await one<any>(env.DB, "SELECT * FROM operational_events WHERE id=?", operationalEventId);
  if (!event) return { notified: false, reason: "NOT_FOUND" };
  if (!shouldNotifyOperationalEvent(event)) return { notified: false, reason: "NOT_CRITICAL" };
  const recipient = adminAlertEmail(env).trim().toLowerCase();
  const selectedProvider = isEmailConfigured(env) && recipient ? "RESEND" : "NOOP";
  const existing = await one<any>(
    env.DB,
    "SELECT * FROM alert_notifications WHERE operational_event_id=? AND provider=? AND COALESCE(recipient,'')=?",
    operationalEventId,
    selectedProvider,
    selectedProvider === "RESEND" ? recipient : ""
  );
  if (existing) return { notified: existing.status === "SENT", reused: true, status: existing.status };
  const notificationId = id("alrt");
  await env.DB.prepare(
    "INSERT INTO alert_notifications(id,operational_event_id,provider,recipient,status) VALUES (?,?,?,?,?)"
  ).bind(notificationId, operationalEventId, selectedProvider, selectedProvider === "RESEND" ? recipient : "", selectedProvider === "RESEND" ? "PENDING" : "SKIPPED").run();
  if (selectedProvider !== "RESEND") return { notified: false, status: "SKIPPED" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey(env)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": notificationId
      },
      body: JSON.stringify({
        from: formatFrom(emailFromName(env), emailFrom(env)),
        to: [recipient],
        subject: `[Finance ${event.severity}] ${event.event_type}`,
        html: `<p><strong>${event.event_type}</strong></p><p>${event.message}</p><p>Severity: ${event.severity}</p>`,
        text: `${event.event_type}\n${event.message}\nSeverity: ${event.severity}`,
        reply_to: emailReplyTo(env),
        tags: [{ name: "type", value: "operational-alert" }]
      })
    });
    const body = await response.json<any>().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.message ?? body?.error ?? `HTTP ${response.status}`));
    await env.DB.prepare(
      "UPDATE alert_notifications SET status='SENT', provider_message_id=?, sent_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(String(body?.id ?? ""), notificationId).run();
    return { notified: true, status: "SENT", provider_message_id: String(body?.id ?? "") };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE alert_notifications SET status='FAILED', failure_message=? WHERE id=?"
    ).bind(error instanceof Error ? error.message : "Alert kunde inte skickas.", notificationId).run();
    return { notified: false, status: "FAILED" };
  }
}
