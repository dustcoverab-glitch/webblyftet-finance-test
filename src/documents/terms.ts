export const WEBBLYFTET_TERMS_VERSION = "WEBBLYFTET_TERMS_V2_DEMO";

export type DocumentTerms = {
  version: string;
  label: string;
  sections: Array<{ title: string; body: string }>;
};

export const demoOfferTerms: DocumentTerms = {
  version: WEBBLYFTET_TERMS_VERSION,
  label: "Demo-villkor för Finance Test. Ska juridiskt granskas innan production.",
  sections: [
    {
      title: "Avtalets omfattning",
      body: "Avtalet omfattar endast de produkter, tjänster, funktioner och leveranser som uttryckligen anges i denna offert eller tillhörande beställningsunderlag. Tillägg eller förändringar utanför omfattningen genomförs efter separat överenskommelse och kan påverka pris och leveranstid."
    },
    {
      title: "Priser och moms",
      body: "Samtliga priser anges i svenska kronor exklusive moms om inget annat uttryckligen anges. Moms tillkommer enligt vid var tid gällande lagstiftning."
    },
    {
      title: "Betalning för engångstjänster",
      body: "Engångstjänster faktureras enligt vad som anges i beställningen. Om ingen annan betalningsplan uttryckligen avtalats får faktura ställas ut i samband med accepterad beställning och projektstart. Standard betalningsvillkor är 30 dagar."
    },
    {
      title: "Löpande tjänster och abonnemang",
      body: "Löpande tjänster börjar gälla från avtalad start- eller aktiveringsdag och löper tills de sägs upp. Om inget annat uttryckligen anges gäller 30 dagars uppsägningstid. Avgifter får debiteras den betalmetod som kunden registrerat för återkommande betalningar."
    },
    {
      title: "Kundens medverkan",
      body: "Kunden ansvarar för att inom rimlig tid tillhandahålla de uppgifter, material, beslut, godkännanden och behörigheter som krävs för uppdragets genomförande. Förseningar eller brister i kundens medverkan kan medföra motsvarande förskjutning av leveranstiden."
    },
    {
      title: "Leveranstid",
      body: "Angivna leveranstider är uppskattningar om inget annat uttryckligen anges. Leveranstiden förutsätter att kunden lämnar material, återkoppling och godkännanden enligt överenskommen process samt att beroenden till tredjepartsleverantörer fungerar normalt."
    },
    {
      title: "Revisioner, ändringar och tillägg",
      body: "Normala justeringar inom den avtalade omfattningen ingår enligt den tjänst som beställts. Större förändringar, nya funktioner, omfattande omarbetningar eller strukturella ändringar efter tidigare godkännande betraktas som tilläggsarbete och kan offereras separat."
    },
    {
      title: "Kundens material och rättigheter",
      body: "Kunden ansvarar för att texter, bilder, logotyper, varumärken, personuppgifter och annat material som kunden lämnar får användas för uppdraget och inte gör intrång i tredje mans rättigheter. Kunden ansvarar också för riktigheten i den information som publiceras på kundens webbplats."
    },
    {
      title: "Immateriella rättigheter",
      body: "Efter full betalning får kunden rätt att använda det kundspecifika slutresultatet inom den egna verksamheten. Webblyftet behåller äganderätten och nyttjanderätten till generella metoder, arbetsprocesser, mallar, återanvändbara komponenter, bibliotek och tekniska lösningar som inte tagits fram exklusivt för kunden, om inget annat skriftligen avtalats."
    },
    {
      title: "Domän, hosting och tredjepartstjänster",
      body: "Domännamn, hosting, e-posttjänster, licenser, plugins, externa API:er och andra tredjepartstjänster kan omfattas av respektive leverantörs egna villkor och prisändringar. Webblyftet ansvarar inte för avbrott eller förändringar som orsakas av tredje part utanför Webblyftets kontroll."
    },
    {
      title: "Löpande underhåll och innehållsändringar",
      body: "Om kunden köper löpande service omfattas de åtgärder som uttryckligen anges för tjänsten. Enklare innehållsuppdateringar avser mindre ändringar i befintligt innehåll och innebär inte automatiskt utveckling av nya funktioner, nya sidstrukturer eller större redesign."
    },
    {
      title: "Betalningsdröjsmål",
      body: "Vid försenad betalning har Webblyftet rätt att debitera dröjsmålsränta och lagstadgade avgifter. Webblyftet har även rätt att tillfälligt pausa ej levererade arbeten eller löpande tjänster efter skälig underrättelse tills förfallen betalning erlagts."
    },
    {
      title: "Fel och rättelse",
      body: "Kunden ska reklamera fel inom skälig tid från det att felet upptäckts eller borde ha upptäckts. Webblyftet ska ges skälig möjlighet att avhjälpa ett verifierat fel innan andra påföljder görs gällande."
    },
    {
      title: "Ansvarsbegränsning",
      body: "Webblyftet ansvarar endast för direkt skada som orsakats genom vårdslöshet och, i den utsträckning lag medger, är det sammanlagda ansvaret begränsat till det belopp kunden betalat för den del av tjänsten som kravet avser under de senaste tolv månaderna. Webblyftet ansvarar inte för indirekt skada, utebliven vinst, dataförlust eller följdskada, om inte annat följer av tvingande lag."
    },
    {
      title: "Personuppgifter",
      body: "Parterna ansvarar var för sig för sin behandling av personuppgifter enligt tillämplig dataskyddslagstiftning. Om Webblyftet behandlar personuppgifter för kundens räkning på ett sätt som kräver personuppgiftsbiträdesavtal ska sådant avtal ingås separat."
    },
    {
      title: "Referensrätt",
      body: "Webblyftet får, efter att webbplatsen offentliggjorts, ange kunden som referens och visa offentliga delar av leveransen i portfolio och marknadsföring, om kunden inte skriftligen motsätter sig detta."
    },
    {
      title: "Force majeure",
      body: "Part ansvarar inte för försening eller utebliven prestation som beror på omständighet utanför partens rimliga kontroll, exempelvis omfattande driftstörning, myndighetsbeslut, konflikt, naturhändelse eller allvarligt fel hos kritisk tredjepartsleverantör."
    },
    {
      title: "Uppsägning och avslut av löpande tjänster",
      body: "Vid avslut av löpande tjänst upphör tjänsten efter gällande uppsägningstid. Kunden ansvarar för att eventuella alternativa tjänster, konton eller tekniska lösningar finns på plats efter avslut. Eventuell överlämning eller migrering som ligger utanför ordinarie tjänst kan debiteras separat efter överenskommelse."
    },
    {
      title: "Ändring av löpande priser och villkor",
      body: "Webblyftet får ändra pris eller villkor för en löpande tjänst med skäligt förhandsmeddelande. Kunden har rätt att säga upp den berörda tjänsten före ändringens ikraftträdande om kunden inte accepterar ändringen."
    },
    {
      title: "Godkännande",
      body: "Genom digital signering, BankID-signering när detta införs, eller annat uttryckligt elektroniskt godkännande bekräftar kunden att offertens omfattning, priser och villkor har granskats och accepterats."
    },
    {
      title: "Tillämplig lag och tvist",
      body: "Avtalet ska tolkas enligt svensk rätt. Tvist ska i första hand lösas genom dialog mellan parterna och, om en lösning inte kan nås, prövas av svensk allmän domstol."
    }
  ]
};
