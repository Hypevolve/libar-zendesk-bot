const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { __internal } = require("../index");

function createMessage({
  role,
  content,
  authoredByHuman = false,
  sourceChannel = "email",
  createdAt = "2026-04-20T18:00:00.000Z"
}) {
  return {
    id: `${role}-${content}`,
    role,
    content,
    authoredByHuman,
    sourceChannel,
    createdAt
  };
}

test("automation resumes after human handoff when a new customer message is the latest public message", () => {
  const ticketSummary = {
    status: "open",
    tags: ["human_active"]
  };
  const messages = [
    createMessage({
      role: "assistant",
      content: "Javit ćemo vam se ručno.",
      authoredByHuman: true,
      sourceChannel: "email",
      createdAt: "2026-04-20T18:00:00.000Z"
    }),
    createMessage({
      role: "user",
      content: "Imam još jedno pitanje oko dostave.",
      sourceChannel: "email",
      createdAt: "2026-04-20T18:05:00.000Z"
    })
  ];

  const blockReason = __internal.getAutomationBlockReason(ticketSummary, messages, "email");

  assert.equal(blockReason, null);
});

test("automation stays blocked while the latest public message is still a human handoff reply", () => {
  const ticketSummary = {
    status: "open",
    tags: ["human_active"]
  };
  const messages = [
    createMessage({
      role: "user",
      content: "Trebam pomoć.",
      sourceChannel: "email",
      createdAt: "2026-04-20T18:00:00.000Z"
    }),
    createMessage({
      role: "assistant",
      content: "Javit ćemo vam se ručno.",
      authoredByHuman: true,
      sourceChannel: "email",
      createdAt: "2026-04-20T18:05:00.000Z"
    })
  ];

  const blockReason = __internal.getAutomationBlockReason(ticketSummary, messages, "email");

  assert.equal(blockReason, "human_active");
});
