const CHANNELS = ["web_chat", "facebook", "email"];

const BASE_CASES = [
  {
    id: "working-hours",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Radno vrijeme\nSadržaj: Radno vrijeme poslovnice je ponedjeljak-petak 08:00 – 20:00 i subotom 08:00 – 13:00.",
      articles: [{ title: "Radno vrijeme", body: "Radno vrijeme poslovnice je ponedjeljak-petak 08:00 – 20:00 i subotom 08:00 – 13:00.", score: 30, source: "onedrive" }]
    },
    validAnswer: "Radimo od ponedjeljka do petka 08:00 – 20:00, a subotom 08:00 – 13:00.",
    wrongAnswer: "Radite svaki dan do 21:00 i subotom do 15:00.",
    requiredPatterns: [/08:00\s*[–-]\s*20:00/i, /08:00\s*[–-]\s*13:00/i]
  },
  {
    id: "contact",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Kontakt\nSadržaj: Telefon je 031-201-230, email info@antikvarijat-libar.com, a na email odgovaramo u roku 1 radnog dana.",
      articles: [{ title: "Kontakt", body: "Telefon je 031-201-230, email info@antikvarijat-libar.com, a na email odgovaramo u roku 1 radnog dana.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Možete nas nazvati na 031-201-230 ili poslati email na info@antikvarijat-libar.com. Na email odgovaramo u roku 1 radnog dana.",
    wrongAnswer: "Nazovite nas na 091-000-0000 i odgovaramo isti dan.",
    requiredPatterns: [/031-201-230/i, /info@antikvarijat-libar\.com/i, /1 radnog dana/i]
  },
  {
    id: "r1",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: R1 račun\nSadržaj: R1 račun nije automatski. Potrebno ga je zatražiti emailom na info@antikvarijat-libar.com.",
      articles: [{ title: "R1 račun", body: "R1 račun nije automatski. Potrebno ga je zatražiti emailom na info@antikvarijat-libar.com.", score: 27, source: "onedrive" }]
    },
    validAnswer: "R1 račun nije automatski. Potrebno ga je zatražiti emailom na info@antikvarijat-libar.com.",
    wrongAnswer: "R1 račun se izdaje automatski uz svaku narudžbu.",
    requiredPatterns: [/nije automatski/i, /info@antikvarijat-libar\.com/i]
  },
  {
    id: "installments",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Plaćanje na rate\nSadržaj: Plaćanje je moguće od 2 do 6 rata za PBZ i ZABA kartice.",
      articles: [{ title: "Plaćanje na rate", body: "Plaćanje je moguće od 2 do 6 rata za PBZ i ZABA kartice.", score: 26, source: "onedrive" }]
    },
    validAnswer: "Plaćanje je moguće od 2 do 6 rata za PBZ i ZABA kartice.",
    wrongAnswer: "Moguće je do 12 rata za sve kartice.",
    requiredPatterns: [/2 do 6 rata/i, /(PBZ|ZABA)/i]
  },
  {
    id: "return",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Povrat i zamjena\nSadržaj: Povrat ili zamjena mogući su unutar 2 tjedna uz predočenje računa.",
      articles: [{ title: "Povrat i zamjena", body: "Povrat ili zamjena mogući su unutar 2 tjedna uz predočenje računa.", score: 29, source: "onedrive" }]
    },
    validAnswer: "Povrat ili zamjena mogući su unutar 2 tjedna uz predočenje računa.",
    wrongAnswer: "Povrat je moguć unutar 30 dana bez računa.",
    requiredPatterns: [/2 tjedna/i, /računa/i]
  },
  {
    id: "delivery-home",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Dostava na kućnu adresu\nSadržaj: GLS ili MBE dostava na kućnu adresu iznosi 5,97 EUR.",
      articles: [{ title: "Dostava na kućnu adresu", body: "GLS ili MBE dostava na kućnu adresu iznosi 5,97 EUR.", score: 30, source: "onedrive" }]
    },
    validAnswer: "GLS ili MBE dostava na kućnu adresu iznosi 5,97 EUR.",
    wrongAnswer: "Dostava na kućnu adresu iznosi 7,50 EUR.",
    requiredPatterns: [/5,97 EUR/i, /(GLS|MBE)/i]
  },
  {
    id: "delivery-locker",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Paketomat\nSadržaj: Dostava u BOXNOW paketomat iznosi 3,50 EUR.",
      articles: [{ title: "Paketomat", body: "Dostava u BOXNOW paketomat iznosi 3,50 EUR.", score: 30, source: "onedrive" }]
    },
    validAnswer: "Dostava u BOXNOW paketomat iznosi 3,50 EUR.",
    wrongAnswer: "Paketomat dostava iznosi 2,00 EUR.",
    requiredPatterns: [/3,50 EUR/i, /BOXNOW/i]
  },
  {
    id: "delivery-times",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Rok dostave\nSadržaj: Dostava traje 1 do 2 radna dana za GLS, MBE i BOXNOW.",
      articles: [{ title: "Rok dostave", body: "Dostava traje 1 do 2 radna dana za GLS, MBE i BOXNOW.", score: 30, source: "onedrive" }]
    },
    validAnswer: "Dostava traje 1 do 2 radna dana za GLS, MBE i BOXNOW.",
    wrongAnswer: "Dostava traje 5 do 7 radnih dana.",
    requiredPatterns: [/1 do 2 radna dana/i, /(GLS|MBE|BOXNOW)/i]
  },
  {
    id: "tracking",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Praćenje pošiljke\nSadržaj: Nakon slanja dobivate tracking broj i link za praćenje pošiljke.",
      articles: [{ title: "Praćenje pošiljke", body: "Nakon slanja dobivate tracking broj i link za praćenje pošiljke.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Nakon slanja dobivate tracking broj i link za praćenje pošiljke.",
    wrongAnswer: "Praćenje pošiljke nije dostupno.",
    requiredPatterns: [/tracking broj/i, /link za praćenje/i]
  },
  {
    id: "basic-school",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Otkup osnovne škole\nSadržaj: Knjige za osnovnu školu ne otkupljujemo.",
      articles: [{ title: "Otkup osnovne škole", body: "Knjige za osnovnu školu ne otkupljujemo.", score: 27, source: "onedrive" }]
    },
    validAnswer: "Knjige za osnovnu školu ne otkupljujemo.",
    wrongAnswer: "Otkupljujemo sve knjige za osnovnu školu.",
    requiredPatterns: [/osnovn\w*\s+škol/i, /ne otkupljujemo/i]
  },
  {
    id: "faculty",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Otkup fakulteta\nSadržaj: Fakultetske knjige ne otkupljujemo.",
      articles: [{ title: "Otkup fakulteta", body: "Fakultetske knjige ne otkupljujemo.", score: 27, source: "onedrive" }]
    },
    validAnswer: "Fakultetske knjige ne otkupljujemo.",
    wrongAnswer: "Otkupljujemo sve knjige za fakultet.",
    requiredPatterns: [/fakultet/i, /ne otkupljujemo/i]
  },
  {
    id: "romanesque",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Romani i beletristika\nSadržaj: Romane i beletristiku ne otkupljujemo.",
      articles: [{ title: "Romani i beletristika", body: "Romane i beletristiku ne otkupljujemo.", score: 27, source: "onedrive" }]
    },
    validAnswer: "Romane i beletristiku ne otkupljujemo.",
    wrongAnswer: "Romane otkupljujemo bez ograničenja.",
    requiredPatterns: [/(romane|beletristik)/i, /ne otkupljujemo/i]
  },
  {
    id: "buyback-methods",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Načini otkupa\nSadržaj: Fizički otkup dostupan je osobnim dolaskom, a online otkup slanjem knjiga kurirskom službom.",
      articles: [{ title: "Načini otkupa", body: "Fizički otkup dostupan je osobnim dolaskom, a online otkup slanjem knjiga kurirskom službom.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Fizički otkup dostupan je osobnim dolaskom, a online otkup slanjem knjiga kurirskom službom.",
    wrongAnswer: "Postoji samo fizički otkup.",
    requiredPatterns: [/Fizički otkup/i, /online otkup/i]
  },
  {
    id: "physical-address",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Adresa poslovnice\nSadržaj: Za fizički otkup dođite na Županijsku 17, Osijek.",
      articles: [{ title: "Adresa poslovnice", body: "Za fizički otkup dođite na Županijsku 17, Osijek.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Za fizički otkup dođite na Županijsku 17, Osijek.",
    wrongAnswer: "Poslovnica je na Trgu bana Jelačića u Zagrebu.",
    requiredPatterns: [/Županijsk\w*\s+17/i, /Osijek/i]
  },
  {
    id: "physical-bring",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Što donijeti\nSadržaj: Za fizički otkup trebate knjige, OIB ili broj osobne i otkupni blok.",
      articles: [{ title: "Što donijeti", body: "Za fizički otkup trebate knjige, OIB ili broj osobne i otkupni blok.", score: 29, source: "onedrive" }]
    },
    validAnswer: "Za fizički otkup trebate knjige, OIB ili broj osobne i otkupni blok.",
    wrongAnswer: "Potrebna je samo osobna iskaznica.",
    requiredPatterns: [/(OIB|broj osobne)/i, /otkupni blok/i]
  },
  {
    id: "physical-payment",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Isplata u poslovnici\nSadržaj: Kod fizičkog otkupa isplata je odmah u gotovini na blagajni.",
      articles: [{ title: "Isplata u poslovnici", body: "Kod fizičkog otkupa isplata je odmah u gotovini na blagajni.", score: 29, source: "onedrive" }]
    },
    validAnswer: "Kod fizičkog otkupa isplata je odmah u gotovini na blagajni.",
    wrongAnswer: "Isplata stiže za 7 dana na račun.",
    requiredPatterns: [/odmah/i, /gotovin/i]
  },
  {
    id: "same-title",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Više istih naslova\nSadržaj: Za 20+ istog udžbenika potrebno je odobrenje direktora.",
      articles: [{ title: "Više istih naslova", body: "Za 20+ istog udžbenika potrebno je odobrenje direktora.", score: 27, source: "onedrive" }]
    },
    validAnswer: "Za 20+ istog udžbenika potrebno je odobrenje direktora.",
    wrongAnswer: "Nema ograničenja za iste naslove.",
    requiredPatterns: [/20\+/i, /odobrenje direktora/i]
  },
  {
    id: "online-small-shipping",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Dostava za manje pošiljke\nSadržaj: Za 3 ili manje knjiga trošak dostave kod online otkupa iznosi 2,70 EUR.",
      articles: [{ title: "Dostava za manje pošiljke", body: "Za 3 ili manje knjiga trošak dostave kod online otkupa iznosi 2,70 EUR.", score: 30, source: "onedrive" }]
    },
    validAnswer: "Za 3 ili manje knjiga trošak dostave kod online otkupa iznosi 2,70 EUR.",
    wrongAnswer: "Za tri knjige dostava je besplatna.",
    requiredPatterns: [/2,70 EUR/i, /3 ili manje knjiga/i]
  },
  {
    id: "online-free-shipping",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Besplatna dostava\nSadržaj: Dostava je besplatna za 4 ili više knjiga kod online otkupa.",
      articles: [{ title: "Besplatna dostava", body: "Dostava je besplatna za 4 ili više knjiga kod online otkupa.", score: 30, source: "onedrive" }]
    },
    validAnswer: "Dostava je besplatna za 4 ili više knjiga kod online otkupa.",
    wrongAnswer: "Besplatna dostava vrijedi tek od 10 knjiga.",
    requiredPatterns: [/BESPLATNA|besplatna/i, /4 ili više knjiga/i]
  },
  {
    id: "online-payout",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Online isplata\nSadržaj: Isplata online otkupa ide isti dan ili sljedeći radni dan.",
      articles: [{ title: "Online isplata", body: "Isplata online otkupa ide isti dan ili sljedeći radni dan.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Isplata online otkupa ide isti dan ili sljedeći radni dan.",
    wrongAnswer: "Isplata ide unutar 14 dana.",
    requiredPatterns: [/isti dan/i, /(sljedeći|idući) radni dan/i]
  },
  {
    id: "aircash",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Aircash\nSadržaj: Isplata na Aircash nije dostupna.",
      articles: [{ title: "Aircash", body: "Isplata na Aircash nije dostupna.", score: 27, source: "onedrive" }]
    },
    validAnswer: "Isplata na Aircash nije dostupna.",
    wrongAnswer: "Aircash je podržan za sve isplate.",
    requiredPatterns: [/Aircash/i, /nije dostupna|ne vršimo isplatu/i]
  },
  {
    id: "package-label",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Naljepnica za paket\nSadržaj: Dostavljač donosi naljepnicu, a Vi ništa ne pišete na paket.",
      articles: [{ title: "Naljepnica za paket", body: "Dostavljač donosi naljepnicu, a Vi ništa ne pišete na paket.", score: 29, source: "onedrive" }]
    },
    validAnswer: "Dostavljač donosi naljepnicu, a Vi ništa ne pišete na paket.",
    wrongAnswer: "Sami trebate napisati adresu i isprintati naljepnicu.",
    requiredPatterns: [/naljepnic/i, /ništa ne pišete na paket/i]
  },
  {
    id: "self-dropoff",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Samostalna predaja paketa\nSadržaj: Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat.",
      articles: [{ title: "Samostalna predaja paketa", body: "Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat.",
    wrongAnswer: "Paket možete sami odnijeti u bilo koji paketomat.",
    requiredPatterns: [/nemamo tu opciju|Nemamo opciju/i]
  },
  {
    id: "courier-no-show",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Dostavljač nije došao\nSadržaj: Ako dostavljač nije došao, javite se na info@antikvarijat-libar.com ili putem chata.",
      articles: [{ title: "Dostavljač nije došao", body: "Ako dostavljač nije došao, javite se na info@antikvarijat-libar.com ili putem chata.", score: 28, source: "onedrive" }]
    },
    validAnswer: "Ako dostavljač nije došao, javite se na info@antikvarijat-libar.com ili putem chata.",
    wrongAnswer: "Ako dostavljač ne dođe, ne možemo pomoći.",
    requiredPatterns: [/nije došao/i, /(info@antikvarijat-libar\.com|putem chata)/i]
  },
  {
    id: "loyalty",
    knowledge: {
      context: "Izvor 1 (OneDrive):\nNaslov: Loyalty program\nSadržaj: Nakon 5 udžbenika ostvarujete 5% popusta, nakon 8 udžbenika 10% popusta, a nakon 11 udžbenika besplatnu dostavu.",
      articles: [{ title: "Loyalty program", body: "Nakon 5 udžbenika ostvarujete 5% popusta, nakon 8 udžbenika 10% popusta, a nakon 11 udžbenika besplatnu dostavu.", score: 27, source: "onedrive" }]
    },
    validAnswer: "Nakon 5 udžbenika ostvarujete 5% popusta, nakon 8 udžbenika 10% popusta, a nakon 11 udžbenika besplatnu dostavu.",
    wrongAnswer: "Loyalty program daje 20% popusta već nakon 3 udžbenika.",
    requiredPatterns: [/(5 udžbenika|8 udžbenika|11 udžbenika)/i, /(5%|10%|besplatnu dostavu)/i]
  }
];

function buildValidAnswerCases(baseCase) {
  return CHANNELS.map((channel) => ({
    id: `${baseCase.id}-${channel}-valid`,
    channel,
    expectedValidity: true,
    expectedReason: "ok",
    knowledge: baseCase.knowledge,
    answer: baseCase.validAnswer,
    requiredPatterns: baseCase.requiredPatterns
  }));
}

function buildInvalidAnswerCases(baseCase) {
  return [
    {
      id: `${baseCase.id}-invalid-fact`,
      channel: "web_chat",
      expectedValidity: false,
      expectedReason: "unsupported_fact_signal",
      knowledge: baseCase.knowledge,
      answer: `${baseCase.wrongAnswer} Za detalje pišite na krivi-podatak@example.com.`
    },
    {
      id: `${baseCase.id}-invalid-internal`,
      channel: "email",
      expectedValidity: false,
      expectedReason: "internal_process_leak",
      knowledge: baseCase.knowledge,
      answer: `Prema našoj bazi znanja i internom kontekstu: ${baseCase.validAnswer}`
    },
    {
      id: `${baseCase.id}-invalid-dump`,
      channel: "facebook",
      expectedValidity: false,
      expectedReason: ["invalid_generated_reply", "low_knowledge_overlap"],
      knowledge: baseCase.knowledge,
      answer: `Članak radno vrijeme dostava adresa ${baseCase.knowledge.articles[0].title}`
    }
  ];
}

const goldenAnswerCases = BASE_CASES.flatMap((baseCase) => [
  ...buildValidAnswerCases(baseCase),
  ...buildInvalidAnswerCases(baseCase)
]);

module.exports = {
  BASE_CASES,
  CHANNELS,
  goldenAnswerCases
};
