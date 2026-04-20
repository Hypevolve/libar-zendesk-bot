const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const knowledgeService = require("../services/knowledgeService");
const aiService = require("../services/aiService");
const { loadFreshOneDriveService } = require("../tests/helpers/oneDriveTestHarness");
const { __internal } = require("../index");

const REPORT_DIR = path.join(__dirname, "..", "docs", "reports");
const DEFAULT_WORKBOOK_PATH = "/Users/zrinko/Downloads/Libar_Chatbot_Upiti_2025-2026.xlsx";
const PYTHON_BIN =
  process.env.CODEX_PYTHON ||
  "/Users/zrinko/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const KNOWLEDGE_ORIENTED_CATEGORIES = new Set([
  "Otkup / prodaja knjiga",
  "Lokacija i radno vrijeme",
  "Dostava i troškovi",
  "Cijena / cjenik",
  "Proces / uputa",
  "Status narudžbe / reklamacija",
  "Popusti i bonusi"
]);

function ensureReportDir() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function buildDateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function extractTopQueries(workbookPath) {
  const pythonScript = `
import json
import sys
from openpyxl import load_workbook

path = sys.argv[1]
wb = load_workbook(path, read_only=True, data_only=True)
ws = wb["Top upiti"]
rows = list(ws.iter_rows(values_only=True))
out = []
for row in rows[1:1001]:
    if not row or not row[1]:
        continue
    out.append({
        "rank": int(row[0] or 0),
        "query": str(row[1]).strip(),
        "count": int(row[2] or 0),
        "category": str(row[3] or "Unknown").strip()
    })
print(json.dumps(out, ensure_ascii=False))
`;

  const result = spawnSync(PYTHON_BIN, ["-c", pythonScript, workbookPath], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to parse workbook: ${result.stderr || result.stdout || "unknown python error"}`
    );
  }

  return JSON.parse(result.stdout || "[]");
}

function createStatsEntry() {
  return {
    rows: 0,
    weighted: 0,
    retrievalHits: 0,
    retrievalMisses: 0,
    safeAnswers: 0,
    nonAutonomous: 0,
    topScoreSum: 0,
    topScoreCount: 0
  };
}

async function resolveAutonomyForQuery(query, category, count) {
  const { knowledge, outcome } = await __internal.resolveAutomatedOutcome(
    {},
    query,
    { channelType: "web_chat" }
  );

  return {
    type: outcome?.type || "unknown",
    reason: outcome?.reason || "unknown",
    title: knowledge?.articles?.[0]?.title || "",
    topScore: Number(knowledge?.topScore || 0),
    query,
    category,
    count,
    knowledge
  };
}

async function runRealQueryRegression(workbookPath) {
  const topQueries = extractTopQueries(workbookPath);
  const { service, restore } = loadFreshOneDriveService();
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const categoryStats = new Map();
  const autonomyReasonStats = new Map();
  const weightedUnsupported = [];
  const startedAt = Date.now();

  let totalRows = 0;
  let totalWeighted = 0;
  let weightedRetrievalHits = 0;
  let weightedRetrievalMisses = 0;
  let weightedSafeAnswers = 0;
  let weightedNonAutonomous = 0;
  let weightedKnowledgeCategoryRows = 0;
  let weightedKnowledgeCategorySafe = 0;

  try {
    knowledgeService.searchKnowledgeDetailed = async (query) => service.searchOneDriveDetailed(query);
    aiService.generateGroundedAnswer = async () => "";

    for (const queryEntry of topQueries) {
      const { query, count, category } = queryEntry;
      totalRows += 1;
      totalWeighted += count;

      if (!categoryStats.has(category)) {
        categoryStats.set(category, createStatsEntry());
      }

      const categoryEntry = categoryStats.get(category);
      categoryEntry.rows += 1;
      categoryEntry.weighted += count;

      const result = await service.searchOneDriveDetailed(query);
      const autonomy = await resolveAutonomyForQuery(query, category, count);

      if (result?.context) {
        weightedRetrievalHits += count;
        categoryEntry.retrievalHits += count;
      } else {
        weightedRetrievalMisses += count;
        categoryEntry.retrievalMisses += count;
      }

      if (Number.isFinite(Number(result?.topScore))) {
        categoryEntry.topScoreSum += Number(result.topScore);
        categoryEntry.topScoreCount += 1;
      }

      if (autonomy.type === "safe_answer") {
        weightedSafeAnswers += count;
        categoryEntry.safeAnswers += count;
      } else {
        weightedNonAutonomous += count;
        categoryEntry.nonAutonomous += count;
        weightedUnsupported.push({
          query,
          count,
          category,
          type: autonomy.type,
          reason: autonomy.reason,
          title: autonomy.title || ""
        });
      }

      const autonomyKey = autonomy.type === "safe_answer"
        ? "safe_answer"
        : `${autonomy.type}:${autonomy.reason}`;
      autonomyReasonStats.set(autonomyKey, (autonomyReasonStats.get(autonomyKey) || 0) + count);

      if (KNOWLEDGE_ORIENTED_CATEGORIES.has(category)) {
        weightedKnowledgeCategoryRows += count;
        if (autonomy.type === "safe_answer") {
          weightedKnowledgeCategorySafe += count;
        }
      }
    }
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    restore();
  }

  const orderedCategoryStats = Object.fromEntries(
    [...categoryStats.entries()]
      .sort((left, right) => right[1].weighted - left[1].weighted)
      .map(([category, entry]) => [
        category,
        {
          ...entry,
          avgTopScore: entry.topScoreCount > 0 ? Number((entry.topScoreSum / entry.topScoreCount).toFixed(2)) : 0,
          weightedRetrievalHitRate:
            entry.weighted > 0 ? Number(((entry.retrievalHits / entry.weighted) * 100).toFixed(2)) : 0,
          weightedAutonomyRate:
            entry.weighted > 0 ? Number(((entry.safeAnswers / entry.weighted) * 100).toFixed(2)) : 0
        }
      ])
  );

  return {
    workbookPath,
    analyzedRows: totalRows,
    weightedTotalQueries: totalWeighted,
    durationMs: Date.now() - startedAt,
    weightedRetrievalHitRate:
      totalWeighted > 0 ? Number(((weightedRetrievalHits / totalWeighted) * 100).toFixed(2)) : 0,
    weightedAutonomyRate:
      totalWeighted > 0 ? Number(((weightedSafeAnswers / totalWeighted) * 100).toFixed(2)) : 0,
    weightedRetrievalHits,
    weightedRetrievalMisses,
    weightedSafeAnswers,
    weightedNonAutonomous,
    weightedKnowledgeCategoryQueries: weightedKnowledgeCategoryRows,
    weightedKnowledgeCategoryAutonomyRate:
      weightedKnowledgeCategoryRows > 0
        ? Number(((weightedKnowledgeCategorySafe / weightedKnowledgeCategoryRows) * 100).toFixed(2))
        : 0,
    knowledgeOrientedCategories: [...KNOWLEDGE_ORIENTED_CATEGORIES],
    autonomyReasonDistribution: Object.fromEntries(
      [...autonomyReasonStats.entries()].sort((left, right) => right[1] - left[1])
    ),
    categoryBreakdown: orderedCategoryStats,
    topNonAutonomousQueries: weightedUnsupported
      .sort((left, right) => right.count - left.count)
      .slice(0, 25)
  };
}

function buildMarkdownReport(report) {
  return [
    "# Real Query Regression Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Workbook: ${report.workbookPath}`,
    "",
    "## Summary",
    `- Analysed rows: ${report.analyzedRows}`,
    `- Weighted total queries: ${report.weightedTotalQueries}`,
    `- Duration: ${report.durationMs} ms`,
    `- Weighted retrieval hit rate: ${report.weightedRetrievalHitRate}%`,
    `- Weighted autonomy rate: ${report.weightedAutonomyRate}%`,
    `- Weighted retrieval hits: ${report.weightedRetrievalHits}`,
    `- Weighted retrieval misses: ${report.weightedRetrievalMisses}`,
    `- Weighted safe answers: ${report.weightedSafeAnswers}`,
    `- Weighted non-autonomous: ${report.weightedNonAutonomous}`,
    `- Knowledge-oriented weighted queries: ${report.weightedKnowledgeCategoryQueries}`,
    `- Knowledge-oriented autonomy rate: ${report.weightedKnowledgeCategoryAutonomyRate}%`,
    "",
    "## Autonomy Reasons",
    ...Object.entries(report.autonomyReasonDistribution).map(([reason, count]) => `- ${reason}: ${count}`),
    "",
    "## Categories",
    ...Object.entries(report.categoryBreakdown).map(
      ([category, stats]) =>
        `- ${category}: weighted ${stats.weighted}, retrieval ${stats.weightedRetrievalHitRate}%, autonomy ${stats.weightedAutonomyRate}%, avg top score ${stats.avgTopScore}`
    ),
    "",
    "## Top Non-Autonomous Queries",
    ...(report.topNonAutonomousQueries.length === 0
      ? ["- None"]
      : report.topNonAutonomousQueries.map(
          (entry) =>
            `- ${entry.query} [${entry.category}] x${entry.count} -> ${entry.type}:${entry.reason}${entry.title ? ` (${entry.title})` : ""}`
        ))
  ].join("\n");
}

async function main() {
  const workbookPath = process.env.REAL_QUERY_DATASET_XLSX || DEFAULT_WORKBOOK_PATH;

  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath}`);
  }

  ensureReportDir();
  const report = await runRealQueryRegression(workbookPath);
  const stamp = buildDateStamp();
  const jsonPath = path.join(REPORT_DIR, `real-query-report-${stamp}.json`);
  const mdPath = path.join(REPORT_DIR, `real-query-report-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(mdPath, buildMarkdownReport(report), "utf8");

  console.log(
    JSON.stringify(
      {
        jsonPath,
        mdPath,
        weightedRetrievalHitRate: report.weightedRetrievalHitRate,
        weightedAutonomyRate: report.weightedAutonomyRate
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
