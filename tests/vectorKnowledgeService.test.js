const test = require("node:test");
const assert = require("node:assert/strict");

const VECTOR_SERVICE_PATH = require.resolve("../services/vectorKnowledgeService");
const EMBEDDING_SERVICE_PATH = require.resolve("../services/embeddingService");

function loadFreshVectorService(env = {}) {
  const keys = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
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
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalCache = require.cache[VECTOR_SERVICE_PATH];
  const originalEmbeddingCache = require.cache[EMBEDDING_SERVICE_PATH];

  for (const key of keys) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  delete require.cache[VECTOR_SERVICE_PATH];
  delete require.cache[EMBEDDING_SERVICE_PATH];
  const service = require(VECTOR_SERVICE_PATH);

  return {
    service,
    restore() {
      if (originalCache) {
        require.cache[VECTOR_SERVICE_PATH] = originalCache;
      } else {
        delete require.cache[VECTOR_SERVICE_PATH];
      }

      if (originalEmbeddingCache) {
        require.cache[EMBEDDING_SERVICE_PATH] = originalEmbeddingCache;
      } else {
        delete require.cache[EMBEDDING_SERVICE_PATH];
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

test("vectorKnowledgeService reports disabled state when Supabase or embeddings are not configured", () => {
  const { service, restore } = loadFreshVectorService();

  try {
    const summary = service.getVectorConfigSummary();

    assert.equal(summary.enabled, false);
    assert.equal(service.isConfigured(), false);
  } finally {
    restore();
  }
});

test("buildDocumentChunks creates bounded chunks with useful domain metadata", () => {
  const { service, restore } = loadFreshVectorService();
  const document = {
    id: "doc-1",
    title: "Online otkup i predaja paketa",
    body: [
      "Kod online otkupa paket predajete dostavljaču prema dogovorenom prikupu.",
      "",
      "Dostavljač donosi naljepnicu, a vi ništa ne pišete na paket.",
      "",
      "Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat."
    ].join("\n"),
    url: "https://example.com/doc",
    lastModifiedAt: "2026-04-24T12:00:00Z"
  };

  try {
    const chunks = service.buildDocumentChunks(document);

    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((chunk) => chunk.source === "onedrive"));
    assert.ok(chunks.every((chunk) => chunk.sourceDocumentId === "doc-1"));
    assert.ok(chunks.every((chunk) => chunk.domain === "buyback"));
    assert.match(chunks[0].body, /dostavljač|dostavljac/i);
  } finally {
    restore();
  }
});

test("vector query builder includes retrieval hints and recent conversation terms", () => {
  const { service, restore } = loadFreshVectorService();

  try {
    const query = service.__internal.buildVectorQuery("A kako da predam paket?", {
      retrievalHints: ["online otkup", "gls", "naljepnica"],
      conversationTerms: [
        "Kako da zapakiram knjige za otkup?",
        "Mogu li sam odnijeti paket u GLS?"
      ]
    });

    assert.match(query, /predam paket/i);
    assert.match(query, /online otkup/i);
    assert.match(query, /naljepnica/i);
    assert.match(query, /zapakiram knjige za otkup/i);
  } finally {
    restore();
  }
});
