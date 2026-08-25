import {
  lineGrossMinor,
  lineNetMinor,
  lineVatMinor,
  segmentedMoneyTotals,
  type BillingType,
  type MoneyLine
} from "../lib/money";

export type { BillingType };

export type DocumentLine = MoneyLine & {
  id?: string;
  description: string;
  article_number?: string | null;
  unit?: string | null;
};

export function formatMinor(value: number | null | undefined, currency = "SEK"): string {
  return (Number(value ?? 0) / 100).toLocaleString("sv-SE", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  });
}

export { lineGrossMinor, lineNetMinor, lineVatMinor };

export function documentTotals(rows: DocumentLine[]) {
  return segmentedMoneyTotals(rows);
}
