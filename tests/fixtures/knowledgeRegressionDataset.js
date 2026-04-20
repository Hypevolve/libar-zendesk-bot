const CHANNEL_SEQUENCE = ["web_chat", "facebook", "email", "web_chat"];

const FACT_GROUPS = [
  {
    id: "buyback-basic-school",
    patterns: [/(osnovu|osnovn\w*)\s+škol/i, /ne otkupljujemo/i],
    questions: [
      "Otkupljujete li knjige za osnovnu školu?",
      "Mogu li vam prodati udžbenike za osnovnu školu?",
      "Primate li osnovnoškolske udžbenike na otkup?",
      "Da li kupujete knjige za osnovnu školu?"
    ]
  },
  {
    id: "buyback-faculty-books",
    patterns: [/fakultet/i, /ne otkupljujemo/i],
    questions: [
      "Otkupljujete li knjige za fakultet?",
      "Mogu li vam prodati fakultetske knjige?",
      "Primate li skripte i knjige za fakultet?",
      "Kupujete li fakultetske udžbenike?"
    ]
  },
  {
    id: "buyback-romanesque",
    patterns: [/(romane|beletristik)/i, /ne otkupljujemo/i],
    questions: [
      "Otkupljujete li romane i beletristiku?",
      "Mogu li prodati romane kod vas?",
      "Primate li beletristiku na otkup?",
      "Kupujete li knjige koje nisu školski udžbenici, tipa romane?"
    ]
  },
  {
    id: "buyback-methods",
    patterns: [/(Fizički otkup dostupan je samo osobnim dolaskom|Donosite knjige osobno|Donosite knjige u poslovnicu)/i, /(putem online otkupa možete nam poslati knjige|Online otkup|Knjige šaljete kurirskom službom)/i],
    questions: [
      "Na koje načine mogu predati knjige za otkup?",
      "Koje opcije otkupa nudite?",
      "Mogu li knjige donijeti osobno ili ih moram slati?",
      "Kako sve mogu prodati knjige vama?"
    ]
  },
  {
    id: "physical-buyback-address",
    patterns: [/Županijska 17/i, /Osijek/i],
    questions: [
      "Na koju adresu mogu osobno donijeti knjige za otkup?",
      "Gdje dolazim ako želim fizički otkup?",
      "Koja je adresa poslovnice za osobni otkup?",
      "Kamo da dođem s knjigama ako ih nosim osobno?"
    ]
  },
  {
    id: "physical-buyback-what-to-bring",
    patterns: [/(OIB|broj osobne)/i, /otkupni blok/i],
    questions: [
      "Što trebam donijeti sa sobom za fizički otkup?",
      "Treba li mi neki dokument kad nosim knjige u poslovnicu?",
      "Koje podatke trebate kod osobnog otkupa?",
      "Moram li imati OIB ili osobnu kad donosim knjige?"
    ]
  },
  {
    id: "physical-buyback-payment",
    patterns: [/(Odmah|na licu mjesta)/i, /(gotovin|isplaćujemo)/i],
    questions: [
      "Kada dobijem novac kod fizičkog otkupa?",
      "Isplaćujete li odmah u poslovnici?",
      "Dobivam li gotovinu odmah kad donesem knjige?",
      "Kako ide isplata ako dođem osobno?"
    ]
  },
  {
    id: "same-title-limit",
    patterns: [/20\+/i, /odobrenje direktora/i],
    questions: [
      "Što ako donesem više od 20 istih udžbenika?",
      "Postoji li ograničenje za puno istih knjiga?",
      "Treba li posebno odobrenje ako imam 20+ istog naslova?",
      "Kako ide otkup ako imam hrpu istih udžbenika?"
    ]
  },
  {
    id: "online-buyback-small-shipping",
    patterns: [/2,70 EUR/i, /3 ili manje knjiga/i],
    questions: [
      "Koliko košta dostava kod online otkupa za 3 knjige?",
      "Plaćam li dostavu ako šaljem samo tri knjige na otkup?",
      "Koji je trošak online otkupa za manje od 4 knjige?",
      "Koliko me izađe slanje ako prodajem jednu do tri knjige?"
    ]
  },
  {
    id: "online-buyback-free-shipping",
    patterns: [/BESPLATNA/i, /4 ili više knjiga/i],
    questions: [
      "Kada je dostava besplatna kod online otkupa?",
      "Plaćam li slanje ako šaljem četiri knjige?",
      "Od koliko knjiga vi pokrivate dostavu za online otkup?",
      "Je li online otkup besplatan za 4+ knjige?"
    ]
  },
  {
    id: "online-buyback-payout-timing",
    patterns: [/isti dan/i, /(sljedeći|idući) radni dan/i],
    questions: [
      "Kad isplaćujete online otkup nakon što primite paket?",
      "Koliko čekam novac kad vam pošaljem knjige?",
      "Je li isplata online otkupa isti dan?",
      "Može li isplata online otkupa biti idući radni dan?"
    ]
  },
  {
    id: "aircash-unavailable",
    patterns: [/Aircash/i, /(nije dostupna|ne vršimo isplatu|nije dostupn)/i],
    questions: [
      "Isplaćujete li na Aircash?",
      "Mogu li za otkup dobiti novac na Aircash?",
      "Podržavate li Aircash za isplatu?",
      "Je li Aircash opcija za otkup?"
    ]
  },
  {
    id: "package-label",
    patterns: [/naljepnic/i, /Vi ništa ne pišete na paket/i],
    questions: [
      "Moram li sam pisati adresu na paket za online otkup?",
      "Tko donosi naljepnicu za paket kod online otkupa?",
      "Pišem li ja podatke na paket kad šaljem knjige?",
      "Dolazi li dostavljač s gotovom naljepnicom?"
    ]
  },
  {
    id: "no-self-dropoff",
    patterns: [/nemamo tu opciju/i],
    questions: [
      "Mogu li sam odnijeti paket u GLS ili BOXNOW paketomat?",
      "Mogu li osobno predati paket za online otkup u paketomat?",
      "Je li moguće da ja sam odnesem pošiljku u GLS?",
      "Mogu li sam ubaciti paket u BOXNOW umjesto da čekam dostavljača?"
    ]
  },
  {
    id: "courier-no-show",
    patterns: [/nije došao/i, /(info@antikvarijat-libar\.com|putem chata)/i],
    questions: [
      "Što ako dostavljač ne dođe po paket?",
      "Kome da se javim ako kurir nije došao na dogovoreni datum?",
      "Dostavljač nije pokupio paket, što sad?",
      "Kako rješavam ako se preuzimanje nije dogodilo?"
    ]
  },
  {
    id: "home-delivery-price",
    patterns: [/5,97 EUR/i, /(GLS|MBE)/i],
    questions: [
      "Kolika je dostava na kućnu adresu?",
      "Koja je cijena GLS ili MBE dostave na adresu?",
      "Koliko košta slanje na kućnu adresu za kupnju knjiga?",
      "Cijena dostave doma preko GLS-a?"
    ]
  },
  {
    id: "locker-delivery-price",
    patterns: [/3,50 EUR/i, /(BOXNOW|paketomat)/i],
    questions: [
      "Koliko košta BOXNOW paketomat?",
      "Koja je cijena dostave na paketomat?",
      "Kolika je dostava za BOXNOW ili GLS paketomat?",
      "Koliko naplaćujete dostavu u paketomat?"
    ]
  },
  {
    id: "delivery-times",
    patterns: [/(1 do 2 radna dana)/i, /(GLS|MBE|BOXNOW)/i],
    questions: [
      "Koliko traje dostava knjiga?",
      "Koliki su rokovi dostave za GLS i BOXNOW?",
      "Za koliko dana stiže narudžba?",
      "Koliko se čeka dostava udžbenika?"
    ]
  },
  {
    id: "tracking-info",
    patterns: [/tracking broj/i, /link za praćenje/i],
    questions: [
      "Kako mogu pratiti pošiljku?",
      "Gdje dobijem tracking za paket?",
      "Šaljete li link za praćenje narudžbe?",
      "Kako saznam gdje mi je paket?"
    ]
  },
  {
    id: "working-hours",
    patterns: [/08:00\s*[–-]\s*20:00/i, /08:00\s*[–-]\s*13:00/i],
    questions: [
      "Koje vam je radno vrijeme preko tjedna i subotom?",
      "Kad radite radnim danom i subotom?",
      "Možete li mi napisati radno vrijeme poslovnice?",
      "Od koliko do koliko ste otvoreni?"
    ]
  },
  {
    id: "contact-channels",
    patterns: [/(031-201-230|Telefon)/i, /1 radnog dana/i],
    questions: [
      "Kako vas mogu kontaktirati i koliko odgovarate na email?",
      "Koji su vam kontakti i rok odgovora na mail?",
      "Imate li telefon i koliko se čeka odgovor emailom?",
      "Kako se mogu javiti i kada odgovarate?"
    ]
  },
  {
    id: "r1-invoice",
    patterns: [/R1 račun/i, /nije automatski/i, /info@antikvarijat-libar\.com/i],
    questions: [
      "Kako mogu dobiti R1 račun?",
      "Izdajete li R1 i kako ga tražim?",
      "Treba mi R1 račun za firmu, što trebam napraviti?",
      "Može li se R1 račun zatražiti emailom?"
    ]
  },
  {
    id: "installments",
    patterns: [/(2 do 6 rata)/i, /(PBZ|ZABA)/i],
    questions: [
      "Mogu li platiti na rate?",
      "Imate li obročno plaćanje karticama?",
      "Na koliko rata mogu platiti i za koje banke?",
      "Podržavate li PBZ ili ZABA rate?"
    ]
  },
  {
    id: "return-and-exchange",
    patterns: [/2 tjedna/i, /račun/i],
    questions: [
      "Koliki je rok za povrat ili zamjenu knjige?",
      "Do kada mogu vratiti pogrešan udžbenik?",
      "Koliki je rok i trebam li račun za povrat knjige?",
      "Kako ide povrat i koji je rok ako sam dobio krivi udžbenik?"
    ]
  },
  {
    id: "loyalty-program",
    patterns: [/(5 udžbenika|Ukupno 8 udžbenika|Ukupno 11 udžbenika)/i, /(5%|10%|Besplatna dostava)/i],
    questions: [
      "Kako radi loyalty program?",
      "Koje su nagrade ako prodam više udžbenika online?",
      "Što dobijem nakon 5, 8 ili 11 prodanih udžbenika?",
      "Postoje li popusti za vjerne kupce?"
    ]
  }
];

const knowledgeRegressionCases = FACT_GROUPS.flatMap((group) =>
  group.questions.map((query, index) => ({
    id: `${group.id}-${index + 1}`,
    channel: CHANNEL_SEQUENCE[index % CHANNEL_SEQUENCE.length],
    query,
    patterns: group.patterns
  }))
);

module.exports = {
  FACT_GROUPS,
  knowledgeRegressionCases
};
