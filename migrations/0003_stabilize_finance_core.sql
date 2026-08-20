CREATE TABLE IF NOT EXISTS payment_method_setup_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_setup_intent_id TEXT,
  client_secret TEXT,
  status TEXT NOT NULL CHECK(status IN ('CREATED','REQUIRES_PAYMENT_METHOD','SUCCEEDED','CANCELLED','EXPIRED','FAILED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_method_setup_sessions_customer
  ON payment_method_setup_sessions(customer_id, status, expires_at);
