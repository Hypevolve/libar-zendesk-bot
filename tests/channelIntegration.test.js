const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { __internal } = require("../index");

function buildPublicCommentAudit({
  id,
  createdAt,
  channel,
  authorId,
  body,
  metadata = {},
  extraEvents = []
}) {
  return {
    id,
    author_id: authorId,
    created_at: createdAt,
    via: { channel },
    metadata: {
      custom: metadata
    },
    events: [
      {
        id: `${id}-comment`,
        type: "Comment",
        public: true,
        author_id: authorId,
        body,
        html_body: `<div>${body}</div>`,
        via: { channel }
      },
      ...extraEvents
    ]
  };
}

test("facebook customer webhook message is not misclassified as assistant when author_id differs from requester", () => {
  const requesterId = 1001;
  const ticketSummary = {
    status: "open",
    tags: []
  };
  const audits = [
    buildPublicCommentAudit({
      id: "audit-bot",
      createdAt: "2026-04-20T18:00:00.000Z",
      channel: "api",
      authorId: 9999,
      body: "Javit ćemo vam se.",
      metadata: {
        libar_message_role: "assistant",
        libar_message_origin: "facebook_ai"
      },
      extraEvents: [
        {
          type: "Change",
          field_name: "tags",
          value: ["ai_replied"]
        }
      ]
    }),
    buildPublicCommentAudit({
      id: "audit-user",
      createdAt: "2026-04-20T18:05:00.000Z",
      channel: "facebook",
      authorId: 2002,
      body: "Imam još jedno pitanje oko dostave."
    })
  ];

  const messages = __internal.mapZendeskAuditsToMessages(audits, requesterId, ticketSummary);

  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(messages.at(-1)?.sourceChannel, "facebook");
  assert.equal(__internal.getAutomationBlockReason(ticketSummary, messages, "facebook"), null);
});

test("email customer webhook message is not misclassified as assistant when author_id differs from requester", () => {
  const requesterId = 1001;
  const ticketSummary = {
    status: "open",
    tags: []
  };
  const audits = [
    buildPublicCommentAudit({
      id: "audit-bot",
      createdAt: "2026-04-20T18:00:00.000Z",
      channel: "api",
      authorId: 9999,
      body: "Javit ćemo vam se čim pregledamo detalje.",
      metadata: {
        libar_message_role: "assistant",
        libar_message_origin: "email_ai"
      },
      extraEvents: [
        {
          type: "Change",
          field_name: "tags",
          value: ["ai_replied"]
        }
      ]
    }),
    buildPublicCommentAudit({
      id: "audit-user",
      createdAt: "2026-04-20T18:05:00.000Z",
      channel: "mail",
      authorId: 2002,
      body: "Možete li mi potvrditi adresu za preuzimanje?"
    })
  ];

  const messages = __internal.mapZendeskAuditsToMessages(audits, requesterId, ticketSummary);

  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(messages.at(-1)?.sourceChannel, "mail");
  assert.equal(__internal.getAutomationBlockReason(ticketSummary, messages, "email"), null);
});
