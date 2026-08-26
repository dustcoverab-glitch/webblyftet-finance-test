-- One-time preflight for remote D1 databases that have migrations 0012-0015 pending.
--
-- Run this before `wrangler d1 migrations apply DB --env test --remote`.
-- It removes only the foreign keys that point at sales_orders/customer_order_sessions
-- from tables that block the locked 0012 table rebuild. Migration 0016 restores them.

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
