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

function detectRequestedTopics(conversation = null) {
  const query = normalizeForComparison(conversation?.standaloneQuery || "");
  const taskIntent = String(conversation?.reasoningResult?.taskIntent || "").trim();
  const topics = new Set();

  if (taskIntent === "support_info") {
    if (/(radno vrijeme|kad radite|otvoreni|subotom|nedjeljom)/.test(query)) {
      topics.add("hours");
    }
    if (/(adresa|gdje ste|gdje se nalazite|lokacija)/.test(query)) {
      topics.add("location");
    }
    if (/(kontakt|telefon|email|mail)/.test(query)) {
      topics.add("contact");
    }
    if (/(otkup|otkupljujete|prodati knjige|prodaja knjiga)/.test(query)) {
      topics.add("buyback");
    }
  }

  if (taskIntent === "delivery") {
    if (/(cijena|koliko|košta|kosta)/.test(query)) {
      topics.add("price");
    }
    if (/(gls)/.test(query)) {
      topics.add("gls");
    }
    if (/(boxnow)/.test(query)) {
      topics.add("boxnow");
    }
    if (/(paketomat)/.test(query)) {
      topics.add("paketomat");
    }
  }

  return topics;
}

function detectAnsweredTopics(answer = "") {
  const normalized = normalizeForComparison(answer);
  const topics = new Set();

  if (/(radimo|radno vrijeme|otvoreni|ponedjeljak|subota|nedjelja)/.test(normalized)) {
    topics.add("hours");
  }
  if (/(adresa|nalazimo|osijek|zupanijska|županijska|lokacija)/.test(normalized)) {
    topics.add("location");
  }
  if (/(kontakt|telefon|email|mail|javite)/.test(normalized)) {
    topics.add("contact");
  }
  if (/(otkup|otkupljujemo|prodati|udžbenike|udzbenike)/.test(normalized)) {
    topics.add("buyback");
  }
  if (/(cijena|košta|kosta|eur|€)/.test(normalized)) {
    topics.add("price");
  }
  if (/\bgls\b/.test(normalized)) {
    topics.add("gls");
  }
  if (/\bboxnow\b/.test(normalized)) {
    topics.add("boxnow");
  }
  if (/(paketomat)/.test(normalized)) {
    topics.add("paketomat");
  }

  return topics;
}

function answerHasConcreteSupportFact(answer = "", topic = "") {
  const normalized = normalizeForComparison(answer);

  if (topic === "hours") {
    return /\b\d{1,2}[:.]\d{2}\b/.test(normalized) || /(ponedjeljak|petak|subota|nedjelja)/.test(normalized);
  }

  if (topic === "location") {
    return /(zupanijska|županijska|osijek|\b\d{1,3}[a-z]?\b)/.test(normalized);
  }

  if (topic === "contact") {
    return /@/.test(answer) || /(?:\+?\d[\d\s/-]{6,}\d)/.test(answer);
  }

  return true;
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

  const requestedTopics = detectRequestedTopics(conversation);
  const answeredTopics = detectAnsweredTopics(trimmed);

  if (String(conversation?.reasoningResult?.taskIntent || "").trim() === "support_info") {
    for (const topic of [...requestedTopics].filter((topic) => ["hours", "location", "contact"].includes(topic))) {
      if (!answerHasConcreteSupportFact(trimmed, topic)) {
        return {
          isValid: false,
          reason: "missing_concrete_support_fact"
        };
      }
    }
  }

  if (requestedTopics.size >= 2) {
    for (const topic of requestedTopics) {
      if (!answeredTopics.has(topic)) {
        return {
          isValid: false,
          reason: "partial_topic_coverage"
        };
      }
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
