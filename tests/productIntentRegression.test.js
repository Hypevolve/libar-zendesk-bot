const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { __internal } = require("../index");

const INTENT_CASES = [
  {
    message: "Imate li knjigu Algebra 1?",
    session: {},
    expected: true
  },
  {
    message: "Prodajete li Hrvatski pravopis Babić, Finka, Moguš?",
    session: {},
    expected: true
  },
  {
    message: "Kako mogu prodati knjige?",
    session: {},
    expected: false
  },
  {
    message: "Koje vam je radno vrijeme?",
    session: {},
    expected: false
  },
  {
    message: "A koliko traje?",
    session: {
      workingMemory: {
        activeDomain: "buyback"
      }
    },
    expected: false
  },
  {
    message: "A za udžbenike?",
    session: {
      workingMemory: {
        activeDomain: "buyback"
      }
    },
    expected: false
  },
  {
    message: "Ima li je još na stanju?",
    session: {
      lastProductTitles: ["Algebra 1"],
      workingMemory: {
        activeDomain: "product_lookup"
      }
    },
    expected: true
  },
  {
    message: "Koja je dostava za Split?",
    session: {
      lastProductTitles: ["Algebra 1"],
      workingMemory: {
        activeDomain: "product_lookup"
      }
    },
    expected: false
  }
];

test("looksLikeProductLookupMessage keeps product intents separated from support intents", () => {
  for (const entry of INTENT_CASES) {
    const actual = __internal.looksLikeProductLookupMessage(entry.message, entry.session);
    assert.equal(actual, entry.expected, entry.message);
  }
});

test("updateSessionRouteMemory stores product context for follow-up availability checks", () => {
  const session = {};

  __internal.updateSessionRouteMemory(session, "Imate li Algebra 1?", {
    source: "product_feed",
    taskIntent: "product_lookup",
    reason: "product_feed_match",
    products: [{ title: "Algebra 1" }]
  });

  assert.equal(session.workingMemory.activeDomain, "product_lookup");
  assert.deepEqual(session.lastProductTitles, ["Algebra 1"]);

  assert.equal(__internal.looksLikeProductLookupMessage("Ima li je još na stanju?", session), true);
});
