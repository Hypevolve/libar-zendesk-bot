const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { knowledgeRegressionCases } = require("../tests/fixtures/knowledgeRegressionDataset");
const { goldenAnswerCases } = require("../tests/fixtures/goldenAnswerDataset");
const { loadFreshOneDriveService } = require("../tests/helpers/oneDriveTestHarness");
const { __internal } = require("../index");

const REPORT_DIR = path.join(__dirname, "..", "docs", "reports");

function ensureReportDir() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function buildDateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function runKnowledgeRegression() {
  const { service, restore } = loadFreshOneDriveService();
  const failures = [];
  const groupStats = new Map();
  const channelStats = new Map();
  const startedAt = Date.now();

  try {
    for (const testCase of knowledgeRegressionCases) {
      groupStats.set(testCase.groupId, (groupStats.get(testCase.groupId) || 0) + 1);
      channelStats.set(testCase.channel, (channelStats.get(testCase.channel) || 0) + 1);

      const result = await service.searchOneDriveDetailed(testCase.query);

      if (!result?.context) {
        failures.push({
          id: testCase.id,
          type: "missing_context",
          query: testCase.query,
          channel: testCase.channel,
          groupId: testCase.groupId
        });
        continue;
      }

      for (const pattern of testCase.patterns) {
        if (!pattern.test(result.context)) {
          failures.push({
            id: testCase.id,
            type: "pattern_mismatch",
            query: testCase.query,
            channel: testCase.channel,
            groupId: testCase.groupId,
            pattern: String(pattern)
          });
          break;
        }
      }
    }
  } finally {
    restore();
  }

  return {
    totalCases: knowledgeRegressionCases.length,
    passedCases: knowledgeRegressionCases.length - failures.length,
    failedCases: failures.length,
    durationMs: Date.now() - startedAt,
    passRate: Number((((knowledgeRegressionCases.length - failures.length) / knowledgeRegressionCases.length) * 100).toFixed(2)),
    groupDistribution: Object.fromEntries([...groupStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    channelDistribution: Object.fromEntries([...channelStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    failures: failures.slice(0, 20)
  };
}

function runGoldenAnswerRegression() {
  const failures = [];
  const reasonStats = new Map();
  const channelStats = new Map();
  const startedAt = Date.now();

  for (const testCase of goldenAnswerCases) {
    channelStats.set(testCase.channel, (channelStats.get(testCase.channel) || 0) + 1);

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

    const effectiveReason = finalized.type === "soft_handoff" ? finalized.reason : qualityCheck.reason;
    reasonStats.set(effectiveReason, (reasonStats.get(effectiveReason) || 0) + 1);

    if (testCase.expectedValidity) {
      if (finalized.type !== "safe_answer") {
        failures.push({
          id: testCase.id,
          type: "unexpected_block",
          reason: effectiveReason
        });
      }
      continue;
    }

    const expectedReasons = Array.isArray(testCase.expectedReason)
      ? testCase.expectedReason
      : [testCase.expectedReason];

    if (finalized.type !== "soft_handoff" || !expectedReasons.includes(finalized.reason)) {
      failures.push({
        id: testCase.id,
        type: "unexpected_pass_or_reason",
        reason: effectiveReason,
        expectedReason: testCase.expectedReason
      });
    }
  }

  return {
    totalCases: goldenAnswerCases.length,
    passedCases: goldenAnswerCases.length - failures.length,
    failedCases: failures.length,
    durationMs: Date.now() - startedAt,
    passRate: Number((((goldenAnswerCases.length - failures.length) / goldenAnswerCases.length) * 100).toFixed(2)),
    channelDistribution: Object.fromEntries([...channelStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    reasonDistribution: Object.fromEntries([...reasonStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    failures
  };
}

function buildMarkdownReport({ generatedAt, knowledge, golden }) {
  return [
    "# Regression Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Knowledge Retrieval",
    `- Total cases: ${knowledge.totalCases}`,
    `- Passed: ${knowledge.passedCases}`,
    `- Failed: ${knowledge.failedCases}`,
    `- Pass rate: ${knowledge.passRate}%`,
    `- Duration: ${knowledge.durationMs} ms`,
    "",
    "Channel distribution:",
    ...Object.entries(knowledge.channelDistribution).map(([channel, count]) => `- ${channel}: ${count}`),
    "",
    "## Golden Answers",
    `- Total cases: ${golden.totalCases}`,
    `- Passed: ${golden.passedCases}`,
    `- Failed: ${golden.failedCases}`,
    `- Pass rate: ${golden.passRate}%`,
    `- Duration: ${golden.durationMs} ms`,
    "",
    "Reason distribution:",
    ...Object.entries(golden.reasonDistribution).map(([reason, count]) => `- ${reason}: ${count}`),
    "",
    "## Sample Failures",
    ...(knowledge.failures.length === 0 && golden.failures.length === 0
      ? ["- None"]
      : [
          ...knowledge.failures.slice(0, 10).map((failure) => `- Retrieval ${failure.id}: ${failure.type}${failure.pattern ? ` (${failure.pattern})` : ""}`),
          ...golden.failures.slice(0, 10).map((failure) => `- Golden ${failure.id}: ${failure.type} (${failure.reason})`)
        ])
  ].join("\n");
}

async function main() {
  ensureReportDir();
  const generatedAt = new Date().toISOString();
  const knowledge = await runKnowledgeRegression();
  const golden = runGoldenAnswerRegression();
  const report = {
    generatedAt,
    knowledge,
    golden
  };
  const stamp = buildDateStamp();
  const jsonPath = path.join(REPORT_DIR, `regression-report-${stamp}.json`);
  const mdPath = path.join(REPORT_DIR, `regression-report-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(mdPath, buildMarkdownReport(report), "utf8");

  console.log(JSON.stringify({
    jsonPath,
    mdPath,
    knowledgePassRate: knowledge.passRate,
    goldenPassRate: golden.passRate
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
