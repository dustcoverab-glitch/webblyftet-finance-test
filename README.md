# Webblyftet Finance Test

Separat testprojekt för Webblyftets ekonomiportal. Tanken är att användaren arbetar i Webblyftets UI medan Fortnox är ekonomisk system-of-record.

## Ingår

- Cloudflare Worker backend
- React/Vite frontend
- D1 för lokal metadata och synkstatus
- R2 för kvitton/underlag
- Fortnox OAuth2 Authorization Code Flow med service account
- Krypterad tokenlagring (AES-GCM)
- Kundregister + push/pull mot Fortnox
- Offertskapande + synk till Fortnox
- Offertacceptans med tokenbaserad audit trail
- Offert → faktura via Fortnox
- Fakturasynk och betalstatus
- Kvitto-/underlagsuppladdning
- Leverantörsfakturor från Fortnox
- Verifikationsvy från Fortnox
- API/synklogg
- Testmiljömarkering

## Viktig arkitektur

Fortnox är system of record för:
- kundfakturor
- bokföring/verifikationer
- leverantörsfakturor
- betalstatus

Webblyftet äger:
- UI
- workflow
- lokal metadata
- offertacceptans
- interna anteckningar
- R2-underlag
- integrationslogg

Bygg INTE parallell juridisk bokföring i D1.

## 1. Förutsättningar

- Node 20+
- Cloudflare-konto
- Fortnox Developer Portal
- Fortnox-moduler/licenser för de resurser/scopes som ska användas

## 2. Fortnox Developer Portal

Skapa integration: `Webblyftet Finance Test`.

Redirect URI lokalt:
`http://localhost:8787/auth/fortnox/callback`

Redirect URI efter deploy:
`https://DIN-TESTDOMAN/auth/fortnox/callback`

Scopes i `wrangler.jsonc`:
`companyinformation customer invoice offer order payment supplier supplierinvoice bookkeeping inbox connectfile settings print`

Använd bara scopes ni faktiskt har licens för.

## 3. Cloudflare setup

```bash
npm install
npx wrangler login

npx wrangler d1 create webblyftet-finance-test
# Kopiera database_id till wrangler.jsonc

npx wrangler r2 bucket create webblyftet-finance-test-receipts

npm run db:migrate:local
npm run cf-types
```

Skapa `.dev.vars` från `.dev.vars.example`.

Generera krypteringsnyckel:
```bash
openssl rand -base64 32
```

Lokal utveckling körs enklast i två terminaler:

Terminal A:
```bash
npm run build
npm run dev:worker
```

Terminal B, om du vill ha Vite HMR:
```bash
npm run dev
```

Vite proxar `/api`, `/auth`, `/sign` till Worker på port 8787.

## 4. Worker secrets inför deploy

```bash
npx wrangler secret put FORTNOX_CLIENT_ID
npx wrangler secret put FORTNOX_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY_BASE64
npx wrangler secret put ADMIN_API_KEY
```

Uppdatera `APP_BASE_URL` till testdomänen.

Migrera och deploya:
```bash
npm run db:migrate:remote
npm run deploy
```

## 5. Testordning

1. Öppna `/integration`
2. Anslut Fortnox
3. Hämta kunder
4. Skapa testkund
5. Synka kund
6. Skapa offert
7. Synka offert
8. Skapa signeringslänk
9. Acceptera offerten
10. Skapa faktura från offerten
11. Hämta fakturor och verifiera status
12. Ladda upp kvitto
13. Hämta leverantörsfakturor
14. Hämta verifikationer

## Ej produktionsklart ännu

### Fortnox Inbox-upload
`POST /api/receipts/:id/push-inbox` är medvetet avstängd med HTTP 501 tills Codex verifierat aktuell multipart-specifikation mot Fortnox OpenAPI. Detta är bättre än att gissa på ett filuppladdningskontrakt.

### BankID
Offertacceptansen i denna scaffold är en enkel elektronisk acceptans med audit trail:
- namn
- e-post
- timestamp
- IP
- user-agent
- one-time token

Det är INTE BankID eller kvalificerad elektronisk signatur. Koppla BankID/e-sign-provider separat om det krävs.

### Autentisering
I `APP_ENV=test` är API:t öppet för att snabbt få sandboxen att fungera. Innan produktion:
- lägg Cloudflare Access framför hela testsidan, eller
- implementera er befintliga portal-auth
- sätt `APP_ENV=production`

### Fortnox endpoint-kontrakt
Fortnox ändrar API-fält över tid. Codex ska läsa aktuell OpenAPI innan deploy och verifiera payloads för:
- Offers
- Create invoice from offer
- Supplier invoices
- Vouchers
- Inbox/file connections

## Datamodell

Se `migrations/0001_init.sql`.

## Säkerhet

- inga secrets i repo
- OAuth state med 10 min expiry
- access/refresh tokens krypteras AES-GCM
- R2-filer exponeras endast genom Worker route
- structured sync log
- separerad testdatabas och testbucket
