import { describe, expect, it } from "vitest";
import { calculate } from "../src/lib/calculations";

describe("calculate", () => {
  it("calculates subtotal, VAT and total with discounts", () => {
    expect(calculate([
      { quantity: 2, unit_price: 100, discount_percent: 10, vat_percent: 25 },
      { quantity: 1, unit_price: 50, vat_percent: 12 }
    ])).toEqual({
      subtotal: 230,
      vatTotal: 51,
      total: 281
    });
  });

  it("normalizes unit prices to minor units before applying quantity", () => {
    expect(calculate([{ quantity: 3, unit_price: 19.995, vat_percent: 25 }])).toEqual({
      subtotal: 60,
      vatTotal: 15,
      total: 75
    });
  });
});
