PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fortnox_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  company_name TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  scope TEXT,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  fortnox_customer_number TEXT UNIQUE,
  org_number TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address1 TEXT,
  address2 TEXT,
  zip TEXT,
  city TEXT,
  country TEXT DEFAULT 'SE',
  vat_number TEXT,
  payment_terms_days INTEGER DEFAULT 30,
  notes TEXT,
  sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  fortnox_document_number TEXT UNIQUE,
  customer_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  offer_date TEXT NOT NULL,
  expire_date TEXT,
  currency TEXT NOT NULL DEFAULT 'SEK',
  language TEXT NOT NULL DEFAULT 'SV',
  remarks TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  vat_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
  accepted_at TEXT,
  accepted_by_name TEXT,
  accepted_by_email TEXT,
  acceptance_ip TEXT,
  acceptance_user_agent TEXT,
  signature_token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS offer_rows (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  article_number TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  discount_percent REAL NOT NULL DEFAULT 0,
  vat_percent REAL NOT NULL DEFAULT 25,
  account_number INTEGER,
  FOREIGN KEY(offer_id) REFERENCES offers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoices (
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
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(source_offer_id) REFERENCES offers(id)
);

CREATE TABLE IF NOT EXISTS invoice_rows (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  article_number TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  discount_percent REAL NOT NULL DEFAULT 0,
  vat_percent REAL NOT NULL DEFAULT 25,
  account_number INTEGER,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  amount REAL,
  vat_amount REAL,
  supplier_name TEXT,
  transaction_date TEXT,
  status TEXT NOT NULL DEFAULT 'UPLOADED',
  fortnox_file_id TEXT,
  voucher_series TEXT,
  voucher_number INTEGER,
  supplier_invoice_number TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  fortnox_document_number TEXT UNIQUE,
  supplier_number TEXT,
  supplier_name TEXT,
  invoice_date TEXT,
  due_date TEXT,
  total REAL,
  balance REAL,
  booked INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SYNCED',
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  fortnox_year INTEGER,
  series TEXT,
  voucher_number INTEGER,
  transaction_date TEXT,
  description TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fortnox_year, series, voucher_number)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  operation TEXT NOT NULL,
  endpoint TEXT,
  http_status INTEGER,
  success INTEGER NOT NULL,
  request_json TEXT,
  response_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_fortnox ON customers(fortnox_customer_number);
CREATE INDEX IF NOT EXISTS idx_offers_customer ON offers(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at DESC);
