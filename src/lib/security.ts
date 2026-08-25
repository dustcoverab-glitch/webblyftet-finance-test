import type { MiddlewareHandler } from "hono";
import {
  cloudflareAccessAudience,
  cloudflareAccessRequired,
  cloudflareAccessTeamDomain
} from "./config";
import { currentUserFromRequest } from "./authorization";

const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";
const CUSTOMER_ORDER_PREFIX = "/customer-order/";
const CUSTOMER_ORDER_ASSETS_PREFIX = "/customer-order-assets/";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_LOG_KEYS = /authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|client_secret|secret|password|api[_-]?key|cookie|set-cookie|stripe[_-]?.*secret/i;
const SENSITIVE_TEXT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=-]+/gi,
  /sk_(?:test|live)_[A-Za-z0-9]+/g,
  /pk_(?:test|live)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+/g,
  /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|client_secret|authorization|secret|api[_-]?key|cookie|set-cookie)=)[^&\s"']+/gi,
  /("(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|client_secret|authorization|secret|api[_-]?key|cookie|set-cookie)"\s*:\s*")([^"]*)(")/gi
];

type AccessJwk = JsonWebKey & { kid?: string };
type Jwks = { keys?: AccessJwk[] };
type AccessPayload = {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iss?: string;
  email?: string;
};

type PublicCustomerOrderRoute = {
  method: "GET" | "POST";
  segments: string[];
};

const PUBLIC_CUSTOMER_ORDER_ROUTES: PublicCustomerOrderRoute[] = [
  { method: "GET", segments: ["customer-order", ":token"] },
  { method: "GET", segments: ["customer-order", ":token", "session"] },
  { method: "GET", segments: ["customer-order", ":token", "offer-document"] },
  { method: "GET", segments: ["customer-order", ":token", "stripe-config"] },
  { method: "POST", segments: ["customer-order", ":token", "review"] },
  { method: "POST", segments: ["customer-order", ":token", "sign"] },
  { method: "POST", segments: ["customer-order", ":token", "payment-method", "setup"] },
  { method: "POST", segments: ["customer-order", ":token", "payment-method", "confirm"] },
  { method: "POST", segments: ["customer-order", ":token", "activate"] }
];

export function isLocalEnvironment(env: Env): boolean {
  return env.APP_ENV === "local";
}

export function isExactStripeWebhookPath(pathname: string): boolean {
  return pathname === STRIPE_WEBHOOK_PATH;
}

export function isPublicCustomerOrderPath(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" && pathname.startsWith(CUSTOMER_ORDER_ASSETS_PREFIX)) return true;
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return PUBLIC_CUSTOMER_ORDER_ROUTES.some((route) => {
    if (route.method !== normalizedMethod || route.segments.length !== segments.length) return false;
    return route.segments.every((expected, index) => expected === ":token" ? isSafePublicTokenSegment(segments[index]) : expected === segments[index]);
  });
}

export function isPublicRoute(method: string, pathname: string): boolean {
  return (method.toUpperCase() === "POST" && isExactStripeWebhookPath(pathname)) || isPublicCustomerOrderPath(method, pathname);
}

export function requireCloudflareAccess(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (isPublicRoute(c.req.method, url.pathname)) {
      await next();
      return;
    }

    if (isLocalEnvironment(c.env) || !cloudflareAccessRequired(c.env)) {
      (c as any).set("authenticatedUser", currentUserFromRequest(c.env, c.req.raw.headers, null));
      await next();
      return;
    }

    const assertion = c.req.header("cf-access-jwt-assertion");
    if (!assertion) {
      return c.json(
        {
          error: "Cloudflare Access krävs för den deployade testmiljön.",
          code: "ACCESS_REQUIRED"
        },
        403
      );
    }

    const result = await verifyCloudflareAccessJwt(c.env, assertion);
    if (!result.ok) {
      return c.json({ error: result.error, code: result.code }, 403);
    }

    (c as any).set("authenticatedUser", currentUserFromRequest(c.env, c.req.raw.headers, result.payload.email));
    await next();
  };
}

export function csrfProtection(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (
      isExactStripeWebhookPath(url.pathname) ||
      isLocalEnvironment(c.env) ||
      !cloudflareAccessRequired(c.env) ||
      !UNSAFE_METHODS.has(c.req.method.toUpperCase())
    ) {
      await next();
      return;
    }

    const expectedOrigin = url.origin;
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const candidate = origin || (referer ? new URL(referer).origin : "");
    if (candidate !== expectedOrigin) {
      return c.json({ error: "Same-origin verifiering krävs.", code: "CSRF_REQUIRED" }, 403);
    }

    await next();
  };
}

export function securityHeaders(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    const url = new URL(c.req.url);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self \"https://js.stripe.com\")");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' https://js.stripe.com",
      "connect-src 'self' https://api.stripe.com",
      "frame-src https://js.stripe.com https://hooks.stripe.com",
      "form-action 'self'",
      "upgrade-insecure-requests"
    ].join("; "));
    if (url.protocol === "https:") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  };
}

export function rateLimitSensitiveRoutes(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (isExactStripeWebhookPath(url.pathname) || !UNSAFE_METHODS.has(c.req.method.toUpperCase()) || !isRateLimitedPath(url.pathname)) {
      await next();
      return;
    }
    await c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS security_rate_limits (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      )`
    ).run();
    const limit = 20;
    const windowSeconds = 60;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSeconds);
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
    const bucketKey = `${ip}:${c.req.method}:${rateLimitScope(url.pathname)}:${windowStart}`;
    await c.env.DB.prepare(
      `INSERT INTO security_rate_limits(bucket_key,count,window_start)
       VALUES (?,1,?)
       ON CONFLICT(bucket_key) DO UPDATE SET count=count+1`
    ).bind(bucketKey, windowStart).run();
    const row = await c.env.DB.prepare("SELECT count FROM security_rate_limits WHERE bucket_key=?").bind(bucketKey).first<{ count: number }>();
    if ((row?.count ?? 0) > limit) {
      return c.json({ error: "För många försök. Vänta en minut och försök igen.", code: "RATE_LIMITED" }, 429);
    }
    const cleanup = c.env.DB.prepare("DELETE FROM security_rate_limits WHERE window_start < ?").bind(windowStart - 3600).run();
    const executionCtx = c.executionCtx as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
    if (typeof executionCtx?.waitUntil === "function") {
      executionCtx.waitUntil(cleanup);
    } else {
      await cleanup;
    }
    await next();
  };
}

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix, _secret, suffix) => {
      if (prefix && suffix) return `${prefix}[REDACTED]${suffix}`;
      if (prefix) return `${prefix}[REDACTED]`;
      if (/^Bearer/i.test(match)) return "Bearer [REDACTED]";
      if (/^Basic/i.test(match)) return "Basic [REDACTED]";
      return "[REDACTED]";
    });
  }
  return redacted;
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
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

export function stringifyLogValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? redactSensitiveText(value) : JSON.stringify(sanitizeForLog(value));
}

export function safeReceiptContentDisposition(filename: string): string {
  const safe = filename.replace(/["\r\n\\]/g, "_").replace(/[^\w .()-]/g, "_").slice(0, 160) || "receipt";
  return `attachment; filename="${safe}"`;
}

export function isAllowedReceiptMimeType(type: string): boolean {
  return new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff"]).has(type);
}

async function verifyCloudflareAccessJwt(env: Env, token: string): Promise<{ ok: true; payload: AccessPayload } | { ok: false; error: string; code: string }> {
  const teamDomain = cloudflareAccessTeamDomain(env);
  const audience = cloudflareAccessAudience(env);
  if (!teamDomain || !audience) {
    return {
      ok: false,
      error: "Cloudflare Access JWT-verifiering saknar CF_ACCESS_TEAM_DOMAIN eller CF_ACCESS_AUD.",
      code: "ACCESS_CONFIG_REQUIRED"
    };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT shape");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(decodeBase64UrlToText(encodedHeader)) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unexpected JWT header");

    const certsResponse = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!certsResponse.ok) throw new Error("Unable to load Access JWKS");
    const jwks = await certsResponse.json<Jwks>();
    const jwk = jwks.keys?.find((key) => key.kid === header.kid);
    if (!jwk) throw new Error("Access signing key not found");

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      toArrayBuffer(decodeBase64Url(encodedSignature)),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
    if (!valid) throw new Error("Invalid Access JWT signature");

    const payload = JSON.parse(decodeBase64UrlToText(encodedPayload)) as AccessPayload;
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!audiences.includes(audience)) throw new Error("Invalid Access audience");
    if (payload.exp && payload.exp <= now) throw new Error("Expired Access JWT");
    if (payload.nbf && payload.nbf > now + 30) throw new Error("Access JWT not active");
    return { ok: true, payload };
  } catch {
    return {
      ok: false,
      error: "Cloudflare Access-token kunde inte verifieras.",
      code: "ACCESS_JWT_INVALID"
    };
  }
}

function decodeBase64UrlToText(value: string): string {
  return new TextDecoder().decode(decodeBase64Url(value));
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isRateLimitedPath(pathname: string): boolean {
  return [
    "/auth/fortnox/start",
    "/api/receipts",
    "/sign/",
    "/customer-order/"
  ].some((prefix) => pathname === prefix || pathname.startsWith(prefix)) ||
    /\/(sync|sync-fortnox|sync-stripe|pull|activate|cancel|payment-method\/setup|stripe-customer|push-inbox|disconnect|sign-link)$/.test(pathname);
}

function rateLimitScope(pathname: string): string {
  return pathname.replace(/\/(cus|off|inv|sub|rcp|prod|price)_[^/]+/g, "/:id");
}

function isSafePublicTokenSegment(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z0-9_-]{16,160}$/.test(value));
}
