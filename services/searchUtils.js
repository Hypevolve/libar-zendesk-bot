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
    pattern: /\b(dostava|isporuka|pošiljka|posiljka|kurir|rok dostave)\b/,
    terms: ["dostava", "isporuka", "pošiljka", "rok dostave", "kurir"]
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
    pattern: /\b(plaćanje|placanje|kartica|gotovina|pouzeće|pouzece)\b/,
    terms: ["plaćanje", "kartica", "gotovina", "pouzeće"]
  }
];

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

  for (const alias of QUERY_ALIASES) {
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
  score += exactPhraseBonuses.length * 4;

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

  const excerptParts = [topSegment.segment];

  const previousSegment = segments[topSegment.index - 1];
  const nextSegment = segments[topSegment.index + 1];

  if (previousSegment && previousSegment.length < 260) {
    excerptParts.unshift(previousSegment);
  }

  if (nextSegment && nextSegment.length < 320) {
    excerptParts.push(nextSegment);
  }

  return truncateText(excerptParts.join(" ").replace(/\s+/g, " ").trim(), maxLength);
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
