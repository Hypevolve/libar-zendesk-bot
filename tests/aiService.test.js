const test = require("node:test");
const assert = require("node:assert/strict");

const AI_SERVICE_PATH = require.resolve("../services/aiService");
const OPENAI_PATH = require.resolve("openai");
const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_FALLBACK_MODEL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_SITE_NAME"
];

function loadAiServiceWithMock({ env = {}, create }) {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  const originalOpenAiCache = require.cache[OPENAI_PATH];
  const originalAiServiceCache = require.cache[AI_SERVICE_PATH];
  const calls = [];

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.OPENROUTER_API_KEY = "test-openrouter-key";

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  class MockOpenAI {
    constructor(config) {
      this.config = config;
      this.chat = {
        completions: {
          create: async (request) => {
            calls.push(request);
            return create(request, calls);
          }
        }
      };
    }
  }

  require.cache[OPENAI_PATH] = {
    id: OPENAI_PATH,
    filename: OPENAI_PATH,
    loaded: true,
    exports: MockOpenAI
  };
  delete require.cache[AI_SERVICE_PATH];

  const aiService = require(AI_SERVICE_PATH);

  return {
    aiService,
    calls,
    restore() {
      if (originalOpenAiCache) {
        require.cache[OPENAI_PATH] = originalOpenAiCache;
      } else {
        delete require.cache[OPENAI_PATH];
      }

      if (originalAiServiceCache) {
        require.cache[AI_SERVICE_PATH] = originalAiServiceCache;
      } else {
        delete require.cache[AI_SERVICE_PATH];
      }

      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

test("aiService defaults to GPT-5 with Gemini 2.5 Pro fallback", () => {
  const { aiService, restore } = loadAiServiceWithMock({
    create: async () => ({ choices: [{ message: { content: "" } }] })
  });

  try {
    assert.deepEqual(aiService.getConfiguredModels(), [
      "openai/gpt-5",
      "google/gemini-2.5-pro"
    ]);
  } finally {
    restore();
  }
});

test("aiService honors configured primary and fallback models without duplicates", () => {
  const { aiService, restore } = loadAiServiceWithMock({
    env: {
      OPENROUTER_MODEL: " openai/gpt-5 ",
      OPENROUTER_FALLBACK_MODEL: "openai/gpt-5"
    },
    create: async () => ({ choices: [{ message: { content: "" } }] })
  });

  try {
    assert.deepEqual(aiService.getConfiguredModels(), ["openai/gpt-5"]);
  } finally {
    restore();
  }
});

test("generateGroundedAnswer falls back from GPT-5 to Gemini 2.5 Pro", async () => {
  let requestCount = 0;
  const { aiService, calls, restore } = loadAiServiceWithMock({
    create: async () => {
      requestCount += 1;

      if (requestCount === 1) {
        const error = new Error("primary unavailable");
        error.status = 529;
        throw error;
      }

      return {
        choices: [{ message: { content: "Narudžbu možete provjeriti preko broja narudžbe." } }]
      };
    }
  });

  try {
    const reply = await aiService.generateGroundedAnswer(
      "Gdje je moja narudžba?",
      "Za status narudžbe potreban je broj narudžbe."
    );

    assert.equal(reply, "Narudžbu možete provjeriti preko broja narudžbe.");
    assert.deepEqual(calls.map((call) => call.model), [
      "openai/gpt-5",
      "google/gemini-2.5-pro"
    ]);
  } finally {
    restore();
  }
});

test("classifySpamCandidate falls back and parses JSON from Gemini 2.5 Pro", async () => {
  let requestCount = 0;
  const { aiService, calls, restore } = loadAiServiceWithMock({
    create: async () => {
      requestCount += 1;

      if (requestCount === 1) {
        const error = new Error("primary unavailable");
        error.status = 503;
        throw error;
      }

      return {
        choices: [{
          message: {
            content: JSON.stringify({
              label: "support_message",
              confidence: 0.91,
              reason: "order_status_question"
            })
          }
        }]
      };
    }
  });

  try {
    const result = await aiService.classifySpamCandidate(
      "Pozdrav, možete li provjeriti status narudžbe?",
      { channelType: "email" }
    );

    assert.deepEqual(result, {
      label: "support_message",
      confidence: 0.91,
      reason: "order_status_question"
    });
    assert.deepEqual(calls.map((call) => call.model), [
      "openai/gpt-5",
      "google/gemini-2.5-pro"
    ]);
  } finally {
    restore();
  }
});

test("generateReply falls back and returns normalized structured decisions", async () => {
  const { aiService, calls, restore } = loadAiServiceWithMock({
    create: async (request) => {
      if (request.model === "openai/gpt-5") {
        const error = new Error("primary unavailable");
        error.status = 500;
        throw error;
      }

      return {
        choices: [{
          message: {
            content: JSON.stringify({
              decision: "safe_answer",
              reply: "Možete naručiti preko web stranice nakon što pronađete traženi naslov.",
              clarifying_question: "",
              reason: "context_supported"
            })
          }
        }]
      };
    }
  });

  try {
    const result = await aiService.generateReply(
      "Kako mogu naručiti?",
      "Kupnja ide preko web stranice.",
      { channelType: "web_chat" }
    );

    assert.deepEqual(result, {
      decision: "safe_answer",
      reply: "Možete naručiti preko web stranice nakon što pronađete traženi naslov.",
      clarifyingQuestion: "Možete naručiti preko web stranice nakon što pronađete traženi naslov.",
      reason: "context_supported"
    });
    assert.deepEqual(calls.map((call) => call.model), [
      "openai/gpt-5",
      "openai/gpt-5",
      "google/gemini-2.5-pro"
    ]);
  } finally {
    restore();
  }
});
