import { PublicAppError } from "./app-error";

const MISSING_FORTNOX_MESSAGE = "Fortnox är inte konfigurerat ännu.";
const MISSING_STRIPE_MESSAGE = "Stripe är inte konfigurerat ännu.";
const MISSING_EMAIL_MESSAGE = "E-post är inte konfigurerat ännu.";

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

export function isEmailConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "RESEND_API_KEY")) && !isPlaceholder(value(env, "EMAIL_FROM"));
}

export function requireEmailConfigured(env: Env): void {
  if (!isEmailConfigured(env)) throw new PublicAppError(503, MISSING_EMAIL_MESSAGE);
}

export function isResendWebhookConfigured(env: Env): boolean {
  return !isPlaceholder(value(env, "RESEND_WEBHOOK_SECRET"));
}

export function resendWebhookSecret(env: Env): string {
  const secret = value(env, "RESEND_WEBHOOK_SECRET");
  if (isPlaceholder(secret)) throw new PublicAppError(503, "Resend webhook är inte konfigurerad ännu.");
  return secret;
}

export function resendApiKey(env: Env): string {
  requireEmailConfigured(env);
  return value(env, "RESEND_API_KEY");
}

export function emailFrom(env: Env): string {
  requireEmailConfigured(env);
  return value(env, "EMAIL_FROM");
}

export function emailFromName(env: Env): string {
  return value(env, "EMAIL_FROM_NAME") || "Webblyftet";
}

export function emailReplyTo(env: Env): string | undefined {
  const raw = value(env, "EMAIL_REPLY_TO");
  return isPlaceholder(raw) ? undefined : raw || undefined;
}

export function adminAlertEmail(env: Env): string {
  return value(env, "ADMIN_ALERT_EMAIL");
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

export function emailAutoSendEnabled(env: Env): boolean {
  const raw = value(env, "ENABLE_EMAIL_AUTOSEND").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return env.APP_ENV !== "local";
}

export function validateProductionGuards(env: Env): void {
  if (env.APP_ENV !== "production") return;
  const problems: string[] = [];
  if (startsWith(value(env, "STRIPE_SECRET_KEY"), "sk_test_")) problems.push("Stripe test secret key");
  if (startsWith(value(env, "STRIPE_PUBLISHABLE_KEY"), "pk_test_")) problems.push("Stripe test publishable key");
  if (value(env, "EMAIL_FROM").toLowerCase() === "onboarding@resend.dev") problems.push("Resend onboarding sender");
  if (value(env, "APP_BASE_URL").includes("workers.dev") || isPlaceholder(value(env, "APP_BASE_URL"))) problems.push("production base URL");
  if (isPlaceholder(value(env, "CF_ACCESS_TEAM_DOMAIN")) || isPlaceholder(value(env, "CF_ACCESS_AUD"))) problems.push("Cloudflare Access config");
  if (isPlaceholder(value(env, "ADMIN_EMAILS")) || isPlaceholder(value(env, "FINANCE_EMAILS"))) problems.push("authorization groups");
  if (isPlaceholder(value(env, "ADMIN_ALERT_EMAIL"))) problems.push("admin alert email");
  const companyFields = [
    "WEBBLYFTET_LEGAL_NAME",
    "WEBBLYFTET_ORG_NUMBER",
    "WEBBLYFTET_VAT_NUMBER",
    "WEBBLYFTET_ADDRESS1",
    "WEBBLYFTET_BANKGIRO"
  ];
  for (const field of companyFields) {
    const configured = value(env, field);
    if (!configured || /demo|test|example|559999|000-0000/i.test(configured)) problems.push(field);
  }
  if (problems.length) {
    throw new PublicAppError(500, `Production config blockerad: ${problems.join(", ")}.`);
  }
}
