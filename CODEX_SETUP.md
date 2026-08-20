# CODEX HANDOFF — Webblyftet Finance Test

Du får ett färdigt separat Cloudflare-projekt för en Fortnox-backed ekonomiportal.

## Ditt uppdrag

Gör projektet körbart och deploya det som EN SEPARAT TESTSIDA. Ändra inte huvudportalen.

### Måste göras

1. Läs hela repot innan ändringar.
2. Kör `npm install`.
3. Kör `npm run typecheck`.
4. Läs aktuell Fortnox OpenAPI och verifiera alla använda endpoint paths + payload-fältnamn.
5. Läs aktuell Cloudflare Wrangler config schema.
6. Skapa/anslut separat D1 `webblyftet-finance-test`.
7. Skapa/anslut separat R2 `webblyftet-finance-test-receipts`.
8. Kör migrations.
9. Konfigurera Fortnox secrets via Wrangler secrets, aldrig i git.
10. Sätt korrekt `APP_BASE_URL` och Redirect URI i Fortnox Developer Portal.
11. Testa OAuth.
12. Testa kedjan:
   kund → Fortnox → offert → Fortnox → acceptans → faktura → fakturastatus.
13. Implementera Fortnox Inbox-upload för receipt route ENDAST efter att du verifierat aktuell OpenAPI/multipart-contract.
14. Lägg Cloudflare Access framför testsidan om det finns ett teamkonto tillgängligt. Annars lämna `APP_ENV=test` och markera tydligt att sidan inte får innehålla skarp ekonomidata.
15. Deploya separat. Ingen merge eller koppling till webblyftet-portal förrän testflödet är godkänt.

## Designkrav

Behåll befintlig design som bas:
- mörk grön/svart sidomeny
- varm ljus bakgrund
- tydlig TESTMILJÖ-markering
- professionell intern SaaS-känsla
- inga gradients
- inget generiskt "AI dashboard"-utseende
- responsiv desktop-first layout

## Funktionskrav

### Dashboard
- kunder
- offerter
- fakturor
- utestående
- Fortnox connection status
- senaste API-sync

### Kunder
- skapa lokalt
- sync till Fortnox
- pull från Fortnox
- visa Fortnox customer number

### Offerter
- skapa med rader, qty, pris, rabatt, moms
- sync till Fortnox
- signeringslänk
- acceptance audit trail
- convert offer → invoice

### Fakturor
- pull Fortnox
- status unpaid/paid/cancelled
- balance/due date

### Kvitton
- upload till R2
- metadata
- preview
- Fortnox Inbox-upload efter API-verifiering

### Leverantörsfakturor
- pull från Fortnox
- belopp, saldo, datum, leverantör

### Bokföring
- vouchers read view
- serie + financial-year ID
- Fortnox är system of record

## Fortnox scopes

Utgå från:
`companyinformation customer invoice offer order payment supplier supplierinvoice bookkeeping inbox connectfile settings print`

Ta bort scopes som bolagets Fortnox-licens inte medger. Fortnox scopes ger både läs- och skrivåtkomst för resursen.

## Säkerhet

- använd inte localStorage för Fortnox tokens
- logga aldrig token eller client secret
- secrets via Wrangler
- token encryption key måste vara 32 bytes
- använd OAuth state
- sanitera filnamn
- begränsa filstorlek och MIME
- skydda produktion med auth
- D1/R2 måste vara separerade från huvudsystemet

## Definition of done

Projektet är klart när:
- typecheck/build går igenom
- testdomänen laddar
- Fortnox kan connect/disconnect
- kund kan synkas åt båda håll
- offert kan skapas och synkas
- offert kan accepteras
- faktura kan skapas från offert och senare synkas till betaldstatus
- kvitto kan laddas upp och visas
- supplier invoices kan hämtas
- vouchers kan hämtas
- sync-logg visar anrop och fel utan secrets
- inga produktionsdata har påverkats
