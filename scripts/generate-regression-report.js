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
  const sourceStats = new Map();
  const autonomyReasonStats = new Map();
  const autonomyChannelStats = new Map();
  let topScoreSum = 0;
  let topScoreCount = 0;
  const startedAt = Date.now();

  try {
    for (const testCase of knowledgeRegressionCases) {
      if (!groupStats.has(testCase.groupId)) {
        groupStats.set(testCase.groupId, {
          total: 0,
          passed: 0,
          failed: 0,
          avgTopScore: 0,
          autonomySafe: 0,
          autonomySoftHandoff: 0
        });
      }

      const groupEntry = groupStats.get(testCase.groupId);
      groupEntry.total += 1;
      channelStats.set(testCase.channel, (channelStats.get(testCase.channel) || 0) + 1);

      const result = await service.searchOneDriveDetailed(testCase.query);

      if (!result?.context) {
        groupEntry.failed += 1;
        failures.push({
          id: testCase.id,
          type: "missing_context",
          query: testCase.query,
          channel: testCase.channel,
          groupId: testCase.groupId
        });
        continue;
      }

      groupEntry.passed += 1;
      sourceStats.set(result.articles?.[0]?.source || "unknown", (sourceStats.get(result.articles?.[0]?.source || "unknown") || 0) + 1);

      if (Number.isFinite(Number(result.topScore))) {
        topScoreSum += Number(result.topScore);
        topScoreCount += 1;
        groupEntry.avgTopScore += Number(result.topScore);
      }

      const simulatedAutonomyOutcome = __internal.finalizeOutcomeForCustomer(
        {
          type: "safe_answer",
          stateTag: "ai_active",
          reason: "knowledge_fallback",
          customerMessage: result.articles?.[0]?.body || ""
        },
        {
          channelType: testCase.channel,
          knowledge: result
        }
      );

      const autonomyKey = simulatedAutonomyOutcome?.type === "safe_answer"
        ? "safe_answer"
        : `${simulatedAutonomyOutcome?.type || "unknown"}:${simulatedAutonomyOutcome?.reason || "unknown"}`;

      autonomyReasonStats.set(autonomyKey, (autonomyReasonStats.get(autonomyKey) || 0) + 1);
      autonomyChannelStats.set(
        testCase.channel,
        (autonomyChannelStats.get(testCase.channel) || 0) + (simulatedAutonomyOutcome?.type === "safe_answer" ? 1 : 0)
      );

      if (simulatedAutonomyOutcome?.type === "safe_answer") {
        groupEntry.autonomySafe += 1;
      } else {
        groupEntry.autonomySoftHandoff += 1;
      }

      for (const pattern of testCase.patterns) {
        if (!pattern.test(result.context)) {
          groupEntry.passed -= 1;
          groupEntry.failed += 1;
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

  const normalizedGroupStats = Object.fromEntries(
    [...groupStats.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([groupId, entry]) => [
        groupId,
        {
          ...entry,
          avgTopScore: entry.total > 0 ? Number((entry.avgTopScore / entry.total).toFixed(2)) : 0
        }
      ])
  );

  return {
    totalCases: knowledgeRegressionCases.length,
    passedCases: knowledgeRegressionCases.length - failures.length,
    failedCases: failures.length,
    durationMs: Date.now() - startedAt,
    passRate: Number((((knowledgeRegressionCases.length - failures.length) / knowledgeRegressionCases.length) * 100).toFixed(2)),
    avgTopScore: topScoreCount > 0 ? Number((topScoreSum / topScoreCount).toFixed(2)) : 0,
    groupDistribution: Object.fromEntries([...groupStats.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([groupId, entry]) => [groupId, entry.total])),
    groupBreakdown: normalizedGroupStats,
    channelDistribution: Object.fromEntries([...channelStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    sourceDistribution: Object.fromEntries([...sourceStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    autonomySimulation: {
      safeAnswers: [...autonomyReasonStats.entries()].reduce((sum, [reason, count]) => sum + (reason === "safe_answer" ? count : 0), 0),
      nonAutonomous: [...autonomyReasonStats.entries()].reduce((sum, [reason, count]) => sum + (reason === "safe_answer" ? 0 : count), 0),
      channelSafeDistribution: Object.fromEntries([...autonomyChannelStats.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
      reasonDistribution: Object.fromEntries([...autonomyReasonStats.entries()].sort((left, right) => left[0].localeCompare(right[0])))
    },
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
    `- Average top score: ${knowledge.avgTopScore}`,
    "",
    "Channel distribution:",
    ...Object.entries(knowledge.channelDistribution).map(([channel, count]) => `- ${channel}: ${count}`),
    "",
    "Source distribution:",
    ...Object.entries(knowledge.sourceDistribution).map(([source, count]) => `- ${source}: ${count}`),
    "",
    "Autonomy simulation:",
    `- Safe answers: ${knowledge.autonomySimulation.safeAnswers}`,
    `- Non-autonomous outcomes: ${knowledge.autonomySimulation.nonAutonomous}`,
    ...Object.entries(knowledge.autonomySimulation.channelSafeDistribution).map(([channel, count]) => `- ${channel} safe: ${count}`),
    "",
    "Autonomy reasons:",
    ...Object.entries(knowledge.autonomySimulation.reasonDistribution).map(([reason, count]) => `- ${reason}: ${count}`),
    "",
    "Group breakdown:",
    ...Object.entries(knowledge.groupBreakdown).map(([groupId, stats]) => `- ${groupId}: pass ${stats.passed}/${stats.total}, avg top score ${stats.avgTopScore}, autonomy ${stats.autonomySafe}/${stats.total}`),
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
