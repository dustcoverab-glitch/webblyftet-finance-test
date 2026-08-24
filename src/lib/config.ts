import { PublicAppError } from "./app-error";

const MISSING_FORTNOX_MESSAGE = "Fortnox är inte konfigurerat ännu.";
const MISSING_STRIPE_MESSAGE = "Stripe är inte konfigurerat ännu.";

type OptionalEnv = Env & Record<string, string | undefined>;

function value(env: Env, key: string): string {
  return ((env as OptionalEnv)[key] ?? "").trim();
}

function isPlaceholder(input: string): boolean {
  return !input || input.includes("REPLACE_WITH_");
}

function startsWith(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

export function isFortnoxConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "FORTNOX_CLIENT_ID")) && !isPlaceholder(value(env, "FORTNOX_CLIENT_SECRET"));
}

export function requireFortnoxConfigured(env: Env): void {
  if (!isFortnoxConfigured(env)) throw new PublicAppError(503, MISSING_FORTNOX_MESSAGE);
}

export function isStripeConfigured(env: Env): boolean {
  const secret = value(env, "STRIPE_SECRET_KEY");
  if (env.APP_ENV === "test" && startsWith(secret, "sk_live_")) {
    throw new PublicAppError(500, "Stripe live-nyckel får inte användas i testmiljön.");
  }
  return !isPlaceholder(secret);
}

export function isStripeWebhookConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "STRIPE_WEBHOOK_SECRET"));
}

export function isStripePublishableKeyConfigured(env: Env): boolean {
  const publishable = value(env, "STRIPE_PUBLISHABLE_KEY");
  if (env.APP_ENV === "test" && startsWith(publishable, "pk_live_")) {
    throw new PublicAppError(500, "Stripe live publishable key får inte användas i testmiljön.");
  }
  return !isPlaceholder(publishable);
}

export function requireStripeConfigured(env: Env): void {
  if (!isStripeConfigured(env)) throw new PublicAppError(503, MISSING_STRIPE_MESSAGE);
}

export function requireStripeWebhookConfigured(env: Env): void {
  if (!isStripeWebhookConfigured(env)) throw new PublicAppError(503, MISSING_STRIPE_MESSAGE);
}

export function stripeSecretKey(env: Env): string {
  requireStripeConfigured(env);
  return value(env, "STRIPE_SECRET_KEY");
}

export function stripeWebhookSecret(env: Env): string {
  requireStripeWebhookConfigured(env);
  return value(env, "STRIPE_WEBHOOK_SECRET");
}

export function fortnoxClientId(env: Env): string {
  requireFortnoxConfigured(env);
  return value(env, "FORTNOX_CLIENT_ID");
}

export function fortnoxClientSecret(env: Env): string {
  requireFortnoxConfigured(env);
  return value(env, "FORTNOX_CLIENT_SECRET");
}

export function cloudflareAccessRequired(env: Env): boolean {
  const raw = value(env, "REQUIRE_CLOUDFLARE_ACCESS").toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return env.APP_ENV !== "local";
}

export function cloudflareAccessTeamDomain(env: Env): string {
  const raw = value(env, "CF_ACCESS_TEAM_DOMAIN");
  if (isPlaceholder(raw)) return "";
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function cloudflareAccessAudience(env: Env): string {
  const raw = value(env, "CF_ACCESS_AUD");
  return isPlaceholder(raw) ? "" : raw;
}

export function maxReceiptUploadBytes(env: Env): number {
  const configured = Number(value(env, "MAX_RECEIPT_UPLOAD_BYTES"));
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 1024 * 1024;
}
