import { env } from "cloudflare:workers";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function testKey(): string {
  return bytesToBase64(new Uint8Array(32).fill(7));
}

type TestEnvOverrides = Partial<Env> & Record<string, string | undefined>;

export function workerEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    ...env,
    APP_ENV: "local",
    APP_BASE_URL: "http://localhost:8787",
    FORTNOX_CLIENT_ID: "test-client-id",
    FORTNOX_CLIENT_SECRET: "test-client-secret",
    FORTNOX_SCOPES: "companyinformation customer invoice offer order payment supplier supplierinvoice bookkeeping inbox connectfile settings print",
    TOKEN_ENCRYPTION_KEY_BASE64: testKey(),
    STRIPE_SECRET_KEY: "test-placeholder",
    STRIPE_WEBHOOK_SECRET: "test-placeholder",
    STRIPE_PUBLISHABLE_KEY: "pk_test_REPLACE_WITH_STRIPE_PUBLISHABLE_KEY",
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-aud",
    MAX_RECEIPT_UPLOAD_BYTES: "10485760",
    RESEND_API_KEY: "test-resend-key",
    RESEND_WEBHOOK_SECRET: "whsec_d2ViaG9va190ZXN0X3NlY3JldA",
    EMAIL_FROM: "offers@example.test",
    EMAIL_FROM_NAME: "Webblyftet",
    EMAIL_REPLY_TO: "ekonomi@example.test",
    LOCAL_DEV_EMAIL: "admin@example.test",
    ADMIN_EMAILS: "admin@example.test",
    FINANCE_EMAILS: "finance@example.test",
    SELLER_EMAILS: "seller@example.test",
    READ_ONLY_EMAILS: "reader@example.test",
    ...overrides
  } as Env;
}

export async function resetTables(db = env.DB): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS fortnox_connections (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      company_name TEXT,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      token_expires_at TEXT,
      scope TEXT,
      connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      verifier TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS document_sequences (
      name TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR IGNORE INTO document_sequences(name,prefix,next_number)
      VALUES ('TEST_INVOICE','TEST-',1)`,
    `CREATE TABLE IF NOT EXISTS sync_log (
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
    )`,
    `CREATE TABLE IF NOT EXISTS operational_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      customer_id TEXT,
      contract_flow_id TEXT,
      sales_order_id TEXT,
      invoice_id TEXT,
      subscription_id TEXT,
      provider TEXT,
      provider_event_id TEXT,
      request_id TEXT,
      details_json TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      acknowledged_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_events_open_dedupe
      ON operational_events(dedupe_key)
      WHERE resolved_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      fortnox_customer_number TEXT UNIQUE,
      org_number TEXT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address1 TEXT,
      zip TEXT,
      city TEXT,
      country TEXT DEFAULT 'SE',
      stripe_customer_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      product_type TEXT NOT NULL,
      stripe_product_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_stripe_product_id
      ON products(stripe_product_id)
      WHERE stripe_product_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS prices (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SEK',
      billing_type TEXT NOT NULL,
      billing_interval TEXT,
      vat_percent REAL NOT NULL DEFAULT 25,
      active INTEGER NOT NULL DEFAULT 1,
      stripe_price_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      fortnox_document_number TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      offer_date TEXT NOT NULL,
      expire_date TEXT,
      remarks TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      vat_total REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      accepted_at TEXT,
      accepted_by_name TEXT,
      accepted_by_email TEXT,
      acceptance_ip TEXT,
      acceptance_user_agent TEXT,
      signature_token_hash TEXT,
      sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS offer_rows (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      article_number TEXT,
      description TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT,
      unit_price REAL NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      vat_percent REAL NOT NULL DEFAULT 25,
      account_number INTEGER,
      product_id TEXT,
      price_id TEXT,
      billing_type TEXT NOT NULL DEFAULT 'ONE_TIME',
      billing_interval TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS offer_versions (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      subtotal INTEGER NOT NULL,
      vat_total INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(offer_id, version_number)
    )`,
    `CREATE TABLE IF NOT EXISTS offer_acceptance_tokens (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      offer_version_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS offer_acceptances (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      offer_version_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      accepted_by_name TEXT NOT NULL,
      accepted_by_email TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      snapshot_hash TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(offer_version_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      offer_version_id TEXT NOT NULL,
      acceptance_id TEXT UNIQUE,
      customer_id TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SEK',
      one_time_total_minor INTEGER NOT NULL DEFAULT 0,
      recurring_monthly_minor INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'CREATED',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sales_order_items (
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
      billing_type TEXT NOT NULL,
      billing_interval TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      sales_order_id TEXT,
      offer_id TEXT,
      offer_version_id TEXT,
      status TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SEK',
      start_date TEXT NOT NULL,
      current_period_start TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_sales_order
      ON subscriptions(sales_order_id)
      WHERE sales_order_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS subscription_items (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      price_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_amount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      fortnox_document_number TEXT,
      customer_id TEXT NOT NULL,
      source_offer_id TEXT,
      sales_order_id TEXT,
      invoice_number TEXT,
      invoice_type TEXT NOT NULL DEFAULT 'PROJECT_INVOICE',
      status TEXT NOT NULL,
      invoice_date TEXT,
      due_date TEXT,
      currency TEXT NOT NULL DEFAULT 'SEK',
      subtotal REAL NOT NULL DEFAULT 0,
      vat_total REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      balance REAL,
      subtotal_minor INTEGER,
      vat_total_minor INTEGER,
      total_minor INTEGER,
      balance_minor INTEGER,
      booked INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_sales_order
      ON invoices(sales_order_id)
      WHERE sales_order_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS invoice_rows (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT,
      unit_price REAL NOT NULL,
      vat_percent REAL NOT NULL DEFAULT 25,
      product_id TEXT,
      price_id TEXT,
      billing_type TEXT NOT NULL DEFAULT 'ONE_TIME',
      billing_interval TEXT,
      unit_price_minor INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS receipts (
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
      fortnox_inbox_file_id TEXT,
      fortnox_archive_file_id TEXT,
      fortnox_inbox_path TEXT,
      pushed_to_fortnox_at TEXT,
      voucher_series TEXT,
      voucher_number INTEGER,
      supplier_invoice_number TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      subscription_id TEXT,
      invoice_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SEK',
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_payment_id TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment_id
      ON payments(provider, provider_payment_id)
      WHERE provider_payment_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS payment_attempts (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_attempt_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_attempt_id
      ON payment_attempts(provider, provider_attempt_id)
      WHERE provider_attempt_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS payment_method_setup_sessions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      stripe_setup_intent_id TEXT,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_payment_method_setup_sessions_customer
      ON payment_method_setup_sessions(customer_id, status, expires_at)`,
    `CREATE TABLE IF NOT EXISTS customer_order_sessions (
      id TEXT PRIMARY KEY,
      sales_order_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      public_token_enc TEXT,
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_order_sessions_order
      ON customer_order_sessions(sales_order_id, status, expires_at)`,
    `CREATE TABLE IF NOT EXISTS contract_flows (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_contract_flows_customer
      ON contract_flows(customer_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_contract_flows_source_customer
      ON contract_flows(source, source_customer_id)
      WHERE source_customer_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_contract_flows_status
      ON contract_flows(status, updated_at)`,
    `CREATE TABLE IF NOT EXISTS payment_methods (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_payment_method_id TEXT NOT NULL,
      type TEXT NOT NULL,
      brand TEXT,
      last4 TEXT,
      exp_month INTEGER,
      exp_year INTEGER,
      status TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_payment_method_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_payment_methods_customer
      ON payment_methods(customer_id, is_default)`,
    `CREATE TABLE IF NOT EXISTS accounting_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      currency TEXT NOT NULL,
      net_amount INTEGER NOT NULL,
      vat_amount INTEGER NOT NULL,
      gross_amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_events_unique
      ON accounting_events(event_type, entity_type, entity_id)`,
    `CREATE TABLE IF NOT EXISTS integration_events (
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
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS security_rate_limits (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS outbound_email_events (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      email_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_message_id TEXT,
      contract_flow_id TEXT,
      customer_order_session_id TEXT,
      offer_id TEXT,
      invoice_id TEXT,
      status TEXT NOT NULL,
      subject TEXT NOT NULL,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      failed_at TEXT,
      delivered_at TEXT,
      bounced_at TEXT,
      complained_at TEXT,
      last_provider_event_id TEXT,
      last_provider_event_type TEXT,
      last_provider_event_at TEXT,
      delivery_trigger TEXT NOT NULL DEFAULT 'MANUAL'
    )`,
    `CREATE TABLE IF NOT EXISTS email_provider_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      provider_message_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_event_id)
    )`,
    `CREATE TABLE IF NOT EXISTS invoice_document_tokens (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_enc TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(invoice_id)
    )`
  ];
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  const sessionColumns = await db.prepare("PRAGMA table_info(customer_order_sessions)").all<{ name: string }>();
  if (!sessionColumns.results.some((column) => column.name === "public_token_enc")) {
    await db.prepare("ALTER TABLE customer_order_sessions ADD COLUMN public_token_enc TEXT").run();
  }
  await db.prepare("DELETE FROM sync_log").run();
  await db.prepare("DELETE FROM fortnox_connections").run();
  await db.prepare("DELETE FROM oauth_states").run();
  await db.prepare("UPDATE document_sequences SET next_number=1, updated_at=CURRENT_TIMESTAMP WHERE name='TEST_INVOICE'").run();
  await db.prepare("DELETE FROM audit_log").run();
  await db.prepare("DELETE FROM integration_events").run();
  await db.prepare("DELETE FROM operational_events").run();
  await db.prepare("DELETE FROM outbound_email_events").run();
  await db.prepare("DELETE FROM email_provider_events").run();
  await db.prepare("DELETE FROM invoice_document_tokens").run();
  await db.prepare("DELETE FROM accounting_events").run();
  await db.prepare("DELETE FROM payment_methods").run();
  await db.prepare("DELETE FROM payment_method_setup_sessions").run();
  await db.prepare("DELETE FROM contract_flows").run();
  await db.prepare("DELETE FROM customer_order_sessions").run();
  await db.prepare("DELETE FROM payment_attempts").run();
  await db.prepare("DELETE FROM payments").run();
  await db.prepare("DELETE FROM subscription_items").run();
  await db.prepare("DELETE FROM subscriptions").run();
  await db.prepare("DELETE FROM invoice_rows").run();
  await db.prepare("DELETE FROM invoices").run();
  await db.prepare("DELETE FROM receipts").run();
  await db.prepare("DELETE FROM sales_order_items").run();
  await db.prepare("DELETE FROM sales_orders").run();
  await db.prepare("DELETE FROM offer_acceptances").run();
  await db.prepare("DELETE FROM offer_acceptance_tokens").run();
  await db.prepare("DELETE FROM offer_versions").run();
  await db.prepare("DELETE FROM offer_rows").run();
  await db.prepare("DELETE FROM offers").run();
  await db.prepare("DELETE FROM prices").run();
  await db.prepare("DELETE FROM products").run();
  await db.prepare("DELETE FROM customers").run();
  await db.prepare("DELETE FROM security_rate_limits").run();
}
