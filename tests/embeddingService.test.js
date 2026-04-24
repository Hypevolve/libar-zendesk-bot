const test = require("node:test");
const assert = require("node:assert/strict");

const EMBEDDING_SERVICE_PATH = require.resolve("../services/embeddingService");
const OPENAI_PATH = require.resolve("openai");

const ENV_KEYS = [
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_BATCH_SIZE",
  "OPENROUTER_API_KEY",
  "OPENROUTER_EMBEDDING_API_KEY",
  "OPENROUTER_EMBEDDING_MODEL",
  "OPENROUTER_EMBEDDING_DIMENSIONS",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_SITE_NAME",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_DIMENSIONS"
];

function loadFreshEmbeddingService(env = {}) {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalServiceCache = require.cache[EMBEDDING_SERVICE_PATH];
  const originalOpenAiCache = require.cache[OPENAI_PATH];
  const calls = [];
  const instances = [];

  class FakeOpenAI {
    constructor(config = {}) {
      instances.push(config);
      this.embeddings = {
        create: async (request) => {
          calls.push(request);
          const inputs = Array.isArray(request.input) ? request.input : [request.input];

          return {
            data: inputs.map((_, index) => ({
              index,
              embedding: [index + 0.1, index + 0.2]
            }))
          };
        }
      };
    }
  }

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  delete require.cache[EMBEDDING_SERVICE_PATH];
  require.cache[OPENAI_PATH] = {
    id: OPENAI_PATH,
    filename: OPENAI_PATH,
    loaded: true,
    exports: FakeOpenAI
  };

  const service = require(EMBEDDING_SERVICE_PATH);

  return {
    calls,
    instances,
    service,
    restore() {
      if (originalServiceCache) {
        require.cache[EMBEDDING_SERVICE_PATH] = originalServiceCache;
      } else {
        delete require.cache[EMBEDDING_SERVICE_PATH];
      }

      if (originalOpenAiCache) {
        require.cache[OPENAI_PATH] = originalOpenAiCache;
      } else {
        delete require.cache[OPENAI_PATH];
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

test("embeddingService uses OpenRouter embeddings by default when OPENROUTER_API_KEY is configured", async () => {
  const { calls, instances, service, restore } = loadFreshEmbeddingService({
    OPENROUTER_API_KEY: "sk-or-v1-test",
    OPENROUTER_EMBEDDING_MODEL: "openai/text-embedding-3-small",
    EMBEDDING_DIMENSIONS: "1536",
    OPENROUTER_SITE_URL: "https://antikvarijat-libar.com",
    OPENROUTER_SITE_NAME: "Antikvarijat Libar Middleware Bot"
  });

  try {
    assert.equal(service.isConfigured(), true);
    assert.deepEqual(service.getEmbeddingConfigSummary(), {
      enabled: true,
      provider: "openrouter",
      model: "openai/text-embedding-3-small",
      dimensions: 1536,
      batchSize: 64,
      openrouterConfigured: true,
      openaiConfigured: false
    });

    const embeddings = await service.embedTexts([
      " Prvi   tekst za embedding. ",
      "Drugi tekst za embedding."
    ]);

    assert.deepEqual(embeddings, [
      [0.1, 0.2],
      [1.1, 1.2]
    ]);
    assert.equal(instances[0].apiKey, "sk-or-v1-test");
    assert.equal(instances[0].baseURL, "https://openrouter.ai/api/v1");
    assert.equal(instances[0].defaultHeaders["HTTP-Referer"], "https://antikvarijat-libar.com");
    assert.equal(instances[0].defaultHeaders["X-Title"], "Antikvarijat Libar Middleware Bot");
    assert.equal(calls[0].model, "openai/text-embedding-3-small");
    assert.equal(calls[0].dimensions, 1536);
    assert.deepEqual(calls[0].input, [
      "Prvi tekst za embedding.",
      "Drugi tekst za embedding."
    ]);
  } finally {
    restore();
  }
});

test("embeddingService treats sk-or keys in OPENAI_API_KEY as OpenRouter keys", async () => {
  const { instances, service, restore } = loadFreshEmbeddingService({
    OPENAI_API_KEY: "sk-or-v1-placed-in-openai-env"
  });

  try {
    const summary = service.getEmbeddingConfigSummary();

    assert.equal(summary.provider, "openrouter");
    assert.equal(summary.openrouterConfigured, true);
    assert.equal(summary.openaiConfigured, false);

    await service.embedText("test");

    assert.equal(instances[0].apiKey, "sk-or-v1-placed-in-openai-env");
    assert.equal(instances[0].baseURL, "https://openrouter.ai/api/v1");
  } finally {
    restore();
  }
});

test("embeddingService can still use direct OpenAI embeddings when explicitly configured", async () => {
  const { instances, service, restore } = loadFreshEmbeddingService({
    EMBEDDING_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-openai-test",
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small"
  });

  try {
    const summary = service.getEmbeddingConfigSummary();

    assert.equal(summary.provider, "openai");
    assert.equal(summary.model, "text-embedding-3-small");
    assert.equal(summary.openaiConfigured, true);

    await service.embedText("test");

    assert.equal(instances[0].apiKey, "sk-openai-test");
    assert.equal(instances[0].baseURL, undefined);
  } finally {
    restore();
  }
});
