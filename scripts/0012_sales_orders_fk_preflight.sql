-- One-time preflight for remote D1 databases that have migrations 0012-0015 pending.
--
-- Run this before `wrangler d1 migrations apply DB --env test --remote`.
-- It removes only the foreign keys that point at tables rebuilt by the locked
-- 0012 table rebuild chain. Migration 0016 restores them.

CREATE TABLE __preflight_0012_guard (
  assertion TEXT NOT NULL CHECK(assertion = 'ok')
);

INSERT INTO __preflight_0012_guard (assertion)
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM d1_migrations WHERE name = '0012_contract_acceptance_semantics.sql'
  ) THEN '0012_ALREADY_APPLIED'
  WHEN EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name IN (
      'outbound_email_events_0012_preflight_old',
      'contract_flows_0012_preflight_old',
      'customer_order_sessions_0012_preflight_old',
      'sales_order_items_0012_preflight_old'
    )
  ) THEN 'PREFLIGHT_ALREADY_STARTED'
  WHEN (
    SELECT COUNT(*) FROM pragma_foreign_key_list('outbound_email_events')
    WHERE "table" IN ('contract_flows', 'customer_order_sessions')
  ) < 2 THEN 'UNEXPECTED_OUTBOUND_EMAIL_EVENTS_FKS'
  WHEN (
    SELECT COUNT(*) FROM pragma_foreign_key_list('contract_flows')
    WHERE "table" IN ('sales_orders', 'customer_order_sessions')
  ) < 2 THEN 'UNEXPECTED_CONTRACT_FLOWS_FKS'
  WHEN (
    SELECT COUNT(*) FROM pragma_foreign_key_list('customer_order_sessions')
    WHERE "table" = 'sales_orders'
  ) < 1 THEN 'UNEXPECTED_CUSTOMER_ORDER_SESSIONS_FKS'
  WHEN (
    SELECT COUNT(*) FROM pragma_foreign_key_list('sales_order_items')
    WHERE "table" = 'sales_orders'
  ) < 1 THEN 'UNEXPECTED_SALES_ORDER_ITEMS_FKS'
  ELSE 'ok'
END;

DROP TABLE __preflight_0012_guard;

ALTER TABLE outbound_email_events RENAME TO outbound_email_events_0012_preflight_old;

CREATE TABLE outbound_email_events (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  email_type TEXT NOT NULL CHECK(email_type IN ('OFFER','INVOICE','CONFIRMATION')),
  provider TEXT NOT NULL CHECK(provider IN ('RESEND')),
  provider_message_id TEXT,
  contract_flow_id TEXT,
  customer_order_session_id TEXT,
  offer_id TEXT,
  invoice_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','FAILED')),
  subject TEXT NOT NULL,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  failed_at TEXT,
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  FOREIGN KEY(invoice_id) REFERENCES invoices(id)
);

INSERT INTO outbound_email_events (
  id, recipient, email_type, provider, provider_message_id, contract_flow_id,
  customer_order_session_id, offer_id, invoice_id, status, subject,
  failure_code, failure_message, created_at, sent_at, failed_at
)
SELECT
  id, recipient, email_type, provider, provider_message_id, contract_flow_id,
  customer_order_session_id, offer_id, invoice_id, status, subject,
  failure_code, failure_message, created_at, sent_at, failed_at
FROM outbound_email_events_0012_preflight_old;

DROP TABLE outbound_email_events_0012_preflight_old;

CREATE INDEX IF NOT EXISTS idx_outbound_email_events_flow
  ON outbound_email_events(contract_flow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_events_session
  ON outbound_email_events(customer_order_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_events_status
  ON outbound_email_events(status, created_at DESC);

ALTER TABLE contract_flows RENAME TO contract_flows_0012_preflight_old;

CREATE TABLE contract_flows (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  source TEXT NOT NULL,
  source_customer_id TEXT,
  seller_name TEXT,
  seller_id TEXT,
  meeting_id TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  notes TEXT,
  handoff_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  sales_order_id TEXT,
  customer_order_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

INSERT INTO contract_flows (
  id, customer_id, source, source_customer_id, seller_name, seller_id, meeting_id,
  status, notes, handoff_json, draft_json, sales_order_id, customer_order_session_id,
  created_at, updated_at, completed_at
)
SELECT
  id, customer_id, source, source_customer_id, seller_name, seller_id, meeting_id,
  status, notes, handoff_json, draft_json, sales_order_id, customer_order_session_id,
  created_at, updated_at, completed_at
FROM contract_flows_0012_preflight_old;

DROP TABLE contract_flows_0012_preflight_old;

CREATE INDEX IF NOT EXISTS idx_contract_flows_customer
  ON contract_flows(customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_contract_flows_source_customer
  ON contract_flows(source, source_customer_id)
  WHERE source_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_flows_status
  ON contract_flows(status, updated_at);

ALTER TABLE customer_order_sessions RENAME TO customer_order_sessions_0012_preflight_old;

CREATE TABLE customer_order_sessions (
  id TEXT PRIMARY KEY,
  sales_order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATED',
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  reviewed_at TEXT,
  signed_at TEXT,
  completed_at TEXT,
  signing_provider TEXT NOT NULL DEFAULT 'BASIC_ACCEPTANCE',
  signing_request_id TEXT,
  signer_name TEXT,
  signer_email TEXT,
  evidence_reference TEXT,
  document_hash TEXT,
  signing_snapshot_json TEXT,
  payment_method_id TEXT,
  payment_method_brand TEXT,
  payment_method_last4 TEXT,
  payment_method_exp_month INTEGER,
  payment_method_exp_year INTEGER,
  activation_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  public_token_enc TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

INSERT INTO customer_order_sessions (
  id, sales_order_id, customer_id, token_hash, status, expires_at, opened_at,
  reviewed_at, signed_at, completed_at, signing_provider, signing_request_id,
  signer_name, signer_email, evidence_reference, document_hash, signing_snapshot_json,
  payment_method_id, payment_method_brand, payment_method_last4, payment_method_exp_month,
  payment_method_exp_year, activation_error, created_at, updated_at, public_token_enc
)
SELECT
  id, sales_order_id, customer_id, token_hash, status, expires_at, opened_at,
  reviewed_at, signed_at, completed_at, signing_provider, signing_request_id,
  signer_name, signer_email, evidence_reference, document_hash, signing_snapshot_json,
  payment_method_id, payment_method_brand, payment_method_last4, payment_method_exp_month,
  payment_method_exp_year, activation_error, created_at, updated_at, public_token_enc
FROM customer_order_sessions_0012_preflight_old;

DROP TABLE customer_order_sessions_0012_preflight_old;

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_order
  ON customer_order_sessions(sales_order_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_customer
  ON customer_order_sessions(customer_id, status, expires_at);

ALTER TABLE sales_order_items RENAME TO sales_order_items_0012_preflight_old;

CREATE TABLE sales_order_items (
  id TEXT PRIMARY KEY,
  sales_order_id TEXT NOT NULL,
  offer_row_id TEXT,
  product_id TEXT,
  price_id TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  unit_price_minor INTEGER NOT NULL,
  vat_percent REAL NOT NULL DEFAULT 25,
  billing_type TEXT NOT NULL CHECK(billing_type IN ('ONE_TIME','RECURRING')),
  billing_interval TEXT CHECK(billing_interval IN ('MONTH','YEAR') OR billing_interval IS NULL),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sales_order_items (
  id, sales_order_id, offer_row_id, product_id, price_id, description, quantity,
  unit, unit_price_minor, vat_percent, billing_type, billing_interval, created_at
)
SELECT
  id, sales_order_id, offer_row_id, product_id, price_id, description, quantity,
  unit, unit_price_minor, vat_percent, billing_type, billing_interval, created_at
FROM sales_order_items_0012_preflight_old;

DROP TABLE sales_order_items_0012_preflight_old;
