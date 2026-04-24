require("dotenv").config();

const knowledgeService = require("../services/knowledgeService");

async function main() {
  const force = process.argv.includes("--force");
  const keepMissing = process.argv.includes("--keep-missing");
  const result = await knowledgeService.syncVectorKnowledgeFromOneDrive({
    force,
    deleteMissing: !keepMissing
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    process.exitCode = result.configured === false ? 2 : 1;
  }
}

main().catch((error) => {
  console.error("Vector knowledge sync failed:", error);
  process.exitCode = 1;
});
