import { decryptString, encryptString } from "../../lib/crypto";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { fortnoxClientId, fortnoxClientSecret, isFortnoxConfigured, requireFortnoxConfigured } from "../../lib/config";

type Connection = {
  id: string;
  tenant_id: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  scope: string | null;
};

const AUTH_URL = "https://apps.fortnox.se/oauth-v1/auth";
const TOKEN_URL = "https://apps.fortnox.se/oauth-v1/token";
const API_BASE = "https://api.fortnox.se/3";
const SENSITIVE_LOG_KEYS = /authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|api[_-]?key/i;

export class FortnoxApiError extends PublicAppError {
  constructor(
    status: number,
    publicMessage: string,
    public readonly syncId: string,
    public readonly responseBody?: unknown
  ) {
    super(status, publicMessage, syncId);
  }
}

export function appBaseUrl(env: Env): string {
  return env.APP_BASE_URL.replace(/\/+$/, "");
}

export function fortnoxRedirectUri(env: Env): string {
  return `${appBaseUrl(env)}/auth/fortnox/callback`;
}

export async function cleanupExpiredOAuthStates(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(new Date().toISOString()).run();
}

export async function createAuthUrl(env: Env): Promise<string> {
  requireFortnoxConfigured(env);
  await cleanupExpiredOAuthStates(env);
  const state = crypto.randomUUID();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO oauth_states(state, expires_at) VALUES (?, ?)").bind(state, expires).run();

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", fortnoxClientId(env));
  url.searchParams.set("redirect_uri", fortnoxRedirectUri(env));
  url.searchParams.set("scope", env.FORTNOX_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("account_type", "service");
  return url.toString();
}

async function basicAuth(env: Env): Promise<string> {
  return btoa(`${fortnoxClientId(env)}:${fortnoxClientSecret(env)}`);
}

export async function consumeOAuthState(env: Env, state: string, now = Date.now()): Promise<void> {
  const record = await one<{ state: string; expires_at: string }>(
    env.DB,
    "SELECT state, expires_at FROM oauth_states WHERE state = ?",
    state
  );
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  if (!record || new Date(record.expires_at).getTime() < now) {
    throw new PublicAppError(400, "OAuth-sessionen är ogiltig eller har gått ut.");
  }
}

export async function exchangeCode(env: Env, code: string, state: string) {
  requireFortnoxConfigured(env);
  await cleanupExpiredOAuthStates(env);
  await consumeOAuthState(env, state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: fortnoxRedirectUri(env)
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${await basicAuth(env)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new PublicAppError(502, "Fortnox-anslutningen kunde inte slutföras.");
  }

  const token = await response.json<{
    access_token: string;
    refresh_token?: string;
    scope: string;
    expires_in: number;
  }>();

  const accessEnc = await encryptString(token.access_token, env.TOKEN_ENCRYPTION_KEY_BASE64);
  const refreshEnc = token.refresh_token
    ? await encryptString(token.refresh_token, env.TOKEN_ENCRYPTION_KEY_BASE64)
    : null;
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

  await env.DB.prepare("DELETE FROM fortnox_connections").run();
  await env.DB.prepare(
    `INSERT INTO fortnox_connections
      (id, access_token_enc, refresh_token_enc, token_expires_at, scope, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(id("fnx"), accessEnc, refreshEnc, expiresAt, token.scope).run();

  const company = await fortnoxRequest<any>(env, "/companyinformation", { method: "GET" });
  const info = company.CompanyInformation ?? company;
  const tenantId = info.DatabaseNumber ? String(info.DatabaseNumber) : null;
  const companyName = info.CompanyName ?? info.Name ?? null;

  await env.DB.prepare(
    "UPDATE fortnox_connections SET tenant_id = ?, company_name = ?, updated_at = CURRENT_TIMESTAMP"
  ).bind(tenantId, companyName).run();

  return { tenantId, companyName, scope: token.scope };
}

function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        SENSITIVE_LOG_KEYS.test(key) ? "redacted" : key,
        SENSITIVE_LOG_KEYS.test(key) ? "[REDACTED]" : sanitizeForLog(item)
      ])
    );
  }
  return value;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=-]+/gi, "Basic [REDACTED]")
    .replace(/("(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|secret|api[_-]?key)"\s*:\s*")([^"]*)(")/gi, "$1[REDACTED]$3")
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|secret|api[_-]?key)=)[^&\s]+/gi, "$1[REDACTED]");
}

function stringifyLogValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactSensitiveText(value);
  return JSON.stringify(sanitizeForLog(value));
}

async function refreshIfNeeded(env: Env, connection: Connection): Promise<string> {
  if (
    connection.access_token_enc &&
    connection.token_expires_at &&
    new Date(connection.token_expires_at).getTime() > Date.now() + 120_000
  ) {
    return decryptString(connection.access_token_enc, env.TOKEN_ENCRYPTION_KEY_BASE64);
  }

  if (connection.tenant_id) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${await basicAuth(env)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        TenantId: connection.tenant_id
      },
      body: new URLSearchParams({ grant_type: "client_credentials" })
    });
    if (response.ok) {
      const token = await response.json<{ access_token: string; expires_in: number; scope: string }>();
      const enc = await encryptString(token.access_token, env.TOKEN_ENCRYPTION_KEY_BASE64);
      const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
      await env.DB.prepare(
        "UPDATE fortnox_connections SET access_token_enc = ?, token_expires_at = ?, scope = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(enc, expiresAt, token.scope, connection.id).run();
      return token.access_token;
    }
  }

  if (!connection.refresh_token_enc) {
    throw new PublicAppError(401, "Fortnox-anslutningen har gått ut. Anslut Fortnox igen.");
  }
  const refreshToken = await decryptString(connection.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY_BASE64);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${await basicAuth(env)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  });
  if (!response.ok) throw new PublicAppError(401, "Fortnox-anslutningen har gått ut. Anslut Fortnox igen.");

  const token = await response.json<{
    access_token: string;
    refresh_token?: string;
    scope: string;
    expires_in: number;
  }>();
  const accessEnc = await encryptString(token.access_token, env.TOKEN_ENCRYPTION_KEY_BASE64);
  const refreshEnc = token.refresh_token
    ? await encryptString(token.refresh_token, env.TOKEN_ENCRYPTION_KEY_BASE64)
    : connection.refresh_token_enc;
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE fortnox_connections SET access_token_enc=?, refresh_token_enc=?, token_expires_at=?, scope=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(accessEnc, refreshEnc, expiresAt, token.scope, connection.id).run();
  return token.access_token;
}

export async function fortnoxRequest<T>(
  env: Env,
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> {
  requireFortnoxConfigured(env);
  const connection = await one<Connection>(
    env.DB,
    "SELECT id, tenant_id, access_token_enc, refresh_token_enc, token_expires_at, scope FROM fortnox_connections LIMIT 1"
  );
  if (!connection) throw new PublicAppError(409, "Fortnox är inte anslutet.");

  const token = await refreshIfNeeded(env, connection);
  const endpoint = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (init.json !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(endpoint, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body
  });

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  }

  const syncId = id("sync");
  await env.DB.prepare(
    `INSERT INTO sync_log
      (id,direction,entity_type,operation,endpoint,http_status,success,request_json,response_json,error_message)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    syncId, "OUTBOUND", "FORTNOX", init.method ?? "GET", endpoint, response.status,
    response.ok ? 1 : 0,
    stringifyLogValue(init.json),
    stringifyLogValue(parsed),
    response.ok ? null : `HTTP ${response.status}`
  ).run();

  if (!response.ok) {
    throw new FortnoxApiError(
      response.status >= 500 ? 502 : response.status,
      `Fortnox-anropet misslyckades. Referens: ${syncId}`,
      syncId,
      parsed
    );
  }
  return parsed as T;
}

export async function uploadInboxFile(
  env: Env,
  file: File,
  folder: "Inbox_v" | "Inbox_s" | "Inbox_kf" | "Inbox_o" | "Inbox_of" = "Inbox_v"
) {
  requireFortnoxConfigured(env);
  const connection = await one<Connection>(
    env.DB,
    "SELECT id, tenant_id, access_token_enc, refresh_token_enc, token_expires_at, scope FROM fortnox_connections LIMIT 1"
  );
  if (!connection) throw new PublicAppError(409, "Fortnox är inte anslutet.");

  const token = await refreshIfNeeded(env, connection);
  const form = new FormData();
  form.append("file", file);
  const endpoint = `${API_BASE}/inbox?path=${encodeURIComponent(folder)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    body: form
  });

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  }

  const syncId = id("sync");
  await env.DB.prepare(
    `INSERT INTO sync_log
      (id,direction,entity_type,operation,endpoint,http_status,success,request_json,response_json,error_message)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    syncId, "OUTBOUND", "FORTNOX_INBOX", "POST", endpoint, response.status,
    response.ok ? 1 : 0,
    stringifyLogValue({ folder, filename: file.name, mime_type: file.type, size: file.size }),
    stringifyLogValue(parsed),
    response.ok ? null : `HTTP ${response.status}`
  ).run();

  if (!response.ok) {
    throw new FortnoxApiError(
      response.status >= 500 ? 502 : response.status,
      `Fortnox Inbox-uppladdningen misslyckades. Referens: ${syncId}`,
      syncId,
      parsed
    );
  }
  return parsed as { File?: { Id?: string; Name?: string; Path?: string; Size?: string } };
}

export async function connectionStatus(env: Env) {
  if (!isFortnoxConfigured(env)) return { configured: false, connected: false };
  const row = await one<any>(
    env.DB,
    "SELECT tenant_id, company_name, scope, connected_at, updated_at FROM fortnox_connections LIMIT 1"
  );
  return row ? { configured: true, connected: true, ...row } : { configured: true, connected: false };
}
