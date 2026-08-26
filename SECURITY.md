# Finance Test Security

Finance Test is a separate internal test application for Webblyftet Finance. It must never share Cloudflare bindings, databases, buckets, provider credentials, or domains with `webblyftet-portal`.

## Architecture

- Cloudflare Worker serves the React UI, same-origin API, Stripe webhook endpoint, Fortnox OAuth callback, and authenticated R2 receipt downloads.
- D1 stores Finance Core records, integration mappings, encrypted Fortnox tokens, sync logs, audit logs, webhook claims, and local rate-limit buckets.
- R2 stores receipt and supplier-document files. The bucket must remain private; files are read through authenticated Worker routes only.
- Stripe is test mode only for this environment.
- Fortnox is sandbox/test environment only for this environment.

## Threat Model

### High

- Unauthorized API access to customers, invoices, payments, subscriptions, R2 files, or sync actions.
- Spoofed Cloudflare Access identity headers if JWTs are not verified.
- Stripe webhook spoofing or replay causing false payment/accounting records.
- Secret leakage in source, D1 logs, console logs, or provider payload snapshots.
- R2 file exposure or inline execution of uploaded HTML/SVG-like content.
- Test/prod cross-contamination, especially live Stripe keys or production Cloudflare resources in test.

### Medium

- CSRF against mutating same-origin endpoints while Cloudflare Access is the browser auth layer.
- IDOR across internal object IDs if Access is not applied consistently.
- Mass creation or abuse of D1/R2/Stripe/Fortnox calls on Workers Free.
- OAuth state replay or redirect manipulation.
- Accidental destructive actions such as disconnect/cancel triggered without explicit POST.

### Low

- UI XSS from customer, offer, invoice, audit, or provider text when React escaping is bypassed.
- Clickjacking or referrer leakage.
- Dependency vulnerabilities in frontend/build tooling that do not affect Worker runtime.

## Cloudflare Access Requirements

Finance Test test deploy must use Cloudflare Access in front of the whole Worker application.

Required Worker vars for `env.test`:

- `REQUIRE_CLOUDFLARE_ACCESS=true`
- `CF_ACCESS_TEAM_DOMAIN=<your-team-name>.cloudflareaccess.com`
- `CF_ACCESS_AUD=<Application Audience AUD tag>`

The Worker validates `Cf-Access-Jwt-Assertion` cryptographically against:

`https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`

A spoofed `cf-access-authenticated-user-email` header is not accepted.

### Required Access Policies

Create two Access applications or equivalent ordered policies:

1. Protected Finance Test app
   - Hostname: `webblyftet-finance-test.webblyftet-finance-test.workers.dev`
   - Path: `/*`
   - Policy: allow only approved internal users.
   - Copy the Application Audience (AUD) tag into `CF_ACCESS_AUD`.

2. Exact Stripe webhook bypass
   - Hostname: `webblyftet-finance-test.webblyftet-finance-test.workers.dev`
   - Path: `/webhooks/stripe`
   - Policy/action: bypass or service-auth pattern that allows Stripe to POST.
   - Do not bypass `/webhooks/stripe/*`, `/webhooks/stripe-test`, or any other route.

Cloudflare Dashboard click path:

1. Zero Trust > Access > Applications.
2. Add an application > Self-hosted.
3. Add the workers.dev hostname.
4. Add the internal allow policy for `/*`.
5. Add a separate exact-path bypass for `/webhooks/stripe`.
6. Open the protected app settings and copy the Application Audience (AUD) tag.
7. Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.jsonc` or as environment vars, then redeploy.

3. Exact Resend webhook bypass
   - Hostname: `webblyftet-finance-test.webblyftet-finance-test.workers.dev`
   - Path: `/webhooks/resend`
   - Policy/action: bypass so Resend can POST webhooks.
   - Do not bypass `/webhooks/resend/*`, `/api/*`, `/assets/*`, or `/`.

## CSRF

Mutating browser endpoints require same-origin `Origin` or `Referer` when Cloudflare Access is required. Stripe webhook is excluded and uses Stripe signature verification instead.

## Stripe Safety

- `APP_ENV=test` rejects `sk_live_` and `pk_live_` keys.
- Stripe webhook signatures are verified against the raw body.
- Stripe webhook path bypass is exact: only `POST /webhooks/stripe` is public.
- Webhook events are claimed atomically for idempotency.
- Subscription accounting remains canonical on `invoice.paid`.
- Stripe client secrets are redacted from stored integration payloads and logs.
- Raw card data, PAN, or CVC must never pass through Worker or D1.

## Fortnox Safety

- OAuth state is one-time and expires.
- Redirect URI is derived from `APP_BASE_URL` and must equal:
  `https://webblyftet-finance-test.webblyftet-finance-test.workers.dev/auth/fortnox/callback`
- Fortnox tokens are encrypted with AES-GCM using `TOKEN_ENCRYPTION_KEY_BASE64`.
- Fortnox access tokens, refresh tokens, client secret, and Authorization headers are redacted before sync-log storage.
- The current API does not expose a robust sandbox/prod flag in a way this app can safely enforce without heuristics. Keep Fortnox sandbox separation operationally enforced through Developer Portal/test credentials until a reliable provider signal is available.

## Secrets Policy

Never commit:

- `.dev.vars`
- `TOKEN_ENCRYPTION_KEY_BASE64`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `FORTNOX_CLIENT_SECRET`
- access tokens, refresh tokens, API tokens, cookies, or OAuth codes.

Rotation procedure:

1. Rotate provider secret in Stripe/Fortnox/Cloudflare.
2. Update Cloudflare Worker secret with `wrangler secret put --env test`.
3. Redeploy.
4. Invalidate old webhook/OAuth/token material in the provider dashboard.
5. Check `sync_log`, `integration_events`, and `audit_log` for unexpected secret fragments.

## R2 Receipts

- R2 bucket must not be public.
- Downloads must go through `/api/receipts/:id/file` behind Cloudflare Access.
- Receipt upload allows only PDF, JPEG, PNG, and TIFF.
- Max receipt upload defaults to `10485760` bytes.
- Downloads use `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`.

## Before Production

- Use separate production D1, R2, Worker name, Access application, domain, Stripe account/mode, webhook endpoint, and Fortnox integration.
- Replace production placeholders in `wrangler.jsonc`.
- Enable Cloudflare Access for production before any real data.
- Verify production AUD/team domain.
- Run full tests, build, Wrangler dry-run, migrations, and a deployment smoke test.
- Review dependency audit and upgrade non-breaking vulnerable packages.
- Run a final secret scan before push/deploy.
- Production startup fails closed on obvious demo/test config: Stripe test keys, `onboarding@resend.dev`, placeholder Access config, placeholder auth groups, placeholder app URL, or demo company/payment details.
