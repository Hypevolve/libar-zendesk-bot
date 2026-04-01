require("dotenv").config();

const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const multer = require("multer");
const zendeskService = require("./services/zendeskService");
const aiService = require("./services/aiService");

const app = express();
const chatSessions = new Map();
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

async function syncSessionMessages(session) {
  if (!session?.ticketId || !session?.requesterId) {
    return session;
  }

  const comments = await zendeskService.getPublicTicketComments(session.ticketId);
  session.messages = mapZendeskCommentsToMessages(comments, session.requesterId);
  session.updatedAt = new Date().toISOString();

  return session;
}

async function generateChatReply(userMessage) {
  const context = await zendeskService.searchHelpCenter(userMessage);
  const aiReply = await aiService.generateReply(userMessage, context);

  if (aiReply === "[ESKALACIJA_NEZNANJE]") {
    return {
      escalation: aiReply,
      customerMessage:
        "Trenutno nemam dovoljno informacija za siguran odgovor. Naš tim će pregledati upit i javiti vam se uskoro."
    };
  }

  if (aiReply === "[ESKALACIJA_HITNO]") {
    return {
      escalation: aiReply,
      customerMessage:
        "Vaš upit zahtijeva brzu ljudsku provjeru. Naš tim će vam se javiti u najkraćem mogućem roku."
    };
  }

  return {
    escalation: null,
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
    const uploadedAttachments = await zendeskService.uploadAttachments(files);
    const uploadTokens = uploadedAttachments.map((item) => item.token).filter(Boolean);
    const { ticketId, requesterId } = await zendeskService.createChatTicket({
      requesterName: name,
      requesterEmail: email,
      initialMessage: message,
      subject: buildChatSubject(name),
      uploadTokens
    });

    const session = createSession({
      ticketId,
      requesterId,
      requesterName: name,
      requesterEmail: email,
      messages: []
    });

    let replyResult;

    if (files.length > 0) {
      await zendeskService.addTagAndNote(
        ticketId,
        "hitno_slike",
        "Korisnik je poslao privitke kroz webshop chat. Potrebna ljudska provjera."
      );
      replyResult = {
        escalation: "[ESKALACIJA_HITNO]",
        customerMessage:
          "Hvala, primili smo vaše privitke. Naš tim će ih pregledati i javiti vam se uskoro."
      };
    } else {
      replyResult = await generateChatReply(message);
    }

    if (replyResult.escalation) {
      await persistEscalation(ticketId, replyResult.escalation);
    }

    await zendeskService.addBotReplyToTicket(ticketId, replyResult.customerMessage);
    await syncSessionMessages(session);

    return res.status(200).json({
      success: true,
      sessionId: session.sessionId,
      session: {
        sessionId: session.sessionId,
        ticketId: session.ticketId,
        requesterId: session.requesterId,
        requesterName: session.requesterName,
        requesterEmail: session.requesterEmail
      },
      ticketId,
      messages: getSession(session.sessionId).messages
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

    let replyResult;

    if (files.length > 0) {
      await zendeskService.addTagAndNote(
        session.ticketId,
        "hitno_slike",
        "Korisnik je poslao privitke kroz webshop chat. Potrebna ljudska provjera."
      );
      replyResult = {
        escalation: "[ESKALACIJA_HITNO]",
        customerMessage:
          "Hvala, primili smo vaše privitke. Naš tim će ih pregledati i javiti vam se uskoro."
      };
    } else {
      replyResult = await generateChatReply(message);
    }

    if (replyResult.escalation) {
      await persistEscalation(session.ticketId, replyResult.escalation);
    }

    await zendeskService.addBotReplyToTicket(session.ticketId, replyResult.customerMessage);
    await syncSessionMessages(session);

    return res.status(200).json({
      success: true,
      ticketId: session.ticketId,
      messages: session.messages
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
