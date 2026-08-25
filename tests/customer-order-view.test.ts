import { describe, expect, it } from "vitest";
import {
  classifyCustomerOrderLoadError,
  customerOrderRenderFallbackCopy,
  normalizeCustomerOrderView
} from "../src/customer-order/view-model";

describe("Customer order public view model", () => {
  it("normalizes optional null fields without throwing", () => {
    const view = normalizeCustomerOrderView({
      status: "CREATED",
      document_hash: null,
      snapshot: null,
      requirements: null,
      invoices: null,
      subscriptions: null,
      payment_method: null
    });

    expect(view.customer).toEqual({});
    expect(view.offer).toEqual({});
    expect(view.totals).toEqual({});
    expect(view.oneTimeRows).toEqual([]);
    expect(view.recurringRows).toEqual([]);
    expect(view.invoices).toEqual([]);
    expect(view.subscriptions).toEqual([]);
    expect(view.documentHash).toBe("");
    expect(view.requirements).toEqual({
      signing_required: true,
      payment_method_required: false,
      activation_required: true
    });
  });

  it("keeps recurring payment requirements when requirements are missing", () => {
    const view = normalizeCustomerOrderView({
      snapshot: {
        rows: [{ id: "row_1", billing_type: "RECURRING", quantity: 1, unit_price_minor: 10000 }]
      },
      requirements: undefined,
      payment_method: null
    });

    expect(view.recurringRows).toHaveLength(1);
    expect(view.requirements.payment_method_required).toBe(true);
  });

  it("uses explicit server requirements ahead of local fallbacks", () => {
    const view = normalizeCustomerOrderView({
      signed_at: "2026-08-25T09:00:00.000Z",
      snapshot: {
        rows: [{ id: "row_1", billing_type: "RECURRING" }]
      },
      requirements: {
        signing_required: false,
        payment_method_required: false,
        activation_required: true
      }
    });

    expect(view.requirements).toEqual({
      signing_required: false,
      payment_method_required: false,
      activation_required: true
    });
    expect(view.currentStep).toBe(3);
  });

  it("classifies invalid and expired public customer-order links", () => {
    expect(classifyCustomerOrderLoadError(new Error("Kundlänken är ogiltig."))).toMatchObject({ status: "invalid" });
    expect(classifyCustomerOrderLoadError(new Error("Kundlänken har gått ut."))).toMatchObject({ status: "expired" });
    expect(classifyCustomerOrderLoadError(new Error("D1 unavailable"))).toMatchObject({ status: "server_error" });
  });

  it("defines a customer-safe render fallback", () => {
    expect(customerOrderRenderFallbackCopy()).toEqual({
      title: "Vi kunde inte visa din beställning",
      text: "Försök ladda om sidan eller kontakta Webblyftet."
    });
  });
});
