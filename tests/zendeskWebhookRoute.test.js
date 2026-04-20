const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const zendeskService = require("../services/zendeskService");
const spamFilterService = require("../services/spamFilterService");
const knowledgeService = require("../services/knowledgeService");
const aiService = require("../services/aiService");
const { resetRuntimeState, __internal } = require("../index");

function createAudit({
  id = "audit-1",
  createdAt = "2026-04-20T20:00:00.000Z",
  channel = "email",
  authorId = 2002,
  body = "Koje dostavne opcije nudite?"
} = {}) {
  return {
    id,
    author_id: authorId,
    created_at: createdAt,
    via: { channel },
    events: [
      {
        id: `${id}-comment`,
        type: "Comment",
        public: true,
        author_id: authorId,
        body,
        html_body: `<div>${body}</div>`,
        via: { channel }
      }
    ]
  };
}

test("extractZendeskWebhookEnvelope accepts nested Zendesk-style email payload", () => {
  const payload = {
    ticket: {
      id: 88797,
      via: {
        channel: "email"
      }
    },
    ticket_event: {
      id: 445566,
      comment: {
        body: "Koje dostavne opcije nudite?"
      }
    }
  };

  assert.deepEqual(__internal.extractZendeskWebhookEnvelope(payload), {
    ticketId: 88797,
    message: "Koje dostavne opcije nudite?",
    channelType: "email",
    auditId: 445566,
    hasAttachments: false
  });
});

test("webhook processing sends reply for nested email payload instead of rejecting it as invalid", async () => {
  const originalGetTicketSummary = zendeskService.getTicketSummary;
  const originalGetTicketAudits = zendeskService.getTicketAudits;
  const originalUpdateConversationState = zendeskService.updateConversationState;
  const originalAddBotReplyToTicket = zendeskService.addBotReplyToTicket;
  const originalAddInternalNote = zendeskService.addInternalNote;
  const originalEvaluateIncomingMessage = spamFilterService.evaluateIncomingMessage;
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const botReplies = [];

  zendeskService.getTicketSummary = async () => ({
    id: 88797,
    status: "open",
    tags: [],
    requesterId: 1001,
    requesterName: "Zrinko Kutnjak",
    requesterEmail: "zrinko@example.com"
  });
  zendeskService.getTicketAudits = async () => [
    createAudit({
      id: "audit-email-user",
      channel: "mail",
      body: "Koje dostavne opcije nudite?"
    })
  ];
  zendeskService.updateConversationState = async () => {};
  zendeskService.addBotReplyToTicket = async (ticketId, replyText, options = {}) => {
    botReplies.push({ ticketId, replyText, options });
  };
  zendeskService.addInternalNote = async () => {};
  spamFilterService.evaluateIncomingMessage = async () => ({
    shouldBlock: false,
    reason: "support_message"
  });
  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Izvor 1 (Zendesk Help Center):\nNaslov: Dostava\nSadržaj: Dostava je dostupna putem Box Now, GLS-a i Hrvatske pošte.",
    articles: [
      {
        title: "Dostava",
        body: "Dostava je dostupna putem Box Now, GLS-a i Hrvatske pošte.",
        score: 32,
        source: "zendesk"
      }
    ],
    topScore: 32,
    totalMatches: 1,
    primarySource: "zendesk"
  });
  aiService.generateGroundedAnswer = async () =>
    "Dostava je dostupna putem Box Now, GLS-a i Hrvatske pošte.";

  try {
    const result = await __internal.processZendeskWebhookPayload({
      ticket: {
        id: 88797,
        via: {
          channel: "email"
        }
      },
      ticket_event: {
        id: 445566,
        comment: {
          body: "Koje dostavne opcije nudite?"
        }
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.action, "customer_reply_sent");
    assert.equal(result.body.channelType, "email");

    assert.equal(botReplies.length, 1);
    assert.equal(botReplies[0].ticketId, 88797);
    assert.equal(
      botReplies[0].replyText,
      "Dostava je dostupna putem Box Now, GLS-a i Hrvatske pošte."
    );
    assert.equal(botReplies[0].options.channelType, "email");
  } finally {
    zendeskService.getTicketSummary = originalGetTicketSummary;
    zendeskService.getTicketAudits = originalGetTicketAudits;
    zendeskService.updateConversationState = originalUpdateConversationState;
    zendeskService.addBotReplyToTicket = originalAddBotReplyToTicket;
    zendeskService.addInternalNote = originalAddInternalNote;
    spamFilterService.evaluateIncomingMessage = originalEvaluateIncomingMessage;
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    resetRuntimeState();
  }
});

test("webhook processing rebuilds retrieval context from prior conversation for non-web channels", async () => {
  const originalGetTicketSummary = zendeskService.getTicketSummary;
  const originalGetTicketAudits = zendeskService.getTicketAudits;
  const originalUpdateConversationState = zendeskService.updateConversationState;
  const originalAddBotReplyToTicket = zendeskService.addBotReplyToTicket;
  const originalAddInternalNote = zendeskService.addInternalNote;
  const originalEvaluateIncomingMessage = spamFilterService.evaluateIncomingMessage;
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const recordedOptions = [];

  zendeskService.getTicketSummary = async () => ({
    id: 88798,
    status: "open",
    tags: [],
    requesterId: 1001,
    requesterName: "Zrinko Kutnjak",
    requesterEmail: "zrinko@example.com"
  });
  zendeskService.getTicketAudits = async () => [
    createAudit({
      id: "audit-user-1",
      createdAt: "2026-04-20T20:00:00.000Z",
      channel: "facebook",
      body: "Želim prodati knjige"
    }),
    {
      id: "audit-bot-1",
      author_id: 9999,
      created_at: "2026-04-20T20:01:00.000Z",
      via: { channel: "api" },
      metadata: {
        custom: {
          libar_message_role: "assistant",
          libar_message_origin: "facebook_ai",
          libar_task_intent: "buyback"
        }
      },
      events: [
        {
          id: "audit-bot-1-comment",
          type: "Comment",
          public: true,
          author_id: 9999,
          body: "Pošaljite naslov ili ISBN.",
          html_body: "<div>Pošaljite naslov ili ISBN.</div>",
          via: { channel: "api" }
        }
      ]
    },
    createAudit({
      id: "audit-user-2",
      createdAt: "2026-04-20T20:02:00.000Z",
      channel: "facebook",
      body: "Koje dostavne opcije nudite?"
    })
  ];
  zendeskService.updateConversationState = async () => {};
  zendeskService.addBotReplyToTicket = async () => {};
  zendeskService.addInternalNote = async () => {};
  spamFilterService.evaluateIncomingMessage = async () => ({
    shouldBlock: false,
    reason: "support_message"
  });
  knowledgeService.searchKnowledgeDetailed = async (_query, options = {}) => {
    recordedOptions.push(options);
    return {
      context: "Izvor 1 (OneDrive):\nNaslov: Dostava\nSadržaj: Dostava je dostupna putem GLS-a i BOXNOW paketomata.",
      articles: [
        {
          title: "Dostava",
          body: "Dostava je dostupna putem GLS-a i BOXNOW paketomata.",
          score: 28,
          source: "onedrive"
        }
      ],
      topScore: 28,
      totalMatches: 1,
      primarySource: "onedrive"
    };
  };
  aiService.generateGroundedAnswer = async () => "Dostava je dostupna putem GLS-a i BOXNOW paketomata.";

  try {
    const result = await __internal.processZendeskWebhookPayload({
      ticket: {
        id: 88798,
        via: {
          channel: "facebook"
        }
      },
      ticket_event: {
        id: 445567,
        comment: {
          body: "Koje dostavne opcije nudite?"
        }
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.action, "customer_reply_sent");
    assert.equal(result.body.channelType, "facebook");
    assert.equal(recordedOptions.length, 1);
    assert.equal(recordedOptions[0].taskIntent, "delivery");
    assert.equal(recordedOptions[0].activeDomain, "delivery");
  } finally {
    zendeskService.getTicketSummary = originalGetTicketSummary;
    zendeskService.getTicketAudits = originalGetTicketAudits;
    zendeskService.updateConversationState = originalUpdateConversationState;
    zendeskService.addBotReplyToTicket = originalAddBotReplyToTicket;
    zendeskService.addInternalNote = originalAddInternalNote;
    spamFilterService.evaluateIncomingMessage = originalEvaluateIncomingMessage;
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    resetRuntimeState();
  }
});
