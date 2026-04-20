const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("intent regression dataset is present and structured", () => {
  const datasetPath = path.join(__dirname, "fixtures", "intent-regression-dataset.json");
  const parsed = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 5);

  for (const row of parsed) {
    assert.equal(typeof row.message, "string");
    assert.equal(typeof row.intent, "string");
    assert.equal(typeof row.desiredSource, "string");
    assert.equal(typeof row.shouldUseProductFeed, "boolean");
    assert.equal(typeof row.expectedOutcome, "string");
  }
});
