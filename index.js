require("dotenv").config();

const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const multer = require("multer");
const zendeskService = require("./services/zendeskService");
const aiService = require("./services/aiService");
const knowledgeService = require("./services/knowledgeService");
const oneDriveService = require("./services/oneDriveService");
const productFeedService = require("./services/productFeedService");
const spamFilterService = require("./services/spamFilterService");
const runtimeStore = require("./services/runtimeStore");
const metricsService = require("./services/metricsService");
const { BASE_URL, buildDirectWebsiteLinks } = require("./services/siteLinkService");
const { normalizeForComparison, normalizeWhitespace } = require("./services/textUtils");

const app = express();
const IS_TEST_ENV = process.env.NODE_ENV === "test";
const SHOULD_LOG_IN_TEST = process.env.DEBUG_TEST_LOGS === "true";
const chatSessions = new Map();
const processedWebhookAudits = new Map();
const processedWebhookMessages = new Map();
const recentChatStarts = new Map();
let vectorKnowledgeSyncPromise = null;
const WEBHOOK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const CHAT_START_DEDUPLICATION_TTL_MS =
  Number(process.env.CHAT_START_DEDUPLICATION_TTL_MS) || 10 * 60 * 1000;
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const chatStreams = new Map();
const KNOWLEDGE_MIN_TOP_SCORE = Number(process.env.KNOWLEDGE_MIN_TOP_SCORE) || 8;
const VECTOR_AUTO_SYNC_ENABLED = String(process.env.VECTOR_AUTO_SYNC_ENABLED || "false").toLowerCase() === "true";
const VECTOR_AUTO_SYNC_INTERVAL_MS = Number(process.env.VECTOR_AUTO_SYNC_INTERVAL_MS) || 24 * 60 * 60 * 1000;
const VECTOR_AUTO_SYNC_INITIAL_DELAY_MS = Number(process.env.VECTOR_AUTO_SYNC_INITIAL_DELAY_MS) || 60 * 1000;
const BLOCKED_AUTOPILOT_TAGS = new Set(["resolved"]);
const ENTRY_FLOW_VERSION = "v1";
const ENTRY_INTENT_LABELS = {
  kupnja_knjiga: "Kupnja knjiga",
  narudzba: "Narudžba",
  dostava: "Dostava",
  otkup_knjiga: "Prodaja knjiga / otkup",
  reklamacija_problem: "Reklamacija ili problem",
  opci_upit: "Drugo"
};
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5
  }
});

function logInfo(...args) {
  if (!IS_TEST_ENV || SHOULD_LOG_IN_TEST) {
    console.info(...args);
  }
}

function logWarn(...args) {
  if (!IS_TEST_ENV || SHOULD_LOG_IN_TEST) {
    console.warn(...args);
  }
}

function logError(...args) {
  if (!IS_TEST_ENV || SHOULD_LOG_IN_TEST) {
    console.error(...args);
  }
}

async function runVectorKnowledgeSync(options = {}) {
  if (vectorKnowledgeSyncPromise) {
    return {
      success: false,
      inProgress: true,
      reason: "vector_sync_already_running"
    };
  }

  vectorKnowledgeSyncPromise = knowledgeService.syncVectorKnowledgeFromOneDrive(options)
    .finally(() => {
      vectorKnowledgeSyncPromise = null;
    });

  return vectorKnowledgeSyncPromise;
}

logInfo("Loaded Zendesk config:", zendeskService.getZendeskConfigSummary());
logInfo("Loaded OneDrive config:", oneDriveService.getOneDriveConfigSummary());
logInfo("Loaded vector knowledge config:", knowledgeService.getVectorConfigSummary?.());
hydrateRuntimeState();
process.on("SIGINT", persistRuntimeState);
process.on("SIGTERM", persistRuntimeState);
process.on("beforeExit", persistRuntimeState);

const EMBED_ALLOWED_ORIGINS = String(process.env.EMBED_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// --- Rate Limiting ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;
const rateLimitStore = new Map();

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please try again later."
    });
  }

  return next();
}

// Periodically clean up expired rate limit entries.
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS * 2);
rateLimitCleanupInterval.unref?.();

const recentChatStartCleanupInterval = setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [key, entry] of recentChatStarts) {
    if (now - Number(entry?.createdAt || 0) > CHAT_START_DEDUPLICATION_TTL_MS) {
      recentChatStarts.delete(key);
      changed = true;
    }
  }

  if (changed) {
    scheduleRuntimePersist();
  }
}, CHAT_START_DEDUPLICATION_TTL_MS);
recentChatStartCleanupInterval.unref?.();

if (VECTOR_AUTO_SYNC_ENABLED && !IS_TEST_ENV) {
  const runScheduledVectorSync = async () => {
    try {
      const result = await runVectorKnowledgeSync({ force: false, deleteMissing: true });
      logInfo("Scheduled vector knowledge sync finished:", result);
    } catch (error) {
      logError("Scheduled vector knowledge sync failed:", { message: error.message });
    }
  };

  const vectorInitialSyncTimeout = setTimeout(runScheduledVectorSync, VECTOR_AUTO_SYNC_INITIAL_DELAY_MS);
  vectorInitialSyncTimeout.unref?.();

  const vectorSyncInterval = setInterval(runScheduledVectorSync, VECTOR_AUTO_SYNC_INTERVAL_MS);
  vectorSyncInterval.unref?.();
}

// --- CORS ---
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || "";

  if (CORS_ALLOWED_ORIGINS.length > 0 && origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
}

// Parse incoming JSON bodies from Zendesk webhooks.
app.use(express.json({ limit: "1mb" }));
app.use(corsMiddleware);
app.use(express.static(path.join(__dirname, "public")));

function applyEmbedFrameHeaders(res) {
  if (EMBED_ALLOWED_ORIGINS.length === 0) {
    return;
  }

  const frameAncestors = ["'self'", ...EMBED_ALLOWED_ORIGINS].join(" ");
  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
}

/**
 * Small helper that normalizes truthy values Zendesk might send.
 * This makes the webhook resilient if the field arrives as a boolean,
 * string ("true"), or number (1).
 */
function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  if (typeof value === "number") {
    return value === 1;
  }

  return false;
}

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function hasAttachmentEntries(value) {
  return Array.isArray(value) && value.length > 0;
}

function extractZendeskWebhookEnvelope(payload = {}) {
  const ticketId = firstDefinedValue(
    payload.ticket_id,
    payload.ticketId,
    payload.ticket?.id,
    payload.ticket_event?.ticket?.id,
    payload.ticket_event?.ticket_id,
    payload.event?.ticket?.id
  );

  const message = firstNonEmptyString(
    payload.message,
    payload.latest_public_comment,
    payload.latestPublicComment,
    payload.latest_comment,
    payload.latestComment,
    payload.comment?.body,
    payload.comment?.plain_body,
    payload.comment?.html_body,
    payload.ticket?.latest_public_comment,
    payload.ticket?.latestPublicComment,
    payload.ticket?.latest_comment,
    payload.ticket?.latestComment,
    payload.ticket?.comment?.body,
    payload.ticket?.comment?.plain_body,
    payload.ticket?.comment?.html_body,
    payload.ticket_event?.comment?.body,
    payload.ticket_event?.comment?.plain_body,
    payload.ticket_event?.comment?.html_body,
    payload.ticket_event?.ticket?.latest_public_comment,
    payload.ticket_event?.ticket?.latest_comment,
    payload.event?.comment?.body
  );

  const channelType = firstDefinedValue(
    payload.channel,
    payload.channel_type,
    payload.channelType,
    payload.via?.channel,
    payload.ticket?.via?.channel,
    payload.ticket?.channel,
    payload.ticket_event?.via?.channel,
    payload.ticket_event?.ticket?.via?.channel,
    payload.ticket_event?.ticket?.channel,
    payload.event?.ticket?.via?.channel
  );

  const auditId = firstDefinedValue(
    payload.audit_id,
    payload.auditId,
    payload.ticket_event?.id,
    payload.ticket_event?.audit_id,
    payload.ticket?.latest_audit_id,
    payload.event?.id
  );

  const hasAttachments =
    toBoolean(
      firstDefinedValue(
        payload.has_attachments,
        payload.hasAttachments,
        payload.comment?.has_attachments,
        payload.ticket?.has_attachments,
        payload.ticket?.comment?.has_attachments,
        payload.ticket_event?.comment?.has_attachments
      )
    ) ||
    hasAttachmentEntries(payload.attachments) ||
    hasAttachmentEntries(payload.comment?.attachments) ||
    hasAttachmentEntries(payload.ticket?.attachments) ||
    hasAttachmentEntries(payload.ticket?.comment?.attachments) ||
    hasAttachmentEntries(payload.ticket_event?.comment?.attachments);

  return {
    ticketId,
    message,
    channelType,
    auditId,
    hasAttachments
  };
}

function normalizeChannelType(value = "") {
  return aiService.normalizeChannelType(value);
}

function formatChannelLabel(channelType = "unknown") {
  switch (normalizeChannelType(channelType)) {
    case "web_chat":
      return "web chat";
    case "facebook":
      return "facebook";
    case "email":
      return "email";
    default:
      return "zendesk";
  }
}

function getChannelMessages(channelType = "unknown") {
  switch (normalizeChannelType(channelType)) {
    case "facebook":
      return {
        attachmentHandoff:
          "Hvala na privitku. Pregledat ćemo ga i javiti vam se ovdje čim provjerimo detalje.",
        hardHandoff:
          "Ovo trebamo provjeriti ručno. Kolege će vam se javiti ovdje čim pregledaju upit.",
        softHandoff:
          "Ne želim vam dati netočan odgovor. Kolege će pregledati upit i javiti vam se ovdje uskoro."
      };
    case "email":
      return {
        attachmentHandoff:
          "Hvala na poslanom privitku. Pregledat ćemo ga i javiti vam se čim provjerimo detalje.",
        hardHandoff:
          "Ovaj upit trebamo provjeriti ručno. Javit ćemo vam se čim pregledamo detalje.",
        softHandoff:
          "Ne želimo vam poslati napola točan odgovor. Vaš upit ćemo pregledati i javiti vam se čim ga provjerimo."
      };
    case "web_chat":
      return {
        attachmentHandoff:
          "Hvala, privitci su stigli. Pregledat ćemo ih i javiti vam se ovdje čim ih prođemo.",
        hardHandoff:
          "Ovo trebamo provjeriti ručno. Javit ćemo vam se ovdje čim pregledamo upit.",
        softHandoff:
          "Ne želim vam dati napola točan odgovor. Pregledat ćemo upit i javiti vam se ovdje uskoro."
      };
    default:
      return {
        attachmentHandoff:
          "Hvala na poslanom privitku. Pregledat ćemo ga i javiti vam se čim provjerimo detalje.",
        hardHandoff:
          "Ovaj upit trebamo provjeriti ručno. Javit ćemo vam se čim pregledamo detalje.",
        softHandoff:
          "Ne želimo vam poslati netočan odgovor. Vaš upit ćemo pregledati i javiti vam se čim ga provjerimo."
      };
  }
}

function buildChatSubject(requesterName) {
  if (!requesterName) {
    return "Webshop chat conversation";
  }

  return `Webshop chat - ${String(requesterName).trim()}`;
}

function getSession(sessionId) {
  return chatSessions.get(sessionId) || null;
}

function persistRuntimeState() {
  runtimeStore.saveRuntimeState({
    sessions: [...chatSessions.values()],
    processedWebhookAudits: [...processedWebhookAudits.entries()].map(([key, createdAt]) => ({
      key,
      createdAt
    })),
    processedWebhookMessages: [...processedWebhookMessages.entries()].map(([key, createdAt]) => ({
      key,
      createdAt
    })),
    recentChatStarts: [...recentChatStarts.entries()].map(([key, value]) => ({
      key,
      ...value
    }))
  });
}

function scheduleRuntimePersist() {
  persistRuntimeState();
}

function hydrateRuntimeState() {
  const persistedState = runtimeStore.loadRuntimeState();

  for (const session of persistedState.sessions) {
    if (session?.sessionId) {
      chatSessions.set(session.sessionId, session);
    }
  }

  for (const entry of persistedState.processedWebhookAudits) {
    if (entry?.key) {
      processedWebhookAudits.set(entry.key, Number(entry.createdAt) || Date.now());
    }
  }

  for (const entry of persistedState.processedWebhookMessages) {
    if (entry?.key) {
      processedWebhookMessages.set(entry.key, Number(entry.createdAt) || Date.now());
    }
  }

  for (const entry of persistedState.recentChatStarts) {
    if (entry?.key && entry?.sessionId) {
      recentChatStarts.set(entry.key, {
        sessionId: entry.sessionId,
        ticketId: entry.ticketId || null,
        createdAt: Number(entry.createdAt) || Date.now()
      });
    }
  }
}

function createSession(payload) {
  const sessionId = randomUUID();
  const session = {
    pendingClarification: null,
    lastResolvedIntent: "",
    lastStandaloneQuery: "",
    lastKnowledgeSource: "",
    lastProductTitles: [],
    sessionId,
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  chatSessions.set(sessionId, session);
  scheduleRuntimePersist();
  return session;
}

function resetRuntimeState() {
  chatSessions.clear();
  chatStreams.clear();
  processedWebhookAudits.clear();
  processedWebhookMessages.clear();
  recentChatStarts.clear();
  rateLimitStore.clear();
  persistRuntimeState();
  metricsService.reset();
}

function findSessionByTicketId(ticketId) {
  for (const session of chatSessions.values()) {
    if (Number(session.ticketId) === Number(ticketId)) {
      return session;
    }
  }

  return null;
}

function removeSession(sessionId) {
  if (!sessionId) {
    return;
  }

  chatSessions.delete(sessionId);
  chatStreams.delete(sessionId);
  scheduleRuntimePersist();
}

function normalizeRequesterFingerprint(name = "", email = "") {
  return `${String(name || "").trim().toLowerCase()}::${String(email || "").trim().toLowerCase()}`;
}

function hasRequesterIdentity(name = "", email = "") {
  return Boolean(String(name || "").trim() || String(email || "").trim());
}

function isValidEmailAddress(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function buildChatStartDeduplicationKey({ name = "", email = "", message = "" } = {}) {
  if (!hasRequesterIdentity(name, email)) {
    return "";
  }

  return [
    normalizeRequesterFingerprint(name, email),
    normalizeMessage(message).toLowerCase()
  ].join("::");
}

function registerRecentChatStart({ name = "", email = "", message = "", sessionId = "", ticketId = null } = {}) {
  const key = buildChatStartDeduplicationKey({ name, email, message });

  if (!key || !sessionId) {
    return;
  }

  recentChatStarts.set(key, {
    sessionId,
    ticketId,
    createdAt: Date.now()
  });
  scheduleRuntimePersist();
}

function isSessionClosed(session = null) {
  const tone = String(session?.conversationState?.tone || "").trim();
  return tone === "resolved";
}

function findReusableChatStart({ name = "", email = "", message = "" } = {}) {
  const dedupeKey = buildChatStartDeduplicationKey({ name, email, message });

  if (!dedupeKey) {
    return null;
  }

  const recentMatch = recentChatStarts.get(dedupeKey);

  if (recentMatch && Date.now() - recentMatch.createdAt <= CHAT_START_DEDUPLICATION_TTL_MS) {
    const session = getSession(recentMatch.sessionId);

    if (session && !isSessionClosed(session)) {
      return session;
    }
  }

  const requesterFingerprint = normalizeRequesterFingerprint(name, email);

  if (!requesterFingerprint || requesterFingerprint === "::") {
    return null;
  }

  for (const session of chatSessions.values()) {
    if (isSessionClosed(session)) {
      continue;
    }

    const sessionFingerprint = normalizeRequesterFingerprint(
      session.requesterName,
      session.requesterEmail
    );

    if (sessionFingerprint !== requesterFingerprint) {
      continue;
    }

    const latestUserMessage = [...(Array.isArray(session.messages) ? session.messages : [])]
      .reverse()
      .find((entry) => entry.role === "user");
    const latestUserContent = normalizeMessage(latestUserMessage?.content).toLowerCase();

    if (latestUserContent && latestUserContent === normalizeMessage(message).toLowerCase()) {
      return session;
    }
  }

  return null;
}

function appendMessageToSession(sessionId, role, content) {
  const session = getSession(sessionId);

  if (!session) {
    return null;
  }

  session.messages.push({
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  });
  session.updatedAt = new Date().toISOString();
  scheduleRuntimePersist();

  return session;
}

function decodeHtmlEntities(content = "") {
  let decoded = String(content);

  for (let i = 0; i < 3; i += 1) {
    const nextDecoded = decoded
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;?/gi, " ")
      .replace(/&#160;/gi, " ")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\u00a0/g, " ");

    if (nextDecoded === decoded) {
      break;
    }

    decoded = nextDecoded;
  }

  return decoded
    .replace(/^[ \t]+$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtmlWithLineBreaks(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|blockquote|h[1-6])>/gi, "\n")
    .replace(/<(li)\b[^>]*>/gi, "- ")
    .replace(/<(p|div|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
}

function stripQuotedEmailContent(content = "") {
  const lines = String(content || "").split("\n");

  if (lines.length === 0) {
    return "";
  }

  const quoteMarkerPatterns = [
    /^>+/,
    /^-+\s*original message\s*-+$/i,
    /^on .+wrote:$/i,
    /^from:\s.+$/i,
    /^sent:\s.+$/i,
    /^subject:\s.+$/i,
    /^to:\s.+$/i,
    /^\*{2,}\s*original message\s*\*{2,}$/i
  ];
  let cutoffIndex = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    if (quoteMarkerPatterns.some((pattern) => pattern.test(line))) {
      cutoffIndex = index;
      break;
    }
  }

  return lines.slice(0, cutoffIndex).join("\n").trim();
}

function stripEmailSignature(content = "") {
  const signaturePatterns = [
    /^--\s*$/,
    /^srda(?:c|č)an pozdrav[,]?$/i,
    /^lijep pozdrav[,]?$/i,
    /^pozdrav[,]?$/i,
    /^lp[,]?$/i,
    /^best regards[,]?$/i,
    /^kind regards[,]?$/i,
    /^sent from my iphone$/i,
    /^sent from my android$/i
  ];
  const lines = String(content || "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    if (signaturePatterns.some((pattern) => pattern.test(line))) {
      return lines.slice(0, index).join("\n").trim();
    }
  }

  return String(content || "").trim();
}

function normalizeZendeskCommentContent(comment = {}) {
  const sources = [comment.html_body, comment.plain_body, comment.body].filter(Boolean);

  if (sources.length === 0) {
    return "";
  }

  for (const source of sources) {
    const normalized = stripEmailSignature(
      stripQuotedEmailContent(
        decodeHtmlEntities(stripHtmlWithLineBreaks(source))
      )
    )
      .replace(/^https?:\/\/(?:www\.)?antikvarijat-libar\.com\/?\s*$/gim, "")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function hasAiReplyMarker(audit = {}) {
  return Array.isArray(audit.events) && audit.events.some((event) => {
    const haystack = JSON.stringify({
      type: event?.type,
      field_name: event?.field_name,
      value: event?.value,
      previous_value: event?.previous_value
    }).toLowerCase();

    return (
      haystack.includes("ai_replied") ||
      haystack.includes("webchat_ai") ||
      haystack.includes("facebook_ai") ||
      haystack.includes("email_ai") ||
      haystack.includes("zendesk_ai")
    );
  });
}

function getZendeskAuditCustomMetadata(audit = {}) {
  const customMetadata = audit?.metadata?.custom;

  if (!customMetadata || typeof customMetadata !== "object") {
    return {};
  }

  if (customMetadata.custom && typeof customMetadata.custom === "object") {
    return customMetadata.custom;
  }

  return customMetadata;
}

function getMessageProductsFromMetadata(audit = {}) {
  const customMetadata = getZendeskAuditCustomMetadata(audit);
  const rawProducts = customMetadata.libar_products;

  if (!rawProducts) {
    return [];
  }

  if (Array.isArray(rawProducts)) {
    return rawProducts;
  }

  if (typeof rawProducts === "string") {
    try {
      const parsed = JSON.parse(rawProducts);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

function parseMetadataArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

function normalizeSuggestedReplies(replies = []) {
  return [...new Set(
    parseMetadataArray(replies)
      .map((reply) => String(reply || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  )]
    .filter((reply) => reply.length <= 80)
    .slice(0, 4);
}

function getSuggestedRepliesFromMetadata(audit = {}) {
  const customMetadata = getZendeskAuditCustomMetadata(audit);
  return normalizeSuggestedReplies(
    customMetadata.libar_suggested_replies || customMetadata.libarSuggestedReplies
  );
}

function getSupportTaskIntentFromMetadata(audit = {}) {
  const customMetadata = getZendeskAuditCustomMetadata(audit);
  return String(customMetadata.libar_task_intent || customMetadata.libarTaskIntent || "").trim();
}

function isKnownExternalCustomerChannel(channelType = "") {
  const normalizedChannelType = normalizeChannelType(channelType);
  return normalizedChannelType === "facebook" || normalizedChannelType === "email";
}

function inferMessageRoleFromAudit(audit, commentEvent, requesterId, ticketSummary) {
  const normalizedRequesterId = Number(requesterId);
  const commentAuthorId = Number(commentEvent?.author_id ?? audit?.author_id);
  const sourceChannel = commentEvent?.via?.channel || audit?.via?.channel || null;
  const customMetadata = getZendeskAuditCustomMetadata(audit);
  const taggedRole = customMetadata.libar_message_role || customMetadata.libarMessageRole || null;
  const taggedOrigin = customMetadata.libar_message_origin || customMetadata.libarMessageOrigin || null;

  if (taggedRole === "assistant") {
    return "assistant";
  }

  if (taggedRole === "customer") {
    return "user";
  }

  if (
    Number.isFinite(commentAuthorId) &&
    Number.isFinite(normalizedRequesterId) &&
    commentAuthorId === normalizedRequesterId
  ) {
    return "user";
  }

  if (
    taggedOrigin === "webchat_ai" ||
    taggedOrigin === "facebook_ai" ||
    taggedOrigin === "email_ai" ||
    taggedOrigin === "zendesk_ai"
  ) {
    return "assistant";
  }

  if (hasAiReplyMarker(audit)) {
    return "assistant";
  }

  if (isKnownExternalCustomerChannel(sourceChannel)) {
    return "user";
  }

  if (
    Number.isFinite(commentAuthorId) &&
    Number.isFinite(normalizedRequesterId) &&
    commentAuthorId !== normalizedRequesterId
  ) {
    return "assistant";
  }

  if (sourceChannel && sourceChannel !== "api") {
    return "assistant";
  }

  if (Array.isArray(ticketSummary?.tags)) {
    const stateTags = new Set(ticketSummary.tags);

    if (
      stateTags.has("human_active") ||
      stateTags.has("awaiting_human") ||
      stateTags.has("ai_replied")
    ) {
      return "user";
    }
  }

  return "user";
}

function mapZendeskAuditsToMessages(audits, requesterId, ticketSummary) {
  return audits
    .flatMap((audit) => {
      const commentEvents = Array.isArray(audit.events)
        ? audit.events.filter((event) => event?.type === "Comment" && event?.public !== false)
        : [];

      return commentEvents.map((commentEvent) => {
        const role = inferMessageRoleFromAudit(audit, commentEvent, requesterId, ticketSummary);
        const sourceChannel = commentEvent?.via?.channel || audit?.via?.channel || null;

        return {
          id: String(commentEvent.id || audit.id),
          role,
          content: normalizeZendeskCommentContent(commentEvent),
          createdAt: audit.created_at,
          sourceChannel,
          authoredByHuman: role === "assistant" && sourceChannel !== "api",
          supportTaskIntent: role === "assistant" ? getSupportTaskIntentFromMetadata(audit) : "",
          products: role === "assistant" ? getMessageProductsFromMetadata(audit) : [],
          suggestedReplies: role === "assistant" ? getSuggestedRepliesFromMetadata(audit) : [],
          attachments: Array.isArray(commentEvent.attachments)
            ? commentEvent.attachments.map((attachment) => ({
                id: attachment.id,
                name: attachment.file_name,
                contentType: attachment.content_type,
                size: attachment.size,
                url: attachment.content_url
              }))
            : []
        };
      });
    })
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
}

function getSessionsByTicketId(ticketId) {
  const sessions = [];

  for (const session of chatSessions.values()) {
    if (Number(session.ticketId) === Number(ticketId)) {
      sessions.push(session);
    }
  }

  return sessions;
}

function isClosedTicketStatus(status = "") {
  return ["solved", "closed"].includes(String(status).toLowerCase());
}

function isActiveTicketStatus(status = "") {
  return ["new", "open", "pending", "hold"].includes(String(status).toLowerCase());
}

function buildConversationState(ticketSummary, messages) {
  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];
  const latestPublicMessage = getLatestPublicMessage(messages);
  const latestHumanAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.authoredByHuman);

  if (ticketSummary?.status === "solved" || ticketSummary?.status === "closed" || tags.includes("resolved")) {
    return {
      tone: "resolved",
      badge: "Riješeno",
      subtitle: "Ovaj razgovor je završen. Ako imate novo pitanje, možete započeti novi razgovor."
    };
  }

  if (latestPublicMessage?.role === "assistant" && latestPublicMessage?.authoredByHuman) {
    return {
      tone: "human-active",
      badge: "Podrška uživo",
      subtitle: "Naš tim nastavlja razgovor s vama ovdje u istoj niti."
    };
  }

  if (
    tags.includes("human_active") &&
    latestPublicMessage?.role !== "user" &&
    latestHumanAssistantMessage
  ) {
    return {
      tone: "human-active",
      badge: "Podrška uživo",
      subtitle: "Naš tim nastavlja razgovor s vama ovdje u istoj niti."
    };
  }

  if (
    tags.includes("awaiting_customer_detail") &&
    latestPublicMessage?.role !== "user"
  ) {
    return {
      tone: "awaiting-customer-detail",
      badge: "Treba još detalja",
      subtitle: "Trebamo još jednu kratku informaciju da bismo nastavili odgovor."
    };
  }

  if (
    (
      tags.includes("awaiting_human") ||
      tags.includes("hitno_slike") ||
      tags.includes("ai_eskalacija")
    ) &&
    latestPublicMessage?.role !== "user"
  ) {
    return {
      tone: "awaiting-human",
      badge: "Provjera upita",
      subtitle: "Pregledavamo vaš upit. Odgovor stiže ovdje čim ga pripremimo."
    };
  }

  return {
    tone: "ai-active",
    badge: "Aktivan",
    subtitle: "Odgovaramo odmah, a po potrebi se u razgovor uključuje i naš tim."
  };
}

async function syncSessionMessages(session) {
  if (!session?.ticketId || !session?.requesterId) {
    return session;
  }

  const [audits, ticketSummary] = await Promise.all([
    zendeskService.getTicketAudits(session.ticketId),
    zendeskService.getTicketSummary(session.ticketId)
  ]);

  return applyZendeskStateToSession(session, {
    audits,
    ticketSummary
  });
}

function applyZendeskStateToSession(session, { audits = [], ticketSummary = null } = {}) {
  session.messages = mapZendeskAuditsToMessages(audits, session.requesterId, ticketSummary);
  session.requesterName = ticketSummary.requesterName || session.requesterName || "";
  session.requesterEmail = ticketSummary.requesterEmail || session.requesterEmail || "";
  session.conversationState = buildConversationState(ticketSummary, session.messages);
  session.resolutionPrompt = getResolutionPrompt(session, ticketSummary);
  session.updatedAt = new Date().toISOString();

  return session;
}

function isZendeskRateLimitError(error) {
  return Number(error?.status || error?.response?.status) === 429;
}

function buildConversationStateFromOutcome(outcome = {}) {
  if (outcome?.stateTag === "resolved") {
    return {
      tone: "resolved",
      badge: "Riješeno",
      subtitle: "Ovaj razgovor je završen. Ako imate novo pitanje, možete započeti novi razgovor."
    };
  }

  if (outcome?.stateTag === "awaiting_human") {
    return {
      tone: "awaiting-human",
      badge: "Provjera upita",
      subtitle: "Pregledavamo vaš upit. Odgovor stiže ovdje čim ga pripremimo."
    };
  }

  if (outcome?.type === "ask_clarifying_question") {
    return {
      tone: "awaiting-customer-detail",
      badge: "Treba još detalja",
      subtitle: "Trebamo još jednu kratku informaciju da bismo nastavili odgovor."
    };
  }

  return {
    tone: "ai-active",
    badge: "Aktivan",
    subtitle: "Odgovaramo odmah, a po potrebi se u razgovor uključuje i naš tim."
  };
}

function appendLocalAssistantOutcome(session, outcome = {}) {
  if (!session || !outcome?.customerMessage) {
    return session;
  }

  const latestAssistantMessage = [...(session.messages || [])]
    .reverse()
    .find((message) => message.role === "assistant" && !message.authoredByHuman);

  if (latestAssistantMessage?.content === outcome.customerMessage) {
    session.conversationState = buildConversationStateFromOutcome(outcome);
    session.resolutionPrompt = null;
    session.updatedAt = new Date().toISOString();
    scheduleRuntimePersist();
    return session;
  }

  session.messages = Array.isArray(session.messages) ? session.messages : [];
  session.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: outcome.customerMessage,
    createdAt: new Date().toISOString(),
    sourceChannel: "api",
    authoredByHuman: false,
    supportTaskIntent: outcome.taskIntent || "",
    products: Array.isArray(outcome.products) ? outcome.products : [],
    suggestedReplies: normalizeSuggestedReplies(outcome.suggestedReplies),
    attachments: []
  });
  session.conversationState = buildConversationStateFromOutcome(outcome);
  session.resolutionPrompt = null;
  session.updatedAt = new Date().toISOString();
  scheduleRuntimePersist();
  return session;
}

async function syncSessionMessagesWithFallback(session, contextLabel = "session_sync") {
  try {
    const syncedSession = await syncSessionMessages(session);
    return {
      session: syncedSession,
      degraded: false,
      error: null
    };
  } catch (error) {
    logError(`${contextLabel} failed:`, {
      sessionId: session?.sessionId,
      ticketId: session?.ticketId,
      message: error.message,
      stack: error.stack
    });

    return {
      session,
      degraded: true,
      error
    };
  }
}

function buildDependencyErrorResponse(error, fallbackMessage) {
  const statusCode = error?.response?.status;
  const message =
    statusCode && statusCode >= 400 && statusCode < 500
      ? fallbackMessage
      : fallbackMessage;

  return {
    success: false,
    error: message
  };
}

function buildClosedSessionPayload({ ticketSummary, requesterName, requesterEmail, messages }) {
  return {
    ticket: {
      id: ticketSummary?.id || null,
      status: ticketSummary?.status || null,
      tags: Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : []
    },
    requester: {
      name: requesterName || "",
      email: requesterEmail || "",
      requesterId: ticketSummary?.requesterId || null
    },
    messages,
    conversationState: {
      tone: "resolved",
      badge: "Prethodni razgovor je završen",
      subtitle: "Možete pregledati raniji odgovor ili otvoriti novi razgovor."
    },
    resolutionPrompt: null
  };
}

function isHardHandoffMessage(message = "") {
  const normalizedMessage = String(message).toLowerCase();

  return [
    "plać",
    "reklamacij",
    "povrat",
    "refund",
    "ljut",
    "prevara",
    "ne radi"
  ].some((token) => normalizedMessage.includes(token));
}

function isResolutionCandidateMessage(message = "") {
  const normalizedMessage = String(message).toLowerCase().trim();

  if (
    !normalizedMessage ||
    normalizedMessage.includes("?") ||
    normalizedMessage.length > 120
  ) {
    return false;
  }

  const candidateTokens = [
    "hvala",
    "super",
    "odlično",
    "to je to",
    "riješeno",
    "reseno",
    "sve jasno",
    "pomoglo je",
    "to mi je pomoglo",
    "to je riješilo",
    "sve ok",
    "ok, hvala"
  ];

  return candidateTokens.some((token) => normalizedMessage.includes(token));
}

function getLatestAssistantMessage(messages = []) {
  return [...messages].reverse().find((message) => message.role === "assistant") || null;
}

function getLatestUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message.role === "user") || null;
}

function buildWebhookMessageDeduplicationKey({ ticketId, latestUserMessage, fallbackMessage = "" } = {}) {
  if (!ticketId || !latestUserMessage) {
    return "";
  }

  const messageId = String(latestUserMessage.id || "").trim();

  if (messageId) {
    return `${ticketId}:message:${messageId}`;
  }

  const createdAt = String(latestUserMessage.createdAt || "").trim();
  const normalizedContent =
    normalizeMessage(latestUserMessage.content) || normalizeMessage(fallbackMessage);
  const attachmentFingerprint = Array.isArray(latestUserMessage.attachments)
    ? latestUserMessage.attachments
      .map((attachment) =>
        String(attachment?.id || attachment?.url || attachment?.name || "").trim()
      )
      .filter(Boolean)
      .join("|")
    : "";
  const fallbackParts = [createdAt, normalizedContent.toLowerCase(), attachmentFingerprint]
    .filter(Boolean);

  if (fallbackParts.length === 0) {
    return "";
  }

  return `${ticketId}:fallback:${fallbackParts.join("::")}`;
}

function getLatestPublicMessage(messages = []) {
  return Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : null;
}

function detectTicketChannelType(ticketSummary, messages = []) {
  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];

  if (tags.includes("webshop_chat")) {
    return "web_chat";
  }

  const latestMessageWithChannel = [...messages]
    .reverse()
    .find((message) => normalizeChannelType(message?.sourceChannel) !== "unknown");

  return normalizeChannelType(latestMessageWithChannel?.sourceChannel);
}

function getAutomationBlockReason(ticketSummary, messages, channelType) {
  if (isClosedTicketStatus(ticketSummary?.status)) {
    return "ticket_closed";
  }

  if (normalizeChannelType(channelType) === "web_chat") {
    return "web_chat_managed_by_widget";
  }

  const latestMessage = getLatestPublicMessage(messages);

  if (!latestMessage) {
    return "no_public_messages";
  }

  if (latestMessage.role === "user") {
    return null;
  }

  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];

  if (tags.some((tag) => BLOCKED_AUTOPILOT_TAGS.has(tag))) {
    return "human_active";
  }

  const conversationState = buildConversationState(ticketSummary, messages);

  if (conversationState.tone === "human-active") {
    return "human_active";
  }

  if (conversationState.tone === "awaiting-human") {
    return "awaiting_human";
  }

  if (latestMessage.role !== "user") {
    return "latest_message_not_user";
  }

  return null;
}

function getResolutionPrompt(session, ticketSummary) {
  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];
  const blockedTags = new Set([
    "ai_eskalacija",
    "hitno_slike",
    "awaiting_human",
    "awaiting_customer_detail",
    "human_active",
    "resolved"
  ]);

  if (!session || !isActiveTicketStatus(ticketSummary?.status)) {
    return null;
  }

  if (session.conversationState?.tone !== "ai-active") {
    return null;
  }

  if (tags.some((tag) => blockedTags.has(tag))) {
    return null;
  }

  const lastMessage = session.messages?.[session.messages.length - 1];
  const latestUserMessage = getLatestUserMessage(session.messages);
  const latestAssistantMessage = getLatestAssistantMessage(
    (session.messages || []).filter((message) => message !== lastMessage)
  );

  if (!lastMessage || lastMessage.role !== "user" || !latestUserMessage) {
    return null;
  }

  if (Array.isArray(lastMessage.attachments) && lastMessage.attachments.length > 0) {
    return null;
  }

  if (!isResolutionCandidateMessage(lastMessage.content)) {
    return null;
  }

  if (isHardHandoffMessage(lastMessage.content)) {
    return null;
  }

  if (!latestAssistantMessage || latestAssistantMessage.authoredByHuman) {
    return null;
  }

  return {
    show: true,
    title: "Je li sve u redu?",
    text: "Ako je problem riješen, možemo završiti ovaj razgovor.",
    confirmLabel: "Da, riješeno je",
    cancelLabel: "Ne, trebam još pomoć"
  };
}

function buildAutopilotNote({
  outcome,
  userMessage,
  knowledge,
  channelType = "web_chat"
}) {
  const summaryLine = [
    `Kanal: ${formatChannelLabel(channelType)}`,
    `Ishod: ${outcome?.type || "unknown"}`
  ].filter(Boolean).join(" | ");

  const knowledgeLine = knowledge && knowledge.articles && knowledge.articles.length > 0
    ? `Korišteni dokument: ${knowledge.articles[0].title}`
    : outcome?.source === "product_feed" && Array.isArray(outcome?.products) && outcome.products.length > 0
      ? `Korišteni proizvod: ${outcome.products[0].title}`
      : "Odgovor nije pronađen u bazi znanja.";

  return [
    summaryLine,
    `Korisnik: ${userMessage}`,
    knowledgeLine,
    outcome?.reason ? `Razlog: ${outcome.reason}` : null,
    outcome?.relevance?.finalIntent ? `Final intent: ${outcome.relevance.finalIntent}` : null,
    outcome?.relevance?.sourceDecision ? `Source decision: ${outcome.relevance.sourceDecision}` : null,
    outcome?.relevance?.fallbackReason ? `Fallback reason: ${outcome.relevance.fallbackReason}` : null,
    outcome?.relevance?.clarificationReason ? `Clarification reason: ${outcome.relevance.clarificationReason}` : null,
    outcome?.relevance?.topicShift ? `Topic shift type: ${outcome.relevance.topicShift}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeCustomerFacingText(value = "") {
  return String(value || "")
    .replace(/\[LIBAR_MEMORY_V1][\s\S]*?\[\/LIBAR_MEMORY_V1]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/:\s*$/, "")
    .trim();
}

function humanizeSupportTone(value = "") {
  return String(value || "")
    .replace(/^\s*poštovani[,!\s-]*/i, "")
    .replace(/\bUkoliko\b/g, "Ako")
    .replace(/\bukoliko\b/g, "ako")
    .replace(/\bLjubazno molimo\b/g, "Molim vas")
    .replace(/\bMolimo Vas\b/g, "Molim vas")
    .replace(/\bVaš upit\b/g, "Vaše pitanje")
    .replace(/\bVas\b/g, "vas")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeKnowledgeTitleDump(value = "") {
  const normalized = normalizeForComparison(value);

  if (!normalized) {
    return false;
  }

  const markerCount =
    (normalized.match(/\bclanak\b/g) || []).length +
    (normalized.match(/\bradno vrijeme\b/g) || []).length +
    (normalized.match(/\badresa\b/g) || []).length +
    (normalized.match(/\bdostava\b/g) || []).length;

  return markerCount >= 3 && !/[.!?]/.test(String(value || ""));
}

const ANSWER_QUALITY_STOP_WORDS = new Set([
  "ako",
  "ali",
  "bio",
  "bih",
  "bila",
  "bile",
  "bili",
  "bilo",
  "ce",
  "cim",
  "da",
  "do",
  "ga",
  "gdje",
  "hvala",
  "i",
  "ih",
  "ili",
  "im",
  "iz",
  "ja",
  "je",
  "joj",
  "kada",
  "kad",
  "kao",
  "koji",
  "koja",
  "koje",
  "kroz",
  "li",
  "me",
  "mi",
  "na",
  "nam",
  "ne",
  "ni",
  "nije",
  "od",
  "oko",
  "po",
  "se",
  "su",
  "to",
  "u",
  "uz",
  "vam",
  "vas",
  "već",
  "za"
]);

function extractMeaningfulTokens(value = "") {
  return normalizeForComparison(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !ANSWER_QUALITY_STOP_WORDS.has(token));
}

function findUnsupportedFactSignals(answer = "", knowledge = null) {
  const knowledgeText = normalizeForComparison(
    [
      knowledge?.context || "",
      ...(Array.isArray(knowledge?.articles)
        ? knowledge.articles.flatMap((article) => [article?.title || "", article?.body || ""])
        : [])
    ].join(" ")
  );

  if (!knowledgeText) {
    return [];
  }

  const factSignals = String(answer || "").match(
    /\b\d{1,2}:\d{2}\b|\b\d+[.,]\d{2}\b|\b\d+\s*(?:eur|eura|rata|dana|tjedna)\b|\b\d{2,3}[-/\s]?\d{3}[-/\s]?\d{3,4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:PBZ|ZABA|GLS|MBE|BOXNOW|Aircash|R1)\b/gi
  ) || [];

  return [...new Set(factSignals.filter((signal) => !knowledgeText.includes(normalizeForComparison(signal))))];
}

function validateAnswerQuality({ answer = "", outcomeType = "", knowledge = null } = {}) {
  const normalizedAnswer = String(answer || "").trim();

  if (!normalizedAnswer) {
    return {
      isValid: false,
      reason: "empty_answer"
    };
  }

  if (!["safe_answer", "ask_clarifying_question"].includes(String(outcomeType || "").trim())) {
    return {
      isValid: true,
      reason: "not_applicable"
    };
  }

  if (!knowledge?.context || !Array.isArray(knowledge?.articles) || knowledge.articles.length === 0) {
    return {
      isValid: false,
      reason: "missing_knowledge_context"
    };
  }

  const normalizedForComparison = normalizeForComparison(normalizedAnswer);

  if (/\b(ai|umjetna inteligencija|baza znanja|bazi znanja|knowledge base|kontekst|kontekstu|interni proces|internom kontekstu|interne procese)\b/i.test(normalizedAnswer)) {
    return {
      isValid: false,
      reason: "internal_process_leak"
    };
  }

  if (/\b(ne znam|nisam siguran|mozda|možda|pretpostavljam|vjerojatno)\b/i.test(normalizedAnswer)) {
    return {
      isValid: false,
      reason: "uncertain_answer"
    };
  }

  const unsupportedFactSignals = findUnsupportedFactSignals(normalizedAnswer, knowledge);

  if (unsupportedFactSignals.length > 0) {
    return {
      isValid: false,
      reason: "unsupported_fact_signal",
      details: unsupportedFactSignals
    };
  }

  const answerTokens = extractMeaningfulTokens(normalizedForComparison);
  const knowledgeReferenceText = [
    knowledge.context,
    ...knowledge.articles.flatMap((article) => [article?.title || "", article?.body || ""])
  ].join(" ");
  const knowledgeTokens = new Set(extractMeaningfulTokens(knowledgeReferenceText));
  const overlappingTokens = answerTokens.filter((token) => knowledgeTokens.has(token));
  const overlapRatio = answerTokens.length > 0 ? overlappingTokens.length / answerTokens.length : 0;

  if (answerTokens.length >= 3 && overlapRatio < 0.2) {
    return {
      isValid: false,
      reason: "low_knowledge_overlap"
    };
  }

  return {
    isValid: true,
    reason: "ok"
  };
}

function finalizeOutcomeForCustomer(
  outcome = null,
  {
    channelType = "web_chat",
    knowledge = null
  } = {}
) {
  if (!outcome?.customerMessage) {
    return outcome;
  }

  const channelMessages = getChannelMessages(channelType);
  const sanitizedCustomerMessage = humanizeSupportTone(sanitizeCustomerFacingText(outcome.customerMessage));
  const sanitizedZendeskMessage = humanizeSupportTone(sanitizeCustomerFacingText(
    outcome.zendeskMessage || outcome.customerMessage
  ));

  const qualityCheck = validateAnswerQuality({
    answer: sanitizedCustomerMessage,
    outcomeType: outcome.type,
    knowledge,
  });

  if (!sanitizedCustomerMessage || looksLikeKnowledgeTitleDump(sanitizedCustomerMessage) || !qualityCheck.isValid) {
    metricsService.increment("answer_quality_guard_triggered_total");
    return {
      ...outcome,
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: qualityCheck.isValid ? "invalid_generated_reply" : qualityCheck.reason,
      customerMessage: channelMessages.softHandoff,
      zendeskMessage: channelMessages.softHandoff
    };
  }

  return {
    ...outcome,
    customerMessage: sanitizedCustomerMessage,
    zendeskMessage: sanitizedZendeskMessage
  };
}

function appendDirectWebsiteLink(
  outcome = null,
  {
    conversation = null,
    knowledge = null,
    channelType = "web_chat"
  } = {}
) {
  if (!outcome?.customerMessage || !["safe_answer", "ask_clarifying_question"].includes(outcome.type)) {
    return outcome;
  }

  const existingText = `${outcome.customerMessage}\n${outcome.zendeskMessage || ""}`;

  if (existingText.includes(BASE_URL)) {
    return outcome;
  }

  const directLinks = buildDirectWebsiteLinks({
    conversation,
    knowledge,
    outcome
  });

  if (!Array.isArray(directLinks) || directLinks.length === 0) {
    return outcome;
  }

  const formattedLinks = directLinks
    .map((link) => `- ${link.label}: ${link.url}`)
    .join("\n");
  const linkBlock =
    channelType === "email"
      ? `Korisne poveznice:\n${formattedLinks}`
      : `Poveznice:\n${formattedLinks}`;

  return {
    ...outcome,
    customerMessage: [outcome.customerMessage, linkBlock].filter(Boolean).join("\n"),
    zendeskMessage: [outcome.zendeskMessage || outcome.customerMessage, linkBlock].filter(Boolean).join("\n")
  };
}

function trimKnowledgeFallbackText(value = "", maxLength = 520) {
  const normalized = sanitizeCustomerFacingText(value);

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);

  if (sentences.length > 1) {
    let collected = "";

    for (const sentence of sentences) {
      const nextValue = collected ? `${collected} ${sentence}` : sentence;

      if (nextValue.length > maxLength && collected) {
        break;
      }

      collected = nextValue;

      if (collected.length >= Math.min(240, maxLength)) {
        break;
      }
    }

    if (collected) {
      return collected;
    }
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildKnowledgeFallbackAnswer(knowledge = null) {
  if (
    !knowledge ||
    Number(knowledge.topScore || 0) < KNOWLEDGE_MIN_TOP_SCORE ||
    !Array.isArray(knowledge.articles) ||
    knowledge.articles.length === 0
  ) {
    return "";
  }

  for (const article of knowledge.articles) {
    const candidate = trimKnowledgeFallbackText(article?.body || "");

    if (candidate && !looksLikeKnowledgeTitleDump(candidate)) {
      return candidate;
    }
  }

  return "";
}

function isGreetingOnlyMessage(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage || normalizedMessage.includes("?")) {
    return false;
  }

  return [
    "pozdrav",
    "bok",
    "dobar dan",
    "dobra vecer",
    "hej",
    "hello",
    "hi"
  ].includes(normalizedMessage);
}

function getSessionActiveDomain(session = {}) {
  const rawDomain = normalizeForComparison(
    session?.workingMemory?.activeDomain || session?.entryTopicLock || session?.entryIntent || ""
  );

  if (/(buyback|otkup|prodaja|otkup_knjiga)/.test(rawDomain)) {
    return "buyback";
  }

  if (/(delivery|dostava)/.test(rawDomain)) {
    return "delivery";
  }

  if (/(support|opci|kontakt|contact)/.test(rawDomain)) {
    return "support_info";
  }

  if (/(order|narudzba|reklamacija)/.test(rawDomain)) {
    return "order";
  }

  if (/(product|kupnja|availability)/.test(rawDomain)) {
    return "product_lookup";
  }

  return "";
}

function getSessionActiveTaskIntent(session = {}) {
  const rawIntent = normalizeForComparison(
    session?.workingMemory?.activeTaskIntent || session?.lastResolvedIntent || ""
  );

  if (/(buyback|otkup|prodaja)/.test(rawIntent)) {
    return "buyback";
  }

  if (/(delivery|dostava)/.test(rawIntent)) {
    return "delivery";
  }

  if (/(support|kontakt|contact|support_info)/.test(rawIntent)) {
    return "support_info";
  }

  if (/(order|narudzba|reklamacija)/.test(rawIntent)) {
    return "order";
  }

  if (/(product|kupnja|availability|product_lookup)/.test(rawIntent)) {
    return "product_lookup";
  }

  return "";
}

function looksLikeBuyerSearchDespiteSellWords(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage) {
    return false;
  }

  return (
    /\b(imate li|imate|da li imate|dali imate|ima li|prodajete li)\b.{0,80}\bza prodati\b/.test(normalizedMessage) ||
    /\bza prodati\b.{0,100}\b(trazim|tražim|treba|trebam|kcer|kćer|dijete|kupiti|kupujem)\b/.test(normalizedMessage) ||
    /\b(nemam|nemamo)\b.{0,100}\b(trazim|tražim|treba|trebam|kcer|kćer|dijete|kupiti|kupujem)\b/.test(normalizedMessage)
  );
}

function looksLikePositiveFeedbackMessage(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage || normalizedMessage.includes("?")) {
    return false;
  }

  return (
    /(jako|bas|baš)?\s*(sam\s+)?(zadovoljn|prezadovoljn|odusevljen|oduševljen|sretan).{0,40}(uslug|pomoc|pomoć|suradnj)/.test(
      normalizedMessage
    ) ||
    /(svaka cast|svaka čast|odlican posao|odličan posao|top ste|super ste|hvala vam puno|hvala puno)/.test(
      normalizedMessage
    )
  );
}

function looksLikeContactDetailsOnlyMessage(message = "") {
  const rawMessage = String(message || "").trim();
  const normalizedMessage = normalizeForComparison(rawMessage).trim();

  if (!normalizedMessage || normalizedMessage.includes("?")) {
    return false;
  }

  const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(rawMessage);
  const hasPhone = /(?:\+?\d[\d\s/()-]{6,}\d)/.test(rawMessage);
  const hasNameLike = /(?:^|[\s,])[A-ZČĆŠĐŽ][a-zčćšđž]+(?:\s+[A-ZČĆŠĐŽ][a-zčćšđž]+){1,2}(?:$|[\s,])/.test(
    rawMessage
  );
  const tokenCount = normalizedMessage.split(/\s+/).filter(Boolean).length;
  const hasIntentKeyword =
    /(narudzb|reklamacij|povrat|otkup|prodati|dostav|radno vrijeme|kontakt|adresa|knjig|udzben|isbn|autor|status|problem|paket|spaj|isplat|placanj|plaćanj)/.test(
      normalizedMessage
    );

  if (hasIntentKeyword) {
    return false;
  }

  return (hasEmail || hasPhone) && (hasNameLike || tokenCount <= 8);
}

function looksLikeFeasibilityFollowupMessage(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage) {
    return false;
  }

  return (
    /^(zanima me\s+)?(samo\s+)?(jel|je li|dal|da li)\s+se\s+moze/.test(normalizedMessage) ||
    /^(a|i)\s+(jel|je li|dal|da li)\s+se\s+moze/.test(normalizedMessage) ||
    /^moze li se/.test(normalizedMessage)
  );
}

function looksLikeOrderMergeRequest(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage) {
    return false;
  }

  return (
    /(spojit|spajanj|spojene|zajedno).{0,80}(narudzb|narudzb)/.test(normalizedMessage) ||
    /(dvije|dve|2).{0,80}(narudzb|narudzb).{0,80}(jedan paket|zajedno|jednom paketu|jedan trosak dostave|jednu dostavu)/.test(
      normalizedMessage
    )
  );
}

function looksLikeBuybackDeliveryExchangeQuestion(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage) {
    return false;
  }

  const hasCourierSignal =
    /(dostavljac|dostavljač|kurir|gls|boxnow|paketomat)/.test(normalizedMessage);
  const hasDeliveryOfOrderSignal =
    /(donosi|donese|kad dode|kad dođe|dolazi).{0,80}(narudzb|narudzb|paket)/.test(
      normalizedMessage
    );
  const hasBuybackHandOverSignal =
    /(predati|dati|predam|ubaciti|predam).{0,80}(knjig|udzben).{0,60}(otkup|prodati)/.test(
      normalizedMessage
    ) ||
    /(knjig|udzben).{0,80}(otkup|prodati).{0,80}(istom dostavljacu|istom dostavljaču|dostavljacu koji)/.test(
      normalizedMessage
    );

  return hasCourierSignal && (hasDeliveryOfOrderSignal || hasBuybackHandOverSignal);
}

function extractExplicitDomainCorrection(message = "") {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (
    !normalizedMessage ||
    !/(ne radi se o|nije .*nego|ne mislim na|ne govorim o|ne pitam za)/.test(normalizedMessage)
  ) {
    return "";
  }

  const pointsToOrder =
    /(kriv\w*(\s+\w+){0,3}\s+(knjig|udzben)|pogresn\w*(\s+\w+){0,3}\s+(knjig|udzben|paket)|krivo\s+poslan\w*(\s+\w+){0,3}\s+(knjig|udzben|paket)|reklamacij|narudzb|povrat|zamjen|racun|račun)/.test(
      normalizedMessage
    );
  const pointsToBuyback =
    /(otkup|prodati|prodajem|otkupn\w*\s+nalog|isplata)/.test(normalizedMessage);
  const pointsToDelivery =
    /(dostav|isporuk|kurir|dostavljac|dostavljač|gls|boxnow|paketomat)/.test(normalizedMessage);
  const pointsToProduct =
    /(knjig|udzben|isbn|autor|naslov|kupiti|naruciti|naručiti)/.test(normalizedMessage) &&
    !pointsToOrder &&
    !pointsToBuyback &&
    !pointsToDelivery;

  if (pointsToOrder) {
    return "order";
  }

  if (pointsToBuyback) {
    return "buyback";
  }

  if (pointsToDelivery) {
    return "delivery";
  }

  if (pointsToProduct) {
    return "product_lookup";
  }

  return "";
}

function hydrateSessionRoutingContext(session = {}) {
  if (!session || typeof session !== "object") {
    return session;
  }

  session.messages = Array.isArray(session.messages) ? session.messages : [];
  session.workingMemory = session.workingMemory && typeof session.workingMemory === "object"
    ? session.workingMemory
    : {};

  const latestTaskIntentMessage = [...session.messages]
    .reverse()
    .find((message) => message?.role === "assistant" && message?.supportTaskIntent);

  if (latestTaskIntentMessage?.supportTaskIntent && !session.workingMemory.activeTaskIntent) {
    session.workingMemory.activeTaskIntent = latestTaskIntentMessage.supportTaskIntent;
  }

  if (!session.workingMemory.activeDomain) {
    session.workingMemory.activeDomain = getSessionActiveTaskIntent(session);
  }

  if ((!Array.isArray(session.lastProductTitles) || session.lastProductTitles.length === 0)) {
    const latestProductMessage = [...session.messages]
      .reverse()
      .find((message) => message?.role === "assistant" && Array.isArray(message?.products) && message.products.length > 0);

    if (latestProductMessage) {
      session.lastProductTitles = latestProductMessage.products
        .map((product) => product?.title)
        .filter(Boolean)
        .slice(0, 5);
    }
  }

  if (!session.lastStandaloneQuery) {
    const latestUserMessage = [...session.messages]
      .reverse()
      .find((message) => message?.role === "user" && normalizeWhitespace(message?.content || ""));

    if (latestUserMessage?.content) {
      session.lastStandaloneQuery = normalizeWhitespace(latestUserMessage.content);
    }
  }

  return session;
}

function inferTaskIntentFromMessage(userMessage = "", session = {}) {
  const normalizedMessage = normalizeForComparison(userMessage).trim();
  const activeDomain = getSessionActiveDomain(session);
  const activeTaskIntent = getSessionActiveTaskIntent(session);

  if (!normalizedMessage) {
    return activeTaskIntent || activeDomain || "";
  }

  const correctedDomain = extractExplicitDomainCorrection(userMessage);

  if (correctedDomain) {
    return correctedDomain;
  }

  if (looksLikeFeasibilityFollowupMessage(userMessage) && (activeTaskIntent || activeDomain)) {
    return activeTaskIntent || activeDomain;
  }

  if (looksLikeContactDetailsOnlyMessage(userMessage)) {
    if (activeTaskIntent || activeDomain) {
      return activeTaskIntent || activeDomain;
    }

    return "support_info";
  }

  if (looksLikeOrderMergeRequest(userMessage)) {
    return "order";
  }

  if (looksLikeBuybackDeliveryExchangeQuestion(userMessage)) {
    return "buyback";
  }

  if (/(narudzb|reklamacij|povrat|refund|r1|racun|račun|problem s narudzb|problem s narudžb|gdje mi je|ostecen|oštećen|kriva knjiga|krive knjige)/.test(normalizedMessage)) {
    return "order";
  }

  if (looksLikeBuybackParcelQuestion(userMessage, session)) {
    return "buyback";
  }

  if (/(dostav|isporuk|postarin|poštarin|paketomat|gls|boxnow|box now|kurir|preuzimanj|rok dostave|dostavne opcije|opcije dostave)/.test(normalizedMessage)) {
    return "delivery";
  }

  if (/(radno vrijeme|adresa|lokacija|kontakt|telefon|email|mail|placanj|na[cč]ini placanja|kartic|gotovin|pouzec)/.test(normalizedMessage)) {
    return "support_info";
  }

  if (/(otkup|prodati|prodajem|procjen|vrednovanj|knjige za otkup|donijeti knjige|poslati knjige|predati paket|predam paket|odnijeti paket|zapakirati paket|zapakiram paket)/.test(normalizedMessage)) {
    return "buyback";
  }

  if (looksLikeProductLookupMessage(userMessage, session)) {
    return "product_lookup";
  }

  if (/^(a|i)\s+/.test(normalizedMessage) && activeDomain) {
    return activeDomain;
  }

  return activeTaskIntent || activeDomain || "";
}

function buildKnowledgeSearchOptions(session = {}, userMessage = "") {
  const activeDomain = getSessionActiveDomain(session);
  const taskIntent = inferTaskIntentFromMessage(userMessage, session) || activeDomain || "";
  const conversationFacts = [];
  const retrievalHints = [];
  const conversationTerms = [];

  if (session?.entryIntent && ENTRY_INTENT_LABELS[session.entryIntent]) {
    conversationFacts.push(ENTRY_INTENT_LABELS[session.entryIntent]);
  }

  if (session?.entryPromptAnswer) {
    conversationFacts.push(session.entryPromptAnswer);
  }

  if (taskIntent === "delivery") {
    retrievalHints.push("dostava", "opcije dostave", "gls", "boxnow", "osobno preuzimanje");
  } else if (taskIntent === "support_info") {
    retrievalHints.push("kontakt", "radno vrijeme", "adresa", "telefon", "email");
  } else if (taskIntent === "buyback") {
    retrievalHints.push("otkup", "prodaja knjiga", "fizicki otkup", "online otkup");
    if (looksLikeBuybackParcelQuestion(userMessage, session)) {
      retrievalHints.push("paket", "dostavljac", "kurir", "gls", "boxnow", "naljepnica", "prikup");
    }
  } else if (taskIntent === "order") {
    retrievalHints.push("narudzba", "reklamacija", "povrat", "racun");
  }

  if (session?.lastStandaloneQuery) {
    conversationTerms.push(session.lastStandaloneQuery);
  }

  const recentUserMessages = Array.isArray(session?.messages)
    ? session.messages
        .filter((message) => message?.role === "user" && message?.content)
        .slice(-3)
        .map((message) => normalizeWhitespace(message.content))
        .filter(Boolean)
    : [];

  conversationTerms.push(...recentUserMessages);

  return {
    taskIntent,
    activeDomain: taskIntent || activeDomain || "",
    conversationFacts: [...new Set(conversationFacts.filter(Boolean))],
    retrievalHints: [...new Set(retrievalHints.filter(Boolean))],
    conversationTerms: [...new Set(conversationTerms.filter(Boolean))].slice(-4),
    retrievalFrame: {
      activeReferenceValue: Array.isArray(session?.lastProductTitles) ? session.lastProductTitles[0] || "" : ""
    }
  };
}

function looksLikeProductContinuationMessage(message = "", session = {}) {
  const normalizedMessage = normalizeForComparison(message).trim();
  const activeDomain = getSessionActiveDomain(session);
  const hasProductContext =
    activeDomain === "product_lookup" ||
    (Array.isArray(session?.lastProductTitles) && session.lastProductTitles.length > 0);

  if (!hasProductContext || !normalizedMessage) {
    return false;
  }

  if (
    /(dostava|isporuka|radno vrijeme|kontakt|adresa|telefon|email|mail|narudzb|reklamacij|povrat|otkup|prodaja|prodati|problem)/.test(
      normalizedMessage
    )
  ) {
    return false;
  }

  return /(^|\b)(ima li (je|ga|ih|jos)|je li (jos )?(dostupn|na stanju)|jos (ima|dostupn)|koliko kost|koja je cijena|cijena|na stanju|moze li se kupiti|moze li se naruciti|mogu li naruciti|imate li jos|postoji li jos|je li ostala)(\b|$)/.test(
    normalizedMessage
  );
}

function looksLikeBuybackParcelQuestion(message = "", session = {}) {
  const normalizedMessage = normalizeForComparison(message).trim();
  const activeDomain = getSessionActiveDomain(session);

  if (!normalizedMessage) {
    return false;
  }

  const hasBuybackContext =
    activeDomain === "buyback" ||
    /(otkup|online otkup|prodaj|prodati|prodajem|knjig|udzben)/.test(normalizedMessage);
  const hasParcelSignal =
    /(paket|posilj|pošilj|kutij|vrecic|vrećic|naljepnic|gls|boxnow|box now|paketomat|kurir|dostavljac|dostavljač|prikup|preuzim)/.test(
      normalizedMessage
    );
  const hasPackageAction =
    /(zapakir|spakir|pakir|preda|predati|predam|odnijeti|odnes|donijeti|poslati|saljem|šaljem|preuzme|pokupi|prikup|naljepnic|sam odn|sama odn|sami odn|ubaciti)/.test(
      normalizedMessage
    );

  return hasBuybackContext && hasParcelSignal && hasPackageAction;
}

function getRelevanceQueryFeatures(message = "", session = {}) {
  const rawMessage = String(message || "");
  const normalizedMessage = normalizeForComparison(rawMessage).trim();
  const tokens = normalizedMessage.split(/\s+/).filter(Boolean);
  const wordCount = tokens.length;
  const commaCount = (rawMessage.match(/,/g) || []).length;
  const titleCaseCount = (rawMessage.match(/\b[A-ZČĆŠĐŽ][a-zčćšđž]{3,}\b/g) || []).length;
  const activeDomain = getSessionActiveDomain(session);

  const hasUnsafeOrInternalRequest =
    /(ignore all previous|administrator|admin\b|listu svih kupaca|kupaca|kupci|buyers|proslog mjeseca|prošli mjesec|previous month|osobni podaci|private data)/.test(
      normalizedMessage
    );
  const hasOrderIssue =
    /(narudzb|narudžb|reklamacij|povrat|refund|r1|racun|račun|problem|gdje mi je|nisam .*dobi|niste odgovorili|otkazat|otkaziv|ostecen|oštećen|kriva knjiga|krive knjige)/.test(
      normalizedMessage
    );
  const hasBuyerForSalePhrase = looksLikeBuyerSearchDespiteSellWords(rawMessage);
  const hasBuybackIntent =
    !hasBuyerForSalePhrase &&
    /\b(otkup\w*|prodati|prodat\w*|prodajem|prodala|prodao|prodaja knjiga|prodaja udzbenika|prodaja udžbenika|procjen\w*|vrednovanj\w*|otkupn\w*\s+nalog)\b/.test(
      normalizedMessage
    );
  const hasDeliverySignal =
    /(dostav|isporuk|postarin|poštarin|paketomat|gls|boxnow|box now|kurir|preuzimanj|rok dostave|kucn\w*\s+adres|kućn\w*\s+adres)/.test(
      normalizedMessage
    );
  const hasSupportInfoSignal =
    /(radno vrijeme|adresa|lokacija|kontakt|telefon|email|mail|placanj|plaćanj|pouzec|pouzeć|gdje se nalaz)/.test(
      normalizedMessage
    );
  const hasBookSearchVerb =
    /\b(imate li|prodajete li|treba mi|trebam|trebala bi|trebao bih|trazim|tražim|zanima me|potrebna mi je|potrebno mi je|mogu li naruciti|mogu li naručiti|da li se mogu.*naruciti|da li se mogu.*naručiti|dali ima|ima li jos|ima li još|dostupn|kupiti|kupi|kupnja|uzeti|uzet cemo|uzet ćemo)\b/.test(
      normalizedMessage
    );
  const hasIsbn =
    /\b(?:97[89][-\s]?)?\d(?:[-\s]?\d){8,12}[\dXx]\b/.test(rawMessage) ||
    /\bisbn\b/.test(normalizedMessage);
  const hasBookTerm =
    /(knjig|ud[zž]ben|us[zž]ben|radn\w*\s+bilje|workbook|textbook|pravopis|atlas|citank|čitank|prirucnik|priručnik|zbirka|svezak|izdanje|edition|online practice|skripta|focus|fokus|putokazi|dodi i vidi|dođi i vidi|fon fon|tragom teksta)/.test(
      normalizedMessage
    );
  const hasSchoolContext =
    /(razred|gimnazij|strukovn|obrtni[cč]k|osnovn|srednj|skol|škol|komercijalist|ekonomsk|trogodišnj|cetverogodišnj|četverogodišnj)/.test(
      normalizedMessage
    );
  const hasSubjectNumber =
    /\b(matematika|fizika|kemija|biologija|hrvatski|engleski|geografija|povijest|informatika|priroda)\s*\d\b/.test(
      normalizedMessage
    ) || /\b\d+\.\s*r\b/.test(normalizedMessage);
  const hasSubjectOrProgramSignal =
    /\b(matematika|fizika|kemija|biologija|hrvatski|engleski|geografija|povijest|informatika|priroda|vjeronauk|ugostitelj|komercijalist|hotelijer|turisticki|turistički)\b/.test(
      normalizedMessage
    );
  const hasEditionSignal =
    /(edition|izdanje|svezak|dio|nd edition|rd edition|th edition|workbook|online practice|prirucnik|priručnik|zbirka|putokazi|profil klet|algoritam)/.test(
      normalizedMessage
    );
  const hasCollectionSearch =
    /(koje\s+knjige\s+o|knjige\s+o\s+|slicne\s+tematike|slične\s+tematike|slicna\s+tematika|slična\s+tematika|sto imate slicno|što imate slično)/.test(
      normalizedMessage
    );
  const hasAuthorCitation =
    commaCount >= 2 ||
    titleCaseCount >= 3 ||
    /\b[a-zčćšđž]\.\s*,?\s*[a-zčćšđž]\./i.test(rawMessage);
  const hasMixedSupportAndProductIntent =
    (hasDeliverySignal || hasSupportInfoSignal) &&
    (hasBookSearchVerb || hasBookTerm || hasSchoolContext);
  const hasContextualSupportFollowup =
    activeDomain &&
    activeDomain !== "product_lookup" &&
    /^(a|i)\s+(za|koliko|kako|gdje|kada|sto|što|što je|sto je)\b/.test(normalizedMessage);
  const hasContactDetailsOnly = looksLikeContactDetailsOnlyMessage(rawMessage);
  const hasPositiveFeedbackSignal = looksLikePositiveFeedbackMessage(rawMessage);
  const isSupportOnly =
    hasUnsafeOrInternalRequest ||
    hasOrderIssue ||
    hasBuybackIntent ||
    hasContactDetailsOnly ||
    hasPositiveFeedbackSignal ||
    hasMixedSupportAndProductIntent ||
    hasContextualSupportFollowup ||
    (hasDeliverySignal && !hasBookSearchVerb && !hasBookTerm) ||
    (hasSupportInfoSignal && !hasBookSearchVerb && !hasBookTerm);
  const isTitleHeavyProductCandidate =
    !isSupportOnly &&
    wordCount >= 2 &&
    (
      hasIsbn ||
      hasBookSearchVerb ||
      (hasBookTerm && (wordCount >= 3 || hasSchoolContext || hasEditionSignal)) ||
      (hasSchoolContext && (hasBookTerm || hasSubjectNumber || hasSubjectOrProgramSignal)) ||
      (hasEditionSignal && wordCount >= 2) ||
      (hasCollectionSearch && wordCount >= 3) ||
      (hasAuthorCitation && wordCount >= 4)
    );
  const isVagueProductQuery =
    !isSupportOnly &&
    (
      (wordCount > 0 && wordCount <= 3 &&
        /(engleski|matematika|fizika|kemija|biologija|sobotta|atlas|pravopis|geografija|povijest|lektira)/.test(
          normalizedMessage
        )) ||
      (wordCount <= 4 && activeDomain === "product_lookup" && !hasBookSearchVerb && !hasIsbn)
    );

  return {
    activeDomain,
    wordCount,
    hasUnsafeOrInternalRequest,
    hasOrderIssue,
    hasBuybackIntent,
    hasDeliverySignal,
    hasSupportInfoSignal,
    hasBookSearchVerb,
    hasIsbn,
    hasBookTerm,
    hasSchoolContext,
    hasSubjectNumber,
    hasSubjectOrProgramSignal,
    hasEditionSignal,
    hasCollectionSearch,
    hasAuthorCitation,
    hasContactDetailsOnly,
    hasPositiveFeedbackSignal,
    hasMixedSupportAndProductIntent,
    hasContextualSupportFollowup,
    isTitleHeavyProductCandidate,
    isVagueProductQuery
  };
}

function looksLikeProductLookupMessage(message = "", session = {}) {
  const normalizedMessage = normalizeForComparison(message).trim();

  if (!normalizedMessage) {
    return false;
  }

  if (looksLikeBuybackParcelQuestion(message, session)) {
    return false;
  }

  if (
    looksLikeContactDetailsOnlyMessage(message) ||
    looksLikePositiveFeedbackMessage(message) ||
    looksLikeFeasibilityFollowupMessage(message)
  ) {
    return false;
  }

  if (looksLikeProductContinuationMessage(message, session)) {
    return true;
  }

  if (looksLikeBuyerSearchDespiteSellWords(message)) {
    return true;
  }

  const queryFeatures = getRelevanceQueryFeatures(message, session);

  if (queryFeatures.isTitleHeavyProductCandidate) {
    return true;
  }

  if (
    /(refund|reklamacij|povrat|dostav|isporuk|postarin|poštarin|paket|paketomat|gls|boxnow|box now|kurir|dostavljac|dostavljač|naljepnic|preda|predati|predam|odnijeti|odnes|zapakir|spakir|\botkup\w*|\bprodaja\b|\bprodati\b|\bprodajem\b|\bprodat\b|radno vrijeme|kontakt|adresa|telefon|email|mail|narudzb|problem|pomoc|administrator|ignore all previous instructions|listu svih kupaca|kupaca|kupci|buyers|proslog mjeseca|prosli mjesec)/.test(
      normalizedMessage
    )
  ) {
    return false;
  }

  if (/^(a|i)\s+(koliko|kako|gdje|kada|sto|što|zasto|zašto|za)\b/.test(normalizedMessage)) {
    return false;
  }

  if (/\b(imate li|prodajete li|treba mi|trazim|knjigu|knjiga|udzbenik|udzbenike|isbn|autor)\b/.test(normalizedMessage)) {
    return true;
  }

  const preprocessedQuery = normalizeForComparison(productFeedService.__internal.preprocessQuery(message));
  const tokens = preprocessedQuery.split(/\s+/).filter(Boolean);
  const genericSupportTokens = new Set([
    "pitanje",
    "pomoc",
    "pomoci",
    "upit",
    "problem",
    "narudzba",
    "dostava",
    "kontakt"
  ]);
  const questionLeadPattern = /^(koliko|kako|gdje|kada|sto|što|zasto|zašto|koje|koji|koja)\b/;
  const hasGenericOnlyVocabulary =
    tokens.length > 0 && tokens.every((token) => genericSupportTokens.has(token));
  const hasTitleLikeSignal =
    tokens.some((token) => /\d/.test(token)) ||
    (tokens.length >= 2 &&
      tokens.some((token) => token.length >= 5) &&
      !questionLeadPattern.test(tokens.join(" ")));
  const hasStrongProductSignal =
    queryFeatures.hasBookSearchVerb ||
    queryFeatures.hasBookTerm ||
    queryFeatures.hasSchoolContext ||
    queryFeatures.hasSubjectOrProgramSignal ||
    queryFeatures.hasEditionSignal ||
    queryFeatures.hasAuthorCitation ||
    queryFeatures.hasIsbn;

  return (
    tokens.length >= 1 &&
    tokens.length <= 10 &&
    hasTitleLikeSignal &&
    hasStrongProductSignal &&
    !hasGenericOnlyVocabulary
  );
}

function getAllowedSourcesForIntent(taskIntent = "") {
  switch (taskIntent) {
    case "product_lookup":
      return ["website_links"];
    case "buyback":
      return ["onedrive_knowledge", "zendesk_knowledge", "website_links"];
    case "delivery":
    case "support_info":
    case "order":
      return ["zendesk_knowledge", "onedrive_knowledge", "website_links"];
    case "complaint":
    case "buyback_payout_issue":
      return ["policy_guard"];
    default:
      return ["zendesk_knowledge", "onedrive_knowledge", "website_links", "policy_guard"];
  }
}

function getTopicShiftType(previousDomain = "", nextDomain = "") {
  if (!previousDomain || !nextDomain || previousDomain === nextDomain) {
    return "";
  }

  if (previousDomain === "product_lookup") {
    return "product_to_support_shift";
  }

  if (nextDomain === "product_lookup") {
    return "support_to_product_shift";
  }

  return `${previousDomain}_to_${nextDomain}_shift`;
}

function inferMissingDetail(taskIntent = "", queryFeatures = {}) {
  if (taskIntent === "product_lookup" && queryFeatures.isVagueProductQuery) {
    return "book_identifier";
  }

  if (taskIntent === "order" && !/\b\d{4,}\b|#\s*\d+/.test(String(queryFeatures.rawMessage || ""))) {
    return "order_identifier";
  }

  return "";
}

function buildRelevanceTurnContext(session = {}, userMessage = "", knowledgeSearchOptions = {}) {
  const queryFeatures = {
    rawMessage: String(userMessage || ""),
    ...getRelevanceQueryFeatures(userMessage, session)
  };
  const previousDomain = getSessionActiveDomain(session);
  const inferredTaskIntent = knowledgeSearchOptions.taskIntent || inferTaskIntentFromMessage(userMessage, session);
  const taskIntent = queryFeatures.isTitleHeavyProductCandidate
    ? "product_lookup"
    : inferredTaskIntent;
  const activeTopic = taskIntent || knowledgeSearchOptions.activeDomain || previousDomain || "";
  const recentUserMessages = Array.isArray(session?.messages)
    ? session.messages
        .filter((message) => message?.role === "user" && normalizeWhitespace(message?.content || ""))
        .slice(-3)
        .map((message) => normalizeWhitespace(message.content))
    : [];
  const topicShiftType = getTopicShiftType(previousDomain, activeTopic);

  return {
    activeTopic,
    allowedSources: getAllowedSourcesForIntent(activeTopic),
    entryFlow: {
      intent: session?.entryIntent || "",
      label: ENTRY_INTENT_LABELS[session?.entryIntent] || "",
      promptAnswer: session?.entryPromptAnswer || "",
      skipped: Boolean(session?.entryFlowSkipped)
    },
    missingDetail: inferMissingDetail(activeTopic, queryFeatures),
    previousDomain,
    queryFeatures,
    recentUserMessages,
    taskIntent: activeTopic,
    topicShiftDetected: Boolean(topicShiftType),
    topicShiftType
  };
}

function getSuggestedRepliesForOutcome(outcome = {}, relevanceContext = {}, channelType = "web_chat") {
  if (normalizeChannelType(channelType) !== "web_chat") {
    return [];
  }

  if (Array.isArray(outcome.suggestedReplies) && outcome.suggestedReplies.length > 0) {
    return normalizeSuggestedReplies(outcome.suggestedReplies);
  }

  if (outcome.type === "ask_clarifying_question" && outcome.reason === "order_issue_clarification") {
    return ["Imam broj narudžbe", "Nemam broj narudžbe", "Problem je s dostavom"];
  }

  if (outcome.type === "ask_clarifying_question" && outcome.reason === "short_query_clarification") {
    return ["Imam ISBN", "Znam autora", "Ne znam točan naslov"];
  }

  if (outcome.taskIntent === "product_lookup" && outcome.reason === "purchase_search_guidance") {
    if (relevanceContext.queryFeatures?.hasSchoolContext) {
      return ["Imam šifru s popisa", "Imam samo naslov", "Trebam pomoć s narudžbom"];
    }

    return ["Imam ISBN", "Imam školski popis", "Ne znam točan naslov"];
  }

  return [];
}

function buildRelevanceDiagnostic(outcome = {}, relevanceContext = {}) {
  return {
    finalIntent: outcome.taskIntent || relevanceContext.taskIntent || "",
    sourceDecision: outcome.source || "",
    fallbackReason: outcome.reason || "",
    clarificationReason: outcome.type === "ask_clarifying_question" ? outcome.reason || "" : "",
    topicShift: relevanceContext.topicShiftType || ""
  };
}

function decorateOutcomeWithRelevance(outcome = {}, relevanceContext = {}, { channelType = "web_chat" } = {}) {
  if (!outcome || typeof outcome !== "object") {
    return outcome;
  }

  const relevance = buildRelevanceDiagnostic(outcome, relevanceContext);

  return {
    ...outcome,
    relevance,
    suggestedReplies: getSuggestedRepliesForOutcome(outcome, relevanceContext, channelType)
  };
}

function sanitizeMetricPart(value = "") {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function recordRelevanceMetrics(outcome = {}, relevanceContext = {}) {
  metricsService.increment(`outcome_${sanitizeMetricPart(outcome.type)}_total`);
  metricsService.increment(`outcome_reason_${sanitizeMetricPart(outcome.reason)}_total`);
  metricsService.increment(`intent_${sanitizeMetricPart(outcome.taskIntent || relevanceContext.taskIntent)}_total`);
  metricsService.increment(`source_${sanitizeMetricPart(outcome.source)}_total`);

  if (outcome.type === "ask_clarifying_question") {
    metricsService.increment(`clarification_${sanitizeMetricPart(outcome.reason)}_total`);
  }

  if (relevanceContext.topicShiftDetected) {
    metricsService.increment("topic_shift_total");
    metricsService.increment(`topic_shift_${sanitizeMetricPart(relevanceContext.topicShiftType)}_total`);
  }
}

function uniqueOutcomeTags(tags = []) {
  return [...new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function buildCriticalComplaintOutcome(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  if (!normalizedMessage) {
    return null;
  }

  const isAggressiveTone =
    /\b(prevarili|prevara|prijevara|varate|lopovi|kradete|ukrali|scam)\b/.test(normalizedMessage);
  const isWrongBooksIssue =
    /(kriv\w*\s+(knjig|udzben)|pogresn\w*\s+(knjig|udzben|paket)|poslali ste mi kriv|zaprimila sam paket.*kriv|zamijenjen\w*\s+paket)/.test(
      normalizedMessage
    );
  const hasPayoutProblemSignal =
    /(nisam|nismo|niste|nije|ne)\s+.{0,50}(novac|novca|uplat|isplat|platili|platila|platio)|novca nigdje|nepostojec\w*\s+uplat|kriv\w*\s+uplat|neuplacen|neisplacen|ne uplacen|ne isplacen|neisplat/.test(
      normalizedMessage
    );
  const isBuybackPayoutIssue =
    hasPayoutProblemSignal &&
    /(otkup|prodaj|prodao|prodala|udzben|knjig|paket)/.test(normalizedMessage);
  const isReturnPolicyQuestion =
    /\bpovrat\w*\b/.test(normalizedMessage) &&
    /(mogu[cć]|moze|može|dal|da li|dali|kako|rok|uvjet|moze li|može li)/.test(normalizedMessage) &&
    !/(reklamacij|refund|ostecen|oštećen|kriva|krivi|pogresn|pogrešn|problem|kupio|kupila|narucio|naručio|narucila|naručila|broj narudzbe|broj narudžbe|nisam|niste)/.test(normalizedMessage);
  const isComplaintOrReturnIssue =
    !isReturnPolicyQuestion &&
    /\b(reklamacij\w*|povrat\w*|refund\w*|ostecen\w*|krivi\s+udzbenik|kriva\s+knjiga)\b/.test(
      normalizedMessage
    );

  if (!isAggressiveTone && !isWrongBooksIssue && !isBuybackPayoutIssue && !isComplaintOrReturnIssue) {
    return null;
  }

  const extraTags = ["reklamacija_problem"];

  if (isWrongBooksIssue) {
    extraTags.push("wrong_books");
  }

  if (isBuybackPayoutIssue) {
    extraTags.push("buyback_payout_issue");
  }

  if (isAggressiveTone) {
    extraTags.push("aggressive_tone");
  }

  if (isComplaintOrReturnIssue) {
    extraTags.push("return_or_refund");
  }

  let reason = "complaint_handoff";
  let taskIntent = "complaint";
  let customerMessage =
    "Žao mi je zbog neugodnosti. Riješit ćemo to s vama u ovoj chat niti. Pošaljite nam broj narudžbe, kratak opis problema, fotografiju računa ili artikla ako je relevantno te kontakt broj.";

  if (isWrongBooksIssue) {
    reason = "wrong_books_handoff";
    customerMessage =
      "Žao mi je zbog neugodnosti, ispričavamo se zbog pogrešno poslanih knjiga. Riješit ćemo to s vama u ovoj chat niti. Pošaljite nam broj narudžbe, sliku računa koji se nalazi unutar jedne od knjiga u paketu, ime i prezime s narudžbe te kontakt broj.";
  } else if (isBuybackPayoutIssue || isAggressiveTone) {
    reason = isAggressiveTone ? "aggressive_complaint_handoff" : "buyback_payout_handoff";
    taskIntent = "buyback_payout_issue";
    customerMessage =
      "Žao mi je zbog neugodnosti. Razumijem frustraciju i provjerit ćemo uplatu ručno; riješit ćemo sve. Pošaljite nam ime i prezime s otkupnog naloga, broj otkupnog naloga ako ga imate, podatak o načinu isplate koji ste naveli i kontakt broj.";
  }

  return {
    type: "hard_handoff",
    stateTag: "awaiting_human",
    reason,
    source: "policy_guard",
    taskIntent,
    extraTags: uniqueOutcomeTags(extraTags),
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function looksLikeOrderStatusOrExistingBuyerIssue(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  if (!normalizedMessage) {
    return false;
  }

  return (
    /(gdje\s+mi\s+je\s+narudzb|status\s+narudzb|problem\s+s\s+narudzb|jeste\s+li\s+poslali\s+moj\w*\s+narudzb|zanima\s+me\s+jeste\s+li\s+poslali|moja\s+narudzb|moju\s+narudzb|kupio\s+sam\s+knjig|kupila\s+sam\s+knjig|kupio\s+sam.*od\s+vas|kupila\s+sam.*od\s+vas|naru[cć]io\s+sam|narucio\s+sam|narucila\s+sam|naru[cć]ila\s+sam)/.test(
      normalizedMessage
    ) ||
    (/kupio|kupila|narucio|narucila/.test(normalizedMessage) &&
      /(od\s+vas|knjig|udzben|narudzb)/.test(normalizedMessage))
  );
}

function buildOrderIssueClarificationOutcome(userMessage = "", { channelType = "web_chat" } = {}) {
  if (!looksLikeOrderStatusOrExistingBuyerIssue(userMessage)) {
    return null;
  }

  const customerMessage =
    channelType === "email"
      ? "Možemo provjeriti narudžbu. Pošaljite broj narudžbe; ako ga nemate, napišite ime i prezime te email ili telefon koji su uneseni pri naručivanju."
      : "Možemo provjeriti narudžbu ovdje u chatu. Pošaljite broj narudžbe; ako ga nemate, napišite ime i prezime te email ili telefon koji su uneseni pri naručivanju.";

  return {
    type: "ask_clarifying_question",
    stateTag: "awaiting_customer_detail",
    reason: "order_issue_clarification",
    source: "policy_guard",
    taskIntent: "order",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function buildOrderMergeGuidanceOutcome() {
  const customerMessage = [
    "Da, možemo pokušati spojiti narudžbe u jedan paket ako još nisu poslane.",
    "Pošaljite brojeve obje narudžbe te ime i prezime s narudžbe.",
    "Provjerit ćemo status i javiti može li ići jedna dostava."
  ].join(" ");

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "order_merge_guidance",
    source: "conversation_fallback",
    taskIntent: "order",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function buildBuybackDeliveryExchangeGuidanceOutcome() {
  const customerMessage = [
    "Da, knjige za otkup možete predati dostavljaču koji donosi vašu narudžbu.",
    `Prije dolaska dostavljača otvorite online otkupni nalog na ${BASE_URL}/otkup-udzbenika/.`,
    "Knjige za otkup zapakirajte odvojeno i predajte ih dostavljaču; on donosi naljepnicu, vi ništa ne pišete na paket.",
    "Isplata ide nakon pregleda zaprimljenih knjiga."
  ].join(" ");

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "buyback_delivery_exchange_guidance",
    source: "website_links",
    taskIntent: "buyback",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function buildPositiveFeedbackOutcome() {
  const customerMessage =
    "Hvala vam na povratnoj informaciji. Drago nam je da ste zadovoljni uslugom. Ako trebate još nešto, slobodno napišite.";

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "positive_feedback_acknowledgement",
    source: "conversation_fallback",
    taskIntent: "support_info",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function looksLikeBuybackConfirmationQuestion(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  return /potvrd\w*\s+.*otkupn\w*\s+nalog|otkupn\w*\s+nalog.*potvrd\w*/.test(normalizedMessage);
}

function hasExplicitBuybackConfirmationKnowledge(knowledge = null) {
  const normalizedContext = normalizeForComparison(
    [
      knowledge?.context || "",
      ...(Array.isArray(knowledge?.articles)
        ? knowledge.articles.flatMap((article) => [article?.title || "", article?.body || ""])
        : [])
    ].join(" ")
  );

  return /potvrd\w*/.test(normalizedContext) && /(otkupn\w*\s+nalog|nalog\s+otkup)/.test(normalizedContext);
}

function buildBuybackConfirmationHandoffOutcome(channelType = "web_chat") {
  const channelMessages = getChannelMessages(channelType);
  const customerMessage =
    channelType === "email"
      ? "Potvrdu online otkupnog naloga trebamo provjeriti ručno kako vam ne bismo poslali pogrešan korak. Javit ćemo vam se čim pregledamo detalje."
      : "Potvrdu online otkupnog naloga trebamo provjeriti ručno kako vam ne bismo poslali pogrešan korak. Javit ćemo vam se ovdje čim pregledamo detalje.";

  return {
    type: "hard_handoff",
    stateTag: "awaiting_human",
    reason: "buyback_confirmation_handoff",
    source: "policy_guard",
    taskIntent: "buyback",
    extraTags: ["buyback_confirmation", "awaiting_human_review"],
    customerMessage: customerMessage || channelMessages.hardHandoff,
    zendeskMessage: customerMessage || channelMessages.hardHandoff
  };
}

function looksLikeExplicitPhysicalBuybackQuestion(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  return (
    /(otkup|prodati|prodaja|knjig|udzben)/.test(normalizedMessage) &&
    /(poslovnic|fizick|osobno|donijeti|donijem|dolazak|adresa|zupanijska)/.test(normalizedMessage)
  );
}

function looksLikeOnlineBuybackOpening(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  if (!normalizedMessage || looksLikeBuybackConfirmationQuestion(userMessage) || looksLikeExplicitPhysicalBuybackQuestion(userMessage)) {
    return false;
  }

  if (/(isplata|uplat|novac|aircash|dostavljac|kurir|nije dosao|nije dosao|paketomat|gls|boxnow)/.test(normalizedMessage)) {
    return false;
  }

  return (
    /(zelim|želim|hoc[uć]|htio bih|htjela bih|imam|kako mogu|mogu li|zanima me).{0,80}(prodati|otkup|otkupiti|procjen|cijena koju mogu dobiti)/.test(
      normalizedMessage
    ) ||
    /(prodaja knjiga|prodaja udzbenika|otkup knjiga|otkup udzbenika|online otkup|prodati udzbenike online|prodati knjige online)/.test(
      normalizedMessage
    )
  );
}

function buildOnlineBuybackGuidanceOutcome() {
  const customerMessage = [
    `Za online otkup krenite ovdje: ${BASE_URL}/otkup-udzbenika/.`,
    "1. Otvorite online otkupni nalog na webu.",
    "2. Mobitelom skenirajte barkod svake knjige; ako skeniranje ne uspije, upišite barkod broj bez crtica ili učitajte sliku barkoda.",
    "3. Nakon što sustav prikaže vrijednost i nastavite s nalogom, zapakirajte knjige.",
    "4. Predajte paket dostavljaču prema dogovorenom prikupu."
  ].join("\n");

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "online_buyback_guidance",
    source: "website_links",
    taskIntent: "buyback",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function looksLikeBuybackAcceptedBooksQuestion(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  return /(koje\s+sve\s+knjige|koje\s+knjige|sto\s+otkupljujete|što\s+otkupljujete|otkupljujete li|radne\s+biljeznice|radne\s+bilježnice|osnovn\w*\s+skol|osnovn\w*\s+škol|osnovnoskol\w*|osnovnoškol\w*|fakultet|beletristik|roman)/.test(normalizedMessage) &&
    /(otkup|otkupljuj|prodati|prodajem|prodaja)/.test(normalizedMessage);
}

function buildBuybackAcceptedBooksOutcome() {
  const customerMessage =
    "Otkupljujemo rabljene udžbenike za srednju školu. Udžbenike za osnovnu školu, knjige za fakultete, romane, beletristiku i ostalu literaturu ne otkupljujemo i ne prodajemo. Ako niste sigurni za konkretan naslov, pošaljite fotografiju ili naslov pa možemo provjeriti.";

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "buyback_accepted_books_guidance",
    source: "conversation_fallback",
    taskIntent: "buyback",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function looksLikeBuybackBonusQuestion(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  return /(kupon\w*|bonus\w*|popust\w*|kampanj\w*)/.test(normalizedMessage) &&
    /(otkup|otkupu|prodaj|prodati)/.test(normalizedMessage);
}

function buildBuybackBonusOutcome() {
  const customerMessage =
    "Povremeno organiziramo otkupne kampanje s dodatnim bonusom na standardnu otkupnu cijenu. Aktivne kampanje objavljujemo na webu i webshopu, Facebooku, Instagramu i email newsletteru. Ako kampanja trenutno nije prikazana na webu, računajte na standardnu otkupnu cijenu koju sustav prikaže nakon skeniranja ili unosa barkoda.";

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "buyback_bonus_guidance",
    source: "conversation_fallback",
    taskIntent: "buyback",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function looksLikeBuybackPriceQuestion(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  return /(cijen\w*|cujene|cijene|koliko\s+(dobijem|vrijedi|kosta|košta)|vrijednost)/.test(normalizedMessage) &&
    /(otkup|otkupa|prodaj|prodati|knjig|udzben)/.test(normalizedMessage);
}

function buildBuybackPriceOutcome() {
  const customerMessage =
    `Točnu otkupnu cijenu najbrže dobijete na stranici ${BASE_URL}/otkup-udzbenika/: skenirajte barkod mobitelom ili ga ručno upišite i sustav će prikazati cijenu bez obveze. Cijena ovisi o naslovu, razredu, stanju knjige i potražnji; knjiga mora biti upotrebljiva.`;

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "buyback_price_guidance",
    source: "website_links",
    taskIntent: "buyback",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function looksLikePurchaseSearchGuidanceMessage(userMessage = "", session = {}) {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  if (
    !normalizedMessage ||
    isResolutionCandidateMessage(userMessage) ||
    isGreetingOnlyMessage(userMessage) ||
    looksLikeOrderStatusOrExistingBuyerIssue(userMessage) ||
    looksLikeBuybackParcelQuestion(userMessage, session)
  ) {
    return false;
  }

  return (
    looksLikeProductLookupMessage(userMessage, session) ||
    /(kako mogu naruciti|kako mogu naru[cć]iti|zelim naruciti|želim naru[cć]iti|treba\w*\s+mi\s+udzben|treba\w*\s+mi\s+udžben|trebaju\s+mi\s+udzben|trebaju\s+mi\s+udžben|kupnja udzbenika|kupnja udžbenika|kupi udzbenike|kupi udžbenike|skolski popis|školski popis|popis udzbenika|popis udžbenika|\b1\s+razred\b|prvi\s+razred|gimnazij)/.test(
      normalizedMessage
    )
  );
}

function buildPurchaseSearchGuidanceOutcome(relevanceContext = {}) {
  const queryFeatures = relevanceContext.queryFeatures || {};
  let searchInstruction =
    "U tražilicu upišite šifru udžbenika sa školskog popisa, naslov, autora ili nakladnika.";

  if (queryFeatures.hasIsbn) {
    searchInstruction =
      "Ako imate ISBN, upišite ga bez razmaka ili crtica; to je najprecizniji način pretrage.";
  } else if (queryFeatures.hasSchoolContext) {
    searchInstruction =
      "Za školski popis najbrže je pretražiti šifru udžbenika, a zatim naslov ili nakladnika ako šifra nije dostupna.";
  } else if (queryFeatures.hasAuthorCitation || queryFeatures.hasEditionSignal) {
    searchInstruction =
      "Kod dužih naslova prvo pretražite najprepoznatljiviji dio naslova, zatim autora ili izdanje ako rezultat nije jasan.";
  }

  const customerMessage =
    `Udžbenike i knjige je najbolje pretražiti direktno na webshopu: ${BASE_URL}/kupi-udzbenike/.\n` +
    `${searchInstruction} Ako imate šifru udžbenika sa školskog popisa, pretražite nju prvu. Ako zapnete s narudžbom, nemate popis ili niste sigurni koji je rezultat pravi, napišite to ovdje pa će se podrška uključiti.`;

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "purchase_search_guidance",
    source: "website_links",
    taskIntent: "product_lookup",
    customerMessage,
    zendeskMessage: customerMessage,
    products: []
  };
}

function buildBuybackParcelGuidanceOutcome(userMessage = "") {
  const normalizedMessage = normalizeForComparison(userMessage).trim();
  const asksAboutSelfDropoff =
    /(sam|sama|sami|odnijeti|odnes|ubaciti).{0,80}(gls|boxnow|box now|paketomat|paket)|\b(gls|boxnow|box now|paketomat)\b/.test(
      normalizedMessage
    );
  const customerMessage = asksAboutSelfDropoff
    ? "Kod online otkupa paket ne nosite samostalno u GLS ili BOXNOW paketomat. Paket predajete dostavljaču prema dogovorenom prikupu; dostavljač donosi naljepnicu, a vi ništa ne pišete na paket."
    : "Kod online otkupa paket zapakirajte čvrsto i predajte dostavljaču prema dogovorenom prikupu. Dostavljač donosi naljepnicu, a vi ništa ne pišete na paket.";

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "buyback_package_guidance",
    source: "conversation_fallback",
    taskIntent: "buyback",
    customerMessage,
    zendeskMessage: customerMessage
  };
}

function buildPolicyOutcome(userMessage = "", { session = {}, channelType = "web_chat" } = {}) {
  const relevanceContext = buildRelevanceTurnContext(
    session,
    userMessage,
    buildKnowledgeSearchOptions(session, userMessage)
  );

  return (
    (looksLikeBuybackAcceptedBooksQuestion(userMessage) ? buildBuybackAcceptedBooksOutcome() : null) ||
    (looksLikeBuybackBonusQuestion(userMessage) ? buildBuybackBonusOutcome() : null) ||
    (looksLikeBuybackPriceQuestion(userMessage) ? buildBuybackPriceOutcome() : null) ||
    buildCriticalComplaintOutcome(userMessage) ||
    (looksLikeOrderMergeRequest(userMessage) ? buildOrderMergeGuidanceOutcome() : null) ||
    (looksLikeBuybackDeliveryExchangeQuestion(userMessage) ? buildBuybackDeliveryExchangeGuidanceOutcome() : null) ||
    buildOrderIssueClarificationOutcome(userMessage, { channelType }) ||
    (looksLikeOnlineBuybackOpening(userMessage) ? buildOnlineBuybackGuidanceOutcome() : null) ||
    (looksLikePositiveFeedbackMessage(userMessage) ? buildPositiveFeedbackOutcome() : null) ||
    (looksLikePurchaseSearchGuidanceMessage(userMessage, session) ? buildPurchaseSearchGuidanceOutcome(relevanceContext) : null)
  );
}

function buildNoContextAutonomousOutcome(userMessage, { session = {}, channelType = "web_chat" } = {}) {
  const normalizedMessage = normalizeForComparison(userMessage).trim();

  if (isResolutionCandidateMessage(userMessage)) {
    return {
      type: "safe_answer",
      stateTag: "resolved",
      reason: "resolution_acknowledgement",
      source: "conversation_fallback",
      customerMessage: "Hvala vam! Ako vam zatreba još nešto, slobodno se javite."
    };
  }

  if (isGreetingOnlyMessage(userMessage)) {
    return {
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "greeting_fallback",
      source: "conversation_fallback",
      customerMessage:
        channelType === "email"
          ? "Pozdrav! Pošaljite naslov knjige, ISBN ili pitanje oko dostave, otkupa i narudžbe pa ću pokušati pomoći."
          : "Pozdrav! Pošaljite naslov knjige, ISBN ili pitanje oko dostave, otkupa i narudžbe pa ću pokušati pomoći."
    };
  }

  if (/^(postovani|poštovani)[,!.\s]*$/i.test(String(userMessage || "").trim())) {
    return {
      type: "ask_clarifying_question",
      stateTag: "ai_active",
      reason: "formal_greeting_clarification",
      source: "conversation_fallback",
      customerMessage:
        "Pozdrav! Napišite naslov knjige, ISBN ili pitanje oko dostave, otkupa i narudžbe pa ću pokušati pomoći."
    };
  }

  if (/^(takoder|također|takodjer)[.!?\s]*$/i.test(String(userMessage || "").trim())) {
    return {
      type: "ask_clarifying_question",
      stateTag: "ai_active",
      reason: "continuation_clarification",
      source: "conversation_fallback",
      customerMessage:
        "Slobodno napišite još malo detalja, na primjer puni naslov knjige, ISBN ili što točno trebate provjeriti."
    };
  }

  if (/(^a\s+za\s+osnovn\w*\s+skol|^a\s+za\s+osnovn\w*\s+škol)/.test(normalizedMessage)) {
    return {
      type: "ask_clarifying_question",
      stateTag: "ai_active",
      reason: "primary_school_context_clarification",
      source: "conversation_fallback",
      taskIntent: "product_lookup",
      customerMessage:
        "Mislite li na kupnju ili otkup knjiga za osnovnu školu? Za kupnju naslov možete potražiti na webshopu, a za otkup nam napišite da pitate za otkup pa ćemo odgovoriti prema pravilima otkupa."
    };
  }

  if (/(sve sam to napravila|jos prosli tjedan|još prošli tjedan|nitko se nije javio|ne nalazim|ne snalazim|gdje je taj odjeljak)/.test(normalizedMessage)) {
    return {
      type: "ask_clarifying_question",
      stateTag: "awaiting_customer_detail",
      reason: "continuation_clarification",
      source: "conversation_fallback",
      taskIntent: "",
      customerMessage:
        "Napišite molim vas na koji postupak mislite i što ste već pokušali, na primjer kupnju, otkup, košaricu, dostavu ili postojeću narudžbu. Tada vas mogu usmjeriti na točan sljedeći korak."
    };
  }

  if (looksLikeFeasibilityFollowupMessage(userMessage)) {
    return {
      type: "ask_clarifying_question",
      stateTag: "ai_active",
      reason: "followup_without_context",
      source: "conversation_fallback",
      customerMessage:
        "Može. Napišite samo na što točno mislite: narudžba, dostava, otkup ili kupnja knjiga."
    };
  }

  if (looksLikeContactDetailsOnlyMessage(userMessage)) {
    const activeDomain = getSessionActiveDomain(session);

    if (activeDomain === "order") {
      return {
        type: "ask_clarifying_question",
        stateTag: "awaiting_customer_detail",
        reason: "order_issue_clarification",
        source: "conversation_fallback",
        taskIntent: "order",
        customerMessage:
          channelType === "email"
            ? "Hvala na podacima. Ako imate broj narudžbe, pošaljite ga; ako ga nemate, napišite što točno trebamo provjeriti na narudžbi."
            : "Hvala na podacima. Ako imate broj narudžbe, pošaljite ga; ako ga nemate, napišite što točno trebamo provjeriti na narudžbi."
      };
    }

    return {
      type: "ask_clarifying_question",
      stateTag: "ai_active",
      reason: "contact_details_without_intent",
      source: "conversation_fallback",
      customerMessage:
        "Hvala na podacima. Napišite još što točno trebate: status narudžbe, reklamaciju, dostavu, otkup ili pomoć oko kupnje."
    };
  }

  if (
    /(narudzb|otkazat|otkaziv|nisam .*dobi|niste odgovorili|reklamacij|povrat)/.test(normalizedMessage)
  ) {
    return {
      type: "ask_clarifying_question",
      stateTag: "awaiting_customer_detail",
      reason: "order_issue_clarification",
      source: "conversation_fallback",
      customerMessage:
        channelType === "email"
          ? "Možemo provjeriti narudžbu. Pošaljite broj narudžbe; ako ga nemate, napišite ime i prezime te email ili telefon koji su uneseni pri naručivanju."
          : "Možemo provjeriti narudžbu ovdje u chatu. Pošaljite broj narudžbe; ako ga nemate, napišite ime i prezime te email ili telefon koji su uneseni pri naručivanju."
    };
  }

  if (looksLikeBuybackParcelQuestion(userMessage, session)) {
    return buildBuybackParcelGuidanceOutcome(userMessage);
  }

  if (
    /(gdje se nalaz|adresa|lokacija|radno vrijeme|kontakt|telefon|email|mail|placanje|placanjem|nacini placanja|pouzecem|pouzece)/.test(
      normalizedMessage
    )
  ) {
    return {
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "support_info_link_fallback",
      source: "website_links",
      taskIntent: "support_info",
      customerMessage:
        "Najbrže ćete provjeriti te informacije na našem webu. Ako želite, mogu zatim pomoći protumačiti što je relevantno za vaš slučaj."
    };
  }

  if (
    /(troskovi dostave|cijena dostave|postarina|poštarina|dostava|dostavn\w*|isporuka|paketomat|gls|boxnow|box now|pouzecem|pouzece)/.test(
      normalizedMessage
    )
  ) {
    return {
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "delivery_link_fallback",
      source: "website_links",
      taskIntent: "delivery",
      customerMessage:
        "Najbrže ćete provjeriti troškove i opcije dostave na ovoj stranici. Ako želite, mogu zatim pomoći protumačiti što vam odgovara."
    };
  }

  if (
    /^(prodaja|otkup|otkupljujete li knjige|da li otkupljujete knjige|koje knjige otkupljujete|koje su cujene otkupa|koje su cijene otkupa|otkupljujete li udzbenike cijelu godinu|pa kada ih mogu otkupiti|otkupljujete li knjige koje nisu udzbenici|kako mogu prodati|zelim prodati|želim prodati|mogu li prodati|mogu li se prodat|jel otkupljujemo knjige|zelim pomoc oko otkupa|želim pomoć oko otkupa|sta se mora napraviti za prodaju|što se mora napraviti za prodaju)/.test(
      normalizedMessage
    ) ||
    /(prodati (udzbenike|knjige)|prodaja knjiga|prodaja udzbenika|otkup knjiga|otkup udzbenika|pomoc oko otkupa|pomo[cć] oko otkupa|prodaju udzbenika|prodaju knjiga|zelim prodati knjigu|zelim prodati knjige|želim prodati knjigu|želim prodati knjige|zelim .*prodati|želim .*prodati|zaraditi vise na svojim udzbenicima|prodati .*u kosaricu|prodati .*kosaricu)/.test(
      normalizedMessage
    )
  ) {
    return {
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "online_buyback_guidance",
      source: "website_links",
      taskIntent: "buyback",
      customerMessage:
        [
          `Za online otkup krenite ovdje: ${BASE_URL}/otkup-udzbenika/.`,
          "1. Otvorite online otkupni nalog na webu.",
          "2. Mobitelom skenirajte barkod svake knjige; ako skeniranje ne uspije, upišite barkod broj bez crtica ili učitajte sliku barkoda.",
          "3. Nakon što sustav prikaže vrijednost i nastavite s nalogom, zapakirajte knjige.",
          "4. Predajte paket dostavljaču prema dogovorenom prikupu."
        ].join("\n")
    };
  }

  const shortAmbiguousTokens = normalizedMessage.split(/\s+/).filter(Boolean);
  if (
    shortAmbiguousTokens.length > 0 &&
    shortAmbiguousTokens.length <= 3 &&
    !/(hvala|pozdrav|bok|dobar dan|problem|narudzb|dostava|otkup|kontakt)/.test(normalizedMessage)
  ) {
    return {
      type: "ask_clarifying_question",
      stateTag: "ai_active",
      reason: "short_query_clarification",
      source: "conversation_fallback",
      customerMessage:
        "Pošaljite puni naslov knjige, autora ili ISBN pa ću pokušati preciznije pomoći."
    };
  }

  if (looksLikeProductLookupMessage(userMessage, session)) {
    return buildPurchaseSearchGuidanceOutcome(
      buildRelevanceTurnContext(session, userMessage, buildKnowledgeSearchOptions(session, userMessage))
    );
  }

  return null;
}

function updateSessionRouteMemory(session, userMessage, outcome = {}) {
  if (!session || typeof session !== "object") {
    return;
  }

  session.lastStandaloneQuery = normalizeWhitespace(userMessage || "");
  session.lastKnowledgeSource = String(outcome.source || "").trim();
  session.lastResolvedIntent = String(outcome.taskIntent || outcome.reason || "").trim();
  session.workingMemory = session.workingMemory && typeof session.workingMemory === "object"
    ? session.workingMemory
    : {};

  if (
    outcome.source === "product_feed" ||
    outcome.taskIntent === "product_lookup" ||
    outcome.reason === "product_lookup_fallback" ||
    outcome.reason === "purchase_search_guidance"
  ) {
    session.workingMemory.activeDomain = "product_lookup";
    session.workingMemory.activeTaskIntent = "product_lookup";
    session.lastProductTitles = Array.isArray(outcome.products)
      ? outcome.products.map((product) => product?.title).filter(Boolean).slice(0, 5)
      : session.lastProductTitles || [];
    return;
  }

  if (
    outcome.taskIntent === "buyback" ||
    outcome.reason === "buyback_clarification" ||
    outcome.reason === "online_buyback_guidance" ||
    outcome.reason === "buyback_package_guidance" ||
    outcome.reason === "buyback_delivery_exchange_guidance"
  ) {
    session.workingMemory.activeDomain = "buyback";
    session.workingMemory.activeTaskIntent = "buyback";
    return;
  }

  if (
    outcome.reason === "order_issue_clarification" ||
    outcome.reason === "order_merge_guidance"
  ) {
    session.workingMemory.activeDomain = "order";
    session.workingMemory.activeTaskIntent = "order";
    return;
  }

  if (
    outcome.reason === "complaint_handoff" ||
    outcome.reason === "wrong_books_handoff" ||
    outcome.reason === "buyback_payout_handoff" ||
    outcome.reason === "aggressive_complaint_handoff"
  ) {
    session.workingMemory.activeDomain = "order";
    session.workingMemory.activeTaskIntent = outcome.taskIntent || "complaint";
    return;
  }

  if (outcome.reason === "delivery_link_fallback") {
    session.workingMemory.activeDomain = "delivery";
    session.workingMemory.activeTaskIntent = "delivery";
    return;
  }

  if (outcome.source === "onedrive_knowledge" || outcome.source === "zendesk_knowledge") {
    session.workingMemory.activeDomain = outcome.taskIntent || session.workingMemory.activeDomain || "";
    session.workingMemory.activeTaskIntent = outcome.taskIntent || session.workingMemory.activeTaskIntent || "";
  }
}

async function resolveAutomatedOutcome(session, userMessage, { hasAttachments = false, channelType = "web_chat" } = {}) {
  hydrateSessionRoutingContext(session);
  const channelMessages = getChannelMessages(channelType);
  const knowledgeSearchOptions = buildKnowledgeSearchOptions(session, userMessage);
  const relevanceContext = buildRelevanceTurnContext(session, userMessage, knowledgeSearchOptions);

  function finishOutcome(outcome, knowledgeValue = null) {
    const decoratedOutcome = decorateOutcomeWithRelevance(outcome, relevanceContext, { channelType });
    updateSessionRouteMemory(session, userMessage, decoratedOutcome);
    recordRelevanceMetrics(decoratedOutcome, relevanceContext);
    return { outcome: decoratedOutcome, knowledge: knowledgeValue, relevanceContext };
  }

  if (hasAttachments) {
    const outcome = decorateOutcomeWithRelevance({
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "attachments_present",
      source: "policy_guard",
      taskIntent: relevanceContext.taskIntent || "",
      customerMessage: channelMessages.attachmentHandoff,
      zendeskMessage: channelMessages.attachmentHandoff
    }, relevanceContext, { channelType });
    recordRelevanceMetrics(outcome, relevanceContext);

    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "attachments_present",
      outcome,
      knowledge: null,
      relevanceContext
    };
  }

  const policyOutcome = buildPolicyOutcome(userMessage, { session, channelType });

  if (policyOutcome) {
    return finishOutcome(policyOutcome, null);
  }

  let knowledge = null;
  try {
    knowledge = await knowledgeService.searchKnowledgeDetailed(userMessage, knowledgeSearchOptions);
  } catch (err) {
    logError("Knowledge search failed:", { message: err.message });
  }

  if (
    looksLikeBuybackConfirmationQuestion(userMessage) &&
    !hasExplicitBuybackConfirmationKnowledge(knowledge)
  ) {
    const outcome = buildBuybackConfirmationHandoffOutcome(channelType);
    return finishOutcome(outcome, knowledge);
  }

  let customerMessage = null;
  if (knowledge && knowledge.context) {
    customerMessage = await aiService.generateGroundedAnswer(userMessage, knowledge.context, {
      channelType,
      customerName: session.requesterName || ""
    });
  }

  if (customerMessage) {
    const outcome = finalizeOutcomeForCustomer({
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "grounded_answer",
      source: knowledge?.primarySource === "zendesk" ? "zendesk_knowledge" : "onedrive_knowledge",
      taskIntent: knowledgeSearchOptions.taskIntent || knowledgeSearchOptions.activeDomain || "",
      customerMessage
    }, {
      channelType,
      knowledge
    });

    if (outcome?.type === "safe_answer") {
      return finishOutcome(outcome, knowledge);
    }
  }

  const fallbackAnswer = buildKnowledgeFallbackAnswer(knowledge);

  if (fallbackAnswer) {
    const outcome = finalizeOutcomeForCustomer({
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "knowledge_fallback",
      source: knowledge?.primarySource === "zendesk" ? "zendesk_knowledge" : "onedrive_knowledge",
      taskIntent: knowledgeSearchOptions.taskIntent || knowledgeSearchOptions.activeDomain || "",
      customerMessage: fallbackAnswer
    }, {
      channelType,
      knowledge
    });

    if (outcome?.type === "safe_answer") {
      return finishOutcome(outcome, knowledge);
    }
  }

  const noContextAutonomousOutcome = buildNoContextAutonomousOutcome(userMessage, { session, channelType });

  if (noContextAutonomousOutcome) {
    const outcome = appendDirectWebsiteLink(noContextAutonomousOutcome, {
      conversation: {
        standaloneQuery: userMessage
      },
      knowledge,
      channelType
    });
    return finishOutcome(outcome, knowledge);
  }

  const outcome = {
    type: "hard_handoff",
    stateTag: "awaiting_human",
    reason: "no_answer_found",
    source: "policy_guard",
    taskIntent: relevanceContext.taskIntent || "",
    customerMessage: channelMessages.hardHandoff
  };
  return finishOutcome(outcome, knowledge);
}

function attachOutcomeDetailsToLatestAssistantMessage(session, outcome = {}) {
  if (!session || !Array.isArray(session.messages) || !outcome?.customerMessage) {
    return;
  }

  const latestAssistantMessage = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.authoredByHuman);

  if (!latestAssistantMessage || latestAssistantMessage.content !== outcome.customerMessage) {
    return;
  }

  latestAssistantMessage.supportTaskIntent = outcome.taskIntent || latestAssistantMessage.supportTaskIntent || "";
  latestAssistantMessage.products = Array.isArray(outcome.products)
    ? outcome.products
    : latestAssistantMessage.products || [];
  latestAssistantMessage.suggestedReplies = normalizeSuggestedReplies(outcome.suggestedReplies);
}

function buildBotReplyMetadata(outcome = {}) {
  return {
    ...(Array.isArray(outcome.products) && outcome.products.length > 0
      ? {
          libar_products: JSON.stringify(outcome.products)
        }
      : {}),
    ...(normalizeSuggestedReplies(outcome.suggestedReplies).length > 0
      ? {
          libar_suggested_replies: JSON.stringify(normalizeSuggestedReplies(outcome.suggestedReplies))
        }
      : {}),
    libar_task_intent: outcome.taskIntent || "",
    libar_relevance_reason: outcome.relevance?.fallbackReason || outcome.reason || "",
    libar_topic_shift: outcome.relevance?.topicShift || ""
  };
}

async function persistEscalation(ticketId, escalationType, { channelType = "web_chat" } = {}) {
  const channelLabel = formatChannelLabel(channelType);
  const noteText =
    escalationType === "[ESKALACIJA_HITNO]"
      ? `AI eskalacija (${channelLabel}): hitan ili osjetljiv korisnički upit. Potrebna ljudska provjera.`
      : `AI eskalacija (${channelLabel}): odgovor nije pronađen u bazi znanja. Potrebna ljudska provjera.`;

  await zendeskService.addTagAndNote(ticketId, "ai_eskalacija", noteText);
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function registerChatStream(sessionId, res) {
  const streams = chatStreams.get(sessionId) || new Set();
  streams.add(res);
  chatStreams.set(sessionId, streams);
}

function unregisterChatStream(sessionId, res) {
  const streams = chatStreams.get(sessionId);

  if (!streams) {
    return;
  }

  streams.delete(res);

  if (streams.size === 0) {
    chatStreams.delete(sessionId);
  }
}

function broadcastSessionUpdate(session) {
  const streams = chatStreams.get(session.sessionId);

  if (!streams || streams.size === 0) {
    return;
  }

  for (const stream of streams) {
    writeSseEvent(stream, "session_update", {
      session
    });
  }
}

function getUploadedFiles(req) {
  return Array.isArray(req.files) ? req.files : [];
}

function normalizeMessage(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEntryIntent(value) {
  const normalized = normalizeMessage(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENTRY_INTENT_LABELS, normalized) ? normalized : "";
}

function normalizeEntryPromptAnswer(value) {
  return normalizeMessage(value).slice(0, 240);
}

function normalizeEntryFlowVersion(value) {
  return normalizeMessage(value) === ENTRY_FLOW_VERSION ? ENTRY_FLOW_VERSION : "";
}

function buildEntryContextMessage({ message, entryIntent, entryPromptAnswer }) {
  const normalizedMessage = normalizeMessage(message);

  if (!normalizedMessage) {
    return "";
  }

  const parts = [normalizedMessage];

  if (entryIntent && ENTRY_INTENT_LABELS[entryIntent]) {
    parts.push(`Kategorija upita: ${ENTRY_INTENT_LABELS[entryIntent]}`);
  }

  if (entryPromptAnswer) {
    parts.push(`Dodatne informacije: ${entryPromptAnswer}`);
  }

  return parts.join("\n");
}

function buildEntryFlowTags({ entryIntent, entryFlowVersion }) {
  if (entryFlowVersion !== ENTRY_FLOW_VERSION) {
    return [];
  }

  if (entryIntent) {
    return [`entry_${entryIntent}`];
  }

  return ["entry_skipped"];
}

function buildEntryFlowNote({ entryIntent, entryPromptAnswer, entryFlowVersion }) {
  if (entryFlowVersion !== ENTRY_FLOW_VERSION) {
    return "";
  }

  return [
    "Entry flow: web widget v1",
    entryIntent
      ? `Odabrana tema: ${ENTRY_INTENT_LABELS[entryIntent] || entryIntent}`
      : "Odabrana tema: korisnik je preskočio quick pick",
    entryPromptAnswer ? `Dodatni odgovor: ${entryPromptAnswer}` : "Dodatni odgovor: nema"
  ].join("\n");
}

async function buildExistingSessionStartResponse(session, res, { duplicateStartPrevented = false } = {}) {
  const syncResult = await syncSessionMessagesWithFallback(session, "chat_start_duplicate_sync");
  if (duplicateStartPrevented) {
    metricsService.increment("duplicate_chat_start_prevented_total");
  }

  return res.status(200).json({
    success: true,
    restored: true,
    duplicateStartPrevented,
    degraded: syncResult.degraded,
    sessionId: session.sessionId,
    session: {
      sessionId: session.sessionId,
      ticketId: session.ticketId,
      requesterId: session.requesterId,
      requesterName: session.requesterName,
      requesterEmail: session.requesterEmail,
      entryIntent: session.entryIntent,
      entryPromptAnswer: session.entryPromptAnswer,
      entryFlowVersion: session.entryFlowVersion,
      entryFlowSkipped: session.entryFlowSkipped,
      entryTopicLock: session.entryTopicLock,
      conversationState: session.conversationState,
      resolutionPrompt: session.resolutionPrompt || null
    },
    ticketId: session.ticketId,
    messages: getSession(session.sessionId)?.messages || session.messages || [],
    conversationState: session.conversationState,
    resolutionPrompt: session.resolutionPrompt || null
  });
}

/**
 * Central webhook entry point for Zendesk.
 *
 * Accepted payloads include the legacy flat contract plus nested Zendesk
 * trigger/event shapes where ticket/comment data may sit under `ticket`,
 * `comment`, or `ticket_event`.
 */
async function processZendeskWebhookPayload(payload = {}) {
  const {
    ticketId,
    message,
    channelType: payloadChannelType,
    hasAttachments,
    auditId
  } = extractZendeskWebhookEnvelope(payload);
  let registeredMessageDeduplicationKey = "";

  // Fix #16: Webhook idempotency — skip duplicate audit processing.
  if (auditId) {
    const idempotencyKey = `${ticketId}:${auditId}`;
    if (processedWebhookAudits.has(idempotencyKey)) {
      metricsService.increment("webhook_duplicate_ignored_total");
      return {
        status: 200,
        body: {
          success: true,
          action: "ignored",
          reason: "duplicate_webhook"
        }
      };
    }
    processedWebhookAudits.set(idempotencyKey, Date.now());
    scheduleRuntimePersist();
  }

  // Validate the minimum contract early so upstream systems receive a clear error.
  if (!ticketId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Invalid payload. 'ticket_id' is required."
      }
    };
  }

  try {
    const [ticketSummary, audits] = await Promise.all([
      zendeskService.getTicketSummary(ticketId),
      zendeskService.getTicketAudits(ticketId)
    ]);
    const messages = mapZendeskAuditsToMessages(audits, ticketSummary.requesterId, ticketSummary);
    const detectedChannelType = detectTicketChannelType(ticketSummary, messages);
    const channelType =
      detectedChannelType !== "unknown"
        ? detectedChannelType
        : normalizeChannelType(payloadChannelType);
    const blockReason = getAutomationBlockReason(ticketSummary, messages, channelType);

    if (blockReason) {
      return {
        status: 200,
        body: {
          success: true,
          action: "ignored",
          reason: blockReason,
          channelType
        }
      };
    }

    const latestUserMessage = getLatestUserMessage(messages);
    const latestMessage = getLatestPublicMessage(messages);
    const normalizedMessage = normalizeMessage(latestUserMessage?.content) || normalizeMessage(message);
    const latestMessageHasAttachments =
      Array.isArray(latestUserMessage?.attachments) && latestUserMessage.attachments.length > 0;

    if (!normalizedMessage && !latestMessageHasAttachments && !hasAttachments) {
      return {
        status: 200,
        body: {
          success: true,
          action: "ignored",
          reason: "empty_customer_message",
          channelType
        }
      };
    }

    const effectiveHasAttachments = hasAttachments || latestMessageHasAttachments;

    const spamFilterResult = await spamFilterService.evaluateIncomingMessage({
      channelType,
      message: normalizedMessage,
      ticketSummary
    });

    if (spamFilterResult.shouldBlock) {
      await zendeskService.addInternalNote(
        ticketId,
        spamFilterService.buildSpamFilterNote(spamFilterResult, channelType),
        ["suspected_spam"]
      );

      return {
        status: 200,
        body: {
          success: true,
          action: "ignored_spam",
          channelType,
          reason: spamFilterResult.reason
        }
      };
    }

    if (effectiveHasAttachments) {
      await zendeskService.addTagAndNote(
        ticketId,
        "hitno_slike",
        `Korisnik je poslao privitak preko ${formatChannelLabel(channelType)} kanala. Potrebna ljudska provjera.`
      );
      await zendeskService.updateConversationState(ticketId, "awaiting_human");
      await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome: {
          type: "hard_handoff",
          reason: "attachments_present"
        },
        userMessage: normalizedMessage || "[privitak bez teksta]",
        knowledge: null,
        channelType
      }));

      return {
        status: 200,
        body: {
          success: true,
          action: "attachment_escalation",
          channelType
        }
      };
    }

    if (!latestMessage || latestMessage.role !== "user") {
      return {
        status: 200,
        body: {
          success: true,
          action: "ignored",
          reason: "latest_message_not_user",
          channelType
        }
      };
    }

    const latestUserMessageDeduplicationKey = buildWebhookMessageDeduplicationKey({
      ticketId,
      latestUserMessage,
      fallbackMessage: normalizedMessage
    });

    if (
      latestUserMessageDeduplicationKey &&
      processedWebhookMessages.has(latestUserMessageDeduplicationKey)
    ) {
      metricsService.increment("webhook_duplicate_ignored_total");
      return {
        status: 200,
        body: {
          success: true,
          action: "ignored",
          reason: "duplicate_customer_message",
          channelType
        }
      };
    }

    if (latestUserMessageDeduplicationKey) {
      processedWebhookMessages.set(latestUserMessageDeduplicationKey, Date.now());
      registeredMessageDeduplicationKey = latestUserMessageDeduplicationKey;
      scheduleRuntimePersist();
    }

    const temporarySession = {
      ticketId,
      requesterId: ticketSummary.requesterId,
      requesterName: ticketSummary.requesterName || "",
      requesterEmail: ticketSummary.requesterEmail || "",
      messages,
      lastKnowledgeSource: ""
    };
    const { knowledge, outcome } = await resolveAutomatedOutcome(
      temporarySession,
      normalizedMessage,
      {
        hasAttachments: false,
        channelType
      }
    );

    if (outcome.type === "ask_clarifying_question") {
      await zendeskService.updateConversationState(ticketId, outcome.stateTag, outcome.extraTags || []);
      await zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
        channelType,
        metadata: buildBotReplyMetadata(outcome)
      });
            await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome,
        userMessage: normalizedMessage,
        knowledge,
        channelType,
      }));

      return {
        status: 200,
        body: {
          success: true,
          action: "customer_detail_requested",
          channelType
        }
      };
    }

    if (outcome.type !== "safe_answer") {
      await persistEscalation(
        ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType }
      );
      // Fix #8: Send customer-facing message for handoff outcomes.
      await Promise.all([
        zendeskService.updateConversationState(ticketId, outcome.stateTag, outcome.extraTags || []),
        outcome.customerMessage
          ? zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
              channelType,
              metadata: buildBotReplyMetadata(outcome)
            })
          : Promise.resolve(),
        zendeskService.addInternalNote(ticketId, buildAutopilotNote({
          outcome,
          userMessage: normalizedMessage,
          knowledge,
          channelType,
        }))
      ]);

      return {
        status: 200,
        body: {
          success: true,
          action: "ai_escalation",
          escalationType:
            outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
          channelType
        }
      };
    }

    // Fix #13: Parallelize independent Zendesk write calls.
    const safeAnswerTasks = [
      zendeskService.updateConversationState(ticketId, outcome.stateTag, outcome.extraTags || []),
      zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
        channelType,
        additionalTags: outcome.source === "product_feed" ? ["product_feed_match"] : [],
        metadata: buildBotReplyMetadata(outcome)
      }),
      zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome,
        userMessage: normalizedMessage,
        knowledge,
        channelType,
      }))
    ];
    if (outcome.source === "product_feed" && outcome.zendeskSummary) {
      safeAnswerTasks.push(
        zendeskService.addInternalNote(
          ticketId,
          `Product feed sažetak:\n${outcome.zendeskSummary}`
        )
      );
    }
    await Promise.all(safeAnswerTasks);

    return {
      status: 200,
      body: {
        success: true,
        action: "customer_reply_sent",
        channelType
      }
    };
  } catch (error) {
    // Keep the response clean for webhook consumers while logging the full detail locally.
    logError("Webhook processing failed:", {
      message: error.message,
      stack: error.stack,
      ticketId
    });

    if (registeredMessageDeduplicationKey) {
      processedWebhookMessages.delete(registeredMessageDeduplicationKey);
      scheduleRuntimePersist();
    }

    return {
      status: 500,
      body: {
        success: false,
        error: "Internal server error while processing Zendesk webhook."
      }
    };
  }
}

app.post("/webhook/zendesk", async (req, res) => {
  const result = await processZendeskWebhookPayload(req.body || {});
  return res.status(result.status).json(result.body);
});

/**
 * Start a webshop chat conversation:
 * - create the backing Zendesk ticket
 * - store the local session mapping
 * - generate the first AI response
 * - mirror both sides into Zendesk
 */
app.post("/api/chat/start", rateLimiter, chatUpload.array("attachments", 5), async (req, res) => {
  const { name, email } = req.body || {};
  const requesterNameInput = normalizeWhitespace(name || "");
  const requesterEmailInput = normalizeWhitespace(email || "");
  const message = normalizeMessage(req.body?.message);
  const entryIntent = normalizeEntryIntent(req.body?.entryIntent);
  const entryPromptAnswer = normalizeEntryPromptAnswer(req.body?.entryPromptAnswer);
  const entryFlowVersion = normalizeEntryFlowVersion(req.body?.entryFlowVersion);
  const files = getUploadedFiles(req);

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required."
    });
  }

  if (requesterEmailInput && !isValidEmailAddress(requesterEmailInput)) {
    return res.status(400).json({
      success: false,
      error: "A valid email address is required when email is provided."
    });
  }

  try {
    const reusableSession = findReusableChatStart({
      name: requesterNameInput,
      email: requesterEmailInput,
      message
    });

    if (reusableSession) {
      return buildExistingSessionStartResponse(reusableSession, res, {
        duplicateStartPrevented: true
      });
    }

    const initialSessionKey = randomUUID();
    const requesterName = requesterNameInput || "Web kupac";
    const requesterEmail = requesterEmailInput || `chat-${initialSessionKey}@antikvarijat-libar-chat.local`;
    const entryContextMessage = buildEntryContextMessage({
      message,
      entryIntent,
      entryPromptAnswer
    });
    const entryFlowTags = buildEntryFlowTags({
      entryIntent,
      entryFlowVersion
    });
    const entryFlowNote = buildEntryFlowNote({
      entryIntent,
      entryPromptAnswer,
      entryFlowVersion
    });
    let uploadedAttachments = [];
    try {
      uploadedAttachments = await zendeskService.uploadAttachments(files);
    } catch (error) {
      logError("Attachment upload failed while starting chat session:", {
        message: error.message,
        stack: error.stack
      });

      return res.status(503).json({
        success: false,
        error: "Privitke trenutno ne možemo obraditi. Pokušajte ponovno bez privitka ili malo kasnije."
      });
    }
    const uploadTokens = uploadedAttachments.map((item) => item.token).filter(Boolean);
    const { ticketId, requesterId } = await zendeskService.createChatTicket({
      requesterName,
      requesterEmail,
      initialMessage: message,
      subject: buildChatSubject(requesterName),
      uploadTokens,
      externalId: initialSessionKey,
      additionalTags: entryFlowTags
    });

    if (entryFlowNote) {
      await zendeskService.addInternalNote(ticketId, entryFlowNote);
    }

    const session = createSession({
      ticketId,
      requesterId,
      requesterName,
      requesterEmail,
      messages: [],
      entryIntent: entryIntent || null,
      entryPromptAnswer: entryPromptAnswer || "",
      entryFlowVersion: entryFlowVersion || null,
      entryFlowSkipped: entryFlowVersion === ENTRY_FLOW_VERSION && !entryIntent,
      externalId: initialSessionKey
    });
    session.workingMemory = {
      customerProfile: {
        name: requesterName,
        firstName: requesterName,
        email: requesterEmail,
        source: "zendesk_requester"
      }
    };

    const { knowledge, outcome } = await resolveAutomatedOutcome(
      session,
      entryContextMessage,
      {
        hasAttachments: files.length > 0,
        channelType: "web_chat"
      }
    );

    if (files.length > 0) {
      await zendeskService.addTagAndNote(
        ticketId,
        "hitno_slike",
        "Korisnik je poslao privitke kroz webshop chat. Potrebna ljudska provjera."
      );
    }

    if (outcome.type !== "safe_answer" && outcome.type !== "ask_clarifying_question") {
      await persistEscalation(
        ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType: "web_chat" }
      );
    }

    let zendeskWriteDegraded = false;
    try {
      await zendeskService.updateConversationState(ticketId, outcome.stateTag, outcome.extraTags || []);
      await zendeskService.addBotReplyToTicket(ticketId, outcome.zendeskMessage || outcome.customerMessage, {
        channelType: "web_chat",
        metadata: buildBotReplyMetadata(outcome)
      });
      await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome,
        userMessage: message,
        knowledge,
        channelType: "web_chat",
      }));
      if (outcome.source === "product_feed" && outcome.zendeskSummary) {
        await zendeskService.addInternalNote(
          ticketId,
          `Product feed sažetak:\n${outcome.zendeskSummary}`
        );
      }
    } catch (error) {
      if (!isZendeskRateLimitError(error)) {
        throw error;
      }

      zendeskWriteDegraded = true;
      logWarn("zendesk_write_rate_limited", {
        sessionId: session.sessionId,
        ticketId,
        status: error.status || error.response?.status || 429,
        reason: outcome.reason
      });
      appendLocalAssistantOutcome(session, outcome);
    }
    const startSync = await syncSessionMessagesWithFallback(session, "chat_start_final_sync");
    attachOutcomeDetailsToLatestAssistantMessage(session, outcome);
    registerRecentChatStart({
      name: requesterNameInput,
      email: requesterEmailInput,
      message,
      sessionId: session.sessionId,
      ticketId: session.ticketId
    });
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      degraded: startSync.degraded || zendeskWriteDegraded,
      sessionId: session.sessionId,
      session: {
        sessionId: session.sessionId,
        ticketId: session.ticketId,
        requesterId: session.requesterId,
        requesterName: session.requesterName,
        requesterEmail: session.requesterEmail,
        entryIntent: session.entryIntent,
        entryPromptAnswer: session.entryPromptAnswer,
        entryFlowVersion: session.entryFlowVersion,
        entryFlowSkipped: session.entryFlowSkipped,
        entryTopicLock: session.entryTopicLock,
        conversationState: session.conversationState,
        resolutionPrompt: session.resolutionPrompt || null
      },
      ticketId,
      messages: getSession(session.sessionId).messages,
      conversationState: session.conversationState,
      resolutionPrompt: session.resolutionPrompt || null
    });
  } catch (error) {
    logError("Failed to start webshop chat session:", {
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: "Unable to start webshop chat session."
    });
  }
});

app.post("/api/chat/restore", async (req, res) => {
  const { ticketId, requesterId, requesterName, requesterEmail } = req.body || {};

  if (!ticketId || !requesterId) {
    return res.status(400).json({
      success: false,
      error: "ticketId and requesterId are required."
    });
  }

  try {
    const existingSession = findSessionByTicketId(ticketId);
    let audits;
    let ticketSummary;

    try {
      [audits, ticketSummary] = await Promise.all([
        zendeskService.getTicketAudits(ticketId),
        zendeskService.getTicketSummary(ticketId)
      ]);
    } catch (error) {
      if (existingSession) {
        return res.status(200).json({
          success: true,
          restored: true,
          degraded: true,
          mode: "active_session",
          session: existingSession
        });
      }

      return res.status(503).json(
        buildDependencyErrorResponse(error, "Zendesk privremeno nije dostupan za obnovu razgovora.")
      );
    }
    const restoredMessages = mapZendeskAuditsToMessages(audits, requesterId, ticketSummary);
    
    if (isClosedTicketStatus(ticketSummary.status)) {
      if (existingSession) {
        removeSession(existingSession.sessionId);
      }

      return res.status(200).json({
        success: true,
        restored: true,
        mode: "closed_session",
        ...buildClosedSessionPayload({
          ticketSummary,
          requesterName: ticketSummary.requesterName || requesterName,
          requesterEmail: ticketSummary.requesterEmail || requesterEmail,
          messages: restoredMessages
        })
      });
    }

    if (existingSession && isActiveTicketStatus(ticketSummary.status)) {
      existingSession.messages = restoredMessages;
      existingSession.requesterName = ticketSummary.requesterName || existingSession.requesterName || "";
      existingSession.requesterEmail = ticketSummary.requesterEmail || existingSession.requesterEmail || "";
            existingSession.conversationState = buildConversationState(ticketSummary, existingSession.messages);
      existingSession.updatedAt = new Date().toISOString();
      scheduleRuntimePersist();

      return res.status(200).json({
        success: true,
        restored: true,
        mode: "active_session",
        session: existingSession
      });
    }

    const session = createSession({
      ticketId,
      requesterId,
      requesterName: ticketSummary.requesterName || requesterName || "",
      requesterEmail: ticketSummary.requesterEmail || requesterEmail || "",
      messages: []
    });

    session.messages = restoredMessages;
        session.conversationState = buildConversationState(ticketSummary, session.messages);
    session.updatedAt = new Date().toISOString();
    scheduleRuntimePersist();

    return res.status(200).json({
      success: true,
      restored: true,
      mode: "active_session",
      session
    });
  } catch (error) {
    logError("Failed to restore webshop chat session:", {
      ticketId,
      requesterId,
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: "Unable to restore webshop chat session."
    });
  }
});

/**
 * Continue an existing webshop chat session.
 */
app.post("/api/chat/message", rateLimiter, chatUpload.array("attachments", 5), async (req, res) => {
  const { sessionId } = req.body || {};
  const message = normalizeMessage(req.body?.message);
  const files = getUploadedFiles(req);
  const session = getSession(sessionId);

  if (!sessionId || !session) {
    return res.status(404).json({
      success: false,
      error: "Chat session not found."
    });
  }

  if (!message && files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "A message or at least one attachment is required."
    });
  }

  try {
    let ticketSummary;
    try {
      ticketSummary = await zendeskService.getTicketSummary(session.ticketId);
    } catch (error) {
      return res.status(503).json(
        buildDependencyErrorResponse(error, "Zendesk privremeno nije dostupan. Pokušajte ponovno za trenutak.")
      );
    }

    if (isClosedTicketStatus(ticketSummary.status)) {
      logInfo("resolved_block", {
        sessionId,
        ticketId: session.ticketId,
        status: ticketSummary.status
      });
      return res.status(409).json({
        success: false,
        error: "Prethodni razgovor je završen. Za novo pitanje pokrenite novi razgovor.",
        conversationState: {
          tone: "resolved",
          badge: "Prethodni razgovor je završen",
          subtitle: "Možete pregledati raniji odgovor ili otvoriti novi razgovor."
        }
      });
    }

    let uploadedAttachments = [];
    try {
      uploadedAttachments = await zendeskService.uploadAttachments(files);
    } catch (error) {
      logError("Attachment upload failed while continuing chat session:", {
        sessionId,
        ticketId: session.ticketId,
        message: error.message,
        stack: error.stack
      });

      return res.status(503).json({
        success: false,
        error: "Privitke trenutno ne možemo obraditi. Pokušajte ponovno bez privitka ili malo kasnije."
      });
    }
    const uploadTokens = uploadedAttachments.map((item) => item.token).filter(Boolean);

    await zendeskService.addCustomerMessageToTicket(
      session.ticketId,
      session.requesterId,
      message || "Šaljem privitak.",
      uploadTokens
    );

    await syncSessionMessages(session);

    if (
      session.conversationState?.tone === "human-active" &&
      session.messages?.[session.messages.length - 1]?.role !== "user"
    ) {
      session.resolutionPrompt = null;
      logInfo("human_pass_through", {
        sessionId,
        ticketId: session.ticketId,
        tone: session.conversationState.tone
      });
      broadcastSessionUpdate(session);

      return res.status(200).json({
        success: true,
        ticketId: session.ticketId,
        messages: session.messages,
        conversationState: session.conversationState,
        resolutionPrompt: null
      });
    }

    if (getResolutionPrompt(session, ticketSummary)) {
      broadcastSessionUpdate(session);

      return res.status(200).json({
        success: true,
        ticketId: session.ticketId,
        messages: session.messages,
        conversationState: session.conversationState,
        resolutionPrompt: session.resolutionPrompt || null
      });
    }

    const { knowledge, outcome } = await resolveAutomatedOutcome(
      session,
      message || "Šaljem privitak.",
      {
        hasAttachments: files.length > 0,
        channelType: "web_chat"
      }
    );

    logInfo("ai_autopilot", {
      sessionId,
      ticketId: session.ticketId,
      outcome: outcome.type,
      stateTag: outcome.stateTag
    });

    if (files.length > 0) {
      await zendeskService.addTagAndNote(
        session.ticketId,
        "hitno_slike",
        "Korisnik je poslao privitke kroz webshop chat. Potrebna ljudska provjera."
      );
    }

    if (outcome.type !== "safe_answer" && outcome.type !== "ask_clarifying_question") {
      await persistEscalation(
        session.ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType: "web_chat" }
      );
    }

    let zendeskWriteDegraded = false;
    try {
      await zendeskService.updateConversationState(session.ticketId, outcome.stateTag, outcome.extraTags || []);
      await zendeskService.addBotReplyToTicket(
        session.ticketId,
        outcome.zendeskMessage || outcome.customerMessage,
        {
          channelType: "web_chat",
          metadata: buildBotReplyMetadata(outcome)
        }
      );
      await zendeskService.addInternalNote(session.ticketId, buildAutopilotNote({
        outcome,
        userMessage: message || "Šaljem privitak.",
        knowledge,
        channelType: "web_chat",
      }));
      if (outcome.source === "product_feed" && outcome.zendeskSummary) {
        await zendeskService.addInternalNote(
          session.ticketId,
          `Product feed sažetak:\n${outcome.zendeskSummary}`
        );
      }
    } catch (error) {
      if (!isZendeskRateLimitError(error)) {
        throw error;
      }

      zendeskWriteDegraded = true;
      logWarn("zendesk_write_rate_limited", {
        sessionId,
        ticketId: session.ticketId,
        status: error.status || error.response?.status || 429,
        reason: outcome.reason
      });
      appendLocalAssistantOutcome(session, outcome);
    }
    const messageSync = await syncSessionMessagesWithFallback(session, "chat_message_final_sync");
    attachOutcomeDetailsToLatestAssistantMessage(session, outcome);
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      degraded: messageSync.degraded || zendeskWriteDegraded,
      ticketId: session.ticketId,
      messages: session.messages,
      conversationState: session.conversationState,
      resolutionPrompt: session.resolutionPrompt || null
    });
  } catch (error) {
    logError("Failed to continue webshop chat session:", {
      sessionId,
      ticketId: session.ticketId,
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: "Unable to continue webshop chat session."
    });
  }
});

app.post("/api/chat/resolve", async (req, res) => {
  const { sessionId, confirmed } = req.body || {};
  const session = getSession(sessionId);

  if (!sessionId || !session) {
    return res.status(404).json({
      success: false,
      error: "Chat session not found."
    });
  }

  try {
    let ticketSummary;
    try {
      ticketSummary = await zendeskService.getTicketSummary(session.ticketId);
    } catch (error) {
      return res.status(503).json(
        buildDependencyErrorResponse(error, "Zendesk privremeno nije dostupan. Pokušajte ponovno za trenutak.")
      );
    }

    if (isClosedTicketStatus(ticketSummary.status)) {
      await syncSessionMessagesWithFallback(session, "chat_resolve_closed_sync");

      return res.status(200).json({
        success: true,
        action: "ticket_already_resolved",
        session,
        conversationState: session.conversationState,
        resolutionPrompt: null
      });
    }

    await syncSessionMessagesWithFallback(session, "chat_resolve_sync");

    if (!confirmed) {
      session.resolutionPrompt = null;

      return res.status(200).json({
        success: true,
        action: "resolution_cancelled",
        session,
        conversationState: session.conversationState,
        resolutionPrompt: null
      });
    }

    let freshTicketSummary;
    try {
      freshTicketSummary = await zendeskService.getTicketSummary(session.ticketId);
    } catch (error) {
      return res.status(503).json(
        buildDependencyErrorResponse(error, "Zendesk privremeno nije dostupan. Pokušajte ponovno za trenutak.")
      );
    }
    const resolutionPrompt = getResolutionPrompt(session, freshTicketSummary);

    if (!resolutionPrompt) {
      session.resolutionPrompt = null;

      return res.status(200).json({
        success: true,
        action: "resolution_not_available",
        session,
        conversationState: session.conversationState,
        resolutionPrompt: null
      });
    }

    await zendeskService.solveTicket(session.ticketId, {
      commentBody: "Drago mi je da smo pomogli. Ako vam zatreba još nešto, slobodno otvorite novi razgovor.",
      additionalTags: ["resolved", "resolved_by_customer_confirmation"]
    });

    const resolvedSync = await syncSessionMessagesWithFallback(session, "chat_resolve_final_sync");
    let resolvedTicketSummary = freshTicketSummary;
    let resolvedAudits = [];

    if (!resolvedSync.degraded) {
      try {
        [resolvedTicketSummary, resolvedAudits] = await Promise.all([
          zendeskService.getTicketSummary(session.ticketId),
          zendeskService.getTicketAudits(session.ticketId)
        ]);
      } catch (error) {
        logError("chat_resolve_persist_fetch failed:", {
          sessionId,
          ticketId: session.ticketId,
          message: error.message,
          stack: error.stack
        });
      }
    }
    session.resolutionPrompt = null;
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      action: "ticket_solved",
      session,
      conversationState: session.conversationState,
      resolutionPrompt: null
    });
  } catch (error) {
    logError("Failed to resolve webshop chat session:", {
      sessionId,
      ticketId: session.ticketId,
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: "Unable to resolve webshop chat session."
    });
  }
});

app.get("/api/chat/session/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Chat session not found."
    });
  }

  return syncSessionMessagesWithFallback(session, "chat_session_fetch")
    .then(({ session: syncedSession, degraded }) =>
      res.status(200).json({
        success: true,
        session: syncedSession,
        degraded
      })
    )
    .catch((error) =>
      res.status(500).json({
        success: false,
        error: error.message
      })
    );
});

app.get("/api/chat/stream/:sessionId", async (req, res) => {
  const session = getSession(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Chat session not found."
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  registerChatStream(session.sessionId, res);

  const { session: syncedSession, degraded } = await syncSessionMessagesWithFallback(
    session,
    "chat_stream_initial_sync"
  );
  writeSseEvent(res, "session_update", {
    session: syncedSession,
    degraded
  });

  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unregisterChatStream(session.sessionId, res);
  });
});

app.post("/webhook/zendesk/events", async (req, res) => {
  const token = req.headers["x-zendesk-webhook-token"];

  if (!zendeskService.verifyWebhookToken(token)) {
    return res.status(401).json({
      success: false,
      error: "Invalid Zendesk webhook token."
    });
  }

  const ticketId = req.body?.ticket_id || req.body?.ticketId || req.body?.ticket?.id;

  if (!ticketId) {
    return res.status(400).json({
      success: false,
      error: "ticket_id is required."
    });
  }

  try {
    const sessions = getSessionsByTicketId(ticketId);
    const [ticketSummary, audits] = await Promise.all([
      zendeskService.getTicketSummary(ticketId),
      zendeskService.getTicketAudits(ticketId)
    ]);

    if (ticketSummary.status === "solved" || ticketSummary.status === "closed") {
      await zendeskService.updateConversationState(ticketId, "resolved");
    }

    for (const session of sessions) {
      applyZendeskStateToSession(session, {
        audits,
        ticketSummary
      });

      if (session.conversationState?.tone === "human-active") {
        await zendeskService.updateConversationState(ticketId, "human_active");
              } else if (session.conversationState?.tone === "awaiting-human") {
        await zendeskService.updateConversationState(ticketId, "awaiting_human");
              } else if (session.conversationState?.tone === "resolved") {
              } else if (session.conversationState?.tone === "ai-active") {
        await zendeskService.updateConversationState(ticketId, "ai_active");
      }

      broadcastSessionUpdate(session);
    }

    return res.status(200).json({
      success: true,
      updatedSessions: sessions.length
    });
  } catch (error) {
    logError("Zendesk event webhook failed:", {
      ticketId,
      message: error.message,
      stack: error.stack
    });

    return res.status(503).json(
      buildDependencyErrorResponse(error, "Zendesk event webhook trenutno nije dostupan.")
    );
  }
});

// Fix #20: Health-check that verifies external dependencies.
app.get("/health", async (req, res) => {
  const vectorConfig = knowledgeService.getVectorConfigSummary?.();
  const checks = {
    zendesk: false,
    onedrive: oneDriveService.isConfigured() ? false : "not_configured",
    vectorKnowledge: vectorConfig?.enabled ? true : "not_configured"
  };

  try {
    await zendeskService.getZendeskConfigSummary();
    checks.zendesk = true;
  } catch (_error) {
    checks.zendesk = false;
  }

  if (oneDriveService.isConfigured()) {
    try {
      checks.onedrive = true;
    } catch (_error) {
      checks.onedrive = false;
    }
  }

  const allHealthy = checks.zendesk !== false;

  res.status(allHealthy ? 200 : 503).json({
    success: allHealthy,
    status: allHealthy ? "ok" : "degraded",
    checks,
    activeSessions: chatSessions.size,
    uptime: Math.floor(process.uptime()),
    metrics: metricsService.getSnapshot()
  });
});

app.post("/admin/cache/knowledge/refresh", (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized. Provide ?token=<ADMIN_TOKEN> to access this endpoint."
    });
  }

  oneDriveService.resetOneDriveCache?.();
  zendeskService.resetHelpCenterCache?.();

  return res.status(200).json({
    success: true,
    refreshed: ["onedrive", "zendesk_help_center"]
  });
});

app.post("/admin/vector/knowledge/sync", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized. Provide ?token=<ADMIN_TOKEN> to access this endpoint."
    });
  }

  const force = String(req.query.force || req.body?.force || "false").toLowerCase() === "true";
  const deleteMissing = String(req.query.deleteMissing || req.body?.deleteMissing || "true").toLowerCase() !== "false";
  const result = await runVectorKnowledgeSync({ force, deleteMissing });
  const statusCode = result.inProgress ? 409 : result.configured === false ? 400 : result.success ? 200 : 207;

  return res.status(statusCode).json(result);
});

app.get("/chat", (req, res) => {
  applyEmbedFrameHeaders(res);
  return res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/embed/chat", (req, res) => {
  applyEmbedFrameHeaders(res);
  return res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// Fix #3: Gate debug endpoint behind ADMIN_TOKEN env var.
app.get("/debug/zendesk/:ticketId", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized. Provide ?token=<ADMIN_TOKEN> to access this endpoint."
    });
  }

  try {
    const result = await zendeskService.testZendeskTicketAccess(req.params.ticketId);

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Periodically clean up expired webhook idempotency entries.
const webhookIdempotencyCleanupInterval = setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [key, timestamp] of processedWebhookAudits) {
    if (now - timestamp > WEBHOOK_IDEMPOTENCY_TTL_MS) {
      processedWebhookAudits.delete(key);
      changed = true;
    }
  }

  for (const [key, timestamp] of processedWebhookMessages) {
    if (now - timestamp > WEBHOOK_IDEMPOTENCY_TTL_MS) {
      processedWebhookMessages.delete(key);
      changed = true;
    }
  }

  if (changed) {
    scheduleRuntimePersist();
  }
}, WEBHOOK_IDEMPOTENCY_TTL_MS);
webhookIdempotencyCleanupInterval.unref?.();

const port = Number(process.env.PORT) || 3000;

function startServer(listenPort = port) {
  return app.listen(listenPort, () => {
    logInfo(`Server listening on port ${listenPort}`);
  });
}

if (require.main === module) {
  startServer(port);
}

module.exports = {
  app,
  startServer,
  resetRuntimeState,
  __internal: {
    appendDirectWebsiteLink,
    buildAutopilotNote,
    buildConversationState,
    buildConversationStateFromOutcome,
    detectTicketChannelType,
    extractZendeskWebhookEnvelope,
    finalizeOutcomeForCustomer,
    formatChannelLabel,
    getAutomationBlockReason,
    getChannelMessages,
    appendLocalAssistantOutcome,
    isZendeskRateLimitError,
    getSessionActiveDomain,
    looksLikeProductContinuationMessage,
    looksLikeProductLookupMessage,
    mapZendeskAuditsToMessages,
    normalizeChannelType,
    normalizeZendeskCommentContent,
    processZendeskWebhookPayload,
    resolveAutomatedOutcome,
    updateSessionRouteMemory,
    validateAnswerQuality
  }
};
