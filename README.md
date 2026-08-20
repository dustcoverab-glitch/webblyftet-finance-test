# Webblyftet Finance Test

Separat testprojekt för Webblyftets ekonomiportal. Projektet ska hållas helt fristående från `webblyftet-portal` och använder egna Cloudflare-resurser för Worker, D1, R2 och testdomän.

## Arkitekturprincip

Webblyftet Finance äger affärslogiken. Fortnox är en extern redovisningsadapter, och Stripe är grunden för kortbetalningar och återkommande abonnemang. Finance Core ska därför modellera kunder, produkter, priser, offerter, abonnemang, fakturor, betalningar, accounting events och audit log utan att bädda in Fortnox response-format i core-logiken.

Integrationskod ligger under:

- `src/integrations/fortnox`
- `src/integrations/stripe`

## Ingår

- Cloudflare Worker backend
- React/Vite frontend
- D1 för lokal metadata och synkstatus
- R2 för kvitton/underlag
- Fortnox OAuth2 Authorization Code Flow med service account
- Fortnox client credentials-tokenflöde efter hämtad `tenantId`
- Stripe foundation med Customer, Product, Price, SetupIntent, Subscription och signerade webhooks
- Krypterad tokenlagring med AES-GCM
- Products, prices, subscriptions, payments, accounting events och audit log i Finance Core
- Kundregister + push/pull mot Fortnox
- Offertskapande + synk till Fortnox
- Offertacceptans med immutable offer version, hashad one-time-token och audit trail
- Accepterad offert till sales order, intern testfaktura och pending subscription
- Intern faktura till Fortnox-faktura via adapter
- Fakturasynk och betalstatus
- Kvitto-/underlagsuppladdning till Fortnox Inbox
- Leverantörsfakturor från Fortnox
- Verifikationsvy från Fortnox
- API/synklogg

## Viktig arkitektur

Fortnox är system of record för kundfakturor, bokföring/verifikationer, leverantörsfakturor och betalstatus. Webblyftet Finance Test äger UI, workflow, lokal metadata, offertacceptans, interna anteckningar, R2-underlag och integrationslogg.

Bygg inte parallell juridisk bokföring i D1.

## Förutsättningar

- Node 20+
- Cloudflare-konto
- Fortnox Developer Portal
- Fortnox-moduler/licenser för de resurser/scopes som ska testas

## Lokal utveckling

```bash
npm install
npm run cf-types
cp .dev.vars.example .dev.vars
```

Skapa en lokal krypteringsnyckel:

```bash
openssl rand -base64 32
```

Fyll i `.dev.vars` lokalt. Filen är gitignored och får aldrig committas.

Lokal utveckling tillåts utan Cloudflare Access när `APP_ENV=local`.

```bash
npm run build
npm run dev:worker
```

Valfritt för Vite HMR:

```bash
npm run dev
```

Vite proxar `/api`, `/auth` och `/sign` till Worker på port 8787.

## Cloudflare-resurser

`wrangler.jsonc` är source of truth.

Local:
- Worker: `webblyftet-finance-test-local`
- D1: `webblyftet-finance-test-local`
- R2: `webblyftet-finance-test-local-receipts`

Test:
- Worker: `webblyftet-finance-test`
- D1: `webblyftet-finance-test`
- R2: `webblyftet-finance-test-receipts`

Framtida production:
- Worker: `webblyftet-finance-production`
- D1: `webblyftet-finance-production`
- R2: `webblyftet-finance-production-receipts`

Skapa resurserna separat och kopiera respektive `database_id` till rätt miljö i `wrangler.jsonc`.

```bash
npx wrangler d1 create webblyftet-finance-test-local
npx wrangler d1 create webblyftet-finance-test
npx wrangler r2 bucket create webblyftet-finance-test-local-receipts
npx wrangler r2 bucket create webblyftet-finance-test-receipts
```

## Secrets

Required secrets deklareras i `wrangler.jsonc`:

- `FORTNOX_CLIENT_ID`
- `FORTNOX_CLIENT_SECRET`
- `TOKEN_ENCRYPTION_KEY_BASE64`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Sätt dem per miljö. Exempel för test:

```bash
npx wrangler secret put FORTNOX_CLIENT_ID --env test
npx wrangler secret put FORTNOX_CLIENT_SECRET --env test
npx wrangler secret put TOKEN_ENCRYPTION_KEY_BASE64 --env test
npx wrangler secret put STRIPE_SECRET_KEY --env test
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env test
```

Inga secrets skickas till frontend. Browsern autentiseras inte med `x-admin-api-key`; deployad testmiljö ska skyddas med Cloudflare Access framför hela applikationen.

## Cloudflare Access

För deployad test/staging ska Cloudflare Access ligga framför hela testsidan.

1. Skapa en Access application i Cloudflare Zero Trust för testdomänen, till exempel `finance-test.example.se`.
2. Sätt applikationens policy till de användare/grupper som får testa Finance Test.
3. Skydda hela origin/appens path, inte bara `/api`.
4. Se till att Worker-routen pekar på den separata test-Workern `webblyftet-finance-test`.
5. Behåll `APP_ENV=test` i testmiljön.

Workern kräver Cloudflare Access identity headers när `APP_ENV` inte är `local`. Saknas Access-header får klienten HTTP 403 med ett neutralt fel. Lokalt utvecklingsläge är undantaget för att `wrangler dev` ska fungera utan Access.

Enda publika route-undantaget är exakt:

```text
POST /webhooks/stripe
```

Den routen får vara publik för Stripe, men verifierar alltid `Stripe-Signature` mot `STRIPE_WEBHOOK_SECRET` innan något event behandlas.
Närliggande paths som `/webhooks/stripe/foo` och `/webhooks/stripe-test` ska fortsätta ligga bakom Cloudflare Access.

## Fortnox Developer Portal

Skapa integration: `Webblyftet Finance Test`.

Redirect URI lokalt:

```text
http://localhost:8787/auth/fortnox/callback
```

Redirect URI efter deploy:

```text
https://DIN-TESTDOMAN/auth/fortnox/callback
```

Redirect URI byggs konsekvent från `APP_BASE_URL` + `/auth/fortnox/callback`, så Fortnox-konfigurationen måste matcha exakt.

Scopes i `wrangler.jsonc`:

```text
companyinformation customer invoice offer order payment supplier supplierinvoice bookkeeping inbox connectfile settings print
```

Använd bara scopes ni faktiskt har licens för.

Fortnox service-account-flöde:

1. Kör initial OAuth authorization code med `account_type=service`.
2. Hämta och lagra `tenantId` via `companyinformation`.
3. När `tenantId` finns används Fortnox client credentials med `TenantId` för nya access tokens.
4. Refresh token behålls endast som kompatibilitetsfallback om client credentials inte fungerar.

## Stripe

Stripe SDK körs i Workers med `Stripe.createFetchHttpClient()`. Webhook-verifiering använder Stripes officiella webhook verifiering med raw body och SubtleCrypto-provider.

Implementerat nu:

- `GET /api/customers/:id`
- `POST /api/customers/:id/stripe-customer`
- `POST /api/customers/:id/payment-method/setup`
- `GET /api/stripe/config`
- `POST /api/products/:id/sync-stripe`
- `POST /api/prices/:id/sync-stripe`
- `POST /api/subscriptions/:id/activate`
- `POST /api/subscriptions/:id/cancel`
- `POST /webhooks/stripe`

SetupIntent används som backendgrund för att senare kunna registrera företagskort. Backend skapar en lokal `payment_method_setup_sessions`-rad och använder dess id som Stripe idempotency key. Retries för samma aktiva session återanvänder sparat Stripe SetupIntent ID, hämtar aktuell `client_secret` från Stripe och skapar inte parallella SetupIntents. `client_secret` sparas inte permanent i D1 och får aldrig loggas. Frontend får bara `client_secret` för Stripe-klientflödet. Råa kortnummer får aldrig passera Worker eller D1.

Förberedda webhook event-typer:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`

Frontendens `/payment-method/:customerId` använder Stripe.js Elements och `confirmCardSetup`. Det är endast ett testflöde för Stripe testmode. Råa kortnummer skickas direkt till Stripe från browsern och passerar inte Worker, D1, audit-log, integration-events eller sync-log.

Stripe webhooks lagras i `integration_events` med statusflödet `RECEIVED -> PROCESSING -> PROCESSED` eller `FAILED`. `PROCESSED` och pågående `PROCESSING` behandlas som dubbletter, medan `FAILED` och kvarlämnad `RECEIVED` får köras om. Webhookar för `customer.subscription.created|updated|deleted` uppdaterar bara befintliga lokala subscriptions via `stripe_subscription_id` eller metadata `webblyftet_subscription_id`; okända Stripe subscriptions skapar inte lokal core-data.

## Products, Prices och Subscriptions

Belopp i `prices`, `payments`, `subscription_items` och `accounting_events` sparas som integer i minsta valutaenhet, till exempel `29500` för 295 kr.

Subscription-rader valideras alltid mot aktiva products/prices innan några DB-skrivningar görs. Produkten måste vara `SUBSCRIPTION`, priset måste vara aktivt `RECURRING`, product/price måste matcha, quantity måste vara ett positivt heltal och alla rader måste ha samma valuta. Klienter får inte ange `unit_amount`; det snapshots alltid från vald price.

Betalningar accepterar bara explicita statusövergångar: `PENDING -> PROCESSING|FAILED`, `PROCESSING -> SUCCEEDED|FAILED`, `FAILED -> PROCESSING`, `SUCCEEDED -> PARTIALLY_REFUNDED|REFUNDED` och `PARTIALLY_REFUNDED -> REFUNDED`. Sena webhookar får därför inte skriva om `SUCCEEDED` till `FAILED`.

Accounting events som skapas från Stripe-betalningar markerar `payload_json.accounting_semantics = "SETTLEMENT"`, eftersom `net_amount=gross` och `vat_amount=0` beskriver betalningsavräkning och inte framtida försäljningsmoms.

## Offer Acceptance och Sales Orders

När en offert skickas för acceptans skapas en immutable rad i `offer_versions` med totals och rad-snapshot. Acceptlänken pekar på en specifik version via `offer_acceptance_tokens`, där endast hash av token sparas i D1. Tokens är one-time, har expiry och äldre oanvända länkar invalidieras när ny länk skapas.

När kunden accepterar:

1. `offer_acceptances` sparar exakt version, kund, signerande namn/e-post, IP, user-agent och `snapshot_hash`.
2. `sales_orders` och `sales_order_items` skapas idempotent från acceptansen.
3. `ONE_TIME`-rader skapar en intern testfaktura med `TEST-xxxxx`-nummer och minor-unit totals.
4. `RECURRING`-rader skapar en lokal subscription i `PENDING`.
5. `INVOICE_CREATED` accounting event skapas exakt en gång med `accounting_semantics = "SALE"`.

Fortnox-faktura skapas från den interna fakturan via `POST /api/invoices/:id/sync-fortnox`; Fortnox document number sparas tillbaka på invoice-raden. Stripe recurring-flödet skapas separat via `POST /api/subscriptions/:id/activate`.

## Stripe Subscriptions

Produkter och priser synkas från Finance Core till Stripe med lokala idempotency keys och metadata (`webblyftet_product_id`, `webblyftet_price_id`). Subscriptions aktiveras bara om lokal subscription finns, kunden har Stripe Customer och en aktiv lokal Stripe-betalmetod finns.

`invoice.paid` är canonical signal för lyckad återkommande debitering. Canonical Finance payment för recurring billing använder `provider = STRIPE` och `provider_payment_id = stripe_invoice_id`. PaymentIntent och charge-ID:n hör hemma på `payment_attempts`/metadata som diagnostik, inte som separata ekonomiska payments. Webhooken skapar/uppdaterar lokal payment, verifierar att lokal `payment.status === "SUCCEEDED"` och skapar sedan `SUBSCRIPTION_PAYMENT_RECEIVED` exakt en gång. `invoice.payment_failed` markerar subscription som `PAST_DUE` och skapar failed payment attempt utan känslig kortdata. Ett senare `invoice.paid` för samma Stripe-invoice får lyfta lokal payment från `FAILED -> PROCESSING -> SUCCEEDED`; sena failed-event får inte backa en lyckad payment.

`payment_intent.succeeded` skapar fortsatt `PAYMENT_RECEIVED` för fristående engångsbetalningar. Om PaymentIntent kan kopplas till en Stripe invoice/subscription uppdaterar den bara payment/payment_attempt-diagnostik och skapar inget generellt accounting event; `invoice.paid` får ensam skapa subscription accounting event.

Lokala testprodukter kan seedas från UI:t `Produkter & priser` eller via:

```bash
curl -X POST http://localhost:8787/api/products/seed-test
```

Seed är spärrad när `APP_ENV=production`.

## Deploy

```bash
npm run cf-types
npm run typecheck
npm test
npm run build
npm run db:migrate:test
npm run deploy
```

`deploy` deployar `--env test`. Production har separat kommando och separata bindings:

```bash
npm run deploy:production
```

## Testordning

1. Öppna `/integration` bakom Cloudflare Access
2. Öppna `/products` och skapa testprodukter
3. Öppna `/subscriptions` och verifiera subscriptions-vyn
4. Anslut Fortnox
5. Hämta kunder
6. Skapa testkund
7. Synka kund
8. Skapa testprodukter/priser och synka relevanta recurring prices till Stripe
9. Skapa offert med minst en engångsrad och en återkommande rad
10. Synka offert till Fortnox om Fortnox-offert ska jämföras
11. Skapa signeringslänk
12. Acceptera offerten via `/sign/:token`
13. Verifiera att sales order, intern invoice och pending subscription skapas
14. Synka intern invoice till Fortnox med `POST /api/invoices/:id/sync-fortnox`
15. Skapa Stripe Customer och registrera testkort via `/payment-method/:customerId`
16. Aktivera subscription och verifiera Stripe testmode-webhooks
17. Hämta fakturor och verifiera status
18. Ladda upp kvitto
19. Hämta leverantörsfakturor
20. Hämta verifikationer

Rör inte riktiga Fortnox-data i den här testmiljön.

## Säkerhet

- `.dev.vars` är gitignored
- inga secrets eller tokens i repo
- Cloudflare Access skyddar deployad test/staging
- inga credentials skickas till frontend
- OAuth state är one-time och rensas vid expiry
- callback visar neutral felsida vid fel
- access/refresh tokens krypteras AES-GCM
- Fortnox client credentials används långsiktigt efter `tenantId`
- Stripe webhook verifieras kryptografiskt med raw body och signing secret
- externa ekonomiska objekt skyddas med database constraints och provider-idempotency där stöd finns
- sync-loggar får request/sync-ID men inte Authorization headers eller tokens
- R2-filer exponeras endast genom Worker route
- signerade offertvärden HTML-escapas innan rendering

## Kvar innan skarp test

- Ersätt placeholder-D1-ID:n i `wrangler.jsonc`
- Skapa testdomän och Worker-route
- Konfigurera Cloudflare Access för testdomänen
- Sätt Cloudflare secrets i rätt miljö
- Lägg Fortnox redirect URI exakt enligt testdomänen
- Säkerställ Fortnox-licenser/scopes för alla endpoints som testas
- Skapa Stripe testmode webhook endpoint till `/webhooks/stripe`
- Sätt Stripe webhook secret från testmode-endpointen
