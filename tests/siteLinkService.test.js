const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDirectWebsiteLinks } = require("../services/siteLinkService");

test("buildDirectWebsiteLinks returns buyback and faq pages for sell-books questions", () => {
  const result = buildDirectWebsiteLinks({
    conversation: {
      standaloneQuery: "Želim prodati knjige, koji je postupak?",
      reasoningResult: {
        taskIntent: "buyback",
        actionIntent: "ask_how_to",
        primaryIntent: "otkup_upit"
      }
    }
  });

  assert.equal(result[0].url, "https://antikvarijat-libar.com/otkup-udzbenika/");
  assert.equal(result[1].url, "https://antikvarijat-libar.com/najcesca-pitanja/");
});

test("buildDirectWebsiteLinks returns payment page for payment questions", () => {
  const result = buildDirectWebsiteLinks({
    conversation: {
      standaloneQuery: "Koji su načini plaćanja?",
      reasoningResult: {
        taskIntent: "support_info",
        actionIntent: "ask_info",
        primaryIntent: "opci_upit"
      }
    }
  });

  assert.equal(result[0].url, "https://antikvarijat-libar.com/nacini-placanja/");
});

test("buildDirectWebsiteLinks returns contact page for contact and hours questions", () => {
  const result = buildDirectWebsiteLinks({
    conversation: {
      standaloneQuery: "Koje vam je radno vrijeme i koja je adresa?",
      reasoningResult: {
        taskIntent: "support_info",
        actionIntent: "ask_general_info",
        primaryIntent: "opci_upit"
      }
    }
  });

  assert.equal(result[0].url, "https://antikvarijat-libar.com/kontakt/");
});

test("buildDirectWebsiteLinks returns privacy page for data-protection questions", () => {
  const result = buildDirectWebsiteLinks({
    conversation: {
      standaloneQuery: "Kako obrađujete osobne podatke i GDPR?",
      reasoningResult: {
        taskIntent: "support_info",
        actionIntent: "ask_info",
        primaryIntent: "opci_upit"
      }
    }
  });

  assert.equal(result[0].url, "https://antikvarijat-libar.com/zastita-osobnih-podataka/");
});

test("buildDirectWebsiteLinks prefers website retrieval result before heuristic fallback", () => {
  const result = buildDirectWebsiteLinks({
    conversation: {
      standaloneQuery: "Koje vam je radno vrijeme?",
      reasoningResult: {
        taskIntent: "support_info",
        actionIntent: "ask_general_info",
        primaryIntent: "opci_upit"
      }
    },
    knowledge: {
      primarySource: "website",
      articles: [
        {
          source: "website",
          title: "Kontakt",
          url: "https://antikvarijat-libar.com/kontakt/"
        }
      ]
    }
  });

  assert.equal(result[0].url, "https://antikvarijat-libar.com/kontakt/");
});
