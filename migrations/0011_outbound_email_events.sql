ALTER TABLE customer_order_sessions ADD COLUMN public_token_enc TEXT;

CREATE TABLE IF NOT EXISTS outbound_email_events (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  email_type TEXT NOT NULL CHECK(email_type IN ('OFFER','INVOICE','CONFIRMATION')),
  provider TEXT NOT NULL CHECK(provider IN ('RESEND')),
  provider_message_id TEXT,
  contract_flow_id TEXT,
  customer_order_session_id TEXT,
  offer_id TEXT,
  invoice_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','FAILED')),
  subject TEXT NOT NULL,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  failed_at TEXT,
  FOREIGN KEY(contract_flow_id) REFERENCES contract_flows(id),
  FOREIGN KEY(customer_order_session_id) REFERENCES customer_order_sessions(id),
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  FOREIGN KEY(invoice_id) REFERENCES invoices(id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_email_events_flow
  ON outbound_email_events(contract_flow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_events_session
  ON outbound_email_events(customer_order_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_email_events_status
  ON outbound_email_events(status, created_at DESC);
