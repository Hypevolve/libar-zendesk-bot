require("dotenv").config();

const express = require("express");
const zendeskService = require("./services/zendeskService");
const aiService = require("./services/aiService");

const app = express();

console.log("Loaded Zendesk config:", zendeskService.getZendeskConfigSummary());

// Parse incoming JSON bodies from Zendesk webhooks.
app.use(express.json({ limit: "1mb" }));

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

// Basic health endpoint for local checks and deployment probes.
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "ok"
  });
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
