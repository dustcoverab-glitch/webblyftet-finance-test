export type SigningSnapshot = {
  generated_at: string;
  order: {
    id: string;
    status: string;
    currency: string;
    one_time_total_minor: number;
    recurring_monthly_minor: number;
  };
  customer: {
    id: string;
    name: string;
    org_number?: string | null;
    email?: string | null;
    phone?: string | null;
    address1?: string | null;
    zip?: string | null;
    city?: string | null;
    country?: string | null;
    contact_name?: string | null;
  };
  offer: {
    id: string;
    title?: string | null;
    version_id: string;
    version_number?: number | null;
    terms_version?: string | null;
    offer_date?: string | null;
    expire_date?: string | null;
    remarks?: string | null;
    fortnox_document_number?: string | null;
  };
  rows: Array<{
    id: string;
    description: string;
    quantity: number;
    unit?: string | null;
    unit_price_minor: number;
    vat_percent: number;
    billing_type: "ONE_TIME" | "RECURRING";
    billing_interval?: "MONTH" | "YEAR" | null;
    product_id?: string | null;
    price_id?: string | null;
  }>;
  totals: {
    one_time_net_minor: number;
    one_time_vat_minor: number;
    one_time_total_minor: number;
    recurring_monthly_net_minor: number;
    recurring_monthly_vat_minor: number;
    recurring_monthly_total_minor: number;
    recurring_year_total_minor: number;
  };
};

export type SigningResult = {
  provider: "BASIC_ACCEPTANCE";
  signing_request_id: string;
  evidence_reference: string;
};

export type SigningProvider = {
  sign(input: {
    session_id: string;
    document_hash: string;
    signer_name: string;
    signer_email: string;
    ip_address?: string | null;
    user_agent?: string | null;
  }): SigningResult;
};
