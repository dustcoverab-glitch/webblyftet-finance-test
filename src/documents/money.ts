export type BillingType = "ONE_TIME" | "RECURRING";

export type DocumentLine = {
  id?: string;
  description: string;
  article_number?: string | null;
  quantity: number;
  unit?: string | null;
  unit_price_minor: number;
  discount_percent?: number | null;
  vat_percent?: number | null;
  billing_type?: BillingType | string | null;
  billing_interval?: "MONTH" | "YEAR" | string | null;
};

export function formatMinor(value: number | null | undefined, currency = "SEK"): string {
  return (Number(value ?? 0) / 100).toLocaleString("sv-SE", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  });
}

export function lineNetMinor(row: DocumentLine): number {
  const quantity = Math.max(0, Math.round(Number(row.quantity ?? 0) * 10000));
  const gross = Math.round(Number(row.unit_price_minor ?? 0) * quantity / 10000);
  const discount = Math.max(0, Math.min(10000, Math.round(Number(row.discount_percent ?? 0) * 100)));
  return Math.round(gross * (10000 - discount) / 10000);
}

export function lineVatMinor(row: DocumentLine): number {
  return Math.round(lineNetMinor(row) * Number(row.vat_percent ?? 0) / 100);
}

export function lineGrossMinor(row: DocumentLine): number {
  return lineNetMinor(row) + lineVatMinor(row);
}

export function documentTotals(rows: DocumentLine[]) {
  const oneTime = { net: 0, vat: 0, gross: 0 };
  const recurringMonthly = { net: 0, vat: 0, gross: 0 };
  const recurringAnnual = { gross: 0 };
  const vatByRate = new Map<number, number>();
  for (const row of rows) {
    const net = lineNetMinor(row);
    const vat = lineVatMinor(row);
    const gross = net + vat;
    vatByRate.set(Number(row.vat_percent ?? 0), (vatByRate.get(Number(row.vat_percent ?? 0)) ?? 0) + vat);
    if (row.billing_type === "RECURRING") {
      const divisor = row.billing_interval === "YEAR" ? 12 : 1;
      recurringMonthly.net += Math.round(net / divisor);
      recurringMonthly.vat += Math.round(vat / divisor);
      recurringMonthly.gross += Math.round(gross / divisor);
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
