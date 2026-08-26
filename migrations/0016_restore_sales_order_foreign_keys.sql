-- Restores the sales_order/customer_order/email foreign keys removed by the
-- one-time 0012 preflight remediation. This must run after locked migrations
-- 0012-0015.

ALTER TABLE sales_order_items RENAME TO sales_order_items_0016_old;

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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE
);

INSERT INTO sales_order_items (
  id, sales_order_id, offer_row_id, product_id, price_id, description, quantity,
  unit, unit_price_minor, vat_percent, billing_type, billing_interval, created_at
)
SELECT
  id, sales_order_id, offer_row_id, product_id, price_id, description, quantity,
  unit, unit_price_minor, vat_percent, billing_type, billing_interval, created_at
FROM sales_order_items_0016_old;

DROP TABLE sales_order_items_0016_old;

ALTER TABLE customer_order_sessions RENAME TO customer_order_sessions_0016_old;

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
  FOREIGN KEY(sales_order_id) REFERENCES sales_orders(id),
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
FROM customer_order_sessions_0016_old;

DROP TABLE customer_order_sessions_0016_old;

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_order
  ON customer_order_sessions(sales_order_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_customer
  ON customer_order_sessions(customer_id, status, expires_at);

ALTER TABLE contract_flows RENAME TO contract_flows_0016_old;

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
  completed_at TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY(customer_order_session_id) REFERENCES customer_order_sessions(id)
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
FROM contract_flows_0016_old;

DROP TABLE contract_flows_0016_old;

CREATE INDEX IF NOT EXISTS idx_contract_flows_customer
  ON contract_flows(customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_contract_flows_source_customer
  ON contract_flows(source, source_customer_id)
  WHERE source_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_flows_status
  ON contract_flows(status, updated_at);

ALTER TABLE invoice_rows RENAME TO invoice_rows_0016_no_invoice_fk;

CREATE TABLE invoice_rows (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  unit_price REAL NOT NULL,
  vat_percent REAL NOT NULL DEFAULT 25,
  discount_percent REAL NOT NULL DEFAULT 0,
  article_number TEXT,
  account_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id TEXT,
  price_id TEXT,
  billing_type TEXT NOT NULL DEFAULT 'ONE_TIME',
  billing_interval TEXT,
  unit_price_minor INTEGER
);

INSERT INTO invoice_rows (
  id, invoice_id, sort_order, description, quantity, unit, unit_price,
  vat_percent, discount_percent, article_number, account_number,
  product_id, price_id, billing_type, billing_interval, unit_price_minor
)
SELECT
  id, invoice_id, sort_order, description, quantity, unit, unit_price,
  vat_percent, discount_percent, article_number, account_number,
  product_id, price_id, billing_type, billing_interval, unit_price_minor
FROM invoice_rows_0016_no_invoice_fk;

DROP TABLE invoice_rows_0016_no_invoice_fk;

ALTER TABLE credit_invoices RENAME TO credit_invoices_0016_no_invoice_fk;

CREATE TABLE credit_invoices (
  id TEXT PRIMARY KEY,
  original_invoice_id TEXT NOT NULL UNIQUE,
  credit_invoice_id TEXT NOT NULL UNIQUE,
  credit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO credit_invoices (
  id, original_invoice_id, credit_invoice_id, credit_reason, created_at
)
SELECT
  id, original_invoice_id, credit_invoice_id, credit_reason, created_at
FROM credit_invoices_0016_no_invoice_fk;

DROP TABLE credit_invoices_0016_no_invoice_fk;

ALTER TABLE invoices RENAME TO invoices_0016_old;

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  fortnox_document_number TEXT UNIQUE,
  customer_id TEXT NOT NULL,
  source_offer_id TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  currency TEXT NOT NULL DEFAULT 'SEK',
  remarks TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  vat_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  balance REAL,
  booked INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sales_order_id TEXT,
  invoice_number TEXT,
  subtotal_minor INTEGER,
  vat_total_minor INTEGER,
  total_minor INTEGER,
  balance_minor INTEGER,
  invoice_type TEXT NOT NULL DEFAULT 'PROJECT_INVOICE'
    CHECK(invoice_type IN ('PROJECT_INVOICE','SUBSCRIPTION_INVOICE','CREDIT_INVOICE')),
  original_invoice_id TEXT,
  credited_by_invoice_id TEXT,
  credit_reason TEXT,
  credit_type TEXT CHECK(credit_type IN ('FULL','PARTIAL') OR credit_type IS NULL),
  fortnox_credit_invoice_reference TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(source_offer_id) REFERENCES offers(id)
);

INSERT INTO invoices (
  id, fortnox_document_number, customer_id, source_offer_id, status, invoice_date,
  due_date, currency, remarks, subtotal, vat_total, total, balance, booked,
  cancelled, sync_status, last_synced_at, created_at, updated_at, sales_order_id,
  invoice_number, subtotal_minor, vat_total_minor, total_minor, balance_minor,
  invoice_type, original_invoice_id, credited_by_invoice_id, credit_reason,
  credit_type, fortnox_credit_invoice_reference
)
SELECT
  id, fortnox_document_number, customer_id, source_offer_id, status, invoice_date,
  due_date, currency, remarks, subtotal, vat_total, total, balance, booked,
  cancelled, sync_status, last_synced_at, created_at, updated_at, sales_order_id,
  invoice_number, subtotal_minor, vat_total_minor, total_minor, balance_minor,
  invoice_type, original_invoice_id, credited_by_invoice_id, credit_reason,
  credit_type, fortnox_credit_invoice_reference
FROM invoices_0016_old;

DROP TABLE invoices_0016_old;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number
  ON invoices(invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_sales_order
  ON invoices(sales_order_id)
  WHERE sales_order_id IS NOT NULL AND invoice_type!='CREDIT_INVOICE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_original_invoice_credit
  ON invoices(original_invoice_id)
  WHERE original_invoice_id IS NOT NULL AND invoice_type='CREDIT_INVOICE';

ALTER TABLE invoice_rows RENAME TO invoice_rows_0016_restore_fk;

CREATE TABLE invoice_rows (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  unit_price REAL NOT NULL,
  vat_percent REAL NOT NULL DEFAULT 25,
  discount_percent REAL NOT NULL DEFAULT 0,
  article_number TEXT,
  account_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id TEXT,
  price_id TEXT,
  billing_type TEXT NOT NULL DEFAULT 'ONE_TIME',
  billing_interval TEXT,
  unit_price_minor INTEGER,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

INSERT INTO invoice_rows (
  id, invoice_id, sort_order, description, quantity, unit, unit_price,
  vat_percent, discount_percent, article_number, account_number,
  product_id, price_id, billing_type, billing_interval, unit_price_minor
)
SELECT
  id, invoice_id, sort_order, description, quantity, unit, unit_price,
  vat_percent, discount_percent, article_number, account_number,
  product_id, price_id, billing_type, billing_interval, unit_price_minor
FROM invoice_rows_0016_restore_fk;

DROP TABLE invoice_rows_0016_restore_fk;

ALTER TABLE credit_invoices RENAME TO credit_invoices_0016_restore_fk;

CREATE TABLE credit_invoices (
  id TEXT PRIMARY KEY,
  original_invoice_id TEXT NOT NULL UNIQUE,
  credit_invoice_id TEXT NOT NULL UNIQUE,
  credit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(original_invoice_id) REFERENCES invoices(id),
  FOREIGN KEY(credit_invoice_id) REFERENCES invoices(id)
);

INSERT INTO credit_invoices (
  id, original_invoice_id, credit_invoice_id, credit_reason, created_at
)
SELECT
  id, original_invoice_id, credit_invoice_id, credit_reason, created_at
FROM credit_invoices_0016_restore_fk;

DROP TABLE credit_invoices_0016_restore_fk;

ALTER TABLE outbound_email_events RENAME TO outbound_email_events_0016_old;

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
  delivery_trigger TEXT NOT NULL DEFAULT 'MANUAL' CHECK(delivery_trigger IN ('AUTO','MANUAL')),
  FOREIGN KEY(contract_flow_id) REFERENCES contract_flows(id),
  FOREIGN KEY(customer_order_session_id) REFERENCES customer_order_sessions(id),
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  FOREIGN KEY(invoice_id) REFERENCES invoices(id)
);

INSERT INTO outbound_email_events (
  id, recipient, email_type, provider, provider_message_id, contract_flow_id,
  customer_order_session_id, offer_id, invoice_id, status, subject,
  failure_code, failure_message, created_at, sent_at, failed_at, delivered_at,
  bounced_at, complained_at, last_provider_event_id, last_provider_event_type,
  last_provider_event_at, delivery_trigger
)
SELECT
  id, recipient, email_type, provider, provider_message_id, contract_flow_id,
  customer_order_session_id, offer_id, invoice_id, status, subject,
  failure_code, failure_message, created_at, sent_at, failed_at, delivered_at,
  bounced_at, complained_at, last_provider_event_id, last_provider_event_type,
  last_provider_event_at, delivery_trigger
FROM outbound_email_events_0016_old;

DROP TABLE outbound_email_events_0016_old;

CREATE INDEX IF NOT EXISTS idx_outbound_email_flow
  ON outbound_email_events(contract_flow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_session
  ON outbound_email_events(customer_order_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_status
  ON outbound_email_events(status, created_at DESC);
