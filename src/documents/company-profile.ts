export type CompanyProfile = {
  legal_name: string;
  brand_name: string;
  org_number: string;
  vat_number: string;
  address1: string;
  zip: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  bankgiro: string;
  iban: string;
  bic: string;
  seat: string;
  payment_terms_days: number;
};

const defaults: CompanyProfile = {
  legal_name: "Webblyftet Finance Test AB (demo)",
  brand_name: "Webblyftet",
  org_number: "559999-0000",
  vat_number: "SE559999000001",
  address1: "Testgatan 1",
  zip: "582 00",
  city: "Linkoping",
  country: "Sverige",
  email: "ekonomi@example.test",
  phone: "010-000 00 00",
  website: "webblyftet.se",
  bankgiro: "000-0000 (test)",
  iban: "",
  bic: "",
  seat: "Linkoping",
  payment_terms_days: 30
};

function envValue(env: Env, key: string, fallback: string): string {
  const value = (env as unknown as Record<string, string | undefined>)[key];
  return value && value.trim() ? value.trim() : fallback;
}

export function webblyftetCompanyProfile(env: Env): CompanyProfile {
  return {
    legal_name: envValue(env, "WEBBLYFTET_LEGAL_NAME", defaults.legal_name),
    brand_name: envValue(env, "WEBBLYFTET_BRAND_NAME", defaults.brand_name),
    org_number: envValue(env, "WEBBLYFTET_ORG_NUMBER", defaults.org_number),
    vat_number: envValue(env, "WEBBLYFTET_VAT_NUMBER", defaults.vat_number),
    address1: envValue(env, "WEBBLYFTET_ADDRESS1", defaults.address1),
    zip: envValue(env, "WEBBLYFTET_ZIP", defaults.zip),
    city: envValue(env, "WEBBLYFTET_CITY", defaults.city),
    country: envValue(env, "WEBBLYFTET_COUNTRY", defaults.country),
    email: envValue(env, "WEBBLYFTET_EMAIL", defaults.email),
    phone: envValue(env, "WEBBLYFTET_PHONE", defaults.phone),
    website: envValue(env, "WEBBLYFTET_WEBSITE", defaults.website),
    bankgiro: envValue(env, "WEBBLYFTET_BANKGIRO", defaults.bankgiro),
    iban: envValue(env, "WEBBLYFTET_IBAN", defaults.iban),
    bic: envValue(env, "WEBBLYFTET_BIC", defaults.bic),
    seat: envValue(env, "WEBBLYFTET_SEAT", defaults.seat),
    payment_terms_days: Number(envValue(env, "WEBBLYFTET_PAYMENT_TERMS_DAYS", String(defaults.payment_terms_days))) || defaults.payment_terms_days
  };
}
