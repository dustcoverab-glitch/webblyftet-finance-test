# Production Release Checklist

## Cloudflare

- Separat production account/resursgrupp verifierad.
- Worker: `webblyftet-finance-production`.
- D1: `webblyftet-finance-production`.
- R2: `webblyftet-finance-production-receipts`.
- Custom domain satt och testad.
- Cloudflare Access application skyddar hela appen.
- Exakta webhook-bypass finns bara för Stripe och Resend.
- `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` och `REQUIRE_CLOUDFLARE_ACCESS=true` är korrekta.

## Secrets och config

- `TOKEN_ENCRYPTION_KEY_BASE64` genererad och satt som Worker secret.
- `STRIPE_SECRET_KEY` är live key i production.
- `STRIPE_WEBHOOK_SECRET` matchar live webhook endpoint.
- `FORTNOX_CLIENT_ID` och `FORTNOX_CLIENT_SECRET` är production integration.
- `RESEND_API_KEY` och `RESEND_WEBHOOK_SECRET` är production secrets.
- `EMAIL_FROM` använder verifierad Webblyftet-domän, inte `onboarding@resend.dev`.
- Company data är skarp: legal name, org.nr, VAT, adress, bankgiro/IBAN/BIC.
- `BASIC_ACCEPTANCE` presenteras inte som BankID eller kvalificerad signatur.
- `ADMIN_ALERT_EMAIL` går till bevakad ekonomiadress.

## Provider setup

- Stripe live webhook prenumererar bara på events appen hanterar.
- Stripe product/price strategi för live är beslutad.
- Fortnox redirect URI matchar production `APP_BASE_URL`.
- Fortnox tenant är korrekt ansluten.
- Resend-domän är verifierad med SPF/DKIM/return-path enligt Resend.
- Resend webhook är konfigurerad till `POST /webhooks/resend`.

## Release gate

Kör:

```bash
pnpm release:check
```

`pnpm release:check` kör migrationscheck, typecheck, full testsuite, build och Wrangler dry-run. Branch protection på `main` bör kräva grön CI innan merge.

Innan migration:

```bash
npx wrangler d1 backup create webblyftet-finance-production
npx wrangler d1 export webblyftet-finance-production --remote --output=./backups/webblyftet-finance-production-YYYYMMDD.sql
```

Efter deploy:

- Health/API smoke med giltig Access-session.
- Public customer-order deep link smoke utan Access.
- `/api/*` skyddas av Access.
- Stripe webhook invalid signature nekas.
- Resend webhook invalid signature nekas.
- Låg-risk testtransaction i live endast efter separat godkännande.
- Fortnox sync smoke på kontrollerad production-testpost först efter separat godkännande.

## Rollback

- Dokumentera föregående Worker Version ID.
- Ha senaste D1 backup/export innan migration.
- Rollbacka Worker först om felet är runtime/UI.
- Återställ D1 endast vid bekräftad datakorruption och efter ny backup av nuvarande läge.
