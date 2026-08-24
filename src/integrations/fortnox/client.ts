import { decryptString, encryptString } from "../../lib/crypto";
import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { fortnoxClientId, fortnoxClientSecret, isFortnoxConfigured, requireFortnoxConfigured } from "../../lib/config";
import { stringifyLogValue } from "../../lib/security";

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

export const FORTNOX_INBOX_PATHS = {
  SUPPLIER_DOCUMENT: "Inbox_s",
  VOUCHER_ATTACHMENT: "Inbox_v",
  CUSTOMER_INVOICE_DOCUMENT: "Inbox_kf",
  ORDER_DOCUMENT: "Inbox_o",
  OFFER_DOCUMENT: "Inbox_of"
} as const;

export type FortnoxInboxPath = typeof FORTNOX_INBOX_PATHS[keyof typeof FORTNOX_INBOX_PATHS];

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
  folder: FortnoxInboxPath,
  options: { folderId?: string } = {}
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
  const endpoint = options.folderId
    ? `${API_BASE}/inbox?folderid=${encodeURIComponent(options.folderId)}`
    : `${API_BASE}/inbox?path=${encodeURIComponent(folder)}`;
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
    stringifyLogValue({ folder, folder_id: options.folderId ?? null, filename: file.name, mime_type: file.type, size: file.size }),
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
  return parsed as { File?: { Id?: string; ArchiveFileId?: string; Name?: string; Path?: string; Size?: string } };
}

export async function verifyInboxFolder(env: Env, folder: FortnoxInboxPath) {
  const result = await fortnoxRequest<any>(env, "/inbox", { method: "GET" });
  const normalized = folder.toLowerCase();
  const match = result.Folder?.Folders?.find((item: any) => String(item.Id ?? "").toLowerCase() === normalized);
  if (!match?.Id) throw new PublicAppError(409, `Fortnox Inbox folder ${folder} not found`);
  return { folderId: String(match.Id), raw: result };
}

export async function retrieveInboxFile(env: Env, fileId: string) {
  requireFortnoxConfigured(env);
  const connection = await one<Connection>(
    env.DB,
    "SELECT id, tenant_id, access_token_enc, refresh_token_enc, token_expires_at, scope FROM fortnox_connections LIMIT 1"
  );
  if (!connection) throw new PublicAppError(409, "Fortnox är inte anslutet.");

  const token = await refreshIfNeeded(env, connection);
  const endpoint = `${API_BASE}/inbox/${encodeURIComponent(fileId)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  let parsed: unknown = {
    file_id: fileId,
    content_type: response.headers.get("content-type"),
    content_length: response.headers.get("content-length")
  };
  if (!response.ok) {
    const raw = await response.text();
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }
  }

  const syncId = id("sync");
  await env.DB.prepare(
    `INSERT INTO sync_log
      (id,direction,entity_type,operation,endpoint,http_status,success,request_json,response_json,error_message)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    syncId, "OUTBOUND", "FORTNOX_INBOX", "GET", endpoint, response.status,
    response.ok ? 1 : 0,
    null,
    stringifyLogValue(parsed),
    response.ok ? null : `HTTP ${response.status}`
  ).run();

  if (!response.ok) {
    throw new FortnoxApiError(
      response.status >= 500 ? 502 : response.status,
      `Fortnox Inbox-filen kunde inte verifieras. Referens: ${syncId}`,
      syncId,
      parsed
    );
  }
  return parsed;
}

export async function connectionStatus(env: Env) {
  if (!isFortnoxConfigured(env)) return { configured: false, connected: false };
  const row = await one<any>(
    env.DB,
    "SELECT tenant_id, company_name, scope, connected_at, updated_at FROM fortnox_connections LIMIT 1"
  );
  return row ? { configured: true, connected: true, ...row } : { configured: true, connected: false };
}
