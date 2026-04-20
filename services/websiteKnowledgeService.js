const { DIRECT_LINKS } = require("./siteLinkService");
const {
  findBestExcerpt,
  preprocessSearchQuery,
  scoreSearchText
} = require("./searchUtils");

const WEBSITE_PAGES = [
  {
    key: "buyback",
    title: "Prodaj udžbenike",
    url: DIRECT_LINKS.buyback.url,
    body:
      "Stranica opisuje kako prodati udžbenike Antikvarijatu Libar. Naglašeni su postupak otkupa, slanje popisa ili skeniranje barkod brojeva, procjena knjiga i isplata nakon potvrde otkupa.",
    keywords: [
      "otkup knjiga",
      "prodaja knjiga",
      "prodaj udžbenike",
      "postupak otkupa",
      "procjena knjiga",
      "barkod",
      "isplata"
    ],
    intents: ["buyback", "support_info"]
  },
  {
    key: "buybackLoyalty",
    title: "Program vjernosti",
    url: DIRECT_LINKS.buybackLoyalty.url,
    body:
      "Stranica objašnjava pogodnosti programa vjernosti povezanog s otkupom i kupnjom udžbenika, uključujući bonus model i korištenje pogodnosti pri budućim kupnjama.",
    keywords: [
      "program vjernosti",
      "bonus",
      "bodovi",
      "otkup bonus"
    ],
    intents: ["buyback", "support_info"]
  },
  {
    key: "buyBooks",
    title: "Kupi udžbenike",
    url: DIRECT_LINKS.buyBooks.url,
    body:
      "Stranica vodi korisnika prema kupnji udžbenika i pretraživanju ponude. Relevantna je za pitanja o kupnji, dostupnosti, naručivanju i općim informacijama o webshopu.",
    keywords: [
      "kupi udžbenike",
      "kupnja knjiga",
      "webshop",
      "dostupnost",
      "naručivanje"
    ],
    intents: ["product_lookup", "support_info"]
  },
  {
    key: "delivery",
    title: "Načini dostave i prikupa",
    url: DIRECT_LINKS.delivery.url,
    body:
      "Stranica sadrži informacije o načinima dostave i prikupa, rokovima isporuke, troškovima dostave te opcijama preuzimanja narudžbe.",
    keywords: [
      "dostava",
      "isporuka",
      "rok dostave",
      "trošak dostave",
      "preuzimanje",
      "prikup"
    ],
    intents: ["delivery", "support_info", "order_status"]
  },
  {
    key: "payments",
    title: "Načini plaćanja",
    url: DIRECT_LINKS.payments.url,
    body:
      "Stranica objašnjava dostupne načine plaćanja, uključujući kartice, gotovinu, pouzeće i druge metode koje webshop podržava.",
    keywords: [
      "načini plaćanja",
      "plaćanje",
      "kartica",
      "gotovina",
      "pouzeće"
    ],
    intents: ["support_info"]
  },
  {
    key: "contact",
    title: "Kontakt",
    url: DIRECT_LINKS.contact.url,
    body:
      "Stranica s kontakt informacijama, adresom poslovnice, radnim vremenom te osnovnim kanalima za javljanje kupaca i prodavatelja.",
    keywords: [
      "kontakt",
      "radno vrijeme",
      "adresa",
      "telefon",
      "email",
      "lokacija"
    ],
    intents: ["support_info"]
  },
  {
    key: "faq",
    title: "Najčešća pitanja",
    url: DIRECT_LINKS.faq.url,
    body:
      "FAQ stranica okuplja odgovore na česta pitanja o kupnji, otkupu, narudžbama, dostavi, plaćanju i pravilima poslovanja.",
    keywords: [
      "faq",
      "najčešća pitanja",
      "cesta pitanja",
      "otkup",
      "dostava",
      "plaćanje"
    ],
    intents: ["support_info", "buyback", "delivery", "order_status"]
  },
  {
    key: "about",
    title: "O nama",
    url: DIRECT_LINKS.about.url,
    body:
      "Stranica predstavlja Antikvarijat Libar, njegovu djelatnost, fokus na udžbenike i opće informacije o poslovnici i ponudi.",
    keywords: [
      "o nama",
      "antikvarijat libar",
      "tko ste",
      "poslovnica"
    ],
    intents: ["support_info"]
  },
  {
    key: "terms",
    title: "Uvjeti poslovanja",
    url: DIRECT_LINKS.terms.url,
    body:
      "Stranica s uvjetima poslovanja, pravilima kupnje, obvezama korisnika i trgovca te općim uvjetima koji vrijede za narudžbe i webshop.",
    keywords: [
      "uvjeti poslovanja",
      "pravila kupnje",
      "uvjeti",
      "opći uvjeti"
    ],
    intents: ["support_info", "order_issue", "complaint"]
  },
  {
    key: "privacy",
    title: "Zaštita osobnih podataka",
    url: DIRECT_LINKS.privacy.url,
    body:
      "Stranica opisuje obradu osobnih podataka, privatnost, GDPR prava korisnika i pravila zaštite podataka na web stranici i u webshopu.",
    keywords: [
      "zaštita osobnih podataka",
      "privatnost",
      "gdpr",
      "osobni podaci"
    ],
    intents: ["support_info"]
  },
  {
    key: "cancellation",
    title: "Pravo na jednostrani raskid ugovora",
    url: DIRECT_LINKS.cancellation.url,
    body:
      "Stranica objašnjava pravo kupca na jednostrani raskid ugovora, rokove, uvjete povrata i postupak za ostvarivanje tog prava.",
    keywords: [
      "raskid ugovora",
      "povrat",
      "refund",
      "rok za povrat"
    ],
    intents: ["complaint", "order_issue", "support_info"]
  },
  {
    key: "news",
    title: "Novosti",
    url: DIRECT_LINKS.news.url,
    body:
      "Stranica s novostima, obavijestima i aktualnim sadržajem Antikvarijata Libar. Korisna je za upite o akcijama i općim novostima.",
    keywords: [
      "novosti",
      "akcije",
      "vijesti",
      "obavijesti"
    ],
    intents: ["support_info"]
  }
];

function normalizeIntent(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildWebsiteText(entry) {
  return [
    entry.title,
    entry.body,
    ...(Array.isArray(entry.keywords) ? entry.keywords : [])
  ].join(" ");
}

function scoreWebsitePage(entry, query, options = {}) {
  const taskIntent = normalizeIntent(options.taskIntent);
  const activeDomain = normalizeIntent(options.activeDomain);
  const actionIntent = normalizeIntent(options.actionIntent);
  const pageText = buildWebsiteText(entry);
  let score = scoreSearchText(pageText, query);

  if (taskIntent && entry.intents.includes(taskIntent)) {
    score += 5;
  }

  if (activeDomain && entry.intents.includes(activeDomain)) {
    score += 3;
  }

  if (actionIntent === "ask_how_to" && /(postupak|koraci|kako)/i.test(pageText)) {
    score += 4;
  }

  if (entry.key === "faq" && score > 0) {
    score -= 2;
  }

  return score;
}

async function searchWebsiteKnowledgeDetailed(query, options = {}) {
  const processedQuery = preprocessSearchQuery(query, options);
  const articles = WEBSITE_PAGES
    .map((entry) => {
      const score = scoreWebsitePage(entry, processedQuery, options);
      return {
        title: entry.title,
        url: entry.url,
        body: findBestExcerpt(entry.body, processedQuery, 700) || entry.body,
        score,
        source: "website",
        pageKey: entry.key
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return {
    articles
  };
}

module.exports = {
  WEBSITE_PAGES,
  searchWebsiteKnowledgeDetailed
};
