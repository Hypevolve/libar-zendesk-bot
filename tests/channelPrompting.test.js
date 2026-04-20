const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const aiService = require("../services/aiService");
const spamFilterService = require("../services/spamFilterService");

test("web chat prompt keeps chat-specific instructions", () => {
  const prompt = aiService.buildSystemPrompt("Kontekst", {
    channelType: "web_chat"
  });

  assert.match(prompt, /KANAL: Web chat/);
  assert.match(prompt, /kraći i direktniji/);
  assert.doesNotMatch(prompt, /prirodan support email odgovor/);
});

test("facebook prompt keeps conversational non-email instructions", () => {
  const prompt = aiService.buildSystemPrompt("Kontekst", {
    channelType: "facebook"
  });

  assert.match(prompt, /KANAL: Facebook/);
  assert.match(prompt, /kraći i razgovorniji/);
  assert.match(prompt, /Nemoj koristiti web-chat formulacije/);
  assert.doesNotMatch(prompt, /support email odgovor/);
});

test("email prompt keeps email-specific formatting instructions", () => {
  const prompt = aiService.buildSystemPrompt("Kontekst", {
    channelType: "email"
  });

  assert.match(prompt, /KANAL: Email/);
  assert.match(prompt, /prirodan support email odgovor/);
  assert.match(prompt, /Ne generiraj subject ni potpis/);
  assert.doesNotMatch(prompt, /razgovorniji nego email/);
});

test("spam filter ignores non-email channels", async () => {
  const result = await spamFilterService.evaluateIncomingMessage({
    channelType: "facebook",
    message: "Guest post opportunity for your website",
    ticketSummary: {
      tags: []
    }
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.reason, "channel_not_eligible");
});
