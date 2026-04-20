const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHANNEL_SEQUENCE,
  DATASET_TARGET_SIZE,
  FACT_GROUPS,
  QUESTION_VARIANTS_PER_BASE,
  knowledgeRegressionCases
} = require("./fixtures/knowledgeRegressionDataset");

test("knowledge regression dataset stays deterministic and fully distributed", () => {
  assert.equal(FACT_GROUPS.length, 25, "expected 25 fact groups");
  assert.equal(QUESTION_VARIANTS_PER_BASE, 10, "expected 10 variants per base question");
  assert.deepEqual(CHANNEL_SEQUENCE, ["web_chat", "facebook", "email", "web_chat"]);
  assert.equal(knowledgeRegressionCases.length, DATASET_TARGET_SIZE);

  const ids = new Set();
  const queries = new Set();
  const groupCounts = new Map();
  const channelCounts = new Map();

  for (const testCase of knowledgeRegressionCases) {
    assert.ok(testCase.id, "expected case id");
    assert.ok(testCase.groupId, "expected group id");
    assert.ok(testCase.query, `expected query for ${testCase.id}`);
    assert.ok(Array.isArray(testCase.patterns) && testCase.patterns.length >= 1, `expected patterns for ${testCase.id}`);
    assert.equal(ids.has(testCase.id), false, `duplicate id ${testCase.id}`);
    ids.add(testCase.id);

    queries.add(testCase.query);
    groupCounts.set(testCase.groupId, (groupCounts.get(testCase.groupId) || 0) + 1);
    channelCounts.set(testCase.channel, (channelCounts.get(testCase.channel) || 0) + 1);
  }

  assert.equal(ids.size, DATASET_TARGET_SIZE, "expected unique ids for every case");
  assert.ok(queries.size >= 950, `expected high query diversity, got ${queries.size} unique queries`);

  for (const group of FACT_GROUPS) {
    assert.equal(groupCounts.get(group.id), 40, `expected 40 questions for group ${group.id}`);
  }

  assert.deepEqual(
    Object.fromEntries([...channelCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    {
      email: 250,
      facebook: 250,
      web_chat: 500
    }
  );
});
