# Data Inventory And Retention

Detta är en teknisk foundation, inte juridisk rådgivning.

## Persondata och syfte

- `customers`: företagskontakt, e-post, telefon, adress. Behövs för offert, faktura och integrationer.
- `contract_flows`: säljflödets draft, kontaktuppgifter och status. Behövs för operativ avtalskedja.
- `offers`, `offer_versions`, `offer_acceptances`: offertdata, signer/acceptansmetadata och immutable snapshots. Behövs för avtalsspårbarhet.
- `customer_order_sessions`: publik tokenhash, krypterad recoverable token, snapshot, signer, status. Behövs för kundresan och audit.
- `invoices`, `invoice_rows`, `invoice_document_tokens`: fakturadata och säkra dokumentlänkar. Behövs för fakturering.
- `outbound_email_events`, `email_provider_events`: mottagare, provider message id, delivery-state, webhook history. Behövs för leveransbevis och felsökning.
- `receipts`: filmetadata och R2-nycklar. Själva filen ligger i privat R2.
- `audit_log`, `sync_log`, `operational_events`: händelser och felsökningsmetadata. Secrets ska vara redigerade innan lagring.

## Retentionprincip

- Bokförings-/fakturaunderlag: radera inte aggressivt; följ svensk bokförings- och avtalsretention.
- Operational logs: kortare retention, exempelvis 90-180 dagar i test och 180-365 dagar i produktion beroende på incidentbehov.
- Expired customer-order sessions: behåll hash/status/audit, men rensa krypterat tokenmaterial efter expiry plus rimlig grace period.
- Invoice document tokens: hög entropi, tidsbegränsade och kan roteras utan att fakturan raderas.
- Email provider payloads: lagra bara sanerad payload och radera/komprimera äldre payloads när delivery outcome är fastställd.
- Receipts/R2: ska behandlas som ekonomiskt underlag och ska inte raderas utan retentionbeslut.

## Cleanup-strategi

En framtida schemalagd Worker bör köra idempotenta jobb:

1. Nolla `customer_order_sessions.public_token_enc` för länkar som varit expired längre än retention grace.
2. Radera expired `invoice_document_tokens`.
3. Rensa gamla `email_provider_events.payload_json` men behåll eventtyp, timestamps och provider ids.
4. Stäng eller arkivera lösta `operational_events`.

## GDPR export

En kundexport behöver samla records från:

- customer
- contract flows
- offers och versionssnapshots
- sales orders
- invoices och rows
- subscriptions
- payments och payment methods med maskerad kortdata
- customer-order sessions
- outbound email events
- receipts metadata
- audit/sync/operational logs där kunden eller dokumentet refereras

## GDPR anonymisering

Bygg inte en brutal customer delete som förstör faktura- eller bokföringsunderlag. Rätt modell är en framtida `anonymizeCustomerWhereLegallyAllowed()` som:

- behåller faktura-/bokföringsunderlag som måste sparas
- maskerar kontaktdata där retention inte längre krävs
- bevarar audit-kedja med minimerad persondata
- inte ändrar monetära/legal records
