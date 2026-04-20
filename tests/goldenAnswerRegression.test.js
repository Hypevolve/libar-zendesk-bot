const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { goldenAnswerCases } = require("./fixtures/goldenAnswerDataset");
const { __internal } = require("../index");

test("golden answer regression validates correct answers and blocks unsafe or inaccurate ones", () => {
  assert.equal(goldenAnswerCases.length, 150, "expected exactly 150 golden answer cases");

  let validCount = 0;
  let invalidCount = 0;

  for (const testCase of goldenAnswerCases) {
    const qualityCheck = __internal.validateAnswerQuality({
      answer: testCase.answer,
      outcomeType: "safe_answer",
      knowledge: testCase.knowledge
    });

    const finalized = __internal.finalizeOutcomeForCustomer(
      {
        type: "safe_answer",
        stateTag: "ai_active",
        reason: "grounded_answer",
        customerMessage: testCase.answer
      },
      {
        channelType: testCase.channel,
        knowledge: testCase.knowledge
      }
    );

    if (testCase.expectedValidity) {
      validCount += 1;
      assert.equal(qualityCheck.isValid, true, `expected valid answer quality for ${testCase.id}`);
      assert.equal(finalized.type, "safe_answer", `expected safe answer for ${testCase.id}`);
      assert.equal(finalized.reason, "grounded_answer", `expected original reason for ${testCase.id}`);

      for (const pattern of testCase.requiredPatterns || []) {
        assert.match(finalized.customerMessage, pattern, `expected ${pattern} in finalized answer for ${testCase.id}`);
      }

      assert.doesNotMatch(finalized.customerMessage, /\b(ai|baza znanja|interni kontekst)\b/i, `expected no internal leak for ${testCase.id}`);
    } else {
      invalidCount += 1;
      assert.equal(finalized.type, "soft_handoff", `expected guard escalation for ${testCase.id}`);
      assert.equal(finalized.stateTag, "awaiting_human", `expected awaiting_human for ${testCase.id}`);
      const expectedReasons = Array.isArray(testCase.expectedReason)
        ? testCase.expectedReason
        : [testCase.expectedReason];
      assert.ok(expectedReasons.includes(finalized.reason), `expected reason for ${testCase.id}`);
      assert.match(finalized.customerMessage, /Ne želim vam dati|Ne želimo vam poslati/i, `expected soft handoff copy for ${testCase.id}`);
    }
  }

  assert.equal(validCount, 75, "expected 75 valid golden answers");
  assert.equal(invalidCount, 75, "expected 75 invalid golden answers");
});
