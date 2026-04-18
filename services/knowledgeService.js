const zendeskService = require("./zendeskService");
const oneDriveService = require("./oneDriveService");

const KNOWLEDGE_CONTEXT_ITEMS = Number(process.env.KNOWLEDGE_CONTEXT_ITEMS) || 5;

function normalizeKnowledgeArticles(result) {
  return Array.isArray(result?.articles) ? result.articles : [];
}

function mergeKnowledgeResults(
  { zendeskKnowledge = null, oneDriveKnowledge = null } = {},
  options = {}
) {
  const oneDriveArticles = normalizeKnowledgeArticles(oneDriveKnowledge);
  const zendeskArticles = normalizeKnowledgeArticles(zendeskKnowledge);
  const preferredSource = String(options.preferredSource || "").trim().toLowerCase();

  const candidates = [...oneDriveArticles, ...zendeskArticles]
    .map((entry, index) => ({
      ...entry,
      _sortScore:
        Number(entry.score) +
        (entry.source === "onedrive" ? 0.25 : 0) +
        (preferredSource && entry.source === preferredSource ? 0.75 : 0),
      _sortIndex: index
    }))
    .sort((left, right) => {
      if (right._sortScore !== left._sortScore) {
        return right._sortScore - left._sortScore;
      }

      return left._sortIndex - right._sortIndex;
    })
    .slice(0, KNOWLEDGE_CONTEXT_ITEMS)
    .map(({ _sortScore, _sortIndex, ...entry }) => entry);

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

async function searchKnowledgeDetailed(query, options = {}) {
  const [zendeskKnowledge, oneDriveKnowledge] = await Promise.all([
    zendeskService.searchHelpCenterDetailed(query, options),
    oneDriveService.searchOneDriveDetailed(query, options)
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
  searchKnowledge,
  searchKnowledgeDetailed
};
