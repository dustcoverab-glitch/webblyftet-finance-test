CREATE TABLE IF NOT EXISTS document_sequences (
  name TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  next_number INTEGER NOT NULL CHECK(next_number > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO document_sequences(name, prefix, next_number)
VALUES ('TEST_INVOICE', 'TEST-', 1);

ALTER TABLE offer_acceptance_tokens ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK(status IN ('ACTIVE','PROCESSING','USED','EXPIRED','CANCELLED'));

UPDATE offer_acceptance_tokens
SET status = CASE
  WHEN used_at IS NOT NULL THEN 'USED'
  WHEN expires_at <= CURRENT_TIMESTAMP THEN 'EXPIRED'
  ELSE 'ACTIVE'
END;

ALTER TABLE invoices ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'PROJECT_INVOICE'
  CHECK(invoice_type IN ('PROJECT_INVOICE','SUBSCRIPTION_INVOICE'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number
  ON invoices(invoice_number)
  WHERE invoice_number IS NOT NULL;
