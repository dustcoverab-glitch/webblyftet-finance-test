import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import preflight0012 from "../scripts/0012_sales_orders_fk_preflight.sql?raw";
import migration0012 from "../migrations/0012_contract_acceptance_semantics.sql?raw";
import migration0013 from "../migrations/0013_authorization_operational_events.sql?raw";
import migration0014 from "../migrations/0014_email_lifecycle_operations.sql?raw";
import migration0015 from "../migrations/0015_pilot_lifecycle_credit_operations.sql?raw";
import migration0016 from "../migrations/0016_restore_sales_order_foreign_keys.sql?raw";

const migrationChain = [migration0012, migration0013, migration0014, migration0015, migration0016];

const legacyPreflightWithoutEmailDependency = `
ALTER TABLE contract_flows RENAME TO contract_flows_0012_preflight_old;

CREATE TABLE contract_flows (
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
  completed_at TEXT
);

INSERT INTO contract_flows (
  id, customer_id, source, source_customer_id, seller_name, seller_id, meeting_id,
  status, notes, handoff_json, draft_json, sales_order_id, customer_order_session_id,
  created_at, updated_at, completed_at
)
SELECT
  id, customer_id, source, source_customer_id, seller_name, seller_id, meeting_id,
  status, notes, handoff_json, draft_json, sales_order_id, customer_order_session_id,
  created_at, updated_at, completed_at
FROM contract_flows_0012_preflight_old;

DROP TABLE contract_flows_0012_preflight_old;
`;

const legacyInvoiceRowsCreatedAtCopy = `
ALTER TABLE invoice_rows RENAME TO invoice_rows_0016_no_invoice_fk;

CREATE TABLE invoice_rows (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  unit_price REAL NOT NULL,
  vat_percent REAL NOT NULL DEFAULT 25,
  discount_percent REAL NOT NULL DEFAULT 0,
  article_number TEXT,
  account_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id TEXT,
  price_id TEXT,
  billing_type TEXT NOT NULL DEFAULT 'ONE_TIME',
  billing_interval TEXT,
  unit_price_minor INTEGER
);

INSERT INTO invoice_rows (
  id, invoice_id, sort_order, description, quantity, unit, unit_price,
  vat_percent, discount_percent, article_number, account_number, created_at,
  product_id, price_id, billing_type, billing_interval, unit_price_minor
)
SELECT
  id, invoice_id, sort_order, description, quantity, unit, unit_price,
  vat_percent, discount_percent, article_number, account_number, created_at,
  product_id, price_id, billing_type, billing_interval, unit_price_minor
FROM invoice_rows_0016_no_invoice_fk;
`;

async function execSql(script: string): Promise<void> {
  const statements = script
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

const fixtureSql = `
CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

INSERT INTO d1_migrations (id, name, applied_at)
VALUES (11, '0011_outbound_email_events.sql', '2026-08-25 08:52:17');

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE offer_versions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  vat_total INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  UNIQUE(offer_id, version_number)
);

CREATE TABLE offer_acceptances (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_version_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  accepted_by_name TEXT NOT NULL,
  accepted_by_email TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(offer_id) REFERENCES offers(id),
  FOREIGN KEY(offer_version_id) REFERENCES offer_versions(id),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE sales_orders (
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

CREATE TABLE sales_order_items (
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

CREATE TABLE customer_order_sessions (
  id TEXT PRIMARY KEY,
  sales_order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATED',
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  reviewed_at TEXT,
  signed_at TEXT,
  completed_at TEXT,
  signing_provider TEXT NOT NULL DEFAULT 'BASIC_ACCEPTANCE',
  signing_request_id TEXT,
  signer_name TEXT,
  signer_email TEXT,
  evidence_reference TEXT,
  document_hash TEXT,
  signing_snapshot_json TEXT,
  payment_method_id TEXT,
  payment_method_brand TEXT,
  payment_method_last4 TEXT,
  payment_method_exp_month INTEGER,
  payment_method_exp_year INTEGER,
  activation_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  public_token_enc TEXT,
  FOREIGN KEY(sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE INDEX idx_customer_order_sessions_order
  ON customer_order_sessions(sales_order_id, status, expires_at);

CREATE INDEX idx_customer_order_sessions_customer
  ON customer_order_sessions(customer_id, status, expires_at);

CREATE TABLE contract_flows (
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

CREATE INDEX idx_contract_flows_customer
  ON contract_flows(customer_id, created_at);

CREATE INDEX idx_contract_flows_source_customer
  ON contract_flows(source, source_customer_id)
  WHERE source_customer_id IS NOT NULL;

CREATE INDEX idx_contract_flows_status
  ON contract_flows(status, updated_at);

CREATE TABLE subscriptions (
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
  sales_order_id TEXT,
  offer_id TEXT,
  offer_version_id TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE invoices (
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
  sales_order_id TEXT,
  invoice_number TEXT,
  subtotal_minor INTEGER,
  vat_total_minor INTEGER,
  total_minor INTEGER,
  balance_minor INTEGER,
  invoice_type TEXT NOT NULL DEFAULT 'PROJECT_INVOICE'
    CHECK(invoice_type IN ('PROJECT_INVOICE','SUBSCRIPTION_INVOICE')),
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(source_offer_id) REFERENCES offers(id)
);

CREATE UNIQUE INDEX idx_invoices_sales_order
  ON invoices(sales_order_id)
  WHERE sales_order_id IS NOT NULL;

CREATE UNIQUE INDEX idx_invoices_invoice_number
  ON invoices(invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE TABLE invoice_rows (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  unit_price REAL NOT NULL,
  vat_percent REAL NOT NULL DEFAULT 25,
  discount_percent REAL NOT NULL DEFAULT 0,
  article_number TEXT,
  account_number INTEGER,
  product_id TEXT,
  price_id TEXT,
  billing_type TEXT NOT NULL DEFAULT 'ONE_TIME',
  billing_interval TEXT,
  unit_price_minor INTEGER,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE outbound_email_events (
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

CREATE INDEX idx_outbound_email_events_flow
  ON outbound_email_events(contract_flow_id, created_at DESC);

CREATE INDEX idx_outbound_email_events_session
  ON outbound_email_events(customer_order_session_id, created_at DESC);

CREATE INDEX idx_outbound_email_events_status
  ON outbound_email_events(status, created_at DESC);

INSERT INTO customers (id, name) VALUES ('cus_1', 'Migration Demo AB');
INSERT INTO offers (id, customer_id) VALUES ('off_1', 'cus_1');
INSERT INTO offer_versions (id, offer_id, version_number, snapshot_json, subtotal, vat_total, total)
VALUES ('ov_1', 'off_1', 1, '{}', 10000, 2500, 12500);
INSERT INTO offer_acceptances (
  id, offer_id, offer_version_id, customer_id, accepted_by_name, accepted_by_email, accepted_at, snapshot_hash
) VALUES ('acc_1', 'off_1', 'ov_1', 'cus_1', 'Demo', 'demo@example.test', '2026-01-01T00:00:00Z', 'hash');
INSERT INTO sales_orders (id, offer_id, offer_version_id, acceptance_id, customer_id, one_time_total_minor, recurring_monthly_minor)
VALUES ('so_1', 'off_1', 'ov_1', 'acc_1', 'cus_1', 10000, 29500);
INSERT INTO sales_order_items (
  id, sales_order_id, description, quantity, unit_price_minor, vat_percent, billing_type, billing_interval
) VALUES ('soi_1', 'so_1', 'Bas', 1, 10000, 25, 'ONE_TIME', NULL);
INSERT INTO customer_order_sessions (id, sales_order_id, customer_id, token_hash, expires_at, public_token_enc)
VALUES ('cos_1', 'so_1', 'cus_1', 'tokenhash', '2027-01-01T00:00:00Z', 'encrypted-token');
INSERT INTO contract_flows (id, customer_id, source, handoff_json, draft_json, sales_order_id, customer_order_session_id)
VALUES ('cf_1', 'cus_1', 'SIMULATED_MEETING', '{}', '{}', 'so_1', 'cos_1');
INSERT INTO subscriptions (id, customer_id, status, start_date, sales_order_id, offer_id, offer_version_id)
VALUES ('sub_1', 'cus_1', 'ACTIVE', '2026-01-01', 'so_1', 'off_1', 'ov_1');
INSERT INTO invoices (
  id, customer_id, source_offer_id, sales_order_id, invoice_number, status, invoice_date,
  subtotal, vat_total, total, balance, subtotal_minor, vat_total_minor, total_minor, balance_minor, invoice_type
) VALUES (
  'inv_1', 'cus_1', 'off_1', 'so_1', 'TEST-1', 'DRAFT', '2026-01-01',
  100, 25, 125, 125, 10000, 2500, 12500, 12500, 'PROJECT_INVOICE'
);
INSERT INTO invoice_rows (
  id, invoice_id, sort_order, description, quantity, unit, unit_price, vat_percent,
  discount_percent, unit_price_minor
) VALUES ('ir_1', 'inv_1', 1, 'Bas', 1, 'st', 100, 25, 0, 10000);
INSERT INTO outbound_email_events (
  id, recipient, email_type, provider, provider_message_id, contract_flow_id,
  customer_order_session_id, offer_id, invoice_id, status, subject, sent_at
) VALUES (
  'mail_1', 'demo@example.test', 'OFFER', 'RESEND', 'msg_1', 'cf_1',
  'cos_1', 'off_1', 'inv_1', 'SENT', 'Offer', '2026-01-01T00:00:00Z'
);
`;

async function resetMigrationFixture(): Promise<void> {
  await execSql(`
DROP TABLE IF EXISTS alert_notifications;
DROP TABLE IF EXISTS credit_invoices;
DROP TABLE IF EXISTS invoice_document_tokens;
DROP TABLE IF EXISTS email_provider_events;
DROP TABLE IF EXISTS outbound_email_events;
DROP TABLE IF EXISTS operational_events;
DROP TABLE IF EXISTS invoice_rows;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS contract_flows;
DROP TABLE IF EXISTS customer_order_sessions;
DROP TABLE IF EXISTS sales_order_items;
DROP TABLE IF EXISTS sales_orders;
DROP TABLE IF EXISTS offer_acceptances;
DROP TABLE IF EXISTS offer_versions;
DROP TABLE IF EXISTS offers;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS d1_migrations;
`);
}

async function tableCount(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? -1;
}

async function fkCount(table: string, referencedTable: string): Promise<number> {
  const result = await env.DB.prepare(`PRAGMA foreign_key_list('${table}')`).all<{ table: string }>();
  return result.results.filter((row) => row.table === referencedTable).length;
}

async function first<T extends Record<string, unknown>>(sql: string): Promise<T> {
  const row = await env.DB.prepare(sql).first<T>();
  if (!row) throw new Error(`Expected row for ${sql}`);
  return row;
}

describe("D1 sales_orders migration remediation", () => {
  it("reproduces the locked 0012 failure when D1 runs the migration in a transaction", async () => {
    await resetMigrationFixture();
    await execSql(fixtureSql);

    await expect(execSql(migration0012)).rejects.toThrow(
      /FOREIGN KEY constraint failed/
    );
  });

  it("reproduces the remote preflight failure when outbound_email_events still references contract_flows", async () => {
    await resetMigrationFixture();
    await execSql(fixtureSql);

    await expect(execSql(legacyPreflightWithoutEmailDependency)).rejects.toThrow(
      /FOREIGN KEY constraint failed/
    );
  });

  it("fails closed if the one-time preflight is run when 0012 is already applied", async () => {
    await resetMigrationFixture();
    await execSql(fixtureSql);
    await env.DB.prepare(
      `INSERT INTO d1_migrations (id, name, applied_at)
       VALUES (12, '0012_contract_acceptance_semantics.sql', '2026-08-26 00:00:00')`
    ).run();

    await expect(execSql(preflight0012)).rejects.toThrow(
      /CHECK constraint failed/
    );
  });

  it("reproduces the pending 0016 failure when invoice_rows lacks created_at", async () => {
    await resetMigrationFixture();
    await execSql(fixtureSql);
    await execSql(preflight0012);
    await execSql([migration0012, migration0013, migration0014, migration0015].join("\n"));

    await expect(execSql(legacyInvoiceRowsCreatedAtCopy)).rejects.toThrow(
      /no such column: created_at/
    );
  });

  it("applies the preflight plus pending migration chain while preserving rows and FK integrity", async () => {
    await resetMigrationFixture();
    await execSql(fixtureSql);

    const beforeCounts = {
      salesOrders: await tableCount("sales_orders"),
      salesOrderItems: await tableCount("sales_order_items"),
      customerOrderSessions: await tableCount("customer_order_sessions"),
      contractFlows: await tableCount("contract_flows"),
      outboundEmailEvents: await tableCount("outbound_email_events"),
      invoices: await tableCount("invoices"),
      invoiceRows: await tableCount("invoice_rows"),
    };

    await execSql(preflight0012);

    await expect(fkCount("outbound_email_events", "contract_flows")).resolves.toBe(0);
    await expect(fkCount("outbound_email_events", "customer_order_sessions")).resolves.toBe(0);
    await expect(fkCount("contract_flows", "sales_orders")).resolves.toBe(0);
    await expect(fkCount("contract_flows", "customer_order_sessions")).resolves.toBe(0);
    await expect(fkCount("customer_order_sessions", "sales_orders")).resolves.toBe(0);
    await expect(fkCount("sales_order_items", "sales_orders")).resolves.toBe(0);

    await expect(execSql(preflight0012)).rejects.toThrow(
      /CHECK constraint failed/
    );

    await execSql(migrationChain.join("\n"));

    const fkCheck = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(fkCheck.results).toEqual([]);

    await expect(tableCount("sales_orders")).resolves.toBe(beforeCounts.salesOrders);
    await expect(tableCount("sales_order_items")).resolves.toBe(beforeCounts.salesOrderItems);
    await expect(tableCount("customer_order_sessions")).resolves.toBe(beforeCounts.customerOrderSessions);
    await expect(tableCount("contract_flows")).resolves.toBe(beforeCounts.contractFlows);
    await expect(tableCount("outbound_email_events")).resolves.toBe(beforeCounts.outboundEmailEvents);
    await expect(tableCount("invoices")).resolves.toBe(beforeCounts.invoices);
    await expect(tableCount("invoice_rows")).resolves.toBe(beforeCounts.invoiceRows);
    await expect(first<{ created_at: string }>(
      "SELECT created_at FROM invoice_rows WHERE id='ir_1'"
    )).resolves.toMatchObject({ created_at: expect.any(String) });

    await expect(fkCount("sales_order_items", "sales_orders")).resolves.toBe(1);
    await expect(fkCount("customer_order_sessions", "sales_orders")).resolves.toBe(1);
    await expect(fkCount("contract_flows", "sales_orders")).resolves.toBe(1);
    await expect(fkCount("contract_flows", "customer_order_sessions")).resolves.toBe(1);
    await expect(fkCount("outbound_email_events", "contract_flows")).resolves.toBe(1);
    await expect(fkCount("outbound_email_events", "customer_order_sessions")).resolves.toBe(1);
    await expect(fkCount("outbound_email_events", "offers")).resolves.toBe(1);
    await expect(fkCount("outbound_email_events", "invoices")).resolves.toBe(1);

    await expect(first<{ sales_order_id: string }>(
      "SELECT sales_order_id FROM sales_order_items WHERE id='soi_1'"
    )).resolves.toMatchObject({ sales_order_id: "so_1" });
    await expect(first<{ sales_order_id: string }>(
      "SELECT sales_order_id FROM customer_order_sessions WHERE id='cos_1'"
    )).resolves.toMatchObject({ sales_order_id: "so_1" });
    await expect(first<{ sales_order_id: string; customer_order_session_id: string }>(
      "SELECT sales_order_id, customer_order_session_id FROM contract_flows WHERE id='cf_1'"
    )).resolves.toMatchObject({
      sales_order_id: "so_1",
      customer_order_session_id: "cos_1",
    });
    await expect(first<{
      provider_message_id: string;
      contract_flow_id: string;
      customer_order_session_id: string;
      offer_id: string;
      invoice_id: string;
      status: string;
    }>(
      "SELECT provider_message_id, contract_flow_id, customer_order_session_id, offer_id, invoice_id, status FROM outbound_email_events WHERE id='mail_1'"
    )).resolves.toMatchObject({
      provider_message_id: "msg_1",
      contract_flow_id: "cf_1",
      customer_order_session_id: "cos_1",
      offer_id: "off_1",
      invoice_id: "inv_1",
      status: "SENT",
    });

    await env.DB.prepare(
      `INSERT INTO invoices (
        id, fortnox_document_number, customer_id, source_offer_id, status, invoice_date,
        currency, subtotal, vat_total, total, booked, cancelled, sync_status, sales_order_id,
        invoice_number, subtotal_minor, vat_total_minor, total_minor, balance_minor, invoice_type,
        original_invoice_id, credit_type
      ) VALUES (
        'cred_1', NULL, 'cus_1', 'off_1', 'DRAFT', '2026-01-02', 'SEK',
        -100, -25, -125, 0, 0, 'LOCAL_ONLY', 'so_1', 'KTEST-1',
        -10000, -2500, -12500, -12500, 'CREDIT_INVOICE', 'inv_1', 'FULL'
      )`
    ).run();
  });
});
