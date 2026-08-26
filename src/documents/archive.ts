import { PublicAppError } from "../lib/app-error";
import { one } from "../lib/db";

export type ContractArchiveEvidence = {
  provider: "BASIC_ACCEPTANCE";
  session_id: string;
  sales_order_id: string;
  customer_id: string;
  signer_name: string;
  signer_email: string;
  signed_at: string;
  document_hash: string;
  terms_version: string | null;
  offer_id: string | null;
  offer_version_id: string | null;
  evidence_reference: string | null;
  snapshot: unknown;
};

export async function buildContractArchiveEvidence(env: Env, customerOrderSessionId: string): Promise<ContractArchiveEvidence> {
  const session = await one<any>(
    env.DB,
    `SELECT cos.*, so.offer_id, so.offer_version_id
     FROM customer_order_sessions cos
     LEFT JOIN sales_orders so ON so.id=cos.sales_order_id
     WHERE cos.id=?`,
    customerOrderSessionId
  );
  if (!session) throw new PublicAppError(404, "Kundorder-session saknas.");
  if (!session.signed_at || !session.signing_snapshot_json || !session.document_hash) {
    throw new PublicAppError(409, "Avtalet är inte signerat och kan inte arkiveras ännu.");
  }
  const snapshot = JSON.parse(session.signing_snapshot_json);
  return {
    provider: "BASIC_ACCEPTANCE",
    session_id: session.id,
    sales_order_id: session.sales_order_id,
    customer_id: session.customer_id,
    signer_name: session.signer_name ?? "",
    signer_email: session.signer_email ?? "",
    signed_at: session.signed_at,
    document_hash: session.document_hash,
    terms_version: snapshot?.offer?.terms_version ?? null,
    offer_id: session.offer_id ?? snapshot?.offer?.id ?? null,
    offer_version_id: session.offer_version_id ?? snapshot?.offer?.version_id ?? null,
    evidence_reference: session.evidence_reference ?? null,
    snapshot
  };
}

export function renderContractArchiveHtml(evidence: ContractArchiveEvidence): string {
  const escape = (value: unknown) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="sv">
<head><meta charset="utf-8"><title>Arkiverat avtal ${escape(evidence.sales_order_id)}</title></head>
<body>
  <h1>Arkiverat avtal</h1>
  <dl>
    <dt>Signeringsprovider</dt><dd>${escape(evidence.provider)}</dd>
    <dt>Signerare</dt><dd>${escape(evidence.signer_name)} &lt;${escape(evidence.signer_email)}&gt;</dd>
    <dt>Signerad</dt><dd>${escape(evidence.signed_at)}</dd>
    <dt>Dokumenthash</dt><dd><code>${escape(evidence.document_hash)}</code></dd>
    <dt>Villkorsversion</dt><dd>${escape(evidence.terms_version)}</dd>
    <dt>Order</dt><dd>${escape(evidence.sales_order_id)}</dd>
    <dt>Session</dt><dd>${escape(evidence.session_id)}</dd>
  </dl>
  <h2>Signerad snapshot</h2>
  <pre>${escape(JSON.stringify(evidence.snapshot, null, 2))}</pre>
</body>
</html>`;
}
