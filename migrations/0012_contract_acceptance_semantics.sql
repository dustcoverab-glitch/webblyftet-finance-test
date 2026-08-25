PRAGMA foreign_keys=off;

ALTER TABLE sales_orders RENAME TO sales_orders_old;

CREATE TABLE sales_orders (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_version_id TEXT NOT NULL,
  acceptance_id TEXT,
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

INSERT INTO sales_orders (
  id, offer_id, offer_version_id, acceptance_id, customer_id, status, currency,
  one_time_total_minor, recurring_monthly_minor, created_at, updated_at
)
SELECT
  id, offer_id, offer_version_id, acceptance_id, customer_id, status, currency,
  one_time_total_minor, recurring_monthly_minor, created_at, updated_at
FROM sales_orders_old;

DROP TABLE sales_orders_old;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_orders_acceptance
  ON sales_orders(acceptance_id)
  WHERE acceptance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_prepared_version
  ON sales_orders(offer_id, offer_version_id)
  WHERE acceptance_id IS NULL;

PRAGMA foreign_keys=on;
