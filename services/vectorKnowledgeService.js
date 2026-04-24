const crypto = require("crypto");
const axios = require("axios");
const embeddingService = require("./embeddingService");
const oneDriveService = require("./oneDriveService");
const { normalizeForComparison, normalizeWhitespace } = require("./textUtils");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const VECTOR_MATCH_COUNT = Number(process.env.VECTOR_MATCH_COUNT) || 8;
const VECTOR_MIN_SCORE = Number(process.env.VECTOR_MIN_SCORE) || 0.68;
const VECTOR_CONTEXT_ITEMS = Number(process.env.VECTOR_CONTEXT_ITEMS) || 5;
const VECTOR_CHUNK_MAX_CHARS = Number(process.env.VECTOR_CHUNK_MAX_CHARS) || 1200;
const VECTOR_CHUNK_OVERLAP_CHARS = Number(process.env.VECTOR_CHUNK_OVERLAP_CHARS) || 180;
const VECTOR_INSERT_BATCH_SIZE = Number(process.env.VECTOR_INSERT_BATCH_SIZE) || 100;
const IS_TEST_ENV = process.env.NODE_ENV === "test";
const SHOULD_LOG_IN_TEST = process.env.DEBUG_TEST_LOGS === "true";

function logError(...args) {
  if (!IS_TEST_ENV || SHOULD_LOG_IN_TEST) {
    console.error(...args);
  }
}

function maskSecret(value = "") {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= 8) {
    return "***";
  }

  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function isConfigured() {
  return isSupabaseConfigured() && embeddingService.isConfigured();
}

function getVectorConfigSummary() {
  return {
    enabled: isConfigured(),
    supabaseConfigured: isSupabaseConfigured(),
    supabaseUrl: SUPABASE_URL,
    serviceRoleKeyPreview: maskSecret(SUPABASE_SERVICE_ROLE_KEY),
    embeddings: embeddingService.getEmbeddingConfigSummary(),
    matchCount: VECTOR_MATCH_COUNT,
    minScore: VECTOR_MIN_SCORE,
    contextItems: VECTOR_CONTEXT_ITEMS,
    chunkMaxChars: VECTOR_CHUNK_MAX_CHARS,
    chunkOverlapChars: VECTOR_CHUNK_OVERLAP_CHARS
  };
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for vector knowledge.");
  }

  return axios.create({
    baseURL: SUPABASE_URL,
    timeout: 30000,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    }
  });
}

function hashText(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function splitLongText(value = "", maxChars = VECTOR_CHUNK_MAX_CHARS) {
  const words = normalizeWhitespace(value).split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const word of words) {
    const nextValue = current ? `${current} ${word}` : word;

    if (nextValue.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = nextValue;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function tailOverlap(value = "", overlapChars = VECTOR_CHUNK_OVERLAP_CHARS) {
  const normalized = normalizeWhitespace(value);

  if (!normalized || overlapChars <= 0 || normalized.length <= overlapChars) {
    return normalized;
  }

  const tail = normalized.slice(-overlapChars);
  const firstSpace = tail.indexOf(" ");

  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

function chunkText(value = "", maxChars = VECTOR_CHUNK_MAX_CHARS) {
  const normalized = String(value || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .trim();

  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}|\n(?=\s*(?:ČLANAK|CLANAK|\d+[.)]|[-*]\s))/i)
    .map(normalizeWhitespace)
    .filter(Boolean);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const paragraphParts = paragraph.length > maxChars ? splitLongText(paragraph, maxChars) : [paragraph];

    for (const part of paragraphParts) {
      const nextValue = current ? `${current}\n\n${part}` : part;

      if (nextValue.length > maxChars && current) {
        chunks.push(current);
        const overlap = tailOverlap(current);
        current = overlap && overlap !== current ? `${overlap}\n\n${part}` : part;
      } else {
        current = nextValue;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function inferDomain(document = {}, chunkBody = "") {
  const text = normalizeForComparison(`${document.title || ""} ${chunkBody || document.body || ""}`);

  if (/(otkup|prodaj|prodati|prodajem|isplata|aircash|dostavljac|dostavljač|kurir|naljepnic|online otkup)/.test(text)) {
    return "buyback";
  }

  if (/(dostava|isporuk|gls|boxnow|paketomat|tracking|pracen|praćen|pouzec)/.test(text)) {
    return "delivery";
  }

  if (/(narudzb|račun|racun|reklamacij|povrat|zamjen)/.test(text)) {
    return "order";
  }

  if (/(radno vrijeme|kontakt|telefon|email|mail|adresa|placanj|plaćanj)/.test(text)) {
    return "support_info";
  }

  return "general";
}

function buildDocumentChunks(document = {}) {
  const chunks = chunkText(document.body || "");

  return chunks.map((body, index) => ({
    source: "onedrive",
    sourceDocumentId: String(document.id || ""),
    chunkIndex: index,
    title: document.title || "OneDrive dokument",
    body,
    domain: inferDomain(document, body),
    url: document.url || null,
    contentHash: hashText(`${document.id || ""}:${index}:${body}`),
    metadata: {
      path: document.path || "",
      lastModifiedAt: document.lastModifiedAt || null
    }
  }));
}

async function getIndexedDocuments(source = "onedrive") {
  const response = await getSupabaseClient().get("/rest/v1/kb_documents", {
    params: {
      source: `eq.${source}`,
      select: "id,source_document_id,content_hash"
    }
  });

  return Array.isArray(response.data) ? response.data : [];
}

async function upsertDocument(document, contentHash) {
  const response = await getSupabaseClient().post(
    "/rest/v1/kb_documents?on_conflict=source,source_document_id",
    {
      source: "onedrive",
      source_document_id: String(document.id || ""),
      title: document.title || "OneDrive dokument",
      url: document.url || null,
      source_path: document.path || "",
      last_modified_at: document.lastModifiedAt || null,
      content_hash: contentHash,
      metadata: {
        title: document.title || "",
        source: "onedrive"
      },
      synced_at: new Date().toISOString()
    },
    {
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      }
    }
  );

  return Array.isArray(response.data) ? response.data[0] : null;
}

async function deleteChunksForDocument(documentId) {
  await getSupabaseClient().delete("/rest/v1/kb_chunks", {
    params: {
      document_id: `eq.${documentId}`
    }
  });
}

async function deleteDocument(documentId) {
  await getSupabaseClient().delete("/rest/v1/kb_documents", {
    params: {
      id: `eq.${documentId}`
    }
  });
}

async function insertChunkRows(rows = []) {
  for (let index = 0; index < rows.length; index += VECTOR_INSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + VECTOR_INSERT_BATCH_SIZE);

    if (batch.length === 0) {
      continue;
    }

    await getSupabaseClient().post("/rest/v1/kb_chunks", batch, {
      headers: {
        Prefer: "return=minimal"
      }
    });
  }
}

async function indexDocument(document, { force = false, existing = null } = {}) {
  const documentHash = hashText(`${document.title || ""}\n${document.lastModifiedAt || ""}\n${document.body || ""}`);

  if (!force && existing?.content_hash === documentHash) {
    return {
      status: "skipped",
      documentId: existing.id,
      chunks: 0
    };
  }

  const documentRow = await upsertDocument(document, documentHash);

  if (!documentRow?.id) {
    throw new Error(`Unable to upsert vector document for ${document.title || document.id}.`);
  }

  const chunks = buildDocumentChunks(document);

  await deleteChunksForDocument(documentRow.id);

  if (chunks.length === 0) {
    return {
      status: "indexed",
      documentId: documentRow.id,
      chunks: 0
    };
  }

  const embeddings = await embeddingService.embedTexts(
    chunks.map((chunk) => `${chunk.title}\n\n${chunk.body}`)
  );

  if (embeddings.length !== chunks.length) {
    throw new Error(`Embedding count mismatch for ${document.title || document.id}.`);
  }

  const rows = chunks.map((chunk, index) => ({
    document_id: documentRow.id,
    source: chunk.source,
    source_document_id: chunk.sourceDocumentId,
    chunk_index: chunk.chunkIndex,
    title: chunk.title,
    body: chunk.body,
    domain: chunk.domain,
    url: chunk.url,
    content_hash: chunk.contentHash,
    metadata: chunk.metadata,
    embedding: embeddings[index]
  }));

  await insertChunkRows(rows);

  return {
    status: "indexed",
    documentId: documentRow.id,
    chunks: chunks.length
  };
}

async function syncOneDriveKnowledge({ force = false, deleteMissing = true } = {}) {
  if (!isConfigured()) {
    return {
      success: false,
      configured: false,
      reason: "vector_knowledge_not_configured",
      summary: getVectorConfigSummary()
    };
  }

  const documents = await oneDriveService.fetchFolderDocuments();
  const existingDocuments = await getIndexedDocuments("onedrive");
  const existingBySourceId = new Map(
    existingDocuments.map((document) => [String(document.source_document_id || ""), document])
  );
  const seenSourceIds = new Set();
  const result = {
    success: true,
    configured: true,
    documentsSeen: documents.length,
    indexedDocuments: 0,
    skippedDocuments: 0,
    deletedDocuments: 0,
    chunksIndexed: 0,
    errors: []
  };

  for (const document of documents) {
    const sourceId = String(document.id || "");

    if (!sourceId || !document.body) {
      continue;
    }

    seenSourceIds.add(sourceId);

    try {
      const indexed = await indexDocument(document, {
        force,
        existing: existingBySourceId.get(sourceId)
      });

      if (indexed.status === "skipped") {
        result.skippedDocuments += 1;
      } else {
        result.indexedDocuments += 1;
        result.chunksIndexed += indexed.chunks;
      }
    } catch (error) {
      result.errors.push({
        documentId: sourceId,
        title: document.title || "",
        message: error.message
      });
    }
  }

  if (deleteMissing) {
    for (const existingDocument of existingDocuments) {
      const sourceId = String(existingDocument.source_document_id || "");

      if (sourceId && !seenSourceIds.has(sourceId)) {
        await deleteDocument(existingDocument.id);
        result.deletedDocuments += 1;
      }
    }
  }

  result.success = result.errors.length === 0;
  return result;
}

function buildVectorQuery(query = "", options = {}) {
  const pieces = [
    query,
    ...(Array.isArray(options?.retrievalHints) ? options.retrievalHints : []),
    ...(Array.isArray(options?.conversationTerms) ? options.conversationTerms.slice(-2) : [])
  ];

  return pieces.map(normalizeWhitespace).filter(Boolean).join("\n");
}

function normalizeDomainFilter(options = {}) {
  const domain = normalizeForComparison(options.taskIntent || options.activeDomain || "");

  if (["buyback", "delivery", "order", "support_info"].includes(domain)) {
    return domain;
  }

  return null;
}

async function searchVectorKnowledgeDetailed(query, options = {}) {
  if (!isConfigured()) {
    return null;
  }

  try {
    const vectorQuery = buildVectorQuery(query, options);
    const embedding = await embeddingService.embedText(vectorQuery);

    if (!embedding) {
      return null;
    }

    const response = await getSupabaseClient().post("/rest/v1/rpc/match_knowledge_chunks", {
      query_embedding: embedding,
      match_count: VECTOR_MATCH_COUNT,
      match_threshold: VECTOR_MIN_SCORE,
      filter_source: "onedrive",
      filter_domain: normalizeDomainFilter(options)
    });
    const rows = Array.isArray(response.data) ? response.data : [];

    if (rows.length === 0) {
      return null;
    }

    const articles = rows.slice(0, VECTOR_CONTEXT_ITEMS).map((row) => ({
      id: row.chunk_id || row.id || null,
      title: row.title || "OneDrive dokument",
      body: row.body || "",
      score: Math.round(Number(row.similarity || 0) * 100),
      source: "onedrive",
      url: row.url || null,
      retrieval: "vector",
      domain: row.domain || null,
      documentId: row.document_id || null
    }));
    const context = articles
      .map((article, index) => [
        `Dokument ${index + 1}:`,
        "Izvor: OneDrive vector",
        `Naslov: ${article.title}`,
        `Relevantnost: ${article.score}`,
        `Sadržaj: ${article.body}`
      ].join("\n"))
      .join("\n\n");

    return {
      context,
      articles,
      topScore: articles[0]?.score || 0,
      totalMatches: articles.length,
      primarySource: "onedrive"
    };
  } catch (error) {
    logError("Vector knowledge retrieval failed:", {
      message: error.message,
      status: error.response?.status,
      responseData: error.response?.data
    });

    return null;
  }
}

module.exports = {
  buildDocumentChunks,
  getVectorConfigSummary,
  isConfigured,
  searchVectorKnowledgeDetailed,
  syncOneDriveKnowledge,
  __internal: {
    chunkText,
    inferDomain,
    buildVectorQuery,
    normalizeDomainFilter,
    hashText
  }
};
