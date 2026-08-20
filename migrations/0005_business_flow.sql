ALTER TABLE products ADD COLUMN stripe_product_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_stripe_product_id
  ON products(stripe_product_id)
  WHERE stripe_product_id IS NOT NULL;

ALTER TABLE offer_rows ADD COLUMN product_id TEXT;
ALTER TABLE offer_rows ADD COLUMN price_id TEXT;
ALTER TABLE offer_rows ADD COLUMN billing_type TEXT NOT NULL DEFAULT 'ONE_TIME';
ALTER TABLE offer_rows ADD COLUMN billing_interval TEXT;

CREATE TABLE IF NOT EXISTS offer_versions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  vat_total INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  UNIQUE(offer_id, version_number)
);

CREATE TABLE IF NOT EXISTS offer_acceptance_tokens (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_version_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  FOREIGN KEY(offer_version_id) REFERENCES offer_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_offer_acceptance_tokens_offer
  ON offer_acceptance_tokens(offer_id, offer_version_id, expires_at);

CREATE TABLE IF NOT EXISTS offer_acceptances (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_version_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  accepted_by_name TEXT NOT NULL,
  accepted_by_email TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  snapshot_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  FOREIGN KEY(offer_version_id) REFERENCES offer_versions(id),
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  UNIQUE(offer_version_id)
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_version_id TEXT NOT NULL,
  acceptance_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  currency TEXT NOT NULL DEFAULT 'SEK',
  one_time_total_minor INTEGER NOT NULL DEFAULT 0,
  recurring_monthly_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  FOREIGN KEY(offer_version_id) REFERENCES offer_versions(id),
  FOREIGN KEY(acceptance_id) REFERENCES offer_acceptances(id),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS sales_order_items (
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

ALTER TABLE subscriptions ADD COLUMN sales_order_id TEXT;
ALTER TABLE subscriptions ADD COLUMN offer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN offer_version_id TEXT;

ALTER TABLE invoices ADD COLUMN sales_order_id TEXT;
ALTER TABLE invoices ADD COLUMN invoice_number TEXT;
ALTER TABLE invoices ADD COLUMN subtotal_minor INTEGER;
ALTER TABLE invoices ADD COLUMN vat_total_minor INTEGER;
ALTER TABLE invoices ADD COLUMN total_minor INTEGER;
ALTER TABLE invoices ADD COLUMN balance_minor INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_sales_order
  ON invoices(sales_order_id)
  WHERE sales_order_id IS NOT NULL;

ALTER TABLE invoice_rows ADD COLUMN product_id TEXT;
ALTER TABLE invoice_rows ADD COLUMN price_id TEXT;
ALTER TABLE invoice_rows ADD COLUMN billing_type TEXT NOT NULL DEFAULT 'ONE_TIME';
ALTER TABLE invoice_rows ADD COLUMN billing_interval TEXT;
ALTER TABLE invoice_rows ADD COLUMN unit_price_minor INTEGER;

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_payment_method_id TEXT NOT NULL,
  type TEXT NOT NULL,
  brand TEXT,
  last4 TEXT,
  exp_month INTEGER,
  exp_year INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  UNIQUE(provider, provider_payment_method_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_customer
  ON payment_methods(customer_id, is_default, status);
