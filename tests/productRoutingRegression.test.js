const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const aiService = require("../services/aiService");
const knowledgeService = require("../services/knowledgeService");
const productFeedService = require("../services/productFeedService");
const conversationDataset = require("./fixtures/conversation-regression-dataset.json");
const { __internal } = require("../index");

function buildProductMatch(query) {
  return {
    query,
    topScore: 96,
    products: [
      {
        id: "p1",
        title: "Algebra 1",
        imageUrl: "https://example.test/algebra-1.jpg",
        metaLine: "Matematika • 1. razred • Udžbenik",
        availabilityLabel: "Na zalihi: 2",
        availabilityTone: "available",
        priceLabel: "9,90 EUR",
        buyLink: "https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=Algebra%201",
        sellLink: "https://antikvarijat-libar.com/otkup-udzbenika/?tab=tab-form&pretraga_isbn=1234567890",
        buyButtonLabel: "Otvori kupnju",
        sellButtonLabel: "Otkup"
      }
    ],
    rawProducts: [
      {
        title: "Algebra 1",
        availableForPurchase: true,
        stockCount: 2,
        buyPriceEur: 9.9
      }
    ],
    zendeskSummary: "1. Algebra 1 | dostupno za kupnju | https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=Algebra%201"
  };
}

test("conversation regression keeps product lookup isolated from support routes", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;

  aiService.generateGroundedAnswer = async () => null;

  try {
    for (const scenario of conversationDataset) {
      let productLookupCalled = false;
      let knowledgeLookupCalled = false;

      knowledgeService.searchKnowledgeDetailed = async () => {
        knowledgeLookupCalled = true;

        if (scenario.expectedRoute === "clarify") {
          return null;
        }

        return {
          context: `Kontekst za: ${scenario.message}`,
          articles: [
            {
              title: "Mock KB",
              body:
                scenario.expectedRoute === "onedrive_knowledge"
                  ? "Radimo ponedjeljkom do petka od 08:00 do 20:00."
                  : "Mock body",
              score: 95
            }
          ],
          topScore: 95
        };
      };

      productFeedService.searchProductsDetailed = async (query) => {
        productLookupCalled = true;
        return buildProductMatch(query);
      };

      const session = {
        requesterName: "Ana",
        messages: Array.isArray(scenario.history) ? scenario.history.map((message, index) => ({
          id: `m-${index}`,
          createdAt: new Date(2026, 0, index + 1).toISOString(),
          ...message
        })) : [],
        ...(scenario.session || {})
      };

      const { outcome } = await __internal.resolveAutomatedOutcome(session, scenario.message, {
        channelType: scenario.channel
      });

      assert.equal(
        productLookupCalled,
        scenario.shouldUseProductFeed,
        `${scenario.message} -> unexpected product feed usage`
      );

      if (scenario.expectedRoute === "product_feed") {
        assert.equal(outcome.reason, "product_feed_match", scenario.message);
        assert.equal(outcome.source, "product_feed", scenario.message);
        assert.equal(outcome.taskIntent, "product_lookup", scenario.message);
        assert.equal(Array.isArray(outcome.products) && outcome.products.length > 0, true, scenario.message);
        assert.equal(knowledgeLookupCalled, false, `${scenario.message} -> product route should short-circuit KB`);
        continue;
      }

      assert.notEqual(outcome.source, "product_feed", scenario.message);

      if (scenario.expectedRoute === "onedrive_knowledge") {
        assert.equal(knowledgeLookupCalled, true, scenario.message);
        assert.equal(outcome.reason, "knowledge_fallback", scenario.message);
        continue;
      }

      if (scenario.expectedRoute === "clarify") {
        assert.equal(knowledgeLookupCalled, true, scenario.message);
        assert.ok(
          outcome.type === "ask_clarifying_question" || outcome.reason === "delivery_link_fallback",
          scenario.message
        );
      }
    }
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});
