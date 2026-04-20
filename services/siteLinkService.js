const { normalizeForComparison } = require("./textUtils");

const BASE_URL = "https://antikvarijat-libar.com";

const DIRECT_LINKS = {
  homepage: {
    url: `${BASE_URL}/`,
    label: "Početna"
  },
  buyback: {
    url: `${BASE_URL}/prodaj-udzbenike/`,
    label: "Otkup udžbenika"
  },
  buybackLoyalty: {
    url: `${BASE_URL}/program-vjernosti/`,
    label: "Program vjernosti"
  },
  buyBooks: {
    url: `${BASE_URL}/kupi-udzbenike/`,
    label: "Kupi udžbenike"
  },
  delivery: {
    url: `${BASE_URL}/troskovi-isporuke/`,
    label: "Načini dostave i prikupa"
  },
  payments: {
    url: `${BASE_URL}/nacini-placanja/`,
    label: "Načini plaćanja"
  },
  contact: {
    url: `${BASE_URL}/kontakt/`,
    label: "Kontakt"
  },
  faq: {
    url: `${BASE_URL}/najcesca-pitanja/`,
    label: "Najčešća pitanja"
  },
  about: {
    url: `${BASE_URL}/o-nama/`,
    label: "O nama"
  },
  terms: {
    url: `${BASE_URL}/uvjeti-poslovanja/`,
    label: "Uvjeti poslovanja"
  },
  privacy: {
    url: `${BASE_URL}/zastita-osobnih-podataka/`,
    label: "Zaštita osobnih podataka"
  },
  cancellation: {
    url: `${BASE_URL}/pravo-na-jednostrani-raskid-ugovora/`,
    label: "Pravo na jednostrani raskid ugovora"
  },
  news: {
    url: `${BASE_URL}/novosti/`,
    label: "Novosti"
  }
};

function containsAny(normalizedText = "", phrases = []) {
  return phrases.some((phrase) => normalizedText.includes(normalizeForComparison(phrase)));
}

function pushUnique(target, linkKey) {
  if (!linkKey || !DIRECT_LINKS[linkKey]) {
    return;
  }

  if (!target.includes(linkKey)) {
    target.push(linkKey);
  }
}

function chooseLinkKeys({ conversation = null, knowledge = null, outcome = null } = {}) {
  const query = normalizeForComparison(
    conversation?.standaloneQuery ||
      conversation?.summary ||
      outcome?.customerMessage ||
      ""
  );
  const taskIntent = String(conversation?.reasoningResult?.taskIntent || "").trim();
  const actionIntent = String(conversation?.reasoningResult?.actionIntent || "").trim();
  const primaryIntent = String(conversation?.reasoningResult?.primaryIntent || "").trim();
  const source = String(knowledge?.primarySource || outcome?.source || "").trim();
  const links = [];

  if (containsAny(query, ["program vjernosti", "vjernost", "bonus", "sjedi 5"])) {
    pushUnique(links, "buybackLoyalty");
    pushUnique(links, "buyback");
  }

  if (
    taskIntent === "support_info" &&
    containsAny(query, [
      "plaćanje",
      "placanje",
      "načini plaćanja",
      "nacini placanja",
      "kartica",
      "gotovina",
      "pouzeće",
      "pouzece"
    ])
  ) {
    pushUnique(links, "payments");
  }

  if (
    taskIntent === "delivery" ||
    containsAny(query, ["dostava", "isporuka", "paketomat", "gls", "boxnow", "preuzimanje"])
  ) {
    pushUnique(links, "delivery");
    if (containsAny(query, ["otkup", "prodati knjige", "prodaja knjiga"])) {
      pushUnique(links, "buyback");
    }
  }

  if (
    taskIntent === "support_info" &&
    containsAny(query, ["kontakt", "radno vrijeme", "adresa", "telefon", "email", "mail", "gdje ste"])
  ) {
    pushUnique(links, "contact");
  }

  if (
    taskIntent === "buyback" ||
    primaryIntent === "otkup_upit" ||
    containsAny(query, ["otkup", "prodati knjige", "prodaja knjiga", "procjena", "vrednovanje"])
  ) {
    pushUnique(links, "buyback");
    pushUnique(links, "faq");
  }

  if (
    taskIntent === "product_lookup" ||
    primaryIntent === "product_availability" ||
    primaryIntent === "product_pricing" ||
    source === "product_feed" ||
    containsAny(query, ["kupi", "kupiti", "udžbenik", "udzbenik", "kupnja"])
  ) {
    pushUnique(links, "buyBooks");
    pushUnique(links, "faq");
  }

  if (containsAny(query, ["povrat", "refund", "raskid ugovora"])) {
    pushUnique(links, "cancellation");
    pushUnique(links, "terms");
  }

  if (containsAny(query, ["uvjeti", "uvjeti poslovanja"])) {
    pushUnique(links, "terms");
  }

  if (containsAny(query, ["privatnost", "osobni podaci", "gdpr", "zaštita podataka", "zastita podataka"])) {
    pushUnique(links, "privacy");
  }

  if (containsAny(query, ["o vama", "o nama", "tko ste"])) {
    pushUnique(links, "about");
  }

  if (
    actionIntent === "ask_info" ||
    containsAny(query, ["faq", "često", "cesto", "najčešća pitanja", "najcesca pitanja"])
  ) {
    pushUnique(links, "faq");
  }

  if (containsAny(query, ["novosti", "akcija", "kupon", "vijesti"])) {
    pushUnique(links, "news");
  }

  if (links.length === 0) {
    pushUnique(links, "homepage");
  }

  return links.slice(0, 2);
}

function buildDirectWebsiteLinks({ conversation = null, knowledge = null, outcome = null } = {}) {
  return chooseLinkKeys({ conversation, knowledge, outcome })
    .map((key) => DIRECT_LINKS[key])
    .filter(Boolean);
}

module.exports = {
  BASE_URL,
  DIRECT_LINKS,
  buildDirectWebsiteLinks
};
