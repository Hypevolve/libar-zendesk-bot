const test = require("node:test");
const assert = require("node:assert/strict");

const { searchWebsiteKnowledgeDetailed } = require("../services/websiteKnowledgeService");

test("website knowledge search returns contact page for operating-hours question", async () => {
  const result = await searchWebsiteKnowledgeDetailed("Koje vam je radno vrijeme i adresa?", {
    taskIntent: "support_info",
    activeDomain: "support_info"
  });

  assert.equal(result.articles[0].source, "website");
  assert.equal(result.articles[0].url, "https://antikvarijat-libar.com/kontakt/");
});

test("website knowledge search returns buyback page for sell-books procedure question", async () => {
  const result = await searchWebsiteKnowledgeDetailed("Želim prodati knjige, koji je postupak otkupa?", {
    taskIntent: "buyback",
    activeDomain: "buyback",
    actionIntent: "ask_how_to"
  });

  assert.equal(result.articles[0].url, "https://antikvarijat-libar.com/prodaj-udzbenike/");
});

test("website knowledge search returns payment page for payment query", async () => {
  const result = await searchWebsiteKnowledgeDetailed("Koji su načini plaćanja?", {
    taskIntent: "support_info",
    activeDomain: "support_info"
  });

  assert.equal(result.articles[0].url, "https://antikvarijat-libar.com/nacini-placanja/");
});
