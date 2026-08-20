ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_stripe_customer_id
  ON customers(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  product_type TEXT NOT NULL CHECK(product_type IN ('ONE_TIME','SUBSCRIPTION')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount >= 0),
  currency TEXT NOT NULL DEFAULT 'SEK',
  billing_type TEXT NOT NULL CHECK(billing_type IN ('ONE_TIME','RECURRING')),
  billing_interval TEXT CHECK(billing_interval IN ('MONTH','YEAR') OR billing_interval IS NULL),
  vat_percent REAL NOT NULL DEFAULT 25,
  active INTEGER NOT NULL DEFAULT 1,
  stripe_price_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES products(id),
  CHECK(
    (billing_type = 'ONE_TIME' AND billing_interval IS NULL) OR
    (billing_type = 'RECURRING' AND billing_interval IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prices_stripe_price_id
  ON prices(stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','PENDING','ACTIVE','PAST_DUE','PAUSED','CANCELLED','ENDED')),
  currency TEXT NOT NULL DEFAULT 'SEK',
  start_date TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id
  ON subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_items (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_amount INTEGER NOT NULL CHECK(unit_amount >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id),
  FOREIGN KEY(price_id) REFERENCES prices(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  invoice_id TEXT,
  amount INTEGER NOT NULL CHECK(amount >= 0),
  currency TEXT NOT NULL DEFAULT 'SEK',
  status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','REFUNDED','PARTIALLY_REFUNDED')),
  provider TEXT NOT NULL CHECK(provider IN ('STRIPE','FORTNOX','BANK','MANUAL')),
  provider_payment_id TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id),
  FOREIGN KEY(invoice_id) REFERENCES invoices(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment_id
  ON payments(provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('STRIPE','FORTNOX','BANK','MANUAL')),
  provider_attempt_id TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_attempt_id
  ON payment_attempts(provider, provider_attempt_id)
  WHERE provider_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounting_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('INVOICE_CREATED','INVOICE_CREDITED','PAYMENT_RECEIVED','PAYMENT_REFUNDED','SUBSCRIPTION_PAYMENT_RECEIVED','SUPPLIER_INVOICE_REGISTERED')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  currency TEXT NOT NULL,
  net_amount INTEGER NOT NULL,
  vat_amount INTEGER NOT NULL,
  gross_amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','READY','EXPORTED','FAILED')),
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_events_unique
  ON accounting_events(event_type, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS integration_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('USER','SYSTEM','STRIPE','FORTNOX')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_items_subscription ON subscription_items(subscription_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_accounting_events_status ON accounting_events(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
