const { normalizeForComparison, stripHtml } = require("./textUtils");

function splitSentences(text = "") {
  return stripHtml(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12);
}

function splitParagraphs(text = "") {
  return stripHtml(text)
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 8);
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

function isHeadingLike(sentence = "", articleTitle = "") {
  const normalizedSentence = normalizeForComparison(sentence);
  const normalizedTitle = normalizeForComparison(articleTitle);

  if (!normalizedSentence) {
    return true;
  }

  if (normalizedTitle && normalizedSentence === normalizedTitle) {
    return true;
  }

  return /^clanak\b/.test(normalizedSentence) || /^naslov\b/.test(normalizedSentence);
}

function collectSupportInfoKeywords(query = "") {
  const normalized = normalizeForComparison(query);
  const keywords = new Set();

  if (/\bsubotom\b/.test(normalized)) {
    ["subotom", "subota", "radno vrijeme", "otvoreni"].forEach((value) => keywords.add(value));
  }

  if (/\bnedjeljom\b/.test(normalized)) {
    ["nedjeljom", "nedjelja", "radno vrijeme", "otvoreni"].forEach((value) => keywords.add(value));
  }

  if (/(radno vrijeme|kad radite|otvoreni)/.test(normalized)) {
    ["radno vrijeme", "ponedjeljak", "petak", "subota", "subotom", "nedjelja", "nedjeljom", "otvoreni"].forEach((value) => keywords.add(value));
  }

  if (/(adresa|gdje ste|gdje se nalazite|lokacija)/.test(normalized)) {
    ["adresa", "lokacija", "nalazimo", "osijek", "županijska", "zupanijska"].forEach((value) => keywords.add(value));
  }

  if (/(kontakt|telefon|email|mail)/.test(normalized)) {
    ["kontakt", "telefon", "email", "mail", "@"].forEach((value) => keywords.add(value));
  }

  if (/(plaćanje|placanje|kartica|gotovina|pouzeće|pouzece)/.test(normalized)) {
    ["plaćanje", "placanje", "kartica", "gotovina", "pouzeće", "pouzece"].forEach((value) => keywords.add(value));
  }

  if (/(preuzimanje|poslovnici)/.test(normalized)) {
    ["preuzimanje", "poslovnici", "osobno preuzimanje"].forEach((value) => keywords.add(value));
  }

  if (/(otkup|otkupljujete|otkupljujete li|prodati knjige|prodaja knjiga)/.test(normalized)) {
    ["otkup", "otkupljujemo", "prodati", "udžbenike", "udzbenike"].forEach((value) => keywords.add(value));
  }

  if (keywords.size > 0) {
    return [...keywords];
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

  if (/(postupak|kako ide|kako funkcionira|kako funkcionise)/.test(normalized)) {
    return ["postupak", "način", "nacin", "otkup", "pošaljite", "posaljite", "skeniranje", "fotografirati"];
  }

  if (actionIntent === "ask_timeline" || /(koliko traje|kada|kad)/.test(normalized)) {
    return ["procjena", "otkup", "rok", "kada", "odgovor"];
  }

  if (actionIntent === "request_estimate" || /(koliko vrijedi|procjena|procjenu|vrednovanje)/.test(normalized)) {
    return ["procjena", "vrednovanje", "pošaljite", "posaljite", "popis", "fotografije", "bonus"];
  }

  return ["otkup", "pošaljite", "posaljite", "popis", "fotografije", "procjena", "bonus", "donesite"];
}

function detectSupportInfoTopicsInText(text = "") {
  const normalized = normalizeForComparison(text);
  const topics = new Set();

  if (/(radno vrijeme|kad radite|otvoreni|subotom|nedjeljom|\b\d{1,2}[:.]\d{2}\b|ponedjeljak|petak)/.test(normalized)) {
    topics.add("hours");
  }

  if (/(adresa|gdje ste|gdje se nalazite|lokacija|nalazimo se|osijek|zupanijska)/.test(normalized)) {
    topics.add("location");
  }

  if (/(kontakt|telefon|email|mail|@)/.test(normalized)) {
    topics.add("contact");
  }

  if (/(placanje|plaćanje|kartica|gotovina|pouzece|pouzeće)/.test(normalized)) {
    topics.add("payment");
  }

  if (
    /(otkup|otkupljujemo|otkupljujete|prodati knjige|prodaja knjiga|udzbenike|udžbenike|isplacujemo|isplaćujemo|dostavljacu|dostavljaču|nalog|zapakirati)/.test(normalized)
  ) {
    topics.add("buyback");
  }

  return topics;
}

function isSupportInfoParagraphCompatible(paragraph = "", requestedTopics = new Set()) {
  const segmentTopics = detectSupportInfoTopicsInText(paragraph);
  const requestedNonBuyback = [...requestedTopics].filter((topic) => topic !== "buyback");
  const normalizedParagraph = normalizeForComparison(paragraph);

  if (segmentTopics.has("buyback") && !requestedTopics.has("buyback")) {
    return false;
  }

  if (
    requestedNonBuyback.length > 0 &&
    !requestedNonBuyback.some((topic) => segmentTopics.has(topic))
  ) {
    return false;
  }

  if (
    /\b(otkup|isplacujemo|isplaćujemo|dostavljacu|dostavljaču|zapakirati|predati paket|online otkup|potvrdite online otkupni nalog)\b/.test(normalizedParagraph) &&
    !requestedTopics.has("buyback")
  ) {
    return false;
  }

  return true;
}

function buildParagraphCandidates(article = {}, keywords = [], options = {}) {
  const paragraphs = splitParagraphs(article.body || "");
  const candidates = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];

    if (isHeadingLike(paragraph, article.title || "")) {
      continue;
    }

    let segment = paragraph;
    const normalizedParagraph = normalizeForComparison(paragraph);

    if (
      options.allowProceduralContinuation !== false &&
      (
        /[:\-]\s*$/.test(paragraph) ||
        /\b(nacin|način|korak|koraci|mogucnost|mogućnost|postupak)\b/.test(normalizedParagraph)
      )
    ) {
      const nextParagraph = paragraphs[index + 1] || "";

      if (nextParagraph && !isHeadingLike(nextParagraph, article.title || "")) {
        segment = [paragraph.replace(/[:\-]\s*$/, "").trim(), nextParagraph].filter(Boolean).join(" ");
      }
    }

    if (
      options.taskIntent === "support_info" &&
      !isSupportInfoParagraphCompatible(segment, options.requestedTopics)
    ) {
      continue;
    }

    candidates.push({
      segment,
      keywordScore:
        scoreSentenceKeywords(segment, keywords) +
        ([...detectSupportInfoTopicsInText(segment)].filter((topic) => options.requestedTopics?.has(topic)).length * 3)
    });
  }

  return candidates;
}

function selectSentencesFromArticles(articles = [], keywords = [], maxSentences = 2) {
  const matched = [];
  const fallback = [];

  for (const article of Array.isArray(articles) ? articles : []) {
    const paragraphCandidates = buildParagraphCandidates(article, keywords, {
      allowProceduralContinuation: article.taskIntentHint !== "support_info",
      taskIntent: article.taskIntentHint,
      requestedTopics: article.requestedTopics || new Set()
    });

    if (paragraphCandidates.length > 0) {
      for (const candidate of paragraphCandidates) {
        if (candidate.keywordScore > 0 || sentenceMatchesKeywords(candidate.segment, keywords)) {
          matched.push({ sentence: candidate.segment, keywordScore: candidate.keywordScore });
        } else {
          fallback.push(candidate.segment);
        }
      }

      continue;
    }

    for (const sentence of splitSentences(article.body || "")) {
      if (isHeadingLike(sentence, article.title || "")) {
        continue;
      }

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

  const sourcePool = rankedMatched.length > 0 ? rankedMatched : fallback;
  const picked = uniqueSentences(sourcePool).slice(0, maxSentences);
  return picked;
}

function detectSupportInfoTopics(query = "") {
  const normalized = normalizeForComparison(query);
  const topics = new Set();

  if (/(radno vrijeme|kad radite|otvoreni|subotom|nedjeljom)/.test(normalized)) {
    topics.add("hours");
  }

  if (/(adresa|gdje ste|gdje se nalazite|lokacija)/.test(normalized)) {
    topics.add("location");
  }

  if (/(kontakt|telefon|email|mail)/.test(normalized)) {
    topics.add("contact");
  }

  if (/(plaćanje|placanje|kartica|gotovina|pouzeće|pouzece)/.test(normalized)) {
    topics.add("payment");
  }

  if (/(otkup|otkupljujete|prodati knjige|prodaja knjiga)/.test(normalized)) {
    topics.add("buyback");
  }

  return topics;
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
    const supportTopics = detectSupportInfoTopics(standaloneQuery);

    if (supportTopics.has("buyback") && supportTopics.size > 1) {
      return null;
    }

    keywords = collectSupportInfoKeywords(standaloneQuery);
  } else if (taskIntent === "delivery") {
    keywords = collectDeliveryKeywords(standaloneQuery);
  } else if (taskIntent === "buyback") {
    keywords = collectBuybackKeywords(standaloneQuery, actionIntent);
  } else {
    return null;
  }

  const articleCandidates = articles.map((article) => ({
    ...article,
    taskIntentHint: taskIntent,
    requestedTopics: taskIntent === "support_info" ? detectSupportInfoTopics(standaloneQuery) : new Set()
  }));

  let sentences = selectSentencesFromArticles(articleCandidates, keywords, 2);

  if (taskIntent === "buyback") {
    sentences = ensureBuybackBonus(sentences, articles);
  }

  if (sentences.length === 0) {
    return null;
  }

  return sentences
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/:\s*$/, "")
    .trim();
}

module.exports = {
  composeDeterministicReply
};
