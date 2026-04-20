const { normalizeForComparison, stripHtml } = require("./textUtils");

function splitSentences(text = "") {
  return stripHtml(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12);
}

function uniqueSentences(sentences = []) {
  const seen = new Set();

  return (Array.isArray(sentences) ? sentences : []).filter((sentence) => {
    const key = normalizeForComparison(sentence);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function sentenceMatchesKeywords(sentence = "", keywords = []) {
  const normalizedSentence = normalizeForComparison(sentence);
  return keywords.some((keyword) => normalizedSentence.includes(normalizeForComparison(keyword)));
}

function scoreSentenceKeywords(sentence = "", keywords = []) {
  const normalizedSentence = normalizeForComparison(sentence);
  let score = 0;

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeForComparison(keyword);

    if (normalizedKeyword && normalizedSentence.includes(normalizedKeyword)) {
      score += 1;
    }
  }

  return score;
}

function collectSupportInfoKeywords(query = "") {
  const normalized = normalizeForComparison(query);

  if (/\bsubotom\b/.test(normalized)) {
    return ["subotom", "subota", "radno vrijeme", "otvoreni"];
  }

  if (/\bnedjeljom\b/.test(normalized)) {
    return ["nedjeljom", "nedjelja", "radno vrijeme", "otvoreni"];
  }

  if (/(radno vrijeme|kad radite|otvoreni)/.test(normalized)) {
    return ["radno vrijeme", "ponedjeljak", "petak", "subota", "subotom", "nedjelja", "nedjeljom", "otvoreni"];
  }

  if (/(adresa|gdje ste|gdje se nalazite|lokacija)/.test(normalized)) {
    return ["adresa", "lokacija", "nalazimo", "osijek", "županijska", "zupanijska"];
  }

  if (/(kontakt|telefon|email|mail)/.test(normalized)) {
    return ["kontakt", "telefon", "email", "mail", "@"];
  }

  if (/(plaćanje|placanje|kartica|gotovina|pouzeće|pouzece)/.test(normalized)) {
    return ["plaćanje", "placanje", "kartica", "gotovina", "pouzeće", "pouzece"];
  }

  if (/(preuzimanje|poslovnici)/.test(normalized)) {
    return ["preuzimanje", "poslovnici", "osobno preuzimanje"];
  }

  return ["radno vrijeme", "adresa", "kontakt", "telefon", "email"];
}

function collectDeliveryKeywords(query = "") {
  const normalized = normalizeForComparison(query);

  if (/(rok|kada|kad|trajanje)/.test(normalized)) {
    return ["rok", "isporuka", "dostava", "radni dan", "stiže", "stize"];
  }

  if (/(cijena|koliko)/.test(normalized)) {
    return ["cijena", "dostava", "eur", "€"];
  }

  return ["dostava", "isporuka", "kurir", "pošta", "posta", "rok", "cijena"];
}

function collectBuybackKeywords(query = "", actionIntent = "") {
  const normalized = normalizeForComparison(query);

  if (actionIntent === "ask_timeline" || /(koliko traje|kada|kad)/.test(normalized)) {
    return ["procjena", "otkup", "rok", "kada", "odgovor"];
  }

  if (actionIntent === "request_estimate" || /(koliko vrijedi|procjena|procjenu|vrednovanje)/.test(normalized)) {
    return ["procjena", "vrednovanje", "pošaljite", "posaljite", "popis", "fotografije", "bonus"];
  }

  return ["otkup", "pošaljite", "posaljite", "popis", "fotografije", "procjena", "bonus", "donesite"];
}

function selectSentencesFromArticles(articles = [], keywords = [], maxSentences = 2) {
  const matched = [];
  const fallback = [];

  for (const article of Array.isArray(articles) ? articles : []) {
    const sentences = splitSentences(`${article.title || ""}. ${article.body || ""}`);

    for (const sentence of sentences) {
      const keywordScore = scoreSentenceKeywords(sentence, keywords);

      if (keywordScore > 0 || sentenceMatchesKeywords(sentence, keywords)) {
        matched.push({ sentence, keywordScore });
      } else {
        fallback.push(sentence);
      }
    }
  }

  const rankedMatched = matched
    .sort((left, right) => right.keywordScore - left.keywordScore)
    .map((entry) => entry.sentence);

  const picked = uniqueSentences([...rankedMatched, ...fallback]).slice(0, maxSentences);
  return picked;
}

function ensureBuybackBonus(sentences = [], articles = []) {
  const normalizedCombined = normalizeForComparison(sentences.join(" "));

  if (normalizedCombined.includes("bonus")) {
    return sentences;
  }

  for (const article of Array.isArray(articles) ? articles : []) {
    const bonusSentence = splitSentences(article.body || "").find((sentence) =>
      /bonus/.test(normalizeForComparison(sentence))
    );

    if (bonusSentence) {
      return uniqueSentences([...sentences, bonusSentence]).slice(0, 2);
    }
  }

  return sentences;
}

function composeDeterministicReply({ conversation = null, knowledge = null } = {}) {
  const taskIntent = String(conversation?.reasoningResult?.taskIntent || "").trim();
  const actionIntent = String(conversation?.reasoningResult?.actionIntent || "").trim();
  const standaloneQuery = String(conversation?.standaloneQuery || "").trim();
  const articles = Array.isArray(knowledge?.articles) ? knowledge.articles : [];

  if (!knowledge?.quality?.isStrong || articles.length === 0) {
    return null;
  }

  let keywords = [];

  if (taskIntent === "support_info") {
    keywords = collectSupportInfoKeywords(standaloneQuery);
  } else if (taskIntent === "delivery") {
    keywords = collectDeliveryKeywords(standaloneQuery);
  } else if (taskIntent === "buyback") {
    keywords = collectBuybackKeywords(standaloneQuery, actionIntent);
  } else {
    return null;
  }

  let sentences = selectSentencesFromArticles(articles, keywords, 2);

  if (taskIntent === "buyback") {
    sentences = ensureBuybackBonus(sentences, articles);
  }

  if (sentences.length === 0) {
    return null;
  }

  return sentences.join(" ").replace(/\s+/g, " ").trim();
}

module.exports = {
  composeDeterministicReply
};
