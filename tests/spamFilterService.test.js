const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const spamFilterService = require("../services/spamFilterService");
const aiService = require("../services/aiService");

function stubMethod(target, key, replacement, restoreList) {
  restoreList.push([target, key, target[key]]);
  target[key] = replacement;
}

function restoreMethods(restoreList) {
  while (restoreList.length > 0) {
    const [target, key, original] = restoreList.pop();
    target[key] = original;
  }
}

test("non-email channels bypass spam classifier", async () => {
  const result = await spamFilterService.evaluateIncomingMessage({
    channelType: "facebook",
    message: "Koje vam je radno vrijeme?",
    ticketSummary: {}
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.reason, "channel_not_eligible");
});

test("hard heuristic spam is blocked without AI review", async () => {
  const result = await spamFilterService.evaluateIncomingMessage({
    channelType: "email",
    message: "We offer guest post and backlink exchange to boost your traffic.",
    ticketSummary: {}
  });

  assert.equal(result.shouldBlock, true);
  assert.equal(result.usedAiReview, false);
  assert.equal(result.classification, "spam");
});

test("likely spam uses AI review and can be blocked", async () => {
  const restoreList = [];
  stubMethod(aiService, "classifySpamCandidate", async () => ({
    label: "marketing_spam",
    confidence: 0.92,
    reason: "mass outreach"
  }), restoreList);

  try {
    const result = await spamFilterService.evaluateIncomingMessage({
      channelType: "email",
      message: "Dear website owner, I came across your website with a collaboration opportunity.",
      ticketSummary: {}
    });

      assert.equal(result.shouldBlock, true);
    assert.equal(result.usedAiReview, true);
    assert.equal(result.aiClassification.label, "marketing_spam");
  } finally {
    restoreMethods(restoreList);
  }
});

test("support signals prevent false positive blocking for legitimate support mail", async () => {
  const result = await spamFilterService.evaluateIncomingMessage({
    channelType: "email",
    message: "Pozdrav, imam problem s dostavom narudžbe i trebam račun. Hvala.",
    ticketSummary: {}
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.usedAiReview, false);
});

test("buildSpamFilterNote includes heuristic and AI context", () => {
  const note = spamFilterService.buildSpamFilterNote({
    reason: "marketing_spam",
    matchedSignals: ["generic_outreach", "multiple_links"],
    aiClassification: {
      label: "marketing_spam",
      confidence: 0.91
    }
  }, "email");

  assert.match(note, /Spam filter \(email\)/);
  assert.match(note, /generic_outreach, multiple_links/);
  assert.match(note, /marketing_spam \(0\.91\)/);
});
