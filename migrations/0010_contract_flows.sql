CREATE TABLE IF NOT EXISTS contract_flows (
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

CREATE INDEX IF NOT EXISTS idx_contract_flows_customer
  ON contract_flows(customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_contract_flows_source_customer
  ON contract_flows(source, source_customer_id)
  WHERE source_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_flows_status
  ON contract_flows(status, updated_at);
