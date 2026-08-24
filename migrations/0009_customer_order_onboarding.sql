CREATE TABLE IF NOT EXISTS customer_order_sessions (
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
  FOREIGN KEY(sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_order
  ON customer_order_sessions(sales_order_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_customer
  ON customer_order_sessions(customer_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_customer_order_sessions_snapshot_immutable
BEFORE UPDATE OF signing_snapshot_json, document_hash ON customer_order_sessions
FOR EACH ROW
WHEN OLD.signing_snapshot_json IS NOT NULL
  AND (
    NEW.signing_snapshot_json IS NOT OLD.signing_snapshot_json
    OR NEW.document_hash IS NOT OLD.document_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'customer order signing snapshot is immutable');
END;
