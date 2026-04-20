const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { __internal } = require("../index");

test("conversation regression dataset is present and structured", () => {
  const datasetPath = path.join(__dirname, "fixtures", "conversation-regression-dataset.json");
  const parsed = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 10);

  for (const row of parsed) {
    assert.equal(typeof row.channel, "string");
    assert.ok(Array.isArray(row.history));
    assert.equal(typeof row.message, "string");
    assert.equal(typeof row.expectedDomain, "string");
    assert.equal(typeof row.expectedUserJob, "string");
    assert.equal(typeof row.expectedTopicShiftType, "string");
    assert.equal(typeof row.expectedSourceContract, "string");
    assert.equal(typeof row.shouldUseProductFeed, "boolean");
    assert.equal(typeof row.expectedRoute, "string");
  }
});

test("conversation regression dataset resolves expected domains and routes", () => {
  const datasetPath = path.join(__dirname, "fixtures", "conversation-regression-dataset.json");
  const parsed = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

  for (const row of parsed) {
    const runtimeConversation = __internal.buildConversationAnalysis({
      ...(row.session || {}),
      messages: row.history || []
    }, row.message);

    assert.equal(
      runtimeConversation.reasoningResult.activeDomain,
      row.expectedDomain,
      `${row.channel}: expected domain ${row.expectedDomain} for "${row.message}"`
    );
    assert.equal(
      runtimeConversation.reasoningResult.actionIntent,
      row.expectedUserJob,
      `${row.channel}: expected user job ${row.expectedUserJob} for "${row.message}"`
    );
    assert.equal(
      runtimeConversation.reasoningResult.topicShiftType,
      row.expectedTopicShiftType,
      `${row.channel}: expected topic shift ${row.expectedTopicShiftType} for "${row.message}"`
    );
    assert.equal(
      runtimeConversation.reasoningResult.sourceContract,
      row.expectedSourceContract,
      `${row.channel}: expected source contract ${row.expectedSourceContract} for "${row.message}"`
    );
    assert.equal(
      runtimeConversation.supportPlan.route,
      row.expectedRoute,
      `${row.channel}: expected planner route ${row.expectedRoute} for "${row.message}"`
    );

    const shouldUseProductFeed = runtimeConversation.supportPlan.route === "product_feed";
    assert.equal(
      shouldUseProductFeed,
      row.shouldUseProductFeed,
      `${row.channel}: product feed mismatch for "${row.message}"`
    );
  }
});
