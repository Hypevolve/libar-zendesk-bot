const zendeskService = require("./zendeskService");
const oneDriveService = require("./oneDriveService");

const KNOWLEDGE_CONTEXT_ITEMS = Number(process.env.KNOWLEDGE_CONTEXT_ITEMS) || 5;

function mergeKnowledgeResults(results = []) {
  const candidates = results
    .filter(Boolean)
    .flatMap((result) => Array.isArray(result.articles) ? result.articles : [])
    .sort((left, right) => right.score - left.score)
    .slice(0, KNOWLEDGE_CONTEXT_ITEMS);

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
    totalMatches: candidates.length
  };
}

async function searchKnowledgeDetailed(query) {
  const [zendeskKnowledge, oneDriveKnowledge] = await Promise.all([
    zendeskService.searchHelpCenterDetailed(query),
    oneDriveService.searchOneDriveDetailed(query)
  ]);

  return mergeKnowledgeResults([zendeskKnowledge, oneDriveKnowledge]);
}

async function searchKnowledge(query) {
  const result = await searchKnowledgeDetailed(query);
  return result?.context || null;
}

module.exports = {
  searchKnowledge,
  searchKnowledgeDetailed
};
