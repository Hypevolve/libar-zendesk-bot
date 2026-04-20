const { normalizeForComparison } = require("./textUtils");

function tokenize(text = "") {
  return normalizeForComparison(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function hasInternalLeakMarkers(text = "") {
  const normalized = normalizeForComparison(text);

  return [
    "libar_memory_v1",
    "standalone upit",
    "primary intent",
    "secondary intent",
    "knowledge quality",
    "izvor 1",
    "relevantnost",
    "task intent",
    "active domain"
  ].some((marker) => normalized.includes(marker));
}

function looksLikeSourceDump(text = "") {
  const normalized = normalizeForComparison(text);

  if (!normalized) {
    return false;
  }

  const sourceMarkers =
    (normalized.match(/\bclanak\b/g) || []).length +
    (normalized.match(/\bdokument\b/g) || []).length +
    (normalized.match(/\bnaslov\b/g) || []).length +
    (normalized.match(/\bizvor\b/g) || []).length;

  return sourceMarkers >= 2 && !/[.!?]/.test(String(text || ""));
}

function endsWithBrokenLeadIn(text = "") {
  return /[:\-]\s*$/.test(String(text || "").trim());
}

function hasStrongLexicalOverlap(answer = "", articles = []) {
  const answerTokens = new Set(tokenize(answer));

  if (answerTokens.size === 0) {
    return false;
  }

  return (Array.isArray(articles) ? articles : []).some((article) => {
    const articleTokens = tokenize(`${article.title || ""} ${article.body || ""}`);
    let overlap = 0;

    for (const token of articleTokens) {
      if (answerTokens.has(token)) {
        overlap += 1;
      }

      if (overlap >= 2) {
        return true;
      }
    }

    return false;
  });
}

function validateAnswerQuality({
  answer = "",
  outcomeType = "",
  knowledge = null,
  conversation = null
} = {}) {
  const trimmed = String(answer || "").trim();

  if (outcomeType !== "safe_answer") {
    return {
      isValid: true,
      reason: "non_safe_answer"
    };
  }

  if (!trimmed) {
    return {
      isValid: false,
      reason: "empty_answer"
    };
  }

  if (hasInternalLeakMarkers(trimmed)) {
    return {
      isValid: false,
      reason: "internal_marker_leak"
    };
  }

  if (looksLikeSourceDump(trimmed)) {
    return {
      isValid: false,
      reason: "source_dump"
    };
  }

  if (endsWithBrokenLeadIn(trimmed)) {
    return {
      isValid: false,
      reason: "broken_lead_in"
    };
  }

  if (
    knowledge?.quality?.isStrong &&
    Array.isArray(knowledge?.articles) &&
    knowledge.articles.length > 0 &&
    !hasStrongLexicalOverlap(trimmed, knowledge.articles)
  ) {
    const taskIntent = String(conversation?.reasoningResult?.taskIntent || "").trim();

    if (["support_info", "delivery", "buyback"].includes(taskIntent)) {
      return {
        isValid: false,
        reason: "low_knowledge_overlap"
      };
    }
  }

  return {
    isValid: true,
    reason: "answer_valid"
  };
}

module.exports = {
  validateAnswerQuality
};
