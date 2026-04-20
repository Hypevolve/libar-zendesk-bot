const oneDriveService = require("./oneDriveService");

const KNOWLEDGE_CONTEXT_ITEMS = Number(process.env.KNOWLEDGE_CONTEXT_ITEMS) || 5;

function normalizeKnowledgeArticles(result) {
  return Array.isArray(result?.articles) ? result.articles : [];
}

async function searchKnowledgeDetailed(query, options = {}) {
  // Prema planu, zahtijevamo isključivo OneDrive dokumentaciju.
  const oneDriveKnowledge = await oneDriveService.searchOneDriveDetailed(query, options);

  const candidates = normalizeKnowledgeArticles(oneDriveKnowledge)
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, KNOWLEDGE_CONTEXT_ITEMS);

  if (candidates.length === 0) {
    return null;
  }

  const context = candidates
    .map((entry, index) => [
      `Izvor ${index + 1} (Baza znanja):`,
      `Naslov: ${entry.title}`,
      `Sadržaj: ${entry.body}`
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  return {
    context,
    articles: candidates,
    topScore: candidates[0]?.score || 0,
    totalMatches: candidates.length,
    primarySource: "onedrive"
  };
}

async function searchKnowledge(query, options = {}) {
  const result = await searchKnowledgeDetailed(query, options);
  return result?.context || null;
}

module.exports = {
  searchKnowledgeDetailed,
  searchKnowledge
};
