require("dotenv").config();

const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const multer = require("multer");
const zendeskService = require("./services/zendeskService");
const aiService = require("./services/aiService");
const knowledgeService = require("./services/knowledgeService");
const oneDriveService = require("./services/oneDriveService");
const spamFilterService = require("./services/spamFilterService");
const productService = require("./services/productService");
const reasoningService = require("./services/reasoningService");
const memoryService = require("./services/memoryService");
const plannerService = require("./services/plannerService");
const runtimeStore = require("./services/runtimeStore");
const metricsService = require("./services/metricsService");
const { composeDeterministicReply } = require("./services/responseComposer");
const { validateAnswerQuality } = require("./services/answerQualityService");
const { BASE_URL, buildDirectWebsiteLinks } = require("./services/siteLinkService");
const { normalizeForComparison } = require("./services/textUtils");

const app = express();
const IS_TEST_ENV = process.env.NODE_ENV === "test";
const SHOULD_LOG_IN_TEST = process.env.DEBUG_TEST_LOGS === "true";
const chatSessions = new Map();
const processedWebhookAudits = new Map();
const recentChatStarts = new Map();
const WEBHOOK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const CHAT_START_DEDUPLICATION_TTL_MS =
  Number(process.env.CHAT_START_DEDUPLICATION_TTL_MS) || 10 * 60 * 1000;
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const chatStreams = new Map();
const KNOWLEDGE_MIN_TOP_SCORE = Number(process.env.KNOWLEDGE_MIN_TOP_SCORE) || 8;
const BLOCKED_AUTOPILOT_TAGS = new Set(["human_active", "resolved"]);
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

logInfo("Loaded Zendesk config:", zendeskService.getZendeskConfigSummary());
logInfo("Loaded OneDrive config:", oneDriveService.getOneDriveConfigSummary());
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
    entryTopicLock: "",
    entryTopicSourcePolicy: null,
    entryTopicSetAt: null,
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

function buildChatStartDeduplicationKey({ name = "", email = "", message = "" } = {}) {
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
  const recentMatch = recentChatStarts.get(dedupeKey);

  if (recentMatch && Date.now() - recentMatch.createdAt <= CHAT_START_DEDUPLICATION_TTL_MS) {
    const session = getSession(recentMatch.sessionId);

    if (session && !isSessionClosed(session)) {
      return session;
    }
  }

  const requesterFingerprint = normalizeRequesterFingerprint(name, email);

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

    return haystack.includes("ai_replied") || haystack.includes("webchat_ai");
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

function getSupportTaskIntentFromMetadata(audit = {}) {
  const customMetadata = getZendeskAuditCustomMetadata(audit);
  return String(customMetadata.libar_task_intent || customMetadata.libarTaskIntent || "").trim();
}

function inferMessageRoleFromAudit(audit, commentEvent, requesterId, ticketSummary) {
  const normalizedRequesterId = Number(requesterId);
  const commentAuthorId = Number(commentEvent?.author_id ?? audit?.author_id);
  const sourceChannel = commentEvent?.via?.channel || audit?.via?.channel || null;
  const customMetadata = getZendeskAuditCustomMetadata(audit);
  const taggedRole = customMetadata.libar_message_role || customMetadata.libarMessageRole || null;

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

  if (sourceChannel && sourceChannel !== "api") {
    return "assistant";
  }

  if (hasAiReplyMarker(audit)) {
    return "assistant";
  }

  if (
    Number.isFinite(commentAuthorId) &&
    Number.isFinite(normalizedRequesterId) &&
    commentAuthorId !== normalizedRequesterId
  ) {
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
  memoryService.applyWorkingMemoryToSession(
    session,
    memoryService.extractLatestWorkingMemory(audits)
  );
  session.conversationState = buildConversationState(ticketSummary, session.messages);
  session.resolutionPrompt = getResolutionPrompt(session, ticketSummary);
  session.updatedAt = new Date().toISOString();

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
  channelType = "web_chat",
  conversation = null
}) {
  const topArticles = Array.isArray(knowledge?.articles) ? knowledge.articles.slice(0, 2) : [];
  const sourceSummary = topArticles
    .map((article) => article.title)
    .filter(Boolean)
    .join(" | ");
  const selectedSources = Array.isArray(conversation?.supportPlan?.selectedSources)
    ? conversation.supportPlan.selectedSources
    : [];
  const blockedSources = Array.isArray(conversation?.supportPlan?.mustNotUseSources)
    ? conversation.supportPlan.mustNotUseSources
    : [];
  const summaryLine = [
    `Kanal: ${formatChannelLabel(channelType)}`,
    `Ishod: ${outcome?.type || "unknown"}`,
    conversation?.supportPlan?.route ? `Ruta: ${conversation.supportPlan.route}` : null,
    conversation?.reasoningResult?.taskIntent ? `Tema: ${conversation.reasoningResult.taskIntent}` : null
  ]
    .filter(Boolean)
    .join(" | ");
  const analysisLine = [
    conversation?.reasoningResult?.actionIntent ? `Akcija: ${conversation.reasoningResult.actionIntent}` : null,
    conversation?.reasoningResult?.questionType ? `Pitanje: ${conversation.reasoningResult.questionType}` : null,
    conversation?.reasoningResult?.emotionalTone ? `Ton: ${conversation.reasoningResult.emotionalTone}` : null,
    conversation?.isFollowUp ? "Follow-up: da" : null
  ]
    .filter(Boolean)
    .join(" | ");
  const knowledgeLine = [
    knowledge?.primarySource
      ? `Primarni izvor: ${knowledge.primarySource === "onedrive" ? "OneDrive" : "Zendesk"}`
      : outcome?.source === "product_feed"
        ? "Primarni izvor: Product feed"
        : null,
    knowledge?.quality?.isStrong ? "Knowledge: strong" : null,
    knowledge?.quality?.isWeak ? "Knowledge: weak" : null,
    knowledge?.quality?.hasConflict ? "Knowledge: conflict" : null,
    Number.isFinite(Number(knowledge?.topScore)) ? `Score: ${Number(knowledge.topScore).toFixed(2)}` : null
  ]
    .filter(Boolean)
    .join(" | ");

  return [
    summaryLine,
    `Korisnik: ${userMessage}`,
    conversation?.standaloneQuery && conversation.standaloneQuery !== userMessage
      ? `Standalone upit: ${conversation.standaloneQuery}`
      : null,
    analysisLine || null,
    selectedSources.length > 0 ? `Dozvoljeni izvori: ${selectedSources.join(", ")}` : null,
    blockedSources.length > 0 ? `Blokirani izvori: ${blockedSources.join(", ")}` : null,
    conversation?.missingSlots?.length ? `Nedostaje: ${conversation.missingSlots.join(", ")}` : null,
    conversation?.riskFlags?.length ? `Rizici: ${conversation.riskFlags.join(", ")}` : null,
    knowledgeLine || null,
    knowledge?.quality?.hasConflict && knowledge?.quality?.conflictFields?.length
      ? `Konfliktna polja: ${knowledge.quality.conflictFields.join(", ")}`
      : null,
    sourceSummary ? `Korišteni izvori: ${sourceSummary}` : null,
    Array.isArray(outcome?.products) && outcome.products.length > 0
      ? `Proizvodi: ${outcome.products.map((product) => product.title).filter(Boolean).join(", ")}`
      : null,
    outcome?.reason ? `Razlog: ${outcome.reason}` : null
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

function finalizeOutcomeForCustomer(
  outcome = null,
  {
    channelType = "web_chat",
    knowledge = null,
    conversation = null
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
    conversation
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

function buildMemoryNote(session, conversation, outcome, knowledge, ticketSummary, previousMemory = null) {
  const memory = memoryService.buildWorkingMemory({
    session,
    conversation,
    outcome,
    knowledge,
    ticketSummary,
    previousMemory
  });

  session.workingMemory = memory;
  return memoryService.serializeWorkingMemory(memory);
}

function buildLifecycleOutcome(session, tone = "") {
  if (tone === "resolved") {
    return {
      type: "resolved",
      reason: "ticket_resolved"
    };
  }

  if (tone === "human-active") {
    return {
      type: "human_reply",
      reason: "human_takeover_active"
    };
  }

  if (tone === "awaiting-human") {
    return {
      type: "soft_handoff",
      reason: "awaiting_human_review"
    };
  }

  if (tone === "awaiting-customer-detail") {
    return {
      type: "ask_clarifying_question",
      reason: "awaiting_customer_detail"
    };
  }

  return {
    type: "safe_answer",
    reason: "ai_active_state"
  };
}

function buildFocusedKnowledgeContext(knowledge, limit = 2) {
  const articles = Array.isArray(knowledge?.articles) ? knowledge.articles.slice(0, limit) : [];

  if (articles.length === 0) {
    return "";
  }

  return articles
    .map((entry, index) => [
      `Izvor ${index + 1}:`,
      `Tip: ${entry.source === "onedrive" ? "OneDrive dokument" : "Zendesk članak"}`,
      `Naslov: ${entry.title}`,
      `Relevantnost: ${entry.score}`,
      `Sadržaj: ${entry.body || ""}`
    ].join("\n"))
    .join("\n\n");
}

function shouldAttemptGroundedAnswerFallback(knowledge) {
  if (!knowledge?.context || !knowledge?.topScore) {
    return false;
  }

  if (knowledge?.quality?.isWeak) {
    return false;
  }

  return knowledge.topScore >= Math.max(KNOWLEDGE_MIN_TOP_SCORE + 2, 10);
}

function recordOutcomeMetrics(outcome = null, conversation = null, knowledge = null) {
  if (!outcome) {
    return;
  }

  metricsService.increment(`outcome_${outcome.type}_total`);

  const activeDomain = String(conversation?.reasoningResult?.activeDomain || "unknown").trim() || "unknown";
  metricsService.increment(`domain_${activeDomain}_${outcome.type}_total`);

  if (outcome.type === "ask_clarifying_question") {
    metricsService.increment("clarification_asked_total");
  }

  if (knowledge?.primarySource) {
    metricsService.increment(`knowledge_source_${knowledge.primarySource}_used_total`);
  }
}

function hasCriticalRiskFlags(conversation = null) {
  const flags = Array.isArray(conversation?.riskFlags) ? conversation.riskFlags : [];
  const primaryIntent = String(conversation?.reasoningResult?.primaryIntent || "").trim();
  const actionIntent = String(conversation?.reasoningResult?.actionIntent || "").trim();
  const refundIsPolicyLike =
    primaryIntent === "reklamacija_povrat" &&
    ["ask_policy", "ask_timeline", "ask_general_info"].includes(actionIntent);

  return (
    (flags.includes("refund") && !refundIsPolicyLike) ||
    flags.includes("payment") ||
    flags.includes("legal_or_abuse")
  );
}

function buildSearchOptions(session, conversation) {
  const entryTopicSourcePolicy = session?.entryTopicSourcePolicy || null;
  const entities = conversation?.reasoningResult?.entities || {};
  const retrievalHints = [
    conversation?.reasoningResult?.primaryIntent ? `Intent ${conversation.reasoningResult.primaryIntent}` : "",
    conversation?.reasoningResult?.taskIntent ? `Task ${conversation.reasoningResult.taskIntent}` : "",
    conversation?.reasoningResult?.actionIntent ? `Action ${conversation.reasoningResult.actionIntent}` : "",
    entities.city ? `Grad ${entities.city}` : "",
    entities.order_reference ? `Broj narudžbe ${entities.order_reference}` : "",
    entities.book_title ? `Naslov ${entities.book_title}` : "",
    entities.author ? `Autor ${entities.author}` : "",
    entities.policy_topic ? `Tema ${entities.policy_topic}` : "",
    session?.workingMemory?.activeReferenceValue
      ? `Prethodna referenca ${session.workingMemory.activeReferenceValue}`
      : ""
  ].filter(Boolean);
  const preferredSource =
    (Array.isArray(conversation?.supportPlan?.sourcePriority) && conversation.supportPlan.sourcePriority[0]
      ? conversation.supportPlan.sourcePriority[0].replace("_knowledge", "")
      : "") ||
    session?.workingMemory?.supportHistory?.lastSuccessfulSource ||
    session?.lastKnowledgeSource ||
    "";

  return {
    conversationFacts: conversation?.conversationFacts || [],
    conversationTerms: conversation?.conversationFacts || [],
    retrievalHints,
    retrievalFrame: conversation?.retrievalFrame || null,
    preferredSource,
    allowedSources:
      conversation?.supportPlan?.selectedSources?.length
        ? conversation.supportPlan.selectedSources
        : entryTopicSourcePolicy?.allowedSources || [],
    blockedSources:
      conversation?.supportPlan?.mustNotUseSources?.length
        ? conversation.supportPlan.mustNotUseSources
        : entryTopicSourcePolicy?.blockedSources || [],
    sourcePriority: conversation?.supportPlan?.sourcePriority || [],
    activeDomain: conversation?.reasoningResult?.activeDomain || "",
    userJob: conversation?.reasoningResult?.actionIntent || "",
    taskIntent: conversation?.reasoningResult?.taskIntent || "",
    actionIntent: conversation?.reasoningResult?.actionIntent || "",
    subjectType: conversation?.reasoningResult?.subjectType || "",
    questionType: conversation?.reasoningResult?.questionType || "",
    contextCarryover: {
      activeDomain: session?.workingMemory?.activeDomain || "",
      activeUserJob: session?.workingMemory?.activeUserJob || "",
      activeReferenceType: session?.workingMemory?.activeReferenceType || "",
      activeReferenceValue: session?.workingMemory?.activeReferenceValue || ""
    }
  };
}

function buildEntryTopicPolicy(entryIntent = "") {
  switch (String(entryIntent || "").trim()) {
    case "kupnja_knjiga":
      return {
        entryTopicLock: "product_lookup",
        entryTopicSourcePolicy: {
          allowedSources: ["product_feed"],
          blockedSources: []
        }
      };
    case "otkup_knjiga":
      return {
        entryTopicLock: "buyback",
        entryTopicSourcePolicy: {
          allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
          blockedSources: ["product_feed"]
        }
      };
    case "dostava":
      return {
        entryTopicLock: "delivery",
        entryTopicSourcePolicy: {
          allowedSources: ["zendesk_knowledge", "onedrive_knowledge"],
          blockedSources: ["product_feed"]
        }
      };
    case "opci_upit":
      return {
        entryTopicLock: "support_info",
        entryTopicSourcePolicy: {
          allowedSources: ["zendesk_knowledge", "onedrive_knowledge"],
          blockedSources: ["product_feed"]
        }
      };
    case "narudzba":
      return {
        entryTopicLock: "order_status",
        entryTopicSourcePolicy: {
          allowedSources: ["zendesk_knowledge", "onedrive_knowledge"],
          blockedSources: ["product_feed"]
        }
      };
    case "reklamacija_problem":
      return {
        entryTopicLock: "complaint",
        entryTopicSourcePolicy: {
          allowedSources: ["zendesk_knowledge", "onedrive_knowledge"],
          blockedSources: ["product_feed"]
        }
      };
    default:
      return {
        entryTopicLock: "",
        entryTopicSourcePolicy: null
      };
  }
}

function shouldReleaseEntryTopicLock(session, conversation) {
  const currentLock = String(session?.entryTopicLock || "").trim();
  const nextTaskIntent = String(conversation?.reasoningResult?.taskIntent || "").trim();
  const confidence = Number(conversation?.reasoningResult?.intentConfidence || 0);

  if (!currentLock || !nextTaskIntent || currentLock === nextTaskIntent) {
    return false;
  }

  if (currentLock === "buyback") {
    if (nextTaskIntent === "product_lookup") {
      return Boolean(conversation?.isExplicitProductLookup) && confidence >= 0.55;
    }

    if (nextTaskIntent === "support_info") {
      return confidence >= 0.55;
    }

    return confidence >= 0.72 && ["delivery", "order_status", "order_issue", "complaint"].includes(nextTaskIntent);
  }

  return confidence >= 0.72;
}

function clearSessionClarification(session) {
  if (!session) {
    return;
  }

  session.pendingClarification = null;
  session.updatedAt = new Date().toISOString();
  scheduleRuntimePersist();
}

function storeSessionClarification(session, conversation, question) {
  if (!session || !conversation || !question) {
    return;
  }

  session.pendingClarification = {
    slotKey: conversation.missingSlots?.[0] || "",
    question,
    intent: conversation.reasoningResult?.primaryIntent || conversation.resolvedUserIntent || "",
    activeDomain: conversation?.reasoningResult?.activeDomain || "",
    activeTaskIntent: conversation?.reasoningResult?.taskIntent || "",
    userJob: conversation?.reasoningResult?.actionIntent || "",
    expectedAnswerType: conversation?.reasoningResult?.questionType || "",
    sourceContract: conversation?.reasoningResult?.sourceContract || "",
    baseQuery: conversation.standaloneQuery || "",
    attemptCount: Number(session.pendingClarification?.attemptCount || 0) + 1,
    askedAt: new Date().toISOString()
  };
  session.updatedAt = new Date().toISOString();
  scheduleRuntimePersist();
}

function updateSessionMemory(session, conversation, outcome, knowledge = null) {
  if (!session || !conversation) {
    return;
  }

  session.lastResolvedIntent =
    conversation.reasoningResult?.primaryIntent ||
    conversation.resolvedUserIntent ||
    session.lastResolvedIntent ||
    "";
  session.lastStandaloneQuery = conversation.standaloneQuery || session.lastStandaloneQuery || "";

  if (outcome?.source === "product_feed" && Array.isArray(outcome.products)) {
    session.lastProductTitles = outcome.products.map((product) => product.title).filter(Boolean).slice(0, 3);
    session.lastKnowledgeSource = "product_feed";
  } else if (knowledge?.primarySource) {
    session.lastKnowledgeSource = knowledge.primarySource;
    if (conversation?.reasoningResult?.taskIntent !== "product_lookup") {
      session.lastProductTitles = [];
    }
  }

  if (conversation?.supportPlan) {
    session.lastRoute = conversation.supportPlan.route;
  }

  if (conversation?.entryTopicLockReleased) {
    session.entryTopicLock = "";
    session.entryTopicSourcePolicy = null;
    session.entryTopicSetAt = null;
  }

  session.lastResolvedEntity =
    conversation?.reasoningResult?.entities?.book_title ||
    conversation?.reasoningResult?.entities?.order_reference ||
    conversation?.reasoningResult?.entities?.city ||
    session.lastResolvedEntity ||
    "";
  session.updatedAt = new Date().toISOString();
  scheduleRuntimePersist();

  if (outcome?.type === "ask_clarifying_question") {
    storeSessionClarification(session, conversation, outcome.customerMessage);
    return;
  }

  clearSessionClarification(session);
}

async function persistWorkingMemory(session, conversation, outcome, knowledge, ticketSummary, audits = []) {
  if (!session?.ticketId) {
    return null;
  }

  const previousMemory = memoryService.extractLatestWorkingMemory(audits) || session.workingMemory || null;
  const nextMemory = memoryService.buildWorkingMemory({
    session,
    conversation,
    outcome,
    knowledge,
    ticketSummary,
    previousMemory
  });

  if (memoryService.areEquivalentWorkingMemories(previousMemory, nextMemory)) {
    session.workingMemory = previousMemory || nextMemory;
    return session.workingMemory;
  }

  const noteText = buildMemoryNote(
    session,
    conversation,
    outcome,
    knowledge,
    ticketSummary,
    previousMemory
  );

  await zendeskService.addInternalNote(session.ticketId, noteText);
  return session.workingMemory;
}

async function determineChatOutcome(
  userMessage,
  knowledge,
  {
    hasAttachments = false,
    channelType = "web_chat",
    conversation = null,
    allowClarifyingQuestion = true,
    clarifyAfterKnowledge = false,
    customerName = "",
    supportPlan = null,
    reasoningResult = null,
    responsePolicy = null
  } = {}
) {
  const channelMessages = getChannelMessages(channelType);

  if (hasAttachments) {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "attachments_present",
      customerMessage: channelMessages.attachmentHandoff
    };
  }

  if (
    supportPlan?.route === "handoff_hard" ||
    hasCriticalRiskFlags(conversation)
  ) {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "sensitive_or_complaint_topic",
      customerMessage: channelMessages.hardHandoff
    };
  }

  const hasClarifyingNeed = Boolean(
    allowClarifyingQuestion &&
      (responsePolicy?.mode === "ask_one_question" || supportPlan?.route === "clarify") &&
      ((conversation?.missingSlots?.length > 0 && conversation?.canAskClarifyingQuestion) ||
        supportPlan?.route === "clarify") &&
      conversation?.clarifyingQuestion
  );

  if (!clarifyAfterKnowledge && hasClarifyingNeed) {
    return {
      type: "ask_clarifying_question",
      stateTag: "awaiting_customer_detail",
      reason: "missing_required_detail",
      customerMessage: conversation.clarifyingQuestion
    };
  }

  if (!knowledge?.context || !knowledge?.topScore || knowledge.topScore < KNOWLEDGE_MIN_TOP_SCORE) {
    if (clarifyAfterKnowledge && hasClarifyingNeed) {
      return {
        type: "ask_clarifying_question",
        stateTag: "awaiting_customer_detail",
        reason: "missing_required_detail",
        customerMessage: conversation.clarifyingQuestion
      };
    }

    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: "insufficient_context_confidence",
      customerMessage: channelMessages.softHandoff
    };
  }

  if (knowledge?.quality?.hasConflict) {
    metricsService.increment("knowledge_conflict_handoff_total");
    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: "knowledge_source_conflict",
      customerMessage: channelMessages.softHandoff
    };
  }

  if (knowledge?.quality?.isWeak) {
    if (clarifyAfterKnowledge && hasClarifyingNeed) {
      return {
        type: "ask_clarifying_question",
        stateTag: "awaiting_customer_detail",
        reason: "missing_required_detail",
        customerMessage: conversation.clarifyingQuestion
      };
    }

    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: "knowledge_intent_mismatch",
      customerMessage: channelMessages.softHandoff
    };
  }

  if (
    responsePolicy?.acceptLowMarginDirectInfo &&
    knowledge?.quality?.directAnswerability &&
    knowledge?.quality?.contextConsistency &&
    knowledge?.quality?.jobMatch
  ) {
    knowledge.quality.isStrong = true;
  }

  if (
    (allowClarifyingQuestion || clarifyAfterKnowledge) &&
    knowledge?.quality &&
    !knowledge.quality.isStrong &&
    responsePolicy?.mode === "ask_one_question" &&
    conversation?.clarifyingQuestion
  ) {
    return {
      type: "ask_clarifying_question",
      stateTag: "awaiting_customer_detail",
      reason: "knowledge_ambiguous",
      customerMessage: conversation.clarifyingQuestion
    };
  }

  const deterministicReply = composeDeterministicReply({ conversation, knowledge });

  if (deterministicReply) {
    metricsService.increment("deterministic_kb_answer_total");
    return {
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "deterministic_kb_answer",
      customerMessage: deterministicReply,
      source: knowledge?.primarySource || ""
    };
  }

  const aiDecision = await aiService.generateReply(userMessage, knowledge.context, {
    channelType,
    conversationSummary: conversation?.summary || "",
    responsePlan: conversation?.responsePlan || null,
    supportPlan,
    reasoningResult,
    standaloneQuery: conversation?.standaloneQuery || userMessage,
    missingSlots: conversation?.missingSlots || [],
    riskFlags: conversation?.riskFlags || [],
    customerName,
    knowledgeQuality: knowledge?.quality || null,
    responsePolicy
  });

  if (responsePolicy?.mode === "answer_now" && aiDecision.decision === "ask_clarifying_question") {
    return {
      type: "safe_answer",
      stateTag: "ai_active",
      reason: "forced_answer_now",
      customerMessage: aiDecision.reply || channelMessages.softHandoff
    };
  }

  if (aiDecision.decision === "hard_handoff") {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: aiDecision.reason || "ai_flagged_hard_handoff",
      customerMessage: channelMessages.hardHandoff
    };
  }

  if (aiDecision.decision === "ask_clarifying_question") {
    return {
      type: "ask_clarifying_question",
      stateTag: "awaiting_customer_detail",
      reason: aiDecision.reason || "needs_clarification",
      customerMessage: aiDecision.clarifyingQuestion || aiDecision.reply
    };
  }

  if (aiDecision.decision === "soft_handoff") {
    if (shouldAttemptGroundedAnswerFallback(knowledge)) {
      const focusedContext = buildFocusedKnowledgeContext(knowledge, 2);
      const groundedReply = await aiService.generateGroundedAnswer(userMessage, focusedContext, {
        channelType,
        customerName,
        conversationSummary: conversation?.summary || ""
      });

      if (groundedReply) {
        return {
          type: "safe_answer",
          stateTag: "ai_active",
          reason: "grounded_answer_fallback",
          customerMessage: groundedReply
        };
      }
    }

    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: aiDecision.reason || "ai_flagged_unknown",
      customerMessage: channelMessages.softHandoff
    };
  }

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: aiDecision.reason || "context_grounded_answer",
    customerMessage: aiDecision.reply
  };
}

function buildProductOutcome(productMatch) {
  return buildProductOutcomeForChannel(productMatch, { channelType: "web_chat" });
}

function buildProductReplyForChannel(products = [], channelType = "web_chat") {
  const normalizedChannelType = normalizeChannelType(channelType);
  const intro =
    products.length === 1
      ? "Našao sam ovaj udžbenik."
      : "Našao sam nekoliko relevantnih udžbenika.";
  const disclaimer =
    "Cijena i dostupnost mogu odstupati, pa ih prije kupnje provjerite na webshop linku.";

  if (normalizedChannelType === "web_chat") {
    return [intro, disclaimer].join("\n");
  }

  const productBlocks = products.map((product, index) =>
    [
      `${index + 1}. ${product.title}`,
      product.priceLabel ? `Cijena: ${product.priceLabel}` : null,
      product.priceLabel ? "" : null,
      product.buyLink ? `Kupnja: ${product.buyLink}` : null,
      product.buyLink && product.sellLink ? "" : null,
      product.sellLink ? `Otkup: ${product.sellLink}` : null
    ]
      .filter((line) => line !== null)
      .join("\n")
  );

  const sections = [intro, ...productBlocks, disclaimer].filter(Boolean);
  return sections.join("\n\n");
}

function buildProductOutcomeForChannel(productMatch, { channelType = "web_chat" } = {}) {
  const replyText = buildProductReplyForChannel(productMatch.products, channelType);

  return {
    type: "safe_answer",
    source: "product_feed",
    stateTag: "ai_active",
    reason: "product_feed_match",
    topScore: productMatch.topScore,
    customerMessage: replyText,
    products: productMatch.products,
    zendeskMessage: replyText,
    zendeskSummary: productMatch.zendeskSummary
  };
}

function buildConversationAnalysis(session, userMessage) {
  const baseConversation = reasoningService.analyzeConversation({
    message: userMessage,
    messages: session?.messages || [],
    entryIntent: session?.entryIntent || "",
    pendingClarification: session?.pendingClarification || null,
    session: session || {}
  });
  const entryTopicLockReleased = shouldReleaseEntryTopicLock(session, baseConversation);
  const plannerSession = entryTopicLockReleased
    ? {
        ...session,
        entryTopicLock: "",
        entryTopicSourcePolicy: null
      }
    : session;
  const supportPlan = plannerService.buildSupportPlan({
    reasoningResult: baseConversation.reasoningResult,
    session: plannerSession,
    hasAttachments: false
  });
  const responsePolicy = {
    mode:
      baseConversation.reasoningResult?.answerabilityClass === "ask_one_question"
        ? "ask_one_question"
        : baseConversation.reasoningResult?.answerabilityClass === "handoff"
          ? "handoff"
          : "answer_now",
    brevity:
      ["buyback", "delivery", "order"].includes(baseConversation.reasoningResult?.activeDomain)
        ? "procedural_short"
        : baseConversation.reasoningResult?.activeDomain === "support_info"
          ? "terse"
          : "short",
    sourceContract: baseConversation.reasoningResult?.sourceContract || "knowledge_first",
    acceptLowMarginDirectInfo: baseConversation.reasoningResult?.activeDomain === "support_info",
    forbiddenContent:
      baseConversation.reasoningResult?.sourceContract === "support_only"
        ? ["product_links", "webshop_mentions", "multi_questioning"]
        : []
  };
  const retrievalFrame = {
    activeDomain: baseConversation.reasoningResult?.activeDomain || "",
    userJob: baseConversation.reasoningResult?.actionIntent || "",
    questionType: baseConversation.reasoningResult?.questionType || "",
    subjectType: baseConversation.reasoningResult?.subjectType || "",
    activeReferenceType:
      baseConversation.reasoningResult?.entities?.order_reference
        ? "order"
        : baseConversation.reasoningResult?.entities?.city
          ? "city"
          : baseConversation.reasoningResult?.entities?.book_title
            ? "book"
            : "",
    activeReferenceValue:
      baseConversation.reasoningResult?.entities?.order_reference ||
      baseConversation.reasoningResult?.entities?.city ||
      baseConversation.reasoningResult?.entities?.book_title ||
      "",
    shouldResetPreviousRetrieval: baseConversation.reasoningResult?.topicShiftType === "support_to_support_shift",
    allowedSources: supportPlan.selectedSources || [],
    blockedSources: supportPlan.mustNotUseSources || []
  };
  const responsePlan = {
    intent: baseConversation.reasoningResult?.primaryIntent || "general_support",
    taskIntent: baseConversation.reasoningResult?.taskIntent || "",
    actionIntent: baseConversation.reasoningResult?.actionIntent || "",
    nextStep:
      supportPlan.nextBestAction === "ask_missing_detail" || supportPlan.nextBestAction === "disambiguate"
        ? baseConversation.missingSlots?.[0] || "clarify"
        : "answer",
    steps: [
      `Planner route: ${supportPlan.route}`,
      `Response mode: ${supportPlan.responseMode}`,
      `Tone mode: ${supportPlan.toneMode}`,
      baseConversation.reasoningResult?.taskIntent
        ? `Task intent: ${baseConversation.reasoningResult.taskIntent}`
        : "",
      baseConversation.reasoningResult?.actionIntent
        ? `Action intent: ${baseConversation.reasoningResult.actionIntent}`
        : "",
      baseConversation.standaloneQuery
        ? `Standalone upit za retrieval: ${baseConversation.standaloneQuery.slice(0, 180)}`
        : ""
    ].filter(Boolean)
  };

  return {
    ...baseConversation,
    entryTopicLockActive: Boolean(plannerSession?.entryTopicLock),
    entryTopicLockReleased,
    effectiveEntryTopicLock: plannerSession?.entryTopicLock || "",
    retrievalFrame,
    responsePolicy,
    responsePlan,
    supportPlan
  };
}

function shouldUseProductSearch(conversation = null) {
  if (!conversation) {
    return false;
  }

  const route = String(conversation.supportPlan?.route || "").trim();
  const primaryIntent = String(conversation.reasoningResult?.primaryIntent || "").trim();
  const taskIntent = String(conversation.reasoningResult?.taskIntent || "").trim();
  const activeDomain = String(conversation.reasoningResult?.activeDomain || "").trim();
  const sourceContract = String(conversation.reasoningResult?.sourceContract || "").trim();
  const effectiveEntryTopicLock = String(conversation.effectiveEntryTopicLock || "").trim();

  if (conversation.supportPlan?.mustNotUseSources?.includes("product_feed")) {
    return false;
  }

  if (sourceContract !== "product_allowed") {
    return false;
  }

  if (effectiveEntryTopicLock && effectiveEntryTopicLock !== "product_lookup") {
    return false;
  }

  if ((activeDomain && activeDomain !== "product_lookup") || (taskIntent && taskIntent !== "product_lookup")) {
    return false;
  }

  return route === "product_feed" &&
    (primaryIntent === "product_availability" || primaryIntent === "product_pricing");
}

function shouldPreferKnowledgeBeforeClarify(conversation = null) {
  if (!conversation) {
    return false;
  }

  return (
    conversation.reasoningResult?.taskIntent === "buyback" &&
    (conversation.effectiveEntryTopicLock === "buyback" ||
      ["ask_how_to", "ask_policy", "request_estimate", "ask_timeline", "ask_info"].includes(
        conversation.reasoningResult?.actionIntent
      ))
  );
}

function buildClosureAcknowledgment(conversation, channelType) {
  const channelMessages = getChannelMessages(channelType);
  const closureReplies = [
    "Nema na čemu! Ako vam zatreba još nešto, slobodno se javite.",
    "Drago mi je da sam mogao pomoći. Javite se ako bude još pitanja.",
    "Hvala vama! Tu smo ako zatreba."
  ];
  const index = Math.floor(Math.random() * closureReplies.length);

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "closure_acknowledgment",
    customerMessage: closureReplies[index]
  };
}

async function resolveAutomatedOutcome(session, userMessage, { hasAttachments = false, channelType = "web_chat" } = {}) {
  const conversation = buildConversationAnalysis(session, userMessage);
  if (hasAttachments) {
    conversation.supportPlan = plannerService.buildSupportPlan({
      reasoningResult: conversation.reasoningResult,
      session,
      hasAttachments: true
    });
  }
  let knowledge = null;
  let outcome = null;
  const customerName = memoryService.getFirstName(session?.requesterName || session?.workingMemory?.customerProfile?.name);
  const preferKnowledgeBeforeClarify = shouldPreferKnowledgeBeforeClarify(conversation);

  // Fix #4: Closure messages get an acknowledgment, not a handoff.
  if (
    !hasAttachments &&
    conversation.reasoningResult?.primaryIntent === "small_talk_or_closure" &&
    conversation.supportPlan?.route === "clarify"
  ) {
    outcome = buildClosureAcknowledgment(conversation, channelType);
  } else if (
    hasAttachments ||
    conversation.supportPlan?.route === "handoff_hard" ||
    (!preferKnowledgeBeforeClarify &&
      (conversation.supportPlan?.route === "clarify" ||
        (conversation.missingSlots.length > 0 && conversation.canAskClarifyingQuestion)))
  ) {
    outcome = await determineChatOutcome(userMessage, null, {
      hasAttachments,
      channelType,
      conversation,
      allowClarifyingQuestion: true,
      customerName,
      supportPlan: conversation.supportPlan,
      reasoningResult: conversation.reasoningResult,
      responsePolicy: conversation.responsePolicy
    });
  } else {
    const searchQuery = conversation.standaloneQuery || userMessage;
    let productMatch = null;

    if (!preferKnowledgeBeforeClarify && shouldUseProductSearch(conversation)) {
      try {
        productMatch = await productService.searchProducts(searchQuery);
      } catch (error) {
        logError("Product search failed:", {
          message: error.message,
          searchQuery
        });
      }
    }

    if (productMatch) {
      outcome = buildProductOutcomeForChannel(productMatch, { channelType });
    } else {
      try {
        knowledge = await knowledgeService.searchKnowledgeDetailed(
          searchQuery,
          buildSearchOptions(session, conversation)
        );
      } catch (error) {
        logError("Knowledge search failed:", {
          message: error.message,
          searchQuery
        });
        knowledge = null;
      }
      outcome = await determineChatOutcome(searchQuery, knowledge, {
        hasAttachments: false,
        channelType,
        conversation,
        allowClarifyingQuestion: true,
        clarifyAfterKnowledge: preferKnowledgeBeforeClarify,
        customerName,
        supportPlan: conversation.supportPlan,
        reasoningResult: conversation.reasoningResult,
        responsePolicy: conversation.responsePolicy
      });
    }
  }

  outcome = finalizeOutcomeForCustomer(outcome, {
    channelType,
    knowledge,
    conversation
  });
  outcome = appendDirectWebsiteLink(outcome, {
    conversation,
    knowledge,
    channelType
  });
  updateSessionMemory(session, conversation, outcome, knowledge);
  recordOutcomeMetrics(outcome, conversation, knowledge);

  return {
    conversation,
    knowledge,
    outcome
  };
}

function attachProductsToLatestAssistantMessage(session, products = [], expectedContent = "") {
  if (!session || !Array.isArray(session.messages) || products.length === 0) {
    return;
  }

  const latestAssistantMessage = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.authoredByHuman);

  if (!latestAssistantMessage) {
    return;
  }

  if (expectedContent && latestAssistantMessage.content !== expectedContent) {
    return;
  }

  latestAssistantMessage.products = products;
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
 * Expected payload shape:
 * {
 *   "ticket_id": 12345,
 *   "message": "Customer message text...",
 *   "has_attachments": false
 * }
 */
app.post("/webhook/zendesk", async (req, res) => {
  const {
    ticket_id: ticketId,
    message,
    channel: payloadChannelType,
    has_attachments: hasAttachmentsRaw,
    audit_id: auditId
  } = req.body || {};
  const hasAttachments = toBoolean(hasAttachmentsRaw);

  // Fix #16: Webhook idempotency — skip duplicate audit processing.
  if (auditId) {
    const idempotencyKey = `${ticketId}:${auditId}`;
    if (processedWebhookAudits.has(idempotencyKey)) {
      metricsService.increment("webhook_duplicate_ignored_total");
      return res.status(200).json({
        success: true,
        action: "ignored",
        reason: "duplicate_webhook"
      });
    }
    processedWebhookAudits.set(idempotencyKey, Date.now());
    scheduleRuntimePersist();
  }

  // Validate the minimum contract early so upstream systems receive a clear error.
  if (!ticketId) {
    return res.status(400).json({
      success: false,
      error: "Invalid payload. 'ticket_id' is required."
    });
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
      return res.status(200).json({
        success: true,
        action: "ignored",
        reason: blockReason,
        channelType
      });
    }

    const latestUserMessage = getLatestUserMessage(messages);
    const latestMessage = getLatestPublicMessage(messages);
    const normalizedMessage = normalizeMessage(latestUserMessage?.content) || normalizeMessage(message);
    const latestMessageHasAttachments =
      Array.isArray(latestUserMessage?.attachments) && latestUserMessage.attachments.length > 0;

    if (!normalizedMessage && !latestMessageHasAttachments && !hasAttachments) {
      return res.status(200).json({
        success: true,
        action: "ignored",
        reason: "empty_customer_message",
        channelType
      });
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

      return res.status(200).json({
        success: true,
        action: "ignored_spam",
        channelType,
        reason: spamFilterResult.reason
      });
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

      return res.status(200).json({
        success: true,
        action: "attachment_escalation",
        channelType
      });
    }

    if (!latestMessage || latestMessage.role !== "user") {
      return res.status(200).json({
        success: true,
        action: "ignored",
        reason: "latest_message_not_user",
        channelType
      });
    }

    const temporarySession = {
      ticketId,
      requesterId: ticketSummary.requesterId,
      requesterName: ticketSummary.requesterName || "",
      requesterEmail: ticketSummary.requesterEmail || "",
      messages,
      lastKnowledgeSource: ""
    };
    memoryService.applyWorkingMemoryToSession(
      temporarySession,
      memoryService.extractLatestWorkingMemory(audits)
    );
    const { conversation, knowledge, outcome } = await resolveAutomatedOutcome(
      temporarySession,
      normalizedMessage,
      {
        hasAttachments: false,
        channelType
      }
    );

    if (outcome.type === "ask_clarifying_question") {
      await zendeskService.updateConversationState(ticketId, outcome.stateTag);
      await zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
        channelType,
        metadata: {
          libar_task_intent: conversation.reasoningResult?.taskIntent || ""
        }
      });
      await persistWorkingMemory(
        temporarySession,
        conversation,
        outcome,
        knowledge,
        ticketSummary,
        audits
      );
      await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome,
        userMessage: normalizedMessage,
        knowledge,
        channelType,
        conversation
      }));

      return res.status(200).json({
        success: true,
        action: "customer_detail_requested",
        channelType
      });
    }

    if (outcome.type !== "safe_answer") {
      await persistEscalation(
        ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType }
      );
      // Fix #8: Send customer-facing message for handoff outcomes.
      await Promise.all([
        zendeskService.updateConversationState(ticketId, outcome.stateTag),
        outcome.customerMessage
          ? zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, { channelType })
          : Promise.resolve(),
        persistWorkingMemory(
          temporarySession,
          conversation,
          outcome,
          knowledge,
          ticketSummary,
          audits
        ),
        zendeskService.addInternalNote(ticketId, buildAutopilotNote({
          outcome,
          userMessage: normalizedMessage,
          knowledge,
          channelType,
          conversation
        }))
      ]);

      return res.status(200).json({
        success: true,
        action: "ai_escalation",
        escalationType:
          outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        channelType
      });
    }

    // Fix #13: Parallelize independent Zendesk write calls.
    const safeAnswerTasks = [
      zendeskService.updateConversationState(ticketId, outcome.stateTag),
      zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
        channelType,
        additionalTags: outcome.source === "product_feed" ? ["product_feed_match"] : [],
        metadata: {
          ...(outcome.products?.length
            ? {
                libar_products: JSON.stringify(outcome.products)
              }
            : {}),
          libar_task_intent: conversation.reasoningResult?.taskIntent || ""
        }
      }),
      persistWorkingMemory(
        temporarySession,
        conversation,
        outcome,
        knowledge,
        ticketSummary,
        audits
      ),
      zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome,
        userMessage: normalizedMessage,
        knowledge,
        channelType,
        conversation
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

    return res.status(200).json({
      success: true,
      action: "customer_reply_sent",
      channelType
    });
  } catch (error) {
    // Keep the response clean for webhook consumers while logging the full detail locally.
    logError("Webhook processing failed:", {
      message: error.message,
      stack: error.stack,
      ticketId
    });

    return res.status(500).json({
      success: false,
      error: "Internal server error while processing Zendesk webhook."
    });
  }
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
  const message = normalizeMessage(req.body?.message);
  const entryIntent = normalizeEntryIntent(req.body?.entryIntent);
  const entryPromptAnswer = normalizeEntryPromptAnswer(req.body?.entryPromptAnswer);
  const entryFlowVersion = normalizeEntryFlowVersion(req.body?.entryFlowVersion);
  const files = getUploadedFiles(req);

  if (!name || !email || !message) {
    return res.status(400).json({
      success: false,
      error: "Name, email, and message are required."
    });
  }

  try {
    const reusableSession = findReusableChatStart({ name, email, message });

    if (reusableSession) {
      return buildExistingSessionStartResponse(reusableSession, res, {
        duplicateStartPrevented: true
      });
    }

    const initialSessionKey = randomUUID();
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
      requesterName: name,
      requesterEmail: email,
      initialMessage: message,
      subject: buildChatSubject(name),
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
      requesterName: name,
      requesterEmail: email,
      messages: [],
      entryIntent: entryIntent || null,
      entryPromptAnswer: entryPromptAnswer || "",
      entryFlowVersion: entryFlowVersion || null,
      entryFlowSkipped: entryFlowVersion === ENTRY_FLOW_VERSION && !entryIntent,
      externalId: initialSessionKey
    });
    const entryTopicPolicy = buildEntryTopicPolicy(entryIntent);
    session.entryTopicLock = entryTopicPolicy.entryTopicLock;
    session.entryTopicSourcePolicy = entryTopicPolicy.entryTopicSourcePolicy;
    session.entryTopicSetAt = session.entryTopicLock ? new Date().toISOString() : null;
    session.workingMemory = {
      entryTopicLock: session.entryTopicLock,
      entryTopicSourcePolicy: session.entryTopicSourcePolicy,
      customerProfile: {
        name,
        firstName: memoryService.getFirstName(name),
        email,
        source: "zendesk_requester"
      }
    };

    const { conversation, knowledge, outcome } = await resolveAutomatedOutcome(
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

    await zendeskService.updateConversationState(ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(ticketId, outcome.zendeskMessage || outcome.customerMessage, {
      channelType: "web_chat",
      metadata: {
        ...(outcome.products?.length
          ? {
              libar_products: JSON.stringify(outcome.products)
            }
          : {}),
        libar_task_intent: conversation.reasoningResult?.taskIntent || ""
      }
    });
    await persistWorkingMemory(session, conversation, outcome, knowledge, {
      requesterName: name,
      requesterEmail: email
    });
    await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
      outcome,
      userMessage: message,
      knowledge,
      channelType: "web_chat",
      conversation
    }));
    if (outcome.source === "product_feed" && outcome.zendeskSummary) {
      await zendeskService.addInternalNote(
        ticketId,
        `Product feed sažetak:\n${outcome.zendeskSummary}`
      );
    }
    const startSync = await syncSessionMessagesWithFallback(session, "chat_start_final_sync");
    attachProductsToLatestAssistantMessage(session, outcome.products, outcome.customerMessage);
    registerRecentChatStart({
      name,
      email,
      message,
      sessionId: session.sessionId,
      ticketId: session.ticketId
    });
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      degraded: startSync.degraded,
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
    const latestMemory = memoryService.extractLatestWorkingMemory(audits);

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
      memoryService.applyWorkingMemoryToSession(existingSession, latestMemory);
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
    memoryService.applyWorkingMemoryToSession(session, latestMemory);
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

    const { conversation, knowledge, outcome } = await resolveAutomatedOutcome(
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

    await zendeskService.updateConversationState(session.ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(
      session.ticketId,
      outcome.zendeskMessage || outcome.customerMessage,
      {
        channelType: "web_chat",
        metadata: {
          ...(outcome.products?.length
            ? {
                libar_products: JSON.stringify(outcome.products)
              }
            : {}),
          libar_task_intent: conversation.reasoningResult?.taskIntent || ""
        }
      }
    );
    await persistWorkingMemory(session, conversation, outcome, knowledge, ticketSummary);
    await zendeskService.addInternalNote(session.ticketId, buildAutopilotNote({
      outcome,
      userMessage: message || "Šaljem privitak.",
      knowledge,
      channelType: "web_chat",
      conversation
    }));
    if (outcome.source === "product_feed" && outcome.zendeskSummary) {
      await zendeskService.addInternalNote(
        session.ticketId,
        `Product feed sažetak:\n${outcome.zendeskSummary}`
      );
    }
    const messageSync = await syncSessionMessagesWithFallback(session, "chat_message_final_sync");
    attachProductsToLatestAssistantMessage(session, outcome.products, outcome.customerMessage);
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      degraded: messageSync.degraded,
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
    await persistWorkingMemory(
      session,
      null,
      buildLifecycleOutcome(session, "resolved"),
      null,
      resolvedTicketSummary,
      resolvedAudits
    );
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
        await persistWorkingMemory(
          session,
          null,
          buildLifecycleOutcome(session, "human-active"),
          null,
          ticketSummary,
          audits
        );
      } else if (session.conversationState?.tone === "awaiting-human") {
        await zendeskService.updateConversationState(ticketId, "awaiting_human");
        await persistWorkingMemory(
          session,
          null,
          buildLifecycleOutcome(session, "awaiting-human"),
          null,
          ticketSummary,
          audits
        );
      } else if (session.conversationState?.tone === "resolved") {
        await persistWorkingMemory(
          session,
          null,
          buildLifecycleOutcome(session, "resolved"),
          null,
          ticketSummary,
          audits
        );
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
  const checks = {
    zendesk: false,
    onedrive: oneDriveService.isConfigured() ? false : "not_configured"
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
    buildConversationAnalysis,
    buildAutopilotNote,
    buildConversationState,
    detectTicketChannelType,
    formatChannelLabel,
    getAutomationBlockReason,
    getChannelMessages,
    mapZendeskAuditsToMessages,
    normalizeChannelType,
    normalizeZendeskCommentContent
  }
};
