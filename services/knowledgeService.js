const zendeskService = require("./zendeskService");
const oneDriveService = require("./oneDriveService");

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
    if (/(kupnja|webshop|na stanju|isbn)/.test(normalizedText)) {
      score -= 4;
    }
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

  return score;
}

function buildKnowledgeQuality(candidates = [], options = {}) {
  const [top, second] = candidates;
  const topScore = Number(top?.rankingScore || top?.score || 0);
  const secondScore = Number(second?.rankingScore || second?.score || 0);
  const scoreMargin = topScore - secondScore;
  const taskIntent = String(options.taskIntent || "").trim();
  const actionIntent = String(options.actionIntent || "").trim();
  const questionType = String(options.questionType || "").trim();
  const normalizedText = `${top?.title || ""} ${top?.body || ""}`.toLowerCase();

  let relevanceMatch = false;

  if (taskIntent === "buyback") {
    relevanceMatch = /(otkup|procjen|vrednovanj|prodati|bonus)/.test(normalizedText);
  } else if (taskIntent === "delivery") {
    relevanceMatch = /(dostav|isporuk|rok|kurir|pošt|pošta)/.test(normalizedText);
  } else if (taskIntent === "order_status" || questionType === "status") {
    relevanceMatch = /(narudžb|narudzb|status|broj narudžbe|broj narudzbe)/.test(normalizedText);
  } else if (actionIntent === "ask_how_to") {
    relevanceMatch = /(kako|koraci|postupak|potrebno|trebate|pošaljite|pošalji)/.test(normalizedText);
  } else {
    relevanceMatch = topScore > 0;
  }

  return {
    topScore,
    secondScore,
    scoreMargin,
    relevanceMatch,
    isStrong: topScore > 0 && relevanceMatch && (scoreMargin >= KNOWLEDGE_MIN_SCORE_MARGIN || topScore >= 16),
    isWeak: topScore <= 0 || !relevanceMatch
  };
}

function mergeKnowledgeResults(
  { zendeskKnowledge = null, oneDriveKnowledge = null } = {},
  options = {}
) {
  const oneDriveArticles = normalizeKnowledgeArticles(oneDriveKnowledge);
  const zendeskArticles = normalizeKnowledgeArticles(zendeskKnowledge);
  const preferredSource = String(options.preferredSource || "").trim().toLowerCase();

  const candidates = [...oneDriveArticles, ...zendeskArticles]
    .filter((entry) => isSourceAllowed(entry.source, options))
    .map((entry, index) => ({
      ...entry,
      rankingScore: rerankEntry(entry, {
        ...options,
        sourcePriority: options.sourcePriority || (preferredSource ? [preferredSource] : [])
      }) +
        (entry.source === "onedrive" ? 0.25 : 0) +
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
      `Tip: ${entry.source === "onedrive" ? "OneDrive dokument" : "Zendesk članak"}`,
      `Naslov: ${entry.title}`,
      `Relevantnost: ${entry.rankingScore || entry.score}`,
      `Sadržaj: ${entry.body}`
    ].join("\n"))
    .join("\n\n");

  return {
    context,
    articles: candidates,
    topScore: candidates[0]?.rankingScore || candidates[0]?.score || 0,
    quality: buildKnowledgeQuality(candidates, options),
    totalMatches: candidates.length,
    primarySource: candidates[0]?.source || (oneDriveArticles.length > 0 ? "onedrive" : "zendesk")
  };
}

async function searchKnowledgeDetailed(query, options = {}) {
  const shouldUseZendesk = isSourceAllowed("zendesk", options);
  const shouldUseOneDrive = isSourceAllowed("onedrive", options);
  const [zendeskKnowledge, oneDriveKnowledge] = await Promise.all([
    shouldUseZendesk ? zendeskService.searchHelpCenterDetailed(query, options) : Promise.resolve(null),
    shouldUseOneDrive ? oneDriveService.searchOneDriveDetailed(query, options) : Promise.resolve(null)
  ]);

  return mergeKnowledgeResults({
    zendeskKnowledge,
    oneDriveKnowledge
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
