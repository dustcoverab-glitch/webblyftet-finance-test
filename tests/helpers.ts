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
    )`
  ];
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  await db.prepare("DELETE FROM sync_log").run();
  await db.prepare("DELETE FROM fortnox_connections").run();
  await db.prepare("DELETE FROM oauth_states").run();
}
