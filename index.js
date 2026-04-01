require("dotenv").config();

const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const multer = require("multer");
const zendeskService = require("./services/zendeskService");
const aiService = require("./services/aiService");

const app = express();
const chatSessions = new Map();
const chatStreams = new Map();
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5
  }
});

console.log("Loaded Zendesk config:", zendeskService.getZendeskConfigSummary());

// Parse incoming JSON bodies from Zendesk webhooks.
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

function mapZendeskCommentsToMessages(comments, requesterId) {
  return comments.map((comment) => ({
    id: String(comment.id),
    role: Number(comment.author_id) === Number(requesterId) ? "user" : "assistant",
    content: comment.plain_body || comment.body || "",
    createdAt: comment.created_at,
    sourceChannel: comment.via?.channel || null,
    authoredByHuman:
      Number(comment.author_id) !== Number(requesterId) && comment.via?.channel !== "api",
    attachments: Array.isArray(comment.attachments)
      ? comment.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.file_name,
          contentType: attachment.content_type,
          size: attachment.size,
          url: attachment.content_url
        }))
      : []
  }));
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

function buildConversationState(ticketSummary, messages) {
  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags : [];
  const humanAgentActive = messages.some(
    (message) => message.role === "assistant" && message.authoredByHuman
  );

  if (ticketSummary?.status === "solved" || ticketSummary?.status === "closed" || tags.includes("resolved")) {
    return {
      tone: "resolved",
      badge: "Riješeno",
      subtitle: "Razgovor je završen. Ako trebate još nešto, možete poslati novu poruku."
    };
  }

  if (humanAgentActive) {
    return {
      tone: "human-active",
      badge: "Agent uživo",
      subtitle: "Razgovor je preuzeo naš agent i odgovara vam izravno iz podrške."
    };
  }

  if (tags.includes("hitno_slike") || tags.includes("ai_eskalacija")) {
    return {
      tone: "awaiting-human",
      badge: "Ljudska provjera",
      subtitle: "Vaš upit je proslijeđen timu. Čim netko preuzme razgovor, odgovor stiže ovdje."
    };
  }

  return {
    tone: "ai-active",
    badge: "Aktivan",
    subtitle: "Libar Agent odgovara odmah, a po potrebi se u razgovor uključuje i naš tim."
  };
}

async function syncSessionMessages(session) {
  if (!session?.ticketId || !session?.requesterId) {
    return session;
  }

  const [comments, ticketSummary] = await Promise.all([
    zendeskService.getPublicTicketComments(session.ticketId),
    zendeskService.getTicketSummary(session.ticketId)
  ]);

  session.messages = mapZendeskCommentsToMessages(comments, session.requesterId);
  session.conversationState = buildConversationState(ticketSummary, session.messages);
  session.updatedAt = new Date().toISOString();

  return session;
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

function buildAutopilotNote({ outcome, userMessage, knowledge }) {
  const articleSummary = (knowledge?.articles || [])
    .map((article) => `${article.title} (${article.score})`)
    .join(", ");

  return [
    `AI outcome: ${outcome.type}`,
    `Upit korisnika: ${userMessage}`,
    knowledge?.topScore ? `Top relevantnost: ${knowledge.topScore}` : null,
    articleSummary ? `Korišteni članci: ${articleSummary}` : "Korišteni članci: nema",
    outcome.reason ? `Razlog: ${outcome.reason}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

async function determineChatOutcome(userMessage, knowledge, { hasAttachments = false } = {}) {
  if (hasAttachments) {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "attachments_present",
      customerMessage:
        "Hvala, primili smo vaše privitke. Naš tim će ih pregledati i javiti vam se uskoro."
    };
  }

  if (isHardHandoffMessage(userMessage)) {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "sensitive_or_complaint_topic",
      customerMessage:
        "Vaš upit zahtijeva ljudsku provjeru. Naš tim će vam se javiti u najkraćem mogućem roku."
    };
  }

  if (!knowledge?.context || !knowledge?.topScore || knowledge.topScore < 8) {
    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: "insufficient_context_confidence",
      customerMessage:
        "Trenutno nemam dovoljno sigurnih informacija za točan odgovor. Naš tim će pregledati upit i javiti vam se uskoro."
    };
  }

  const aiReply = await aiService.generateReply(userMessage, knowledge.context);

  if (aiReply === "[ESKALACIJA_HITNO]") {
    return {
      type: "hard_handoff",
      stateTag: "awaiting_human",
      reason: "ai_flagged_hard_handoff",
      customerMessage:
        "Vaš upit zahtijeva ljudsku provjeru. Naš tim će vam se javiti u najkraćem mogućem roku."
    };
  }

  if (aiReply === "[ESKALACIJA_NEZNANJE]") {
    return {
      type: "soft_handoff",
      stateTag: "awaiting_human",
      reason: "ai_flagged_unknown",
      customerMessage:
        "Trenutno nemam dovoljno sigurnih informacija za točan odgovor. Naš tim će pregledati upit i javiti vam se uskoro."
    };
  }

  return {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "context_grounded_answer",
    customerMessage: aiReply
  };
}

async function persistEscalation(ticketId, escalationType) {
  const noteText =
    escalationType === "[ESKALACIJA_HITNO]"
      ? "AI chat eskalacija: hitan ili osjetljiv webshop chat upit. Potrebna ljudska provjera."
      : "AI chat eskalacija: odgovor nije pronađen u bazi znanja. Potrebna ljudska provjera.";

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
  const { ticket_id: ticketId, message, has_attachments: hasAttachmentsRaw } = req.body || {};
  const hasAttachments = toBoolean(hasAttachmentsRaw);

  // Validate the minimum contract early so upstream systems receive a clear error.
  if (!ticketId || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: "Invalid payload. 'ticket_id' and non-empty 'message' are required."
    });
  }

  try {
    // 1. Guardrail: if images/files exist, stop AI processing immediately and escalate.
    if (hasAttachments) {
      await zendeskService.addTagAndNote(
        ticketId,
        "hitno_slike",
        "Korisnik je poslao slike. Potrebna ljudska provjera."
      );

      return res.status(200).json({
        success: true,
        action: "attachment_escalation"
      });
    }

    // 2. Retrieve the most relevant Help Center knowledge for the user message.
    const context = await zendeskService.searchHelpCenter(message);

    // 3. Ask the AI to generate a reply or an escalation token.
    const aiReply = await aiService.generateReply(message, context);

    // 4. Route escalation outputs to internal notes instead of customer replies.
    if (
      aiReply === "[ESKALACIJA_NEZNANJE]" ||
      aiReply === "[ESKALACIJA_HITNO]"
    ) {
      const noteText =
        aiReply === "[ESKALACIJA_HITNO]"
          ? "AI eskalacija: hitan ili osjetljiv upit. Potrebna ljudska provjera prije odgovora."
          : "AI eskalacija: odgovor nije pronađen u bazi znanja. Potrebna ljudska provjera.";

      await zendeskService.addTagAndNote(ticketId, "ai_eskalacija", noteText);

      return res.status(200).json({
        success: true,
        action: "ai_escalation",
        escalationType: aiReply
      });
    }

    // Shadow mode: write the AI draft as an internal note only.
    await zendeskService.replyToTicket(ticketId, aiReply, false);

    return res.status(200).json({
      success: true,
      action: "internal_note_added"
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
  const files = getUploadedFiles(req);

  if (!name || !email || !message) {
    return res.status(400).json({
      success: false,
      error: "Name, email, and message are required."
    });
  }

  try {
    const initialSessionKey = randomUUID();
    const uploadedAttachments = await zendeskService.uploadAttachments(files);
    const uploadTokens = uploadedAttachments.map((item) => item.token).filter(Boolean);
    const { ticketId, requesterId } = await zendeskService.createChatTicket({
      requesterName: name,
      requesterEmail: email,
      initialMessage: message,
      subject: buildChatSubject(name),
      uploadTokens,
      externalId: initialSessionKey
    });

    const session = {
      ...createSession({
      ticketId,
      requesterId,
      requesterName: name,
      requesterEmail: email,
      messages: []
      }),
      externalId: initialSessionKey
    };

    const knowledge = await zendeskService.searchHelpCenterDetailed(message);
    const outcome = await determineChatOutcome(message, knowledge, {
      hasAttachments: files.length > 0
    });

    if (files.length > 0) {
      await zendeskService.addTagAndNote(
        ticketId,
        "hitno_slike",
        "Korisnik je poslao privitke kroz webshop chat. Potrebna ljudska provjera."
      );
    }

    if (outcome.type !== "safe_answer") {
      await persistEscalation(ticketId, outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]");
    }

    await zendeskService.updateConversationState(ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(ticketId, outcome.customerMessage);
    await zendeskService.addInternalNote(ticketId, buildAutopilotNote({
      outcome,
      userMessage: message,
      knowledge
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
        conversationState: session.conversationState
      },
      ticketId,
      messages: getSession(session.sessionId).messages,
      conversationState: session.conversationState
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

    if (existingSession) {
      await syncSessionMessages(existingSession);

      return res.status(200).json({
        success: true,
        restored: true,
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

    await syncSessionMessages(session);

    return res.status(200).json({
      success: true,
      restored: true,
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
    const uploadedAttachments = await zendeskService.uploadAttachments(files);
    const uploadTokens = uploadedAttachments.map((item) => item.token).filter(Boolean);

    await zendeskService.addCustomerMessageToTicket(
      session.ticketId,
      session.requesterId,
      message || "Poslan je privitak.",
      uploadTokens
    );

    const knowledge = await zendeskService.searchHelpCenterDetailed(message);
    const outcome = await determineChatOutcome(message, knowledge, {
      hasAttachments: files.length > 0
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
        outcome.type === "hard_handoff" ? "[ESKALACIJA_HITNO]" : "[ESKALACIJA_NEZNANJE]"
      );
    }

    await zendeskService.updateConversationState(session.ticketId, outcome.stateTag);
    await zendeskService.addBotReplyToTicket(session.ticketId, outcome.customerMessage);
    await zendeskService.addInternalNote(session.ticketId, buildAutopilotNote({
      outcome,
      userMessage: message || "Poslan je privitak.",
      knowledge
    }));
    await syncSessionMessages(session);
    broadcastSessionUpdate(session);

    return res.status(200).json({
      success: true,
      ticketId: session.ticketId,
      messages: session.messages,
      conversationState: session.conversationState
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
