const oneDriveService = require("./oneDriveService");
const vectorKnowledgeService = require("./vectorKnowledgeService");
const zendeskService = require("./zendeskService");

const KNOWLEDGE_CONTEXT_ITEMS = Number(process.env.KNOWLEDGE_CONTEXT_ITEMS) || 5;

function normalizeKnowledgeArticles(result) {
  return Array.isArray(result?.articles) ? result.articles : [];
}

function normalizeSourceArticles(result, source) {
  return normalizeKnowledgeArticles(result).map((entry) => ({
    ...entry,
    source: entry?.source || source
  }));
}

function deduplicateArticles(articles = []) {
  const seen = new Map();

  for (const article of articles) {
    const key = `${(article.title || "").toLowerCase().trim()}::${article.source || ""}`;
    const existing = seen.get(key);

    if (!existing || (article.score || 0) > (existing.score || 0)) {
      seen.set(key, article);
    }
  }

  return [...seen.values()];
}

function mergeKnowledgeResults(results = []) {
  const allArticles = results
    .flatMap(({ result, source }) => normalizeSourceArticles(result, source));
  const deduplicated = deduplicateArticles(allArticles);
  const candidates = deduplicated
    .sort((left, right) => {
      const scoreDifference = (right.score || 0) - (left.score || 0);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      if (left.source === right.source) {
        return 0;
      }

      return left.source === "onedrive" ? -1 : 1;
    })
    .slice(0, KNOWLEDGE_CONTEXT_ITEMS);

  if (candidates.length === 0) {
    return null;
  }

  const context = candidates
    .map((entry, index) => [
      `Izvor ${index + 1} (${entry.source === "zendesk" ? "Zendesk Help Center" : "OneDrive"}):`,
      `Naslov: ${entry.title}`,
      `Sadržaj: ${entry.body}`
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  return {
    context,
    articles: candidates,
    topScore: candidates[0]?.score || 0,
    totalMatches: candidates.length,
    primarySource: candidates[0]?.source || null
  };
}

async function searchKnowledgeDetailed(query, options = {}) {
  const [vectorKnowledge, oneDriveKnowledge, zendeskKnowledge] = await Promise.all([
    vectorKnowledgeService.searchVectorKnowledgeDetailed(query, options),
    oneDriveService.searchOneDriveDetailed(query, options),
    zendeskService.searchHelpCenterDetailed(query, options)
  ]);

  return mergeKnowledgeResults([
    { result: vectorKnowledge, source: "onedrive" },
    { result: oneDriveKnowledge, source: "onedrive" },
    { result: zendeskKnowledge, source: "zendesk" }
  ]);
}

async function searchKnowledge(query, options = {}) {
  const result = await searchKnowledgeDetailed(query, options);
  return result?.context || null;
}

module.exports = {
  getVectorConfigSummary: vectorKnowledgeService.getVectorConfigSummary,
  searchKnowledgeDetailed,
  searchKnowledge,
  syncVectorKnowledgeFromOneDrive: vectorKnowledgeService.syncOneDriveKnowledge
};
