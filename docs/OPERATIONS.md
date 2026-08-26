# Finance Test Operations

Finance Test ska köras som en separat miljö med egna Cloudflare-, Stripe-, Fortnox- och Resend-resurser. Rör inte huvudportalen eller dess bindings.

## Före produktionsmigration

1. Bekräfta konto och resursnamn med `wrangler whoami`.
2. Kör full verifiering: `pnpm release:check`.
3. Skapa D1 backup/export.
4. Kontrollera att migrations bara riktas mot avsedd D1.
5. Dokumentera rollbackpunkt, Worker version och senaste commit.

Cloudflare D1 har native backup/restore. Cloudflares dokumentation beskriver manuell backup med:

```bash
npx wrangler d1 backup create <DATABASE_NAME>
```

För SQL-export:

```bash
npx wrangler d1 export <DATABASE_NAME> --remote --output=./backups/<DATABASE_NAME>-YYYYMMDD.sql
```

För Time Travel-kapabla D1-databaser:

```bash
npx wrangler d1 time-travel info <DATABASE_NAME>
npx wrangler d1 time-travel restore <DATABASE_NAME> --bookmark=<BOOKMARK>
```

Skapa alltid en ny backup/export innan restore eftersom restore skriver över databasen.

## Misslyckad migration

1. Stoppa nya deployer.
2. Om dataskrivningar riskerar skada, stäng av skrivande UI/actioner via Access eller feature flag.
3. Jämför migrationens fel mot aktuell remote schema.
4. Återställ från D1 backup/Time Travel endast efter att konsekvensen är förstådd.
5. Deploya korrigerad migration i ny commit. Ändra inte gamla migrationer.

## R2 recovery

R2 är objektlagring med hög durability, men prefix är bara namnkonventioner. Aktivera bucket-level versioning/lifecycle enligt Cloudflares aktuella funktioner innan produktion om återställning av oavsiktligt raderade objekt krävs. Ha separat rutin för att exportera viktiga receipt/provider mappings från D1 eftersom R2-objekt utan D1-mapping är svåra att hitta operativt.

## Provider outage

Stripe:
- Behandla `invoice.paid` som canonical för recurring accounting.
- Retry webhook processing är idempotent via provider event claim.
- Vid Stripe outage: skapa inte manuella accounting events.

Fortnox:
- Fortnox är redovisningsadapter.
- Vid sync-fel: lämna lokal mapping oförändrad och använd recovery/idempotency innan nytt POST.
- Vid auth-fel: kontrollera sandbox/production tenant och OAuth/service account.

Resend:
- `SENT` betyder provider accepted, `DELIVERED` kräver verifierad webhook.
- Bounce/complaint ska följas upp innan fler mail till samma mottagare.
- Webhook replay ska inte skapa alert-flood.

## Operational events

Följande ska skapa operational events med dedupe:

- Stripe webhook critical failure: `ERROR`
- Stripe payment failure: `WARNING`/`ERROR` enligt flöde
- Fortnox sync/auth failure: `ERROR`
- Resend send failure: `ERROR`
- Resend bounce: `ERROR`
- Resend complaint: `CRITICAL`
- Resend delivery delayed: `WARNING`
- Worker unhandled exception: `ERROR`

`operational_events` har `status`, `resolved_at` och `acknowledged_at` för framtida dashboard/alerting.

Pass 5 alert channel:

- `CRITICAL` operational events ska lämna databasen via Resend till `ADMIN_ALERT_EMAIL` när email provider är konfigurerad.
- Repeated `STRIPE_PAYMENT_FAILED` notifieras först när samma öppna dedupe-key har inträffat minst två gånger.
- Om alertkanalen saknar recipient/provider sparas en `NOOP`/`SKIPPED` notification row. Det är acceptabelt i local/test men inte production.
- Alertpayload får inte innehålla Authorization headers, tokens, client secrets eller filinnehåll.

## Backup/restore drill

Kör:

```bash
pnpm run backup:drill webblyftet-finance-test webblyftet-finance-test-receipts
```

Scriptet skriver ut kommandon och checklistor men exekverar inte destructive restore. Vid riktig restore:

1. Skapa backup/export av nuvarande läge först.
2. Återställ bara efter incidentbeslut.
3. Validera D1-tabeller, R2 receipt mappings, Stripe/Fortnox provider references och customer-order public routes.
4. Dokumentera backup-id/exportfil, commit SHA och Worker Version ID.

## D1 migration 0012 preflight

Remote D1 kör Wrangler migration batches transaktionellt. Den låsta
`0012_contract_acceptance_semantics.sql` bygger om `sales_orders`, men äldre
testdatabaser kan redan ha beroende foreign keys från `sales_order_items`,
`customer_order_sessions` och `contract_flows`. När `0012` fortfarande är
pending ska detta köras en gång, efter D1-export och före vanlig migration:

```bash
pnpm run db:preflight:0012:test
pnpm run db:migrate:test
```

Preflighten bevarar rader och tar temporärt bort endast de beroende FK:er som
blockerar den låsta rebuilden. `0016_restore_sales_order_foreign_keys.sql`
återställer FK:erna efter `0012`-`0015` och verifieras med
`PRAGMA foreign_key_check`.

## Avtal och arkiv

`BASIC_ACCEPTANCE` är enkel testsignering. Det arkiverbara underlaget ska vara signed snapshot + hash + terms version + signer + timestamp + provider/reference. Riktig production-signering med BankID och PDF/A-liknande långtidsarkiv är separat scope.
