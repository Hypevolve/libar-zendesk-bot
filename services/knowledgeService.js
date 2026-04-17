const zendeskService = require("./zendeskService");
const oneDriveService = require("./oneDriveService");

const KNOWLEDGE_CONTEXT_ITEMS = Number(process.env.KNOWLEDGE_CONTEXT_ITEMS) || 5;

function normalizeKnowledgeArticles(result) {
  return Array.isArray(result?.articles) ? result.articles : [];
}

function mergeKnowledgeResults({ zendeskKnowledge = null, oneDriveKnowledge = null } = {}) {
  const oneDriveArticles = normalizeKnowledgeArticles(oneDriveKnowledge);
  const zendeskArticles = normalizeKnowledgeArticles(zendeskKnowledge);

  const candidates = oneDriveArticles.length > 0
    ? [
        ...oneDriveArticles,
        ...zendeskArticles
      ].slice(0, KNOWLEDGE_CONTEXT_ITEMS)
    : zendeskArticles.slice(0, KNOWLEDGE_CONTEXT_ITEMS);

  if (candidates.length === 0) {
    return null;
  }

  const context = candidates
    .map((entry, index) => [
      `Izvor ${index + 1}:`,
      `Tip: ${entry.source === "onedrive" ? "OneDrive dokument" : "Zendesk članak"}`,
      `Naslov: ${entry.title}`,
      `Relevantnost: ${entry.score}`,
      `Sadržaj: ${entry.body}`
    ].join("\n"))
    .join("\n\n");

  return {
    context,
    articles: candidates,
    topScore: candidates[0]?.score || 0,
    totalMatches: candidates.length,
    primarySource: oneDriveArticles.length > 0 ? "onedrive" : "zendesk"
  };
}

async function searchKnowledgeDetailed(query) {
  const [zendeskKnowledge, oneDriveKnowledge] = await Promise.all([
    zendeskService.searchHelpCenterDetailed(query),
    oneDriveService.searchOneDriveDetailed(query)
  ]);

  return mergeKnowledgeResults({
    zendeskKnowledge,
    oneDriveKnowledge
  });
}

async function searchKnowledge(query) {
  const result = await searchKnowledgeDetailed(query);
  return result?.context || null;
}

module.exports = {
  searchKnowledge,
  searchKnowledgeDetailed
};
