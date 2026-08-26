CREATE TABLE IF NOT EXISTS outbound_email_events_new (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  email_type TEXT NOT NULL CHECK(email_type IN ('OFFER','INVOICE','CONFIRMATION')),
  provider TEXT NOT NULL CHECK(provider IN ('RESEND')),
  provider_message_id TEXT,
  contract_flow_id TEXT,
  customer_order_session_id TEXT,
  offer_id TEXT,
  invoice_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','DELIVERED','BOUNCED','COMPLAINED','FAILED')),
  subject TEXT NOT NULL,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  failed_at TEXT,
  delivered_at TEXT,
  bounced_at TEXT,
  complained_at TEXT,
  last_provider_event_id TEXT,
  last_provider_event_type TEXT,
  last_provider_event_at TEXT,
  delivery_trigger TEXT NOT NULL DEFAULT 'MANUAL' CHECK(delivery_trigger IN ('AUTO','MANUAL'))
);

INSERT INTO outbound_email_events_new (
  id,recipient,email_type,provider,provider_message_id,contract_flow_id,customer_order_session_id,offer_id,invoice_id,
  status,subject,failure_code,failure_message,created_at,sent_at,failed_at,delivery_trigger
)
SELECT
  id,recipient,email_type,provider,provider_message_id,contract_flow_id,customer_order_session_id,offer_id,invoice_id,
  status,subject,failure_code,failure_message,created_at,sent_at,failed_at,'MANUAL'
FROM outbound_email_events;

DROP TABLE outbound_email_events;
ALTER TABLE outbound_email_events_new RENAME TO outbound_email_events;

CREATE INDEX IF NOT EXISTS idx_outbound_email_flow
  ON outbound_email_events(contract_flow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_session
  ON outbound_email_events(customer_order_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_status
  ON outbound_email_events(status, created_at DESC);

CREATE TABLE IF NOT EXISTS email_provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_message_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_email_provider_events_message
  ON email_provider_events(provider, provider_message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invoice_document_tokens (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_document_tokens_invoice
  ON invoice_document_tokens(invoice_id);

CREATE TABLE IF NOT EXISTS operational_events_new (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'STRIPE_WEBHOOK_ERROR',
    'STRIPE_PAYMENT_FAILED',
    'FORTNOX_SYNC_FAILED',
    'FORTNOX_AUTH_FAILED',
    'EMAIL_SEND_FAILED',
    'EMAIL_BOUNCED',
    'EMAIL_COMPLAINED',
    'EMAIL_DELIVERY_DELAYED',
    'EMAIL_WEBHOOK_ERROR',
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
  resolved_at TEXT,
  acknowledged_at TEXT
);

INSERT INTO operational_events_new (
  id,event_type,severity,status,message,dedupe_key,customer_id,contract_flow_id,sales_order_id,invoice_id,
  subscription_id,provider,provider_event_id,request_id,details_json,occurrence_count,created_at,last_seen_at,resolved_at
)
SELECT
  id,event_type,severity,status,message,dedupe_key,customer_id,contract_flow_id,sales_order_id,invoice_id,
  subscription_id,provider,provider_event_id,request_id,details_json,occurrence_count,created_at,last_seen_at,resolved_at
FROM operational_events;

DROP TABLE operational_events;
ALTER TABLE operational_events_new RENAME TO operational_events;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_events_open_dedupe
  ON operational_events(dedupe_key)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operational_events_open_severity
  ON operational_events(status, severity, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_events_entity
  ON operational_events(customer_id, contract_flow_id, sales_order_id, invoice_id, subscription_id);
