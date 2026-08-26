import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createOffer, createOfferAcceptanceToken, acceptOfferToken } from "../src/core/business-flow";
import { createCustomerOrderSession, signCustomerOrder } from "../src/core/customer-order";
import { buildContractArchiveEvidence, renderContractArchiveHtml } from "../src/documents/archive";
import { resetTables, workerEnv } from "./helpers";

describe("archiveable contract evidence", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("captures basic acceptance evidence against the exact signed snapshot", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email) VALUES (?,?,?)")
      .bind("cus_archive", "Archive AB", "buyer@example.test")
      .run();
    const offer = await createOffer(workerEnv(), {
      customer_id: "cus_archive",
      title: "Arkiverbart testavtal",
      offer_date: "2026-08-26",
      rows: [{ description: "Projekt", quantity: 1, unit_price_minor: 100000, vat_percent: 25 }]
    });
    const offerToken = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    const order = await acceptOfferToken(workerEnv(), {
      token: offerToken.token,
      accepted_by_name: "Seller",
      accepted_by_email: "seller@example.test"
    });
    const link = await createCustomerOrderSession(workerEnv(), order!.id);
    const token = link.url.split("/customer-order/")[1];
    await signCustomerOrder(workerEnv(), token, {
      signer_name: "Kund Signerare",
      signer_email: "buyer@example.test",
      ip_address: "203.0.113.44",
      user_agent: "vitest"
    });

    const evidence = await buildContractArchiveEvidence(workerEnv(), link.id);
    expect(evidence).toMatchObject({
      provider: "BASIC_ACCEPTANCE",
      session_id: link.id,
      sales_order_id: order!.id,
      signer_name: "Kund Signerare",
      signer_email: "buyer@example.test",
      offer_id: offer!.id
    });
    expect(evidence.document_hash).toHaveLength(64);
    expect(evidence.terms_version).toBeTruthy();
    expect(renderContractArchiveHtml(evidence)).toContain("Arkiverat avtal");
  });
});
