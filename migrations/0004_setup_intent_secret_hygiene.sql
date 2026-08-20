CREATE TABLE IF NOT EXISTS payment_method_setup_sessions_v2 (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_setup_intent_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('CREATED','REQUIRES_PAYMENT_METHOD','REQUIRES_CONFIRMATION','REQUIRES_ACTION','PROCESSING','SUCCEEDED','CANCELLED','EXPIRED','FAILED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

INSERT INTO payment_method_setup_sessions_v2
  (id, customer_id, stripe_customer_id, stripe_setup_intent_id, status, expires_at, created_at, updated_at)
SELECT
  id,
  customer_id,
  stripe_customer_id,
  stripe_setup_intent_id,
  CASE
    WHEN status IN ('CREATED','REQUIRES_PAYMENT_METHOD','SUCCEEDED','CANCELLED','EXPIRED','FAILED') THEN status
    ELSE 'CREATED'
  END,
  expires_at,
  created_at,
  updated_at
FROM payment_method_setup_sessions;

DROP TABLE payment_method_setup_sessions;

ALTER TABLE payment_method_setup_sessions_v2 RENAME TO payment_method_setup_sessions;

CREATE INDEX IF NOT EXISTS idx_payment_method_setup_sessions_customer
  ON payment_method_setup_sessions(customer_id, status, expires_at);
