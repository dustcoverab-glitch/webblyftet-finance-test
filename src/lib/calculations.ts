import { calculateMoneyTotals, minorToMoney, moneyToMinor } from "./money";

export type MoneyRow = {
  quantity: number;
  unit_price: number;
  discount_percent?: number;
  vat_percent?: number;
};

export function calculate(rows: MoneyRow[]) {
  const totals = calculateMoneyTotals(rows.map((row) => ({
    quantity: row.quantity,
    unit_price_minor: moneyToMinor(row.unit_price),
    discount_percent: row.discount_percent ?? 0,
    vat_percent: row.vat_percent ?? 25
  })));
  return {
    subtotal: minorToMoney(totals.subtotal),
    vatTotal: minorToMoney(totals.vatTotal),
    total: minorToMoney(totals.total)
  };
}
