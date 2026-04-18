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

const app = express();
const chatSessions = new Map();
const chatStreams = new Map();
const KNOWLEDGE_MIN_TOP_SCORE = Number(process.env.KNOWLEDGE_MIN_TOP_SCORE) || 5;
const BLOCKED_AUTOPILOT_TAGS = new Set(["human_active", "resolved"]);
const ENTRY_FLOW_VERSION = "v1";
const ENTRY_INTENT_LABELS = {
  narudzba: "Narudžba",
  dostava: "Dostava",
  otkup_knjiga: "Otkup knjiga",
  reklamacija_problem: "Reklamacija ili problem",
  opci_upit: "Opći upit"
};
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5
  }
});

console.log("Loaded Zendesk config:", zendeskService.getZendeskConfigSummary());
console.log("Loaded OneDrive config:", oneDriveService.getOneDriveConfigSummary());

const EMBED_ALLOWED_ORIGINS = String(process.env.EMBED_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Parse incoming JSON bodies from Zendesk webhooks.
app.use(express.json({ limit: "1mb" }));
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

function createSession(payload) {
  const sessionId = randomUUID();
  const session = {
    sessionId,
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  chatSessions.set(sessionId, session);
  return session;
}

function findSessionByTicketId(ticketId) {
  for (const session of chatSessions.values()) {
    if (Number(session.ticketId) === Number(ticketId)) {
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

function normalizeZendeskCommentContent(comment = {}) {
  const sources = [comment.html_body, comment.plain_body, comment.body].filter(Boolean);

  if (sources.length === 0) {
    return "";
  }

  for (const source of sources) {
    const normalized = decodeHtmlEntities(stripHtmlWithLineBreaks(source))
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
  const humanAgentActive = messages.some(
    (message) => message.role === "assistant" && message.authoredByHuman
  );

  if (ticketSummary?.status === "solved" || ticketSummary?.status === "closed" || tags.includes("resolved")) {
    return {
      tone: "resolved",
      badge: "Riješeno",
      subtitle: "Ovaj razgovor je završen. Ako imate novo pitanje, možete započeti novi razgovor."
    };
  }

  if (humanAgentActive) {
    return {
      tone: "human-active",
      badge: "Podrška uživo",
      subtitle: "Naš tim nastavlja razgovor s vama ovdje u istoj niti."
    };
  }

  if (
    tags.includes("human_active")
  ) {
    return {
      tone: "human-active",
      badge: "Podrška uživo",
      subtitle: "Naš tim nastavlja razgovor s vama ovdje u istoj niti."
    };
  }

  if (
    tags.includes("awaiting_human") ||
    tags.includes("hitno_slike") ||
    tags.includes("ai_eskalacija")
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

  session.messages = mapZendeskAuditsToMessages(audits, session.requesterId, ticketSummary);
  session.conversationState = buildConversationState(ticketSummary, session.messages);
  session.resolutionPrompt = getResolutionPrompt(session, ticketSummary);
  session.updatedAt = new Date().toISOString();

  return session;
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
    "narudžb",
    "problem",
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

  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];
  const latestMessage = getLatestPublicMessage(messages);

  if (tags.some((tag) => BLOCKED_AUTOPILOT_TAGS.has(tag))) {
    return "human_active";
  }

  const conversationState = buildConversationState(ticketSummary, messages);

  if (conversationState.tone === "human-active") {
    return "human_active";
  }

  if (!latestMessage) {
    return "no_public_messages";
  }

  if (
    conversationState.tone === "awaiting-human" &&
    latestMessage.role !== "user"
  ) {
    return "awaiting_human";
  }

  if (latestMessage.role !== "user") {
    return "latest_message_not_user";
  }

  return null;
}

function getResolutionPrompt(session, ticketSummary) {
  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];
  const blockedTags = new Set(["ai_eskalacija", "hitno_slike", "awaiting_human", "human_active", "resolved"]);

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

function buildAutopilotNote({ outcome, userMessage, knowledge, channelType = "web_chat" }) {
  const sourceSummary = (knowledge?.articles || [])
    .map((article) => {
      const sourceType = article.source === "onedrive" ? "OneDrive dokument" : "Zendesk članak";
      return `${sourceType}: ${article.title} (${article.score})`;
    })
    .join(", ");

  return [
    `Kanal: ${formatChannelLabel(channelType)}`,
    `AI outcome: ${outcome.type}`,
    `Upit korisnika: ${userMessage}`,
    knowledge?.primarySource
      ? `Primarni izvor: ${knowledge.primarySource === "onedrive" ? "OneDrive" : "Zendesk"}`
      : null,
    knowledge?.topScore ? `Top relevantnost: ${knowledge.topScore}` : null,
    sourceSummary ? `Korišteni izvori: ${sourceSummary}` : "Korišteni izvori: nema",
    outcome.reason ? `Razlog: ${outcome.reason}` : null
  ]
    .filter(Boolean)
    .join("\n");
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
  const articles = Array.isArray(knowledge?.articles) ? knowledge.articles : [];
  const topArticle = articles[0] || null;

  if (!knowledge?.context || !knowledge?.topScore || !topArticle) {
    return false;
  }

  if (knowledge.topScore < Math.max(KNOWLEDGE_MIN_TOP_SCORE + 2, 8)) {
    return false;
  }

  return topArticle.source === "onedrive" || knowledge.primarySource === "onedrive";
}

async function determineChatOutcome(
  userMessage,
  knowledge,
  {
    hasAttachments = false,
    channelType = "web_chat"
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

  if (isHardHandoffMessage(userMessage)) {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "sensitive_or_complaint_topic",
      customerMessage: channelMessages.hardHandoff
    };
  }

  if (!knowledge?.context || !knowledge?.topScore || knowledge.topScore < KNOWLEDGE_MIN_TOP_SCORE) {
    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: "insufficient_context_confidence",
      customerMessage: channelMessages.softHandoff
    };
  }

  const aiDecision = await aiService.generateReply(userMessage, knowledge.context, {
    channelType
  });

  if (aiDecision.decision === "hard_handoff") {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: aiDecision.reason || "ai_flagged_hard_handoff",
      customerMessage: channelMessages.hardHandoff
    };
  }

  if (aiDecision.decision === "soft_handoff") {
    if (shouldAttemptGroundedAnswerFallback(knowledge)) {
      const focusedContext = buildFocusedKnowledgeContext(knowledge, 2);
      const groundedReply = await aiService.generateGroundedAnswer(userMessage, focusedContext, {
        channelType
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
    has_attachments: hasAttachmentsRaw
  } = req.body || {};
  const hasAttachments = toBoolean(hasAttachmentsRaw);

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

    const knowledge = await knowledgeService.searchKnowledgeDetailed(normalizedMessage);
    const outcome = await determineChatOutcome(normalizedMessage, knowledge, {
      hasAttachments: false,
      channelType
    });

    if (outcome.type !== "safe_answer") {
      await persistEscalation(
        ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType }
      );
      await zendeskService.updateConversationState(ticketId, outcome.stateTag);
      await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
        outcome,
        userMessage: normalizedMessage,
        knowledge,
        channelType
      }));

      return res.status(200).json({
        success: true,
        action: "ai_escalation",
        escalationType:
          outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        channelType
      });
    }

    await zendeskService.updateConversationState(ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
      channelType
    });
    await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
      outcome,
      userMessage: normalizedMessage,
      knowledge,
      channelType
    }));

    return res.status(200).json({
      success: true,
      action: "customer_reply_sent",
      channelType
    });
  } catch (error) {
    // Keep the response clean for webhook consumers while logging the full detail locally.
    console.error("Webhook processing failed:", {
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
app.post("/api/chat/start", chatUpload.array("attachments", 5), async (req, res) => {
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
    const uploadedAttachments = await zendeskService.uploadAttachments(files);
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

    const session = {
      ...createSession({
        ticketId,
        requesterId,
        requesterName: name,
        requesterEmail: email,
        messages: [],
        entryIntent: entryIntent || null,
        entryPromptAnswer: entryPromptAnswer || "",
        entryFlowVersion: entryFlowVersion || null,
        entryFlowSkipped: entryFlowVersion === ENTRY_FLOW_VERSION && !entryIntent
      }),
      externalId: initialSessionKey
    };

    const knowledge = await knowledgeService.searchKnowledgeDetailed(entryContextMessage);
    const outcome = await determineChatOutcome(entryContextMessage, knowledge, {
      hasAttachments: files.length > 0,
      channelType: "web_chat"
    });

    if (files.length > 0) {
      await zendeskService.addTagAndNote(
        ticketId,
        "hitno_slike",
        "Korisnik je poslao privitke kroz webshop chat. Potrebna ljudska provjera."
      );
    }

    if (outcome.type !== "safe_answer") {
      await persistEscalation(
        ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType: "web_chat" }
      );
    }

    await zendeskService.updateConversationState(ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage, {
      channelType: "web_chat"
    });
    await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
      outcome,
      userMessage: message,
      knowledge,
      channelType: "web_chat"
    }));
    await syncSessionMessages(session);
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
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
        conversationState: session.conversationState,
        resolutionPrompt: session.resolutionPrompt || null
      },
      ticketId,
      messages: getSession(session.sessionId).messages,
      conversationState: session.conversationState,
      resolutionPrompt: session.resolutionPrompt || null
    });
  } catch (error) {
    console.error("Failed to start webshop chat session:", {
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
    const [audits, ticketSummary] = await Promise.all([
      zendeskService.getTicketAudits(ticketId),
      zendeskService.getTicketSummary(ticketId)
    ]);
    const restoredMessages = mapZendeskAuditsToMessages(audits, requesterId, ticketSummary);

    if (isClosedTicketStatus(ticketSummary.status)) {
      if (existingSession) {
        chatSessions.delete(existingSession.sessionId);
      }

      return res.status(200).json({
        success: true,
        restored: true,
        mode: "closed_session",
        ...buildClosedSessionPayload({
          ticketSummary,
          requesterName,
          requesterEmail,
          messages: restoredMessages
        })
      });
    }

    if (existingSession && isActiveTicketStatus(ticketSummary.status)) {
      existingSession.messages = restoredMessages;
      existingSession.conversationState = buildConversationState(ticketSummary, existingSession.messages);
      existingSession.updatedAt = new Date().toISOString();

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
      requesterName: requesterName || "",
      requesterEmail: requesterEmail || "",
      messages: []
    });

    session.messages = restoredMessages;
    session.conversationState = buildConversationState(ticketSummary, session.messages);
    session.updatedAt = new Date().toISOString();

    return res.status(200).json({
      success: true,
      restored: true,
      mode: "active_session",
      session
    });
  } catch (error) {
    console.error("Failed to restore webshop chat session:", {
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
app.post("/api/chat/message", chatUpload.array("attachments", 5), async (req, res) => {
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
    const ticketSummary = await zendeskService.getTicketSummary(session.ticketId);

    if (isClosedTicketStatus(ticketSummary.status)) {
      console.info("resolved_block", {
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

    const uploadedAttachments = await zendeskService.uploadAttachments(files);
    const uploadTokens = uploadedAttachments.map((item) => item.token).filter(Boolean);

    await zendeskService.addCustomerMessageToTicket(
      session.ticketId,
      session.requesterId,
      message || "Šaljem privitak.",
      uploadTokens
    );

    await syncSessionMessages(session);

    if (
      session.conversationState?.tone === "human-active" ||
      session.conversationState?.tone === "awaiting-human" ||
      Array.isArray(ticketSummary.tags) &&
        (ticketSummary.tags.includes("human_active") || ticketSummary.tags.includes("awaiting_human"))
    ) {
      session.resolutionPrompt = null;
      console.info("human_pass_through", {
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

    const knowledge = await knowledgeService.searchKnowledgeDetailed(message);
    const outcome = await determineChatOutcome(message, knowledge, {
      hasAttachments: files.length > 0,
      channelType: "web_chat"
    });

    console.info("ai_autopilot", {
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

    if (outcome.type !== "safe_answer") {
      await persistEscalation(
        session.ticketId,
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]",
        { channelType: "web_chat" }
      );
    }

    await zendeskService.updateConversationState(session.ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(session.ticketId, outcome.customerMessage, {
      channelType: "web_chat"
    });
    await zendeskService.addInternalNote(session.ticketId, buildAutopilotNote({
      outcome,
      userMessage: message || "Šaljem privitak.",
      knowledge,
      channelType: "web_chat"
    }));
    await syncSessionMessages(session);
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      ticketId: session.ticketId,
      messages: session.messages,
      conversationState: session.conversationState,
      resolutionPrompt: session.resolutionPrompt || null
    });
  } catch (error) {
    console.error("Failed to continue webshop chat session:", {
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
    const ticketSummary = await zendeskService.getTicketSummary(session.ticketId);

    if (isClosedTicketStatus(ticketSummary.status)) {
      await syncSessionMessages(session);

      return res.status(200).json({
        success: true,
        action: "ticket_already_resolved",
        session,
        conversationState: session.conversationState,
        resolutionPrompt: null
      });
    }

    await syncSessionMessages(session);

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

    const freshTicketSummary = await zendeskService.getTicketSummary(session.ticketId);
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

    await syncSessionMessages(session);
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
    console.error("Failed to resolve webshop chat session:", {
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

  return syncSessionMessages(session)
    .then((syncedSession) =>
      res.status(200).json({
        success: true,
        session: syncedSession
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

  await syncSessionMessages(session);
  writeSseEvent(res, "session_update", { session });

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
    const ticketSummary = await zendeskService.getTicketSummary(ticketId);

    if (ticketSummary.status === "solved" || ticketSummary.status === "closed") {
      await zendeskService.updateConversationState(ticketId, "resolved");
    }

    for (const session of sessions) {
      await syncSessionMessages(session);

      if (session.conversationState?.tone === "human-active") {
        await zendeskService.updateConversationState(ticketId, "human_active");
      } else if (session.conversationState?.tone === "awaiting-human") {
        await zendeskService.updateConversationState(ticketId, "awaiting_human");
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
    console.error("Zendesk event webhook failed:", {
      ticketId,
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: "Unable to process Zendesk event webhook."
    });
  }
});

// Basic health endpoint for local checks and deployment probes.
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "ok"
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

app.get("/debug/zendesk/:ticketId", async (req, res) => {
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

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
