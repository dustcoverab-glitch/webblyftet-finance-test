export type FortnoxCustomerPayload = {
  Customer: {
    Name: string;
    OrganisationNumber?: string;
    Email?: string;
    Phone1?: string;
    Address1?: string;
    ZipCode?: string;
    City?: string;
    CountryCode?: string;
  };
};

export type FortnoxOfferPayload = {
  Offer: {
    CustomerNumber: string;
    OfferDate: string;
    ExpireDate?: string;
    Remarks?: string;
    OfferRows: Array<{
      ArticleNumber?: string;
      Description: string;
      DeliveredQuantity: number;
      Unit?: string;
      Price: number;
      Discount: number;
      VAT: number;
      AccountNumber?: number;
    }>;
  };
};
