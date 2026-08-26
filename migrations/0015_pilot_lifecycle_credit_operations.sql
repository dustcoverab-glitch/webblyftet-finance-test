ALTER TABLE subscriptions ADD COLUMN cancellation_effective_at TEXT;
ALTER TABLE subscriptions ADD COLUMN cancelled_at TEXT;
ALTER TABLE subscriptions ADD COLUMN cancellation_reason TEXT;
ALTER TABLE subscriptions ADD COLUMN latest_stripe_invoice_id TEXT;
ALTER TABLE subscriptions ADD COLUMN payment_action_required_at TEXT;
ALTER TABLE subscriptions ADD COLUMN payment_recovered_at TEXT;

CREATE TABLE IF NOT EXISTS payment_method_update_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  public_token_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','OPENED','SETUP_CREATED','COMPLETED','EXPIRED','CANCELLED')),
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  completed_at TEXT,
  stripe_setup_intent_id TEXT,
  payment_method_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_method_update_sessions_customer
  ON payment_method_update_sessions(customer_id, subscription_id, status, expires_at);

CREATE TABLE IF NOT EXISTS credit_invoices (
  id TEXT PRIMARY KEY,
  original_invoice_id TEXT NOT NULL UNIQUE,
  credit_invoice_id TEXT NOT NULL UNIQUE,
  credit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(original_invoice_id) REFERENCES invoices(id),
  FOREIGN KEY(credit_invoice_id) REFERENCES invoices(id)
);

ALTER TABLE invoices ADD COLUMN original_invoice_id TEXT;
ALTER TABLE invoices ADD COLUMN credited_by_invoice_id TEXT;
ALTER TABLE invoices ADD COLUMN credit_reason TEXT;
ALTER TABLE invoices ADD COLUMN credit_type TEXT CHECK(credit_type IN ('FULL','PARTIAL') OR credit_type IS NULL);
ALTER TABLE invoices ADD COLUMN fortnox_credit_invoice_reference TEXT;

DROP INDEX IF EXISTS idx_invoices_sales_order;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_sales_order
  ON invoices(sales_order_id)
  WHERE sales_order_id IS NOT NULL AND invoice_type!='CREDIT_INVOICE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_original_invoice_credit
  ON invoices(original_invoice_id)
  WHERE original_invoice_id IS NOT NULL AND invoice_type='CREDIT_INVOICE';

CREATE TABLE IF NOT EXISTS alert_notifications (
  id TEXT PRIMARY KEY,
  operational_event_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('NOOP','RESEND')),
  recipient TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','FAILED','SKIPPED')),
  provider_message_id TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  FOREIGN KEY(operational_event_id) REFERENCES operational_events(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_notifications_event_provider
  ON alert_notifications(operational_event_id, provider, recipient);
