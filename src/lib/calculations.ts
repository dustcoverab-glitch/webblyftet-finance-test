export type MoneyRow = {
  quantity: number;
  unit_price: number;
  discount_percent?: number;
  vat_percent?: number;
};

export function calculate(rows: MoneyRow[]) {
  let subtotal = 0;
  let vatTotal = 0;
  for (const row of rows) {
    const gross = Number(row.quantity) * Number(row.unit_price);
    const net = gross * (1 - Number(row.discount_percent ?? 0) / 100);
    subtotal += net;
    vatTotal += net * (Number(row.vat_percent ?? 25) / 100);
  }
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    vatTotal: Math.round(vatTotal * 100) / 100,
    total: Math.round((subtotal + vatTotal) * 100) / 100
  };
}
