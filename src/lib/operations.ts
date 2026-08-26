import { id } from "./db";
import { sanitizeForLog, stringifyLogValue } from "./security";

export type OperationalSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type OperationalEventType =
  | "STRIPE_WEBHOOK_ERROR"
  | "STRIPE_PAYMENT_FAILED"
  | "FORTNOX_SYNC_FAILED"
  | "FORTNOX_AUTH_FAILED"
  | "EMAIL_SEND_FAILED"
  | "EMAIL_BOUNCED"
  | "EMAIL_COMPLAINED"
  | "EMAIL_DELIVERY_DELAYED"
  | "EMAIL_WEBHOOK_ERROR"
  | "CUSTOMER_ORDER_STALLED"
  | "WORKER_UNHANDLED_ERROR";

export type OperationalEventInput = {
  event_type: OperationalEventType;
  severity: OperationalSeverity;
  message: string;
  dedupe_key?: string | null;
  customer_id?: string | null;
  contract_flow_id?: string | null;
  sales_order_id?: string | null;
  invoice_id?: string | null;
  subscription_id?: string | null;
  provider?: string | null;
  provider_event_id?: string | null;
  request_id?: string | null;
  details?: unknown;
};

export async function emitOperationalAlert(env: Env, input: OperationalEventInput): Promise<void> {
  const eventId = id("op");
  const dedupeKey = input.dedupe_key || `${input.event_type}:${input.provider ?? "internal"}:${input.provider_event_id ?? input.request_id ?? input.message}`;
  await env.DB.prepare(
    `INSERT INTO operational_events
      (id,event_type,severity,status,message,dedupe_key,customer_id,contract_flow_id,sales_order_id,invoice_id,subscription_id,provider,provider_event_id,request_id,details_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dedupe_key) WHERE resolved_at IS NULL DO UPDATE SET
       severity=excluded.severity,
       message=excluded.message,
       details_json=excluded.details_json,
       occurrence_count=occurrence_count+1,
       last_seen_at=CURRENT_TIMESTAMP`
  ).bind(
    eventId,
    input.event_type,
    input.severity,
    "OPEN",
    input.message,
    dedupeKey,
    input.customer_id ?? null,
    input.contract_flow_id ?? null,
    input.sales_order_id ?? null,
    input.invoice_id ?? null,
    input.subscription_id ?? null,
    input.provider ?? null,
    input.provider_event_id ?? null,
    input.request_id ?? null,
    stringifyLogValue(sanitizeForLog(input.details ?? null))
  ).run();
}

export async function operationalHealth(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT event_type,severity,status,message,customer_id,contract_flow_id,sales_order_id,invoice_id,subscription_id,
       provider,provider_event_id,request_id,occurrence_count,created_at,last_seen_at,resolved_at,acknowledged_at
     FROM operational_events
     WHERE status='OPEN'
     ORDER BY
       CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,
       last_seen_at DESC
     LIMIT 50`
  ).all<any>();
  const latest = await env.DB.prepare(
    `SELECT
       (SELECT last_seen_at FROM operational_events WHERE event_type IN ('STRIPE_WEBHOOK_ERROR','STRIPE_PAYMENT_FAILED') ORDER BY last_seen_at DESC LIMIT 1) latest_stripe_failure,
       (SELECT last_seen_at FROM operational_events WHERE event_type IN ('FORTNOX_SYNC_FAILED','FORTNOX_AUTH_FAILED') ORDER BY last_seen_at DESC LIMIT 1) latest_fortnox_failure,
       (SELECT last_seen_at FROM operational_events WHERE event_type IN ('EMAIL_SEND_FAILED','EMAIL_BOUNCED','EMAIL_COMPLAINED','EMAIL_DELIVERY_DELAYED','EMAIL_WEBHOOK_ERROR') ORDER BY last_seen_at DESC LIMIT 1) latest_email_failure,
       (SELECT COUNT(*) FROM operational_events WHERE status='OPEN' AND severity IN ('ERROR','CRITICAL')) unresolved_recent_errors`
  ).first<any>();
  return { latest, open: rows.results };
}
