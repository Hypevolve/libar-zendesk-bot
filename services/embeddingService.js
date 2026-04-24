const OpenAI = require("openai");

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_EMBEDDING_MODEL = String(process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small").trim();
const OPENAI_EMBEDDING_DIMENSIONS = Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) || 1536;
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE) || 64;

let client = null;

function isConfigured() {
  return Boolean(OPENAI_API_KEY);
}

function getEmbeddingConfigSummary() {
  return {
    enabled: isConfigured(),
    model: OPENAI_EMBEDDING_MODEL,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    batchSize: EMBEDDING_BATCH_SIZE
  };
}

function getClient() {
  if (!isConfigured()) {
    throw new Error("OPENAI_API_KEY is required for vector embeddings.");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: OPENAI_API_KEY
    });
  }

  return client;
}

function normalizeEmbeddingInput(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function buildEmbeddingRequest(input) {
  const request = {
    model: OPENAI_EMBEDDING_MODEL,
    input
  };

  if (/^text-embedding-3/.test(OPENAI_EMBEDDING_MODEL) && OPENAI_EMBEDDING_DIMENSIONS > 0) {
    request.dimensions = OPENAI_EMBEDDING_DIMENSIONS;
  }

  return request;
}

async function embedTexts(texts = []) {
  const normalizedTexts = texts.map(normalizeEmbeddingInput).filter(Boolean);
  const embeddings = [];

  for (let index = 0; index < normalizedTexts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = normalizedTexts.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await getClient().embeddings.create(buildEmbeddingRequest(batch));
    const batchEmbeddings = Array.isArray(response?.data)
      ? response.data
          .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
          .map((entry) => entry.embedding)
      : [];

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
