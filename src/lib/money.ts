export const QUANTITY_BASIS = 10_000;
export const PERCENT_BASIS = 10_000;

export type BillingType = "ONE_TIME" | "RECURRING";

export type MoneyLine = {
  quantity: number;
  unit_price_minor: number;
  discount_percent?: number | null;
  vat_percent?: number | null;
  billing_type?: BillingType | string | null;
  billing_interval?: "MONTH" | "YEAR" | string | null;
};

export type MoneyTotals = {
  subtotal: number;
  vatTotal: number;
  total: number;
  roundoff: number;
};

export type SegmentedMoneyTotals = {
  oneTime: { net: number; vat: number; gross: number };
  recurringMonthly: { net: number; vat: number; gross: number };
  recurringAnnual: { gross: number };
  vatByRate: Array<{ rate: number; amount: number }>;
};

export function moneyToMinor(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

export function minorToMoney(value: number): number {
  return Math.round(Number(value ?? 0)) / 100;
}

export function quantityToBasis(quantity: unknown): number {
  const numeric = Number(quantity ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric * QUANTITY_BASIS));
}

export function percentToBasis(percent: unknown): number {
  const numeric = Number(percent ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(PERCENT_BASIS, Math.round(numeric * 100)));
}

export function lineNetMinor(row: MoneyLine): number {
  const gross = Math.round(Number(row.unit_price_minor ?? 0) * quantityToBasis(row.quantity) / QUANTITY_BASIS);
  return Math.round(gross * (PERCENT_BASIS - percentToBasis(row.discount_percent)) / PERCENT_BASIS);
}

export function lineVatMinor(row: MoneyLine): number {
  return Math.round(lineNetMinor(row) * Number(row.vat_percent ?? 0) / 100);
}

export function lineGrossMinor(row: MoneyLine): number {
  return lineNetMinor(row) + lineVatMinor(row);
}

export function calculateMoneyTotals(rows: MoneyLine[]): MoneyTotals {
  const subtotal = rows.reduce((sum, row) => sum + lineNetMinor(row), 0);
  const vatTotal = rows.reduce((sum, row) => sum + lineVatMinor(row), 0);
  const total = subtotal + vatTotal;
  return { subtotal, vatTotal, total, roundoff: total - subtotal - vatTotal };
}

export function recurringMonthlyMinor(row: MoneyLine, amountMinor: number): number {
  return row.billing_interval === "YEAR" ? Math.round(amountMinor / 12) : amountMinor;
}

export function subscriptionMonthlyAmount(items: Array<{ unit_amount: number; quantity: number; billing_interval?: string | null }>): number {
  return items.reduce((sum, item) => {
    const line = lineNetMinor({
      unit_price_minor: item.unit_amount,
      quantity: item.quantity,
      discount_percent: 0,
      vat_percent: 0,
      billing_interval: item.billing_interval
    });
    return sum + (item.billing_interval === "YEAR" ? Math.round(line / 12) : line);
  }, 0);
}

export function segmentedMoneyTotals(rows: MoneyLine[]): SegmentedMoneyTotals {
  const oneTime = { net: 0, vat: 0, gross: 0 };
  const recurringMonthly = { net: 0, vat: 0, gross: 0 };
  const recurringAnnual = { gross: 0 };
  const vatByRate = new Map<number, number>();

  for (const row of rows) {
    const net = lineNetMinor(row);
    const vat = lineVatMinor(row);
    const gross = net + vat;
    const rate = Number(row.vat_percent ?? 0);
    vatByRate.set(rate, (vatByRate.get(rate) ?? 0) + vat);
    if (row.billing_type === "RECURRING") {
      recurringMonthly.net += recurringMonthlyMinor(row, net);
      recurringMonthly.vat += recurringMonthlyMinor(row, vat);
      recurringMonthly.gross += recurringMonthlyMinor(row, gross);
      recurringAnnual.gross += row.billing_interval === "YEAR" ? gross : gross * 12;
    } else {
      oneTime.net += net;
      oneTime.vat += vat;
      oneTime.gross += gross;
    }
  }

  return {
    oneTime,
    recurringMonthly,
    recurringAnnual,
    vatByRate: Array.from(vatByRate.entries()).map(([rate, amount]) => ({ rate, amount }))
  };
}
