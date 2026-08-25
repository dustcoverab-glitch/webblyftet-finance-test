import { describe, expect, it } from "vitest";
import {
  calculateMoneyTotals,
  lineGrossMinor,
  lineNetMinor,
  lineVatMinor,
  segmentedMoneyTotals,
  subscriptionMonthlyAmount
} from "../src/lib/money";
import { documentTotals } from "../src/documents";

describe("canonical money policy", () => {
  it("uses integer minor units for 25%, 12% and 0% VAT", () => {
    const rows = [
      { quantity: 1, unit_price_minor: 10_000, vat_percent: 25 },
      { quantity: 1, unit_price_minor: 10_000, vat_percent: 12 },
      { quantity: 1, unit_price_minor: 10_000, vat_percent: 0 }
    ];
    expect(calculateMoneyTotals(rows)).toEqual({ subtotal: 30_000, vatTotal: 3_700, total: 33_700, roundoff: 0 });
  });

  it("uses fixed-precision quantity for decimal quantities", () => {
    const row = { quantity: 1.2345, unit_price_minor: 10_001, vat_percent: 25 };
    expect(lineNetMinor(row)).toBe(12_346);
    expect(lineVatMinor(row)).toBe(3_087);
    expect(lineGrossMinor(row)).toBe(15_433);
  });

  it("rounds 33.33% discount after line gross in minor units", () => {
    const row = { quantity: 3, unit_price_minor: 9_999, discount_percent: 33.33, vat_percent: 25 };
    expect(lineNetMinor(row)).toBe(19_999);
    expect(lineVatMinor(row)).toBe(5_000);
    expect(lineGrossMinor(row)).toBe(24_999);
  });

  it("handles small and large amounts without floating point drift", () => {
    expect(calculateMoneyTotals([{ quantity: 1, unit_price_minor: 1, vat_percent: 25 }])).toEqual({
      subtotal: 1,
      vatTotal: 0,
      total: 1,
      roundoff: 0
    });
    expect(calculateMoneyTotals([{ quantity: 9999.9999, unit_price_minor: 9_999_999, vat_percent: 25 }])).toEqual({
      subtotal: 99_999_989_000,
      vatTotal: 24_999_997_250,
      total: 124_999_986_250,
      roundoff: 0
    });
  });

  it("keeps offer, document and invoice totals on the same canonical policy", () => {
    const rows = [
      { description: "One", quantity: 2, unit_price_minor: 10_000, discount_percent: 10, vat_percent: 25, billing_type: "ONE_TIME" as const },
      { description: "Recurring month", quantity: 1, unit_price_minor: 29_500, vat_percent: 25, billing_type: "RECURRING" as const, billing_interval: "MONTH" as const },
      { description: "Recurring year", quantity: 1, unit_price_minor: 120_000, vat_percent: 12, billing_type: "RECURRING" as const, billing_interval: "YEAR" as const }
    ];
    const canonical = segmentedMoneyTotals(rows);
    const documents = documentTotals(rows);
    expect(documents).toEqual(canonical);
    expect(canonical.oneTime).toEqual({ net: 18_000, vat: 4_500, gross: 22_500 });
    expect(canonical.recurringMonthly).toEqual({ net: 39_500, vat: 8_575, gross: 48_075 });
    expect(canonical.recurringAnnual.gross).toBe(576_900);
  });

  it("uses the same recurring month policy for subscriptions", () => {
    expect(subscriptionMonthlyAmount([
      { unit_amount: 29_500, quantity: 1, billing_interval: "MONTH" },
      { unit_amount: 120_000, quantity: 1, billing_interval: "YEAR" }
    ])).toBe(39_500);
  });
});
