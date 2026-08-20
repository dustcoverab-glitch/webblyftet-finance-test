import { describe, expect, it } from "vitest";
import { toFortnoxCustomerPayload } from "../src/integrations/fortnox/customers";
import { toFortnoxOfferPayload } from "../src/integrations/fortnox/offers";

describe("Fortnox adapter mapping", () => {
  it("maps Finance Core customer shape to Fortnox customer payload", () => {
    expect(toFortnoxCustomerPayload({
      name: "Acme AB",
      org_number: "559000-0000",
      email: "finance@example.com",
      country: "SE"
    })).toEqual({
      Customer: {
        Name: "Acme AB",
        OrganisationNumber: "559000-0000",
        Email: "finance@example.com",
        CountryCode: "SE"
      }
    });
  });

  it("maps offers without leaking Fortnox response format into callers", () => {
    expect(toFortnoxOfferPayload("1", {
      offer_date: "2026-08-20",
      rows: [{
        description: "Webblyftet Bas",
        quantity: 1,
        unit_price: 7995,
        discount_percent: 0,
        vat_percent: 25
      }]
    }).Offer.OfferRows[0]).toMatchObject({
      Description: "Webblyftet Bas",
      DeliveredQuantity: 1,
      Price: 7995,
      VAT: 25
    });
  });
});
