const test = require("node:test");
const assert = require("node:assert/strict");

const knowledgeService = require("../services/knowledgeService");
const oneDriveService = require("../services/oneDriveService");
const zendeskService = require("../services/zendeskService");

test("searchKnowledgeDetailed merges OneDrive and Zendesk results and prefers OneDrive on tied scores", async () => {
  const originalOneDriveSearch = oneDriveService.searchOneDriveDetailed;
  const originalZendeskSearch = zendeskService.searchHelpCenterDetailed;

  oneDriveService.searchOneDriveDetailed = async () => ({
    articles: [
      { title: "OneDrive članak", body: "OneDrive odgovor", score: 42 }
    ]
  });

  zendeskService.searchHelpCenterDetailed = async () => ({
    articles: [
      { title: "Zendesk članak", body: "Zendesk odgovor", score: 42 }
    ]
  });

  try {
    const result = await knowledgeService.searchKnowledgeDetailed("Kako ide povrat?");

    assert.ok(result);
    assert.equal(result.primarySource, "onedrive");
    assert.equal(result.articles.length, 2);
    assert.equal(result.articles[0].source, "onedrive");
    assert.equal(result.articles[1].source, "zendesk");
    assert.match(result.context, /OneDrive članak/);
    assert.match(result.context, /Zendesk članak/);
  } finally {
    oneDriveService.searchOneDriveDetailed = originalOneDriveSearch;
    zendeskService.searchHelpCenterDetailed = originalZendeskSearch;
  }
});

test("searchKnowledgeDetailed falls back to Zendesk when OneDrive has no relevant result", async () => {
  const originalOneDriveSearch = oneDriveService.searchOneDriveDetailed;
  const originalZendeskSearch = zendeskService.searchHelpCenterDetailed;

  oneDriveService.searchOneDriveDetailed = async () => null;
  zendeskService.searchHelpCenterDetailed = async () => ({
    articles: [
      { title: "Zendesk fallback", body: "Povrat je moguć u roku 14 dana.", score: 27 }
    ]
  });

  try {
    const result = await knowledgeService.searchKnowledgeDetailed("Kako radi povrat?");

    assert.ok(result);
    assert.equal(result.primarySource, "zendesk");
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].source, "zendesk");
    assert.match(result.context, /Zendesk Help Center/);
  } finally {
    oneDriveService.searchOneDriveDetailed = originalOneDriveSearch;
    zendeskService.searchHelpCenterDetailed = originalZendeskSearch;
  }
});
