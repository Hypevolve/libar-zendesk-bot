const zendeskService = require("./zendeskService");
const oneDriveService = require("./oneDriveService");
const websiteKnowledgeService = require("./websiteKnowledgeService");

const KNOWLEDGE_CONTEXT_ITEMS = Number(process.env.KNOWLEDGE_CONTEXT_ITEMS) || 5;
const KNOWLEDGE_MIN_SCORE_MARGIN = Number(process.env.KNOWLEDGE_MIN_SCORE_MARGIN) || 3;

function normalizeKnowledgeArticles(result) {
  return Array.isArray(result?.articles) ? result.articles : [];
}

function normalizeSourceName(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_knowledge$/i, "");
}

function normalizeSourceList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeSourceName).filter(Boolean))];
}

function isSourceAllowed(sourceName, options = {}) {
  const normalizedSource = normalizeSourceName(sourceName);
  const allowedSources = normalizeSourceList(options.allowedSources);
  const blockedSources = normalizeSourceList(options.blockedSources);

  if (blockedSources.includes(normalizedSource)) {
    return false;
  }

  if (allowedSources.length === 0) {
    return true;
  }

  return allowedSources.includes(normalizedSource);
}

function rerankEntry(entry, options = {}) {
  const taskIntent = String(options.taskIntent || "").trim();
  const actionIntent = String(options.actionIntent || "").trim();
  const subjectType = String(options.subjectType || "").trim();
  const questionType = String(options.questionType || "").trim();
  const activeDomain = String(options.activeDomain || "").trim();
  const activeReferenceValue = String(options?.retrievalFrame?.activeReferenceValue || "").trim().toLowerCase();
  const sourcePriority = normalizeSourceList(options.sourcePriority);
  const sourceName = normalizeSourceName(entry.source);
  const normalizedText = `${entry.title || ""} ${entry.body || ""}`.toLowerCase();
  let score = Number(entry.score) || 0;

  if (sourcePriority.length > 0) {
    const sourceIndex = sourcePriority.indexOf(sourceName);
    if (sourceIndex !== -1) {
      score += Math.max(0, 2 - sourceIndex) * 2;
    }
  }

  if (taskIntent === "buyback") {
    if (/(otkup|procjen|vrednovanj|prodati|bonus)/.test(normalizedText)) {
      score += 8;
    }
    if (/(kupnja|webshop|na stanju|isbn|autor|cijena knjige)/.test(normalizedText)) {
      score -= 6;
    }
  }

  if (activeDomain === "buyback" && /(otkup|uvjeti|postupak|proces|procjen|koraci|pošaljite|pošalji)/.test(normalizedText)) {
    score += 4;
  }

  if (activeDomain === "support_info" && /(radno vrijeme|ponedjeljak|subota|nedjelja|adresa|osijek|županijska|zupanijska|kontakt|telefon|email|mail|plaćanje|placanje|kartica|gotovina|pouzeće|pouzece)/.test(normalizedText)) {
    score += 8;
  }

  if (taskIntent === "delivery" && /(dostav|isporuk|rok|kurir|pošt|pošta|cijena dostave)/.test(normalizedText)) {
    score += 5;
  }

  if (actionIntent === "ask_how_to" && /(kako|postupak|koraci|pošaljite|pošalji|trebate|potrebno)/.test(normalizedText)) {
    score += 5;
  }

  if (actionIntent === "request_estimate" && /(procjen|vrednovanj|pošaljite popis|fotografije|naslove)/.test(normalizedText)) {
    score += 6;
  }

  if (questionType === "status" && /(status|broj narudžbe|narudžb)/.test(normalizedText)) {
    score += 4;
  }

  if (questionType === "lookup" && /(isbn|autor|naslov|dostup)/.test(normalizedText)) {
    score += 4;
  }

  if (subjectType === "buyback_process" && /(otkup|proces|postupak|uvjeti)/.test(normalizedText)) {
    score += 4;
  }

  if (activeReferenceValue && normalizedText.includes(activeReferenceValue)) {
    score += 7;
  }

  return score;
}

function extractStructuredFacts(text = "") {
  const normalizedText = String(text || "").toLowerCase();
  const facts = {};
  const emailMatch = normalizedText.match(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/);
  const phoneMatch = normalizedText.match(/(?:\+?\d[\d\s/-]{6,}\d)/);
  const addressMatch = normalizedText.match(/\b(?:adresa|nalazimo se|lokacija)\s*[:\-]?\s*([^\n.]{5,120})/i);
  const hoursMatch = normalizedText.match(
    /\b(?:radno vrijeme|radimo|otvoreni)\b[^\n]{0,80}?(\d{1,2}[:.]\d{2}\s*(?:-|do)\s*\d{1,2}[:.]\d{2})/i
  );

  if (emailMatch) {
    facts.email = emailMatch[0];
  }

  if (phoneMatch) {
    facts.phone = phoneMatch[0].replace(/\s+/g, " ").trim();
  }

  if (addressMatch) {
    facts.address = addressMatch[1].replace(/\s+/g, " ").trim();
  }

  if (hoursMatch) {
    facts.hours = hoursMatch[1].replace(/\s+/g, " ").trim();
  }

  return facts;
}

function detectSourceConflict(candidates = [], options = {}) {
  const taskIntent = String(options.taskIntent || "").trim();
  const activeDomain = String(options.activeDomain || "").trim();

  if (!["support_info", "delivery"].includes(taskIntent) && activeDomain !== "support_info") {
    return {
      hasConflict: false,
      conflictFields: []
    };
  }

  const bestPerSource = new Map();

  for (const candidate of candidates) {
    if (!bestPerSource.has(candidate.source)) {
      bestPerSource.set(candidate.source, candidate);
    }
  }

  const zendesk = bestPerSource.get("zendesk");
  const onedrive = bestPerSource.get("onedrive");

  if (!zendesk || !onedrive) {
    return {
      hasConflict: false,
      conflictFields: []
    };
  }

  const zendeskFacts = extractStructuredFacts(`${zendesk.title || ""}\n${zendesk.body || ""}`);
  const onedriveFacts = extractStructuredFacts(`${onedrive.title || ""}\n${onedrive.body || ""}`);
  const conflictFields = [];

  for (const field of ["hours", "email", "phone", "address"]) {
    if (zendeskFacts[field] && onedriveFacts[field] && zendeskFacts[field] !== onedriveFacts[field]) {
      conflictFields.push(field);
    }
  }

  return {
    hasConflict: conflictFields.length > 0,
    conflictFields
  };
}

function buildKnowledgeQuality(candidates = [], options = {}) {
  const [top, second] = candidates;
  const topScore = Number(top?.rankingScore || top?.score || 0);
  const secondScore = Number(second?.rankingScore || second?.score || 0);
  const scoreMargin = topScore - secondScore;
  const taskIntent = String(options.taskIntent || "").trim();
  const actionIntent = String(options.actionIntent || "").trim();
  const questionType = String(options.questionType || "").trim();
  const activeDomain = String(options.activeDomain || "").trim();
  const activeReferenceValue = String(options?.retrievalFrame?.activeReferenceValue || "").trim().toLowerCase();
  const normalizedText = `${top?.title || ""} ${top?.body || ""}`.toLowerCase();

  let relevanceMatch = false;
  let jobMatch = false;
  let domainMatch = false;
  let contextConsistency = true;
  let directAnswerability = false;

  if (taskIntent === "buyback") {
    relevanceMatch = /(otkup|procjen|vrednovanj|prodati|bonus)/.test(normalizedText);
    jobMatch = /(postupak|proces|uvjeti|koraci|pošaljite|pošalji|procjen|vrednovanj|otkup)/.test(normalizedText);
    domainMatch = relevanceMatch;
    contextConsistency = !/(webshop|na stanju|isbn|autor|kupnja)/.test(normalizedText);
    directAnswerability = /(otkup|postupak|uvjeti|pošaljite|pošalji|isplata)/.test(normalizedText);
  } else if (taskIntent === "support_info" || activeDomain === "support_info") {
    relevanceMatch = /(radno vrijeme|ponedjeljak|petak|subota|nedjelja|adresa|osijek|županijska|zupanijska|kontakt|telefon|email|mail|plaćanje|placanje|kartica|gotovina|pouzeće|pouzece|preuzimanje)/.test(normalizedText);
    jobMatch = relevanceMatch;
    domainMatch = relevanceMatch;
    contextConsistency = !/(webshop|na stanju|isbn|autor|otkupna cijena)/.test(normalizedText);
    directAnswerability = relevanceMatch;
  } else if (taskIntent === "delivery") {
    relevanceMatch = /(dostav|isporuk|rok|kurir|pošt|pošta)/.test(normalizedText);
    jobMatch = /(dostav|isporuk|rok|kurir|pošt|pošta|cijena dostave)/.test(normalizedText);
    domainMatch = relevanceMatch;
    directAnswerability = jobMatch;
  } else if (taskIntent === "order_status" || questionType === "status") {
    relevanceMatch = /(narudžb|narudzb|status|broj narudžbe|broj narudzbe)/.test(normalizedText);
    jobMatch = relevanceMatch;
    domainMatch = relevanceMatch;
    directAnswerability = jobMatch;
  } else if (actionIntent === "ask_how_to") {
    relevanceMatch = /(kako|koraci|postupak|potrebno|trebate|pošaljite|pošalji)/.test(normalizedText);
    jobMatch = relevanceMatch;
    domainMatch = relevanceMatch;
    directAnswerability = jobMatch;
  } else {
    relevanceMatch = topScore > 0;
    jobMatch = relevanceMatch;
    domainMatch = relevanceMatch;
    directAnswerability = relevanceMatch;
  }

  if (!jobMatch && activeDomain === "buyback") {
    jobMatch = /(otkup|postupak|uvjeti|procjen|pošaljite)/.test(normalizedText);
  }

  const isStrong =
    topScore > 0 &&
    relevanceMatch &&
    jobMatch &&
    contextConsistency &&
    (scoreMargin >= KNOWLEDGE_MIN_SCORE_MARGIN || topScore >= 16);
  const isWeak = topScore <= 0 || !relevanceMatch || !jobMatch || !contextConsistency;
  const referenceMatched = activeReferenceValue ? normalizedText.includes(activeReferenceValue) : false;
  const conflict = detectSourceConflict(candidates, options);

  return {
    topScore,
    secondScore,
    scoreMargin,
    relevanceMatch,
    jobMatch,
    domainMatch,
    referenceMatched,
    hasConflict: conflict.hasConflict,
    conflictFields: conflict.conflictFields,
    contextConsistency,
    directAnswerability,
    acceptanceReason: isStrong ? "context_and_job_match" : isWeak ? "insufficient_job_match" : "ambiguous_match",
    isStrong,
    isWeak
  };
}

function mergeKnowledgeResults(
  { zendeskKnowledge = null, oneDriveKnowledge = null, websiteKnowledge = null } = {},
  options = {}
) {
  const oneDriveArticles = normalizeKnowledgeArticles(oneDriveKnowledge);
  const zendeskArticles = normalizeKnowledgeArticles(zendeskKnowledge);
  const websiteArticles = normalizeKnowledgeArticles(websiteKnowledge);
  const preferredSource = String(options.preferredSource || "").trim().toLowerCase();

  const candidates = [...oneDriveArticles, ...zendeskArticles, ...websiteArticles]
    .filter((entry) => isSourceAllowed(entry.source, options))
    .map((entry, index) => ({
      ...entry,
      rankingScore: rerankEntry(entry, {
        ...options,
        sourcePriority: options.sourcePriority || (preferredSource ? [preferredSource] : [])
      }) +
        (entry.source === "onedrive" ? 0.25 : 0) +
        (entry.source === "website" ? 0.15 : 0) +
        (preferredSource && entry.source === preferredSource ? 0.75 : 0),
      _sortIndex: index
    }))
    .sort((left, right) => {
      if (right.rankingScore !== left.rankingScore) {
        return right.rankingScore - left.rankingScore;
      }

      return left._sortIndex - right._sortIndex;
    })
    .slice(0, KNOWLEDGE_CONTEXT_ITEMS)
    .map(({ _sortIndex, ...entry }) => entry);

  if (candidates.length === 0) {
    return null;
  }

  const context = candidates
    .map((entry, index) => [
      `Izvor ${index + 1}:`,
      `Tip: ${
        entry.source === "onedrive"
          ? "OneDrive dokument"
          : entry.source === "website"
            ? "Web stranica"
            : "Zendesk članak"
      }`,
      `Naslov: ${entry.title}`,
      `Relevantnost: ${entry.rankingScore || entry.score}`,
      entry.url ? `URL: ${entry.url}` : null,
      `Sadržaj: ${entry.body}`
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  return {
    context,
    articles: candidates,
    topScore: candidates[0]?.rankingScore || candidates[0]?.score || 0,
    quality: buildKnowledgeQuality(candidates, options),
    totalMatches: candidates.length,
    primarySource:
      candidates[0]?.source ||
      (oneDriveArticles.length > 0
        ? "onedrive"
        : zendeskArticles.length > 0
          ? "zendesk"
          : "website")
  };
}

async function searchKnowledgeDetailed(query, options = {}) {
  const shouldUseZendesk = isSourceAllowed("zendesk", options);
  const shouldUseOneDrive = isSourceAllowed("onedrive", options);
  const shouldUseWebsite = isSourceAllowed("website", options);
  const [zendeskKnowledge, oneDriveKnowledge, websiteKnowledge] = await Promise.all([
    shouldUseZendesk ? zendeskService.searchHelpCenterDetailed(query, options) : Promise.resolve(null),
    shouldUseOneDrive ? oneDriveService.searchOneDriveDetailed(query, options) : Promise.resolve(null),
    shouldUseWebsite ? websiteKnowledgeService.searchWebsiteKnowledgeDetailed(query, options) : Promise.resolve(null)
  ]);

  return mergeKnowledgeResults({
    zendeskKnowledge,
    oneDriveKnowledge,
    websiteKnowledge
  }, options);
}

async function searchKnowledge(query, options = {}) {
  const result = await searchKnowledgeDetailed(query, options);
  return result?.context || null;
}

module.exports = {
  buildKnowledgeQuality,
  isSourceAllowed,
  mergeKnowledgeResults,
  searchKnowledge,
  searchKnowledgeDetailed
};
