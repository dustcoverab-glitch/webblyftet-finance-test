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

export function isFortnoxConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "FORTNOX_CLIENT_ID")) && !isPlaceholder(value(env, "FORTNOX_CLIENT_SECRET"));
}

export function requireFortnoxConfigured(env: Env): void {
  if (!isFortnoxConfigured(env)) throw new PublicAppError(503, MISSING_FORTNOX_MESSAGE);
}

export function isStripeConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "STRIPE_SECRET_KEY"));
}

export function isStripeWebhookConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "STRIPE_WEBHOOK_SECRET"));
}

export function isStripePublishableKeyConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "STRIPE_PUBLISHABLE_KEY"));
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
