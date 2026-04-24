const OpenAI = require("openai");

function looksLikeOpenRouterKey(value = "") {
  return String(value || "").trim().startsWith("sk-or-");
}

const OPENAI_API_KEY_VALUE = String(process.env.OPENAI_API_KEY || "").trim();
const OPENROUTER_API_KEY = String(
  process.env.OPENROUTER_EMBEDDING_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  (looksLikeOpenRouterKey(OPENAI_API_KEY_VALUE) ? OPENAI_API_KEY_VALUE : "")
).trim();
const OPENAI_API_KEY = looksLikeOpenRouterKey(OPENAI_API_KEY_VALUE) ? "" : OPENAI_API_KEY_VALUE;
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function normalizeEmbeddingProvider(value = "") {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "openrouter" || normalized === "openai") {
    return normalized;
  }

  return "";
}

function resolveEmbeddingProvider() {
  const configuredProvider = normalizeEmbeddingProvider(process.env.EMBEDDING_PROVIDER);

  if (configuredProvider) {
    return configuredProvider;
  }

  if (OPENROUTER_API_KEY) {
    return "openrouter";
  }

  if (OPENAI_API_KEY) {
    return "openai";
  }

  return "openrouter";
}

const EMBEDDING_PROVIDER = resolveEmbeddingProvider();
const EMBEDDING_MODEL = String(
  process.env.EMBEDDING_MODEL ||
  (EMBEDDING_PROVIDER === "openrouter"
    ? process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_OPENROUTER_EMBEDDING_MODEL
    : process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_OPENAI_EMBEDDING_MODEL)
).trim();
const EMBEDDING_DIMENSIONS = Number(
  process.env.EMBEDDING_DIMENSIONS ||
  (EMBEDDING_PROVIDER === "openrouter"
    ? process.env.OPENROUTER_EMBEDDING_DIMENSIONS
    : process.env.OPENAI_EMBEDDING_DIMENSIONS) ||
  process.env.OPENAI_EMBEDDING_DIMENSIONS
) || 1536;
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE) || 64;

const clients = new Map();

function isConfigured() {
  if (EMBEDDING_PROVIDER === "openrouter") {
    return Boolean(OPENROUTER_API_KEY);
  }

  if (EMBEDDING_PROVIDER === "openai") {
    return Boolean(OPENAI_API_KEY);
  }

  return false;
}

function getEmbeddingConfigSummary() {
  return {
    enabled: isConfigured(),
    provider: EMBEDDING_PROVIDER,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    batchSize: EMBEDDING_BATCH_SIZE,
    openrouterConfigured: Boolean(OPENROUTER_API_KEY),
    openaiConfigured: Boolean(OPENAI_API_KEY)
  };
}

function getClient() {
  if (!isConfigured()) {
    if (EMBEDDING_PROVIDER === "openai") {
      throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai.");
    }

    throw new Error("OPENROUTER_API_KEY is required for OpenRouter vector embeddings.");
  }

  if (!clients.has(EMBEDDING_PROVIDER)) {
    if (EMBEDDING_PROVIDER === "openrouter") {
      clients.set(EMBEDDING_PROVIDER, new OpenAI({
        apiKey: OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: {
          ...(process.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL } : {}),
          ...(process.env.OPENROUTER_SITE_NAME ? { "X-Title": process.env.OPENROUTER_SITE_NAME } : {})
        }
      }));
    } else {
      clients.set(EMBEDDING_PROVIDER, new OpenAI({
        apiKey: OPENAI_API_KEY
      }));
    }
  }

  return clients.get(EMBEDDING_PROVIDER);
}

function normalizeEmbeddingInput(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function buildEmbeddingRequest(input) {
  const request = {
    model: EMBEDDING_MODEL,
    input
  };

  if (/(^|\/)text-embedding-3/.test(EMBEDDING_MODEL) && EMBEDDING_DIMENSIONS > 0) {
    request.dimensions = EMBEDDING_DIMENSIONS;
  }

  return request;
}

function extractEmbeddingRows(response) {
  return Array.isArray(response?.data) ? response.data : [];
}

async function embedTexts(texts = []) {
  const normalizedTexts = texts.map(normalizeEmbeddingInput).filter(Boolean);
  const embeddings = [];

  for (let index = 0; index < normalizedTexts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = normalizedTexts.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await getClient().embeddings.create(buildEmbeddingRequest(batch));
    const batchEmbeddings = extractEmbeddingRows(response)
      .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
      .map((entry) => entry.embedding);

    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

async function embedText(text = "") {
  const [embedding] = await embedTexts([text]);
  return embedding || null;
}

module.exports = {
  embedText,
  embedTexts,
  getEmbeddingConfigSummary,
  isConfigured,
  normalizeEmbeddingInput
};
