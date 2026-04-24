const {
  stripHtml: sharedStripHtml,
  normalizeForSearch
} = require("./textUtils");

function stripHtml(html = "") {
  return sharedStripHtml(html);
}

function normalizeText(text = "") {
  return normalizeForSearch(text);
}

const STOP_WORDS = new Set([
  "a",
  "ali",
  "bi",
  "da",
  "do",
  "ga",
  "i",
  "ih",
  "ili",
  "iz",
  "je",
  "li",
  "me",
  "mi",
  "na",
  "ne",
  "od",
  "po",
  "sam",
  "se",
  "sto",
  "su",
  "te",
  "to",
  "u",
  "uz",
  "vam",
  "vas",
  "za"
]);

const QUERY_ALIASES = [
  {
    pattern: /\b(radno vrijeme|kad radite|otvoreni|radite li|working hours)\b/,
    terms: ["radno vrijeme", "otvoreni", "ponedjeljak", "subota"]
  },
  {
    pattern: /\b(adresa|gdje ste|lokacija|kontakt|telefon|email)\b/,
    terms: ["adresa", "lokacija", "kontakt", "telefon", "email"]
  },
  {
    pattern: /\b(adresa|gdje|lokacija).*\b(otkup\w*|poslovnic\w*|osobn\w*|fizick\w*)\b|\b(otkup\w*|poslovnic\w*|osobn\w*|fizick\w*).*\b(adresa|gdje|lokacija)\b/u,
    terms: ["zupanijska 17", "osijek", "fizicki otkup", "osobni dolazak", "poslovnica"]
  },
  {
    pattern: /\b(dostava|dostavn\w*|isporuka|pošiljka|posiljka|kurir|rok dostave)\b/,
    terms: ["dostava", "isporuka", "pošiljka", "rok dostave", "kurir"]
  },
  {
    pattern: /\b(naru[cč]iti|naruciti|kupiti|kupovina|kupnja|kupi).*\b(knjig\w*|udzben\w*|udžben\w*)\b|\b(knjig\w*|udzben\w*|udžben\w*)\b.*\b(naru[cč]iti|naruciti|kupiti|kupovina|kupnja|kupi)\b/u,
    terms: [
      "kako naruciti udzbenike",
      "udzbenike mozete kupiti putem webshopa",
      "kupi udzbenike",
      "pretrazivanje po sifri artikla",
      "pretrazivanje po nazivu knjige",
      "dodajte ga u kosaricu",
      "dostava rokovi troskovi pracenje"
    ]
  },
  {
    pattern: /\b(stanje zaliha|na stanju|po trgovin\w*|u trgovin\w*)\b|\b(knjig\w*|udzben\w*|udžben\w*|artikal|artikl\w*|naslov)\b.{0,50}\b(dostupnost|dostupn\w*|nedostup\w*)\b|\b(dostupnost|dostupn\w*|nedostup\w*)\b.{0,50}\b(knjig\w*|udzben\w*|udžben\w*|artikal|artikl\w*|naslov)\b/u,
    terms: [
      "knjiga nije dostupna sto napraviti",
      "provjerite dostupnost na webu",
      "pretraga na webu prikazuje stanje zaliha",
      "stanje zaliha u stvarnom vremenu",
      "ako knjiga nije dostupna",
      "zalihe se mijenjaju"
    ]
  },
  {
    pattern: /\b(zavr[sš]iti kupnju|kako zavr[sš]iti|dodati u ko(?:[sš]|\s*)aricu|ubacim u ko(?:[sš]|\s*)aricu|ubaciti u ko(?:[sš]|\s*)aricu|ne vidim ko(?:[sš]|\s*)aricu|ko(?:[sš]|\s*)aric\w*|kosaric\w*)\b/u,
    terms: [
      "kako naruciti udzbenike",
      "iz rezultata odaberite zeljeni naslov",
      "dodajte ga u kosaricu",
      "pretrazivanje funkcionira",
      "sifra artikla",
      "naziv knjige",
      "isbn"
    ]
  },
  {
    pattern: /\b(bar\s*kod|barkod|isbn).*\b(nedostup\w*|ne mogu dodati|ko[sš]ar\w*|kupiti|naruciti|naru[cč]iti)\b|\b(nedostup\w*|ne mogu dodati|ko[sš]ar\w*|kupiti|naruciti|naru[cč]iti)\b.*\b(bar\s*kod|barkod|isbn)\b/u,
    terms: [
      "knjiga nije dostupna sto napraviti",
      "provjerite dostupnost na webu",
      "pretraga na webu prikazuje stanje zaliha",
      "kako naruciti udzbenike",
      "sifra artikla",
      "isbn"
    ]
  },
  {
    pattern: /\b(fotografij\w*|slik\w*|privitak|privitku|upload|ubacim sliku|poslati sliku|posaljem sliku)\b/u,
    terms: [
      "posaljite fotografiju",
      "fotografiju racuna",
      "fotografiju sporne knjige",
      "info antikvarijat libar",
      "fb messenger",
      "putem chata"
    ]
  },
  {
    pattern: /\b(dostavn\w*\s+opcij\w*|opcij\w*\s+dostav\w*)\b/u,
    terms: [
      "dostava",
      "opcije dostave",
      "dostava na kucnu adresu",
      "boxnow paketomat",
      "osobno preuzimanje",
      "gls",
      "mbe"
    ]
  },
  {
    pattern: /\b(kucnu adresu|kućnu adresu|doma|na adresu)\b.*\b(dostava|slanje|kupnja|narudzba|narudžba)\b|\b(dostava|slanje|kupnja|narudzba|narudžba)\b.*\b(kucnu adresu|kućnu adresu|doma|na adresu)\b/u,
    terms: ["dostava na kucnu adresu", "gls", "mbe", "5 97 eur"]
  },
  {
    pattern: /\b(za koliko dana stize|za koliko dana stiže|koliko traje dostava|rok dostave|kada stize narudzba|kada stiže narudžba)\b/u,
    terms: ["1 do 2 radna dana", "gls", "mbe", "boxnow", "narudzbe saljemo iduci radni dan"]
  },
  {
    pattern: /\b(gls|boxnow|paketomat|tisak paket|overseas)\b/,
    terms: ["gls", "boxnow", "paketomat", "dostava", "isporuka", "cijena dostave"]
  },
  {
    pattern: /\b(3 knjige|tri knjige|3 udzbenika|tri udzbenika|manje od 4 knjige|manje od četiri knjige)\b/,
    terms: ["3 ili manje knjiga", "2 70 eur", "dostava", "online otkup"]
  },
  {
    pattern: /\b(samo tri knjige|jednu do tri knjige|3 knjige na otkup|manje od 4 knjige)\b/u,
    terms: ["3 ili manje knjiga", "2 70 eur", "dostava pri online otkupu"]
  },
  {
    pattern: /\b(cetiri knjige|četiri knjige|4\+ knjige|4 ili vise knjiga|4 ili više knjiga|besplatna dostava)\b/u,
    terms: ["4 ili vise knjiga", "dostava je besplatna", "mi pokrivamo trosak slanja", "online otkup"]
  },
  {
    pattern: /\b(dostava besplatna|besplatna kod online otkupa|online otkup besplatan)\b/u,
    terms: ["4 ili vise knjiga", "dostava je besplatna", "mi pokrivamo trosak slanja", "online otkup"]
  },
  {
    pattern: /\b(od koliko knjiga|koliko knjiga treba).*\b(besplatna|pokrivate dostavu|online otkup)\b|\b(besplatna|pokrivate dostavu|online otkup)\b.*\b(od koliko knjiga|koliko knjiga treba)\b/u,
    terms: ["4 ili vise knjiga", "dostava je besplatna", "mi pokrivamo trosak slanja", "online otkup"]
  },
  {
    pattern: /\b(što trebam donijeti|sto trebam donijeti|što donijeti|sto donijeti|fizick\w*\s+otkup|osobn\w*\s+dolazak)\b/u,
    terms: [
      "sto donijeti sa sobom",
      "knjige koje zelite prodati",
      "slozene i ciste",
      "oib ili broj osobne",
      "otkupni blok",
      "fizicki otkup",
      "osobni dolazak"
    ]
  },
  {
    pattern: /\b(dokument|osobna|osobnu|oib).*\b(poslovnic\w*|otkup\w*|knjige)\b|\b(poslovnic\w*|otkup\w*|knjige).*\b(dokument|osobna|osobnu|oib)\b/u,
    terms: [
      "sto donijeti sa sobom",
      "oib ili broj osobne",
      "otkupni blok",
      "knjige koje zelite prodati"
    ]
  },
  {
    pattern: /\b(kad|kada).*\b(novac|isplata|gotovina)\b.*\b(fizick\w*|poslovnic\w*|osobn\w*)\b|\b(fizick\w*|poslovnic\w*|osobn\w*)\b.*\b(kad|kada).*\b(novac|isplata|gotovina)\b/u,
    terms: [
      "fizicki otkup",
      "odmah gotovina na blagajni",
      "isplata je odmah u gotovini",
      "odmah pri predaji"
    ]
  },
  {
    pattern: /\b(isti\w*\s+knjig|isti\w*\s+udzbenik|puno istih knjiga|vise istih knjiga|više istih knjiga)\b/u,
    terms: [
      "20 istog udzbenika",
      "20+ istog udzbenika",
      "odobrenje direktora"
    ]
  },
  {
    pattern: /\b(hrpu istih udzbenika|hrpu istih knjiga|puno istih udzbenika)\b/u,
    terms: ["20+ istog udzbenika", "odobrenje direktora"]
  },
  {
    pattern: /\b(narudžba|narudzba|status narudžbe|broj narudžbe|order)\b/,
    terms: ["narudžba", "status", "broj narudžbe"]
  },
  {
    pattern: /\b(reklamacija|povrat|refund|oštećen|ostecen|kriva knjiga)\b/,
    terms: ["reklamacija", "povrat", "refund", "oštećen", "kriva knjiga"]
  },
  {
    pattern: /\b(otkup|procjena|procjenu|vrednovanje|prodati knjige|buyback)\b/,
    terms: ["otkup", "procjena", "vrednovanje", "prodati knjige", "bonus"]
  },
  {
    pattern: /\b(na koji način|koje opcije|kako mogu predati|predati knjige|donijeti osobno|poslati knjige)\b/u,
    terms: [
      "na koji nacin mozete predati knjige",
      "fizicki otkup",
      "online otkup",
      "donosite knjige osobno",
      "knjige saljete kurirskom sluzbom"
    ]
  },
  {
    pattern: /\b(osnovn\w*\s+škol|osnovn\w*\s+skol|fakultet\w*|beletristik\w*|roman\w*)\b/u,
    terms: [
      "osnovna skola",
      "ne otkupljujemo",
      "knjige za osnovnu skolu",
      "fakultet",
      "beletristika",
      "romani"
    ]
  },
  {
    pattern: /\b(plaćanje|placanje|kartica|gotovina|pouzeće|pouzece)\b/,
    terms: ["plaćanje", "kartica", "gotovina", "pouzeće"]
  },
  {
    pattern: /\b(aircash)\b/,
    terms: ["aircash", "isplata na aircash nije dostupna", "ne vrsimo isplatu"]
  },
  {
    pattern: /\b(dostavljac nije dosao|dostavljač nije došao|kurir nije dosao|kurir nije došao|nije pokupio paket|nije dosao po paket|nije došao po paket)\b/u,
    terms: ["sto ako dostavljac ne dode", "preuzimanje potvrdeno u sustavu", "kontaktirajte nas", "novi termin preuzimanja"]
  },
  {
    pattern: /\b(kontakt|kontakti|telefon|email|mail|odgovarate|rok odgovora)\b/u,
    terms: ["telefon", "031 201 230", "email", "odgovaramo u roku 1 radnog dana"]
  },
  {
    pattern: /\b(povrat|zamjena|vratiti|vracam|vraćam|krivi udzbenik|krivi udžbenik|racun za povrat|račun za povrat)\b/u,
    terms: ["povrat i zamjena", "unutar 2 tjedna", "predocenje racuna", "fotografiju racuna"]
  },
  {
    pattern: /\b(loyalty|vjern\w*\s+kup\w*|nagrade|popusti za vjerne|lojalnost)\b/u,
    terms: ["loyalty program", "5 udzbenika", "ukupno 8 udzbenika", "ukupno 11 udzbenika", "5 popusta", "10 popusta", "besplatna dostava"]
  }
];

function isAircashPayoutQuery(normalized = "") {
  return /\baircash\b/.test(normalized) && (
    /\b(otkup|isplat\w*|novac|dobiti|uplat\w*|racun|račun)\b/.test(normalized) ||
    /\bne vrsimo isplatu\b/.test(normalized)
  );
}

function uniqueNormalizedTerms(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value))
    .filter(Boolean))];
}

function tokenize(text = "") {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function expandQueryTerms(text = "") {
  const normalized = normalizeText(text);
  const expansions = [];
  const aircashPayoutQuery = isAircashPayoutQuery(normalized);

  for (const alias of QUERY_ALIASES) {
    if (aircashPayoutQuery && alias.terms.includes("knjiga nije dostupna sto napraviti")) {
      continue;
    }

    if (alias.pattern.test(normalized)) {
      expansions.push(...alias.terms);
    }
  }

  return uniqueNormalizedTerms(expansions);
}

function buildSearchLexicon(query = "") {
  const baseTerms = tokenize(query);
  const expandedTerms = expandQueryTerms(query);
  return uniqueNormalizedTerms([...baseTerms, ...expandedTerms]);
}

function truncateText(text, maxLength = 1800) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trim()}...`;
}

function preprocessSearchQuery(query = "", options = {}) {
  const conversationFacts = Array.isArray(options.conversationFacts)
    ? options.conversationFacts.map((fact) => String(fact || "").trim()).filter(Boolean)
    : [];
  const retrievalHints = Array.isArray(options.retrievalHints)
    ? options.retrievalHints.map((hint) => String(hint || "").trim()).filter(Boolean)
    : [];
  const baseQuery = String(query)
    .replace(/\r/g, " ")
    .replace(/^(pozdrav|bok|dobar dan|lijep pozdrav|hello|hi|hey)[,!.:\s-]*/i, "")
    .replace(/\b(zanima me|molim vas|molim|možete li mi reći|mozete li mi reci|imam pitanje|htio bih pitati|htjela bih pitati|hvala unaprijed|unaprijed hvala)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const expandedHints = expandQueryTerms(baseQuery);
  const suffixParts = [...conversationFacts, ...retrievalHints, ...expandedHints];

  if (suffixParts.length === 0) {
    return baseQuery;
  }

  return `${baseQuery} ${suffixParts.join(" ")}`.trim();
}

function scoreSearchText(text = "", query = "") {
  const normalizedQuery = normalizeText(query);
  const queryTokens = buildSearchLexicon(query);
  const searchableText = normalizeText(text);

  if (!normalizedQuery || queryTokens.length === 0 || !searchableText) {
    return 0;
  }

  let score = 0;

  if (searchableText.includes(normalizedQuery)) {
    score += 18;
  }

  for (const token of queryTokens) {
    if (!searchableText.includes(token)) {
      continue;
    }

    score += token.length >= 7 ? 3 : 1;

    if (token.length >= 10) {
      score += 1;
    }
  }

  const tokenCoverage = queryTokens.filter((token) => searchableText.includes(token)).length / queryTokens.length;
  score += Math.round(tokenCoverage * 6);

  const exactPhraseBonuses = expandQueryTerms(query).filter((term) => searchableText.includes(term));
  score += exactPhraseBonuses.length * 8;

  if (/(3|tri).*(knjig|udzbenik).*(otkup)|otkup.*(3|tri).*(knjig|udzbenik)/.test(normalizedQuery) &&
      /(3 ili manje knjiga|2 70 eur)/.test(searchableText)) {
    score += 18;
  }

  if (/(4|\bcetiri\b).*(knjig|udzbenik).*(otkup)|otkup.*(4|\bcetiri\b).*(knjig|udzbenik)|besplatna dostava/.test(normalizedQuery) &&
      /(4 ili vise knjiga|dostava je besplatna|mi pokrivamo trosak slanja)/.test(searchableText)) {
    score += 18;
  }

  if (/(povrat|zamjena)/.test(normalizedQuery) && /(rok|kada|koliki)/.test(normalizedQuery) &&
      /2 tjedna/.test(searchableText)) {
    score += 18;
  }

  if (/(kontakt|telefon|email|mail)/.test(normalizedQuery) && /(odgovarate|rok|kada)/.test(normalizedQuery) &&
      /(1 radnog dana|031 201 230)/.test(searchableText)) {
    score += 14;
  }

  if (/r1/.test(normalizedQuery) && /r1 racun/.test(searchableText)) {
    score += 18;
  }

  if (/(pbz|zaba)/.test(normalizedQuery) && /(pbz|zaba)/.test(searchableText)) {
    score += 18;
  }

  if (isAircashPayoutQuery(normalizedQuery) && /\baircash\b/.test(searchableText)) {
    score += 36;

    if (/(isplata na aircash nije dostupna|ne vrsimo isplatu|isplata|isplate|hp uplatnic|revolut|iban)/.test(searchableText)) {
      score += 18;
    }
  }

  if (/(gdje mi je paket|pratiti posiljku|tracking|link za pracenje)/.test(normalizedQuery) &&
      /(tracking broj|link za pracenje)/.test(searchableText)) {
    score += 18;
  }

  if (/(kako naruciti|naru[cč]iti|kupiti|kupnja|kupovina|kupi udzbenike|dodati u kosaricu|dodati u košaricu|dodati u ko\s*aricu|zavrsiti kupnju|završiti kupnju|ko\s*aric\w*)/.test(normalizedQuery) &&
      /(kako naruciti udzbenike|udžbenike mozete kupiti putem webshopa|udzbenike mozete kupiti putem webshopa|dodajte ga u kosaricu|dodajte ga u košaricu|pretrazivanje funkcionira|pretraživanje funkcionira)/.test(searchableText)) {
    score += 20;
  }

  if (!isAircashPayoutQuery(normalizedQuery) &&
      /(stanje zaliha|na stanju|po trgovin|u trgovin|knjig.{0,50}(dostup|nedostup)|udzben.{0,50}(dostup|nedostup)|artikal.{0,50}(dostup|nedostup)|artikl.{0,50}(dostup|nedostup)|naslov.{0,50}(dostup|nedostup)|(dostup|nedostup).{0,50}(knjig|udzben|artikal|artikl|naslov))/.test(normalizedQuery) &&
      /(knjiga nije dostupna|provjerite dostupnost na webu|pretraga na webu prikazuje stanje zaliha|stanje zaliha u stvarnom vremenu|zalihe se mijenjaju)/.test(searchableText)) {
    score += 20;
  }

  if (/(bar kod|barkod|isbn).*(nedostup|kosar|košar|kupiti|naruciti|naručiti)|(?:nedostup|kosar|košar|kupiti|naruciti|naručiti).*(bar kod|barkod|isbn)/.test(normalizedQuery) &&
      /(knjiga nije dostupna|provjerite dostupnost na webu|stanje zaliha|sifra artikla|šifra artikla|isbn)/.test(searchableText)) {
    score += 18;
  }

  if (/(slik|fotograf|privitak|upload|ubacim sliku|poslati sliku|posaljem sliku)/.test(normalizedQuery) &&
      /(posaljite fotografiju|pošaljite fotografiju|fotografiju racuna|fotografiju sporne knjige|info@antikvarijat-libar\.com|fb messenger|putem chata)/.test(searchableText)) {
    score += 16;
  }

  if (/naljepnic/.test(normalizedQuery) && /naljepnic/.test(searchableText)) {
    score += 18;
  }

  if (/(kamo|gdje).*(dodem|dođem|osobno)|nosim osobno/.test(normalizedQuery) &&
      /(zupanijska 17|osijek)/.test(searchableText)) {
    score += 16;
  }

  if (/^sadrzaj\b/.test(searchableText) || (searchableText.match(/clanak\s+\d+/g) || []).length >= 3) {
    score -= 8;
  }

  return score;
}

function splitIntoSegments(text = "") {
  const plainText = stripHtml(text);

  if (!plainText) {
    return [];
  }

  const paragraphSegments = plainText
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const baseSegments = paragraphSegments.length > 0 ? paragraphSegments : [plainText];

  return baseSegments.flatMap((segment) => {
    if (segment.length <= 420) {
      return [segment];
    }

    const lineSegments = segment
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lineSegments.length > 1) {
      return lineSegments;
    }

    return segment
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  });
}

function findBestExcerpt(text = "", query = "", maxLength = 900) {
  const segments = splitIntoSegments(text);

  if (segments.length === 0) {
    return "";
  }

  const rankedSegments = segments
    .map((segment, index) => ({
      segment,
      index,
      score: scoreSearchText(segment, query)
    }))
    .sort((left, right) => right.score - left.score);

  const topSegment = rankedSegments[0];

  if (!topSegment || topSegment.score <= 0) {
    return truncateText(stripHtml(text), maxLength);
  }

  let startIndex = topSegment.index;
  let endIndex = topSegment.index;
  let excerpt = topSegment.segment;
  let previousSegmentsAdded = 0;
  let nextSegmentsAdded = 0;

  // Expand around the best hit so short heading/table fragments keep
  // the nearby factual lines they depend on.
  while (startIndex > 0 && previousSegmentsAdded < 8) {
    const candidate = segments[startIndex - 1];
    const nextExcerpt = `${candidate} ${excerpt}`.replace(/\s+/g, " ").trim();

    if (nextExcerpt.length > maxLength) {
      break;
    }

    startIndex -= 1;
    previousSegmentsAdded += 1;
    excerpt = nextExcerpt;
  }

  while (endIndex < segments.length - 1 && nextSegmentsAdded < 14) {
    const candidate = segments[endIndex + 1];
    const nextExcerpt = `${excerpt} ${candidate}`.replace(/\s+/g, " ").trim();

    if (nextExcerpt.length > maxLength) {
      break;
    }

    endIndex += 1;
    nextSegmentsAdded += 1;
    excerpt = nextExcerpt;
  }

  return truncateText(excerpt, maxLength);
}

module.exports = {
  buildSearchLexicon,
  expandQueryTerms,
  findBestExcerpt,
  normalizeText,
  preprocessSearchQuery,
  scoreSearchText,
  stripHtml,
  tokenize,
  truncateText
};
