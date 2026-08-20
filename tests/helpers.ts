import { env } from "cloudflare:workers";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function testKey(): string {
  return bytesToBase64(new Uint8Array(32).fill(7));
}

export function workerEnv(overrides: Partial<Env> = {}): Env {
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
    ...overrides
  };
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
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
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
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
      client_secret TEXT,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_payment_method_setup_sessions_customer
      ON payment_method_setup_sessions(customer_id, status, expires_at)`,
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
    )`
  ];
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  await db.prepare("DELETE FROM sync_log").run();
  await db.prepare("DELETE FROM fortnox_connections").run();
  await db.prepare("DELETE FROM oauth_states").run();
  await db.prepare("DELETE FROM audit_log").run();
  await db.prepare("DELETE FROM integration_events").run();
  await db.prepare("DELETE FROM accounting_events").run();
  await db.prepare("DELETE FROM payment_method_setup_sessions").run();
  await db.prepare("DELETE FROM payment_attempts").run();
  await db.prepare("DELETE FROM payments").run();
  await db.prepare("DELETE FROM subscription_items").run();
  await db.prepare("DELETE FROM subscriptions").run();
  await db.prepare("DELETE FROM prices").run();
  await db.prepare("DELETE FROM products").run();
  await db.prepare("DELETE FROM customers").run();
}
