export type DocumentTerms = {
  version: string;
  label: string;
  sections: Array<{ title: string; body: string }>;
};

export const demoOfferTerms: DocumentTerms = {
  version: "WEBBLYFTET-DEMO-TERMS-2026-08-24",
  label: "Demo-standardvillkor for Finance Test",
  sections: [
    { title: "Omfattning", body: "Offerten omfattar de produkter och tjanster som uttryckligen anges i offertens specifikation. Arbeten eller funktioner utover angiven omfattning offereras separat eller genomfors efter sarskild overenskommelse." },
    { title: "Priser", body: "Samtliga priser anges exklusive moms om inget annat uttryckligen anges. Moms tillkommer enligt gallande lagstiftning." },
    { title: "Engangstjanster", body: "Engangstjanster faktureras enligt den betalningsplan som anges i bestallningen. Om ingen sarskild betalningsplan anges faktureras tjansten i samband med att bestallningen har accepterats." },
    { title: "Lopande tjanster", body: "Lopande tjanster debiteras enligt angiven faktureringsperiod. Kunden godkanner att registrerad betalmetod far anvandas for aterkommande debiteringar av avtalade tjanster." },
    { title: "Betalningsvillkor", body: "Fakturor har 30 dagars betalningsvillkor om inget annat har avtalats. Vid forsenad betalning kan drojsmalsranta och lagstadgade avgifter tillkomma." },
    { title: "Start av uppdrag", body: "Arbetet kan paborjas efter att bestallningen har accepterats och de kunduppgifter, material och behorigheter som kravs for uppdraget har tillhandahallits." },
    { title: "Kundens ansvar", body: "Kunden ansvarar for att tillhandahallet material, information, bilder, texter, varumarken och andra tillgangar far anvandas for uppdragets genomforande." },
    { title: "Andringar", body: "Storre forandringar av ursprungligen avtalad omfattning kan medfora justerat pris och leveranstid. Sadana forandringar ska godkannas av kunden innan de genomfors." },
    { title: "Lopande abonnemang", body: "Lopande tjanster fortsatter enligt avtalad period tills de sags upp enligt respektive tjansts villkor. Exakt uppsagningstid och eventuell bindningstid ska framga av den aktuella bestallningen." },
    { title: "Leverans", body: "Leveranstider ar uppskattningar och kan paverkas av hur snabbt kunden lamnar nodvandigt material, aterkoppling och godkannanden." },
    { title: "Digital accept", body: "Genom att godkanna bestallningen bekraftar kunden att uppgifterna, priserna och villkoren har granskats och accepterats. I Finance Test ar detta markerat som demo/test-signering." }
  ]
};
