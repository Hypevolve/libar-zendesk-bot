function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeText(text = "") {
  return stripHtml(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text = "") {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2);
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
  const baseQuery = String(query)
    .replace(/\r/g, " ")
    .replace(/^(pozdrav|bok|dobar dan|lijep pozdrav|hello|hi|hey)[,!.:\s-]*/i, "")
    .replace(/\b(zanima me|molim vas|molim|možete li mi reći|mozete li mi reci|imam pitanje|htio bih pitati|htjela bih pitati|hvala unaprijed|unaprijed hvala)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (conversationFacts.length === 0) {
    return baseQuery;
  }

  return `${baseQuery} ${conversationFacts.join(" ")}`.trim();
}

function scoreSearchText(text = "", query = "") {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(query);
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
  findBestExcerpt,
  normalizeText,
  preprocessSearchQuery,
  scoreSearchText,
  stripHtml,
  tokenize,
  truncateText
};
