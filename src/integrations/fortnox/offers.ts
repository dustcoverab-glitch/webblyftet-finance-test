import { fortnoxRequest } from "./client";
import type { FortnoxOfferPayload } from "./types";

export type FinanceOfferForFortnox = {
  offer_date: string;
  expire_date?: string | null;
  remarks?: string | null;
  rows: Array<{
    article_number?: string | null;
    description: string;
    quantity: number;
    unit?: string | null;
    unit_price: number;
    discount_percent: number;
    vat_percent: number;
    account_number?: number | null;
  }>;
};

export function toFortnoxOfferPayload(customerNumber: string, offer: FinanceOfferForFortnox): FortnoxOfferPayload {
  return {
    Offer: {
      CustomerNumber: customerNumber,
      OfferDate: offer.offer_date,
      ExpireDate: offer.expire_date || undefined,
      Remarks: offer.remarks || undefined,
      OfferRows: offer.rows.map((row) => ({
        ArticleNumber: row.article_number || undefined,
        Description: row.description,
        DeliveredQuantity: row.quantity,
        Unit: row.unit || undefined,
        Price: row.unit_price,
        Discount: row.discount_percent,
        VAT: row.vat_percent,
        AccountNumber: row.account_number || undefined
      }))
    }
  };
}

export async function syncOfferToFortnox(env: Env, customerNumber: string, offer: FinanceOfferForFortnox) {
  const result = await fortnoxRequest<any>(env, "/offers", {
    method: "POST",
    json: toFortnoxOfferPayload(customerNumber, offer)
  });
  return {
    providerDocumentNumber: result.Offer?.DocumentNumber ?? null,
    raw: result
  };
}

export async function createInvoiceFromFortnoxOffer(env: Env, documentNumber: string) {
  return fortnoxRequest<any>(
    env,
    `/offers/${encodeURIComponent(documentNumber)}/createinvoice`,
    { method: "PUT" }
  );
}
