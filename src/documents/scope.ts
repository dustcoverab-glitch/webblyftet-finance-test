import type { DocumentLine } from "./money";

export type OfferScopeContent = {
  assignmentSummary: string;
  baselineTitle: string;
  baselineItems: string[];
  serviceTitle: string;
  serviceItems: string[];
  processSteps: Array<{ title: string; body: string }>;
  customerResponsibilities: string[];
  exclusions: string[];
};

const defaultScope: OfferScopeContent = {
  assignmentSummary:
    "Webblyftet får i uppdrag att ta fram en professionell företagswebbplats anpassad för dator och mobil, med tydlig struktur, modern presentation och tydliga kontaktvägar.",
  baselineTitle: "Detta ingår i Webblyftet Bas",
  baselineItems: [
    "Planering och startmöte",
    "Design och layout",
    "Upp till 6 sidor",
    "Mobilanpassning",
    "Kontaktformulär",
    "Grundläggande teknisk SEO",
    "Cookie- och integritetssidor",
    "Test och publicering"
  ],
  serviceTitle: "Webblyftet Service",
  serviceItems: [
    "Hosting och drift",
    "Teknisk övervakning",
    "Säkerhet och underhåll",
    "Enklare innehållsuppdateringar inom avtalad och rimlig omfattning",
    "Support och rådgivning"
  ],
  processSteps: [
    { title: "Uppstart & material", body: "Vi samlar in mål, kontaktvägar, material och praktiska förutsättningar." },
    { title: "Design & struktur", body: "Webbplatsens struktur, visuell riktning och viktigaste kundresor sätts." },
    { title: "Produktion & feedback", body: "Sidor, innehåll och teknisk grund byggs upp med löpande återkoppling." },
    { title: "Slutjustering & publicering", body: "Sista kontroller, justeringar och publicering genomförs när kunden godkänt innehållet." }
  ],
  customerResponsibilities: [
    "Lämna korrekt företagsinformation",
    "Tillhandahålla material som finns",
    "Lämna nödvändiga behörigheter",
    "Svara på frågor och feedback inom rimlig tid",
    "Kontrollera och godkänna innehåll före publicering"
  ],
  exclusions: [
    "Fotografering eller video",
    "Helt ny grafisk profil eller logotyp",
    "Avancerad copywriting utöver avtalad omfattning",
    "Specialintegrationer",
    "Bokningssystem",
    "Avancerade e-handelsfunktioner",
    "Externa licenser",
    "Tredjepartskostnader",
    "Annonseringsbudget"
  ]
};

export function offerScopeForRows(rows: DocumentLine[]): OfferScopeContent {
  const descriptions = rows.map((row) => row.description.toLowerCase()).join(" ");
  const hasRecurring = rows.some((row) => row.billing_type === "RECURRING");
  const hasProject = rows.some((row) => row.billing_type !== "RECURRING");
  const assignmentSummary = hasProject
    ? defaultScope.assignmentSummary
    : "Webblyftet får i uppdrag att leverera löpande service, drift och rådgivning enligt de tjänster som anges i offerten.";
  return {
    ...defaultScope,
    assignmentSummary,
    baselineTitle: descriptions.includes("bas") ? "Detta ingår i Webblyftet Bas" : "Detta ingår i projektleveransen",
    serviceItems: hasRecurring ? defaultScope.serviceItems : [],
    baselineItems: hasProject ? defaultScope.baselineItems : []
  };
}
