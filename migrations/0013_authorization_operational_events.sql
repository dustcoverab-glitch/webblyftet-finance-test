CREATE TABLE IF NOT EXISTS operational_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'STRIPE_WEBHOOK_ERROR',
    'STRIPE_PAYMENT_FAILED',
    'FORTNOX_SYNC_FAILED',
    'FORTNOX_AUTH_FAILED',
    'EMAIL_SEND_FAILED',
    'EMAIL_BOUNCED',
    'CUSTOMER_ORDER_STALLED',
    'WORKER_UNHANDLED_ERROR'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  message TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  customer_id TEXT,
  contract_flow_id TEXT,
  sales_order_id TEXT,
  invoice_id TEXT,
  subscription_id TEXT,
  provider TEXT,
  provider_event_id TEXT,
  request_id TEXT,
  details_json TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_events_open_dedupe
  ON operational_events(dedupe_key)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operational_events_open_severity
  ON operational_events(status, severity, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_events_entity
  ON operational_events(customer_id, contract_flow_id, sales_order_id, invoice_id, subscription_id);
