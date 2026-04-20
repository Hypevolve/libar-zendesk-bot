const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { app, resetRuntimeState } = require("../index");
const zendeskService = require("../services/zendeskService");
const aiService = require("../services/aiService");
const knowledgeService = require("../services/knowledgeService");
const productService = require("../services/productService");
const spamFilterService = require("../services/spamFilterService");

function stubMethod(target, key, replacement, restoreList) {
  restoreList.push([target, key, target[key]]);
  target[key] = replacement;
}

function restoreMethods(restoreList) {
  while (restoreList.length > 0) {
    const [target, key, original] = restoreList.pop();
    target[key] = original;
  }
}

function createFakeZendesk() {
  let nextTicketId = 1000;
  let nextRequesterId = 5000;
  let nextAuditId = 1;
  const agentId = 999001;
  const tickets = new Map();
  const publicReplies = [];
  const internalNotes = [];

  function nowIso() {
    return new Date(Date.now() + nextAuditId * 1000).toISOString();
  }

  function buildAudit({
    ticketId,
    authorId,
    body,
    channel,
    isPublic = true,
    metadata = {},
    attachments = []
  }) {
    const auditId = nextAuditId++;
    return {
      id: auditId,
      author_id: authorId,
      created_at: nowIso(),
      via: {
        channel
      },
      metadata: {
        custom: metadata
      },
      events: [
        {
          id: auditId,
          type: "Comment",
          author_id: authorId,
          public: isPublic,
          via: {
            channel
          },
          body,
          plain_body: body,
          html_body: body,
          attachments
        }
      ],
      _ticketId: ticketId
    };
  }

  function ensureTicket(ticketId) {
    const ticket = tickets.get(Number(ticketId));
    if (!ticket) {
      throw new Error(`Unknown fake ticket ${ticketId}`);
    }
    return ticket;
  }

  function applyStateTag(ticket, stateTag) {
    const transientTags = new Set([
      "human_active",
      "awaiting_human",
      "awaiting_customer_detail",
      "resolved"
    ]);
    ticket.summary.tags = (ticket.summary.tags || []).filter((tag) => !transientTags.has(tag));

    if (stateTag === "awaiting_human") {
      ticket.summary.tags.push("awaiting_human");
    } else if (stateTag === "awaiting_customer_detail") {
      ticket.summary.tags.push("awaiting_customer_detail");
    } else if (stateTag === "human_active") {
      ticket.summary.tags.push("human_active");
    } else if (stateTag === "resolved") {
      ticket.summary.tags.push("resolved");
      ticket.summary.status = "solved";
    }
  }

  function seedInboundTicket({
    channel,
    requesterName,
    requesterEmail,
    message,
    tags = [],
    attachments = []
  }) {
    const ticketId = nextTicketId++;
    const requesterId = nextRequesterId++;
    const summary = {
      id: ticketId,
      status: "open",
      tags: [...tags],
      requesterId,
      requesterName,
      requesterEmail
    };
    const audits = [
      buildAudit({
        ticketId,
        authorId: requesterId,
        body: message,
        channel,
        isPublic: true,
        attachments
      })
    ];
    tickets.set(ticketId, {
      summary,
      audits
    });
    return {
      ticketId,
      requesterId
    };
  }

  return {
    state: {
      tickets,
      publicReplies,
      internalNotes
    },
    seedInboundTicket,
    uploadAttachments: async (files = []) =>
      files.map((file, index) => ({
        token: `upload-${index + 1}`,
        fileName: file.originalname || file.name || `file-${index + 1}`
      })),
    createChatTicket: async ({
      requesterName,
      requesterEmail,
      initialMessage,
      additionalTags = [],
      externalId = null
    }) => {
      const ticketId = nextTicketId++;
      const requesterId = nextRequesterId++;
      const summary = {
        id: ticketId,
        status: "new",
        tags: ["webshop_chat", ...additionalTags],
        requesterId,
        requesterName,
        requesterEmail,
        externalId
      };
      const audits = [
        buildAudit({
          ticketId,
          authorId: requesterId,
          body: initialMessage,
          channel: "web",
          isPublic: true
        })
      ];
      tickets.set(ticketId, {
        summary,
        audits
      });
      return {
        ticketId,
        requesterId
      };
    },
    addCustomerMessageToTicket: async (ticketId, requesterId, body, uploadTokens = []) => {
      const ticket = ensureTicket(ticketId);
      ticket.audits.push(buildAudit({
        ticketId,
        authorId: requesterId,
        body,
        channel: "web",
        isPublic: true,
        attachments: uploadTokens.map((token, index) => ({
          id: `${token}-${index}`,
          file_name: `${token}.jpg`,
          content_type: "image/jpeg",
          size: 1000,
          content_url: `https://example.com/${token}`
        }))
      }));
    },
    addBotReplyToTicket: async (ticketId, body, { channelType = "web_chat", metadata = {} } = {}) => {
      const ticket = ensureTicket(ticketId);
      publicReplies.push({
        ticketId,
        body,
        channelType,
        metadata
      });
      ticket.audits.push(buildAudit({
        ticketId,
        authorId: agentId,
        body,
        channel:
          channelType === "facebook"
            ? "facebook"
            : channelType === "email"
              ? "email"
              : "api",
        isPublic: true,
        metadata: {
          ...metadata,
          libar_message_role: "assistant"
        }
      }));
    },
    addInternalNote: async (ticketId, body) => {
      ensureTicket(ticketId);
      internalNotes.push({
        ticketId,
        body
      });
    },
    addTagAndNote: async (ticketId, tag, note) => {
      const ticket = ensureTicket(ticketId);
      if (!ticket.summary.tags.includes(tag)) {
        ticket.summary.tags.push(tag);
      }
      internalNotes.push({
        ticketId,
        body: note
      });
    },
    updateConversationState: async (ticketId, stateTag) => {
      const ticket = ensureTicket(ticketId);
      applyStateTag(ticket, stateTag);
    },
    solveTicket: async (ticketId, options = {}) => {
      const ticket = ensureTicket(ticketId);

      ticket.summary.status = "solved";

      for (const tag of options.additionalTags || []) {
        if (!ticket.summary.tags.includes(tag)) {
          ticket.summary.tags.push(tag);
        }
      }

      if (options.commentBody) {
        ticket.audits.push(buildAudit({
          ticketId,
          authorId: agentId,
          body: options.commentBody,
          channel: "api",
          isPublic: true,
          metadata: {
            libar_message_role: "assistant"
          }
        }));
      }
    },
    addHumanReply: ({ ticketId, body, channel = "email" }) => {
      const ticket = ensureTicket(ticketId);
      ticket.audits.push(buildAudit({
        ticketId,
        authorId: agentId,
        body,
        channel,
        isPublic: true,
        metadata: {}
      }));
    },
    addUserReply: ({ ticketId, body, channel = "email", attachments = [] }) => {
      const ticket = ensureTicket(ticketId);
      ticket.audits.push(buildAudit({
        ticketId,
        authorId: ticket.summary.requesterId,
        body,
        channel,
        isPublic: true,
        attachments
      }));
    },
    getTicketSummary: async (ticketId) => {
      const ticket = ensureTicket(ticketId);
      return {
        ...ticket.summary,
        tags: [...ticket.summary.tags]
      };
    },
    getTicketAudits: async (ticketId) => {
      const ticket = ensureTicket(ticketId);
      return ticket.audits.map((audit) => ({
        ...audit,
        events: audit.events.map((event) => ({
          ...event,
          attachments: Array.isArray(event.attachments) ? [...event.attachments] : []
        }))
      }));
    }
  };
}

function getRouteHandler(method, routePath) {
  const stack = app._router?.stack || [];
  const layer = stack.find((entry) => entry.route?.path === routePath && entry.route?.methods?.[method]);

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${routePath} not found`);
  }

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    writes: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end(payload = null) {
      this.body = payload;
      return this;
    },
    sendFile(filePath) {
      this.body = { filePath };
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = {
        ...this.headers,
        ...headers
      };
      return this;
    },
    write(chunk) {
      this.writes.push(String(chunk));
      return true;
    }
  };
}

async function invokeRoute(method, routePath, reqOverrides = {}) {
  const handler = getRouteHandler(method, routePath);
  const reqListeners = new Map();
  const req = {
    body: {},
    files: [],
    headers: {},
    query: {},
    params: {},
    method: method.toUpperCase(),
    ip: "127.0.0.1",
    on(event, callback) {
      reqListeners.set(event, callback);
    },
    emit(event) {
      const listener = reqListeners.get(event);
      if (listener) {
        listener();
      }
    },
    ...reqOverrides
  };
  const res = createMockResponse();
  res.req = req;

  await handler(req, res);
  return res;
}

async function withRuntimeReset(run) {
  try {
    await run();
  } finally {
    resetRuntimeState();
  }
}

function buildKnowledgeResult({
  source = "zendesk",
  title,
  body,
  score = 18
}) {
  return {
    context: [
      "Izvor 1:",
      `Tip: ${source === "onedrive" ? "OneDrive dokument" : "Zendesk članak"}`,
      `Naslov: ${title}`,
      `Relevantnost: ${score}`,
      `Sadržaj: ${body}`
    ].join("\n"),
    articles: [
      {
        source,
        title,
        body,
        score,
        rankingScore: score
      }
    ],
    topScore: score,
    quality: {
      scoreMargin: 4,
      relevanceMatch: true,
      domainMatch: true,
      jobMatch: true,
      directAnswerability: true,
      hasConflict: false,
      conflictFields: [],
      contextConsistency: true,
      isStrong: true,
      isWeak: false
    },
    primarySource: source
  };
}

test("web chat flow keeps support info follow-up on knowledge path and supports restore", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(productService, "searchProducts", async (query) => {
    if (/algebra 1/i.test(query)) {
      return {
        topScore: 97,
        zendeskSummary: "Algebra 1",
        products: [
          {
            title: "Algebra 1",
            priceLabel: "12,00 €",
            buyLink: "https://antikvarijat-libar.com/algebra-1"
          }
        ]
      };
    }

    return null;
  }, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async (query, options = {}) => {
    if (options.activeDomain === "buyback") {
      return buildKnowledgeResult({
        source: "onedrive",
        title: "Otkup knjiga - postupak",
        body: "Za otkup donesite knjige u antikvarijat ili pošaljite popis za procjenu."
      });
    }

    return buildKnowledgeResult({
      source: "zendesk",
      title: "Radno vrijeme i kontakt",
      body: "Radimo ponedjeljak-petak 08:00-20:00, subotom 08:00-13:00."
    });
  }, restoreList);
  stubMethod(aiService, "generateReply", async (message, _context, options = {}) => {
    if (options.reasoningResult?.activeDomain === "buyback") {
      return {
        decision: "safe_answer",
        reply: "Knjige možete donijeti u antikvarijat ili poslati popis za procjenu.",
        clarifying_question: "",
        reason: "context_supported"
      };
    }

    if (options.reasoningResult?.activeDomain === "support_info") {
      return {
        decision: "safe_answer",
        reply: "Radimo od ponedjeljka do petka 08:00-20:00, a subotom 08:00-13:00.",
        clarifying_question: "",
        reason: "context_supported"
      };
    }

    return {
      decision: "safe_answer",
      reply: "Našao sam knjigu Algebra 1.",
      clarifying_question: "",
      reason: "context_supported"
    };
  }, restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Želim prodati knjige",
          entryIntent: "otkup_knjiga",
          entryFlowVersion: "v1"
        }
      });
      assert.equal(startResponse.statusCode, 200);

      const startJson = startResponse.body;
      assert.equal(startJson.session.entryTopicLock, "buyback");
      assert.equal(startJson.messages.at(-1).supportTaskIntent, "buyback");
      assert.deepEqual(startJson.messages.at(-1).products, []);

      const followUpResponse = await invokeRoute("post", "/api/chat/message", {
        body: {
          sessionId: startJson.sessionId,
          message: "Koje vam je radno vrijeme?"
        }
      });
      assert.equal(followUpResponse.statusCode, 200);

      const followUpJson = followUpResponse.body;
      const latestAssistant = [...followUpJson.messages].reverse().find((message) => message.role === "assistant");
      assert.equal(latestAssistant.supportTaskIntent, "support_info");
      assert.deepEqual(latestAssistant.products, []);

      const restoreResponse = await invokeRoute("post", "/api/chat/restore", {
        body: {
          ticketId: startJson.ticketId,
          requesterId: startJson.session.requesterId,
          requesterName: "Ana Horvat",
          requesterEmail: "ana@example.com"
        }
      });
      assert.equal(restoreResponse.statusCode, 200);

      const restoreJson = restoreResponse.body;
      assert.equal(restoreJson.mode, "active_session");
      assert.equal(restoreJson.session.messages.at(-1).supportTaskIntent, "support_info");
      assert.equal(fakeZendesk.state.publicReplies.length >= 2, true);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("web chat start reuses existing active session instead of opening duplicate ticket", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Kontakt",
    body: "Javite nam se kroz chat i pomoći ćemo."
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    reply: "Rado ćemo pomoći.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const firstResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Trebam pomoć oko dostave"
        }
      });

      const secondResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Trebam pomoć oko dostave"
        }
      });

      assert.equal(firstResponse.statusCode, 200);
      assert.equal(secondResponse.statusCode, 200);
      assert.equal(secondResponse.body.duplicateStartPrevented, true);
      assert.equal(secondResponse.body.sessionId, firstResponse.body.sessionId);
      assert.equal(fakeZendesk.state.tickets.size, 1);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("health endpoint exposes runtime metrics after duplicate prevention", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Kontakt",
    body: "Javite nam se kroz chat i pomoći ćemo."
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    reply: "Rado ćemo pomoći.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Trebam pomoć oko dostave"
        }
      });

      await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Trebam pomoć oko dostave"
        }
      });

      const healthResponse = await invokeRoute("get", "/health");

      assert.equal(healthResponse.statusCode, 200);
      assert.ok(
        Number(healthResponse.body.metrics?.counters?.duplicate_chat_start_prevented_total || 0) >= 1
      );
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("deterministic KB reply answers strong support query even when AI generation fails", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Radno vrijeme i kontakt",
    body:
      "Radimo ponedjeljak-petak 08:00-20:00. " +
      "Subotom radimo 08:00-13:00."
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => {
    throw new Error("AI should not be called for deterministic KB replies");
  }, restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Test Kupac",
          email: "test@example.com",
          message: "Koje vam je radno vrijeme subotom?"
        }
      });

      assert.equal(startResponse.statusCode, 200);
      const payload = startResponse.body;
      const assistantReply = payload.messages.findLast((message) => message.role === "assistant")?.content || "";

      assert.equal(payload.success, true);
      assert.match(assistantReply, /Subotom radimo 08:00-13:00/i);
      assert.match(assistantReply, /https:\/\/antikvarijat-libar\.com\/kontakt\//i);

      const healthResponse = await invokeRoute("get", "/health");

      assert.equal(healthResponse.statusCode, 200);
      assert.ok(
        Number(healthResponse.body.metrics?.counters?.deterministic_kb_answer_total || 0) >= 1
      );
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("buyback safe answer appends direct Libar website link", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => ({
    context: "Izvor 1:\nTip: OneDrive dokument\nNaslov: Otkup udžbenika\nRelevantnost: 19\nSadržaj: Udžbenike možete prodati online kroz obrazac za otkup.",
    articles: [
      {
        source: "onedrive",
        title: "Otkup udžbenika",
        body: "Udžbenike možete prodati online kroz obrazac za otkup.",
        score: 19,
        rankingScore: 19
      }
    ],
    topScore: 19,
    quality: {
      scoreMargin: 4,
      relevanceMatch: true,
      domainMatch: true,
      jobMatch: true,
      directAnswerability: true,
      hasConflict: false,
      conflictFields: [],
      contextConsistency: true,
      isStrong: true,
      isWeak: false
    },
    primarySource: "onedrive"
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    reply: "Udžbenike možete prodati online kroz obrazac za otkup.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Test Kupac",
          email: "test@example.com",
          message: "Želim prodati knjige, koji je postupak?"
        }
      });

      assert.equal(startResponse.statusCode, 200);
      const assistantReply = startResponse.body.messages.findLast((message) => message.role === "assistant")?.content || "";

      assert.match(assistantReply, /obrazac za otkup/i);
      assert.match(assistantReply, /https:\/\/antikvarijat-libar\.com\/prodaj-udzbenike\//i);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("facebook webhook handles support shift and deduplicates repeated audits", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();
  const seeded = fakeZendesk.seedInboundTicket({
    channel: "facebook",
    requesterName: "Zrinko Kutnjak",
    requesterEmail: "zrinko@example.com",
    message: "Htio bih prodati knjige"
  });

  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async (query, options = {}) => {
    if (options.activeDomain === "buyback") {
      return buildKnowledgeResult({
        source: "onedrive",
        title: "Otkup knjiga - postupak",
        body: "Za otkup donesite knjige u antikvarijat ili pošaljite popis za procjenu."
      });
    }

    return buildKnowledgeResult({
      source: "zendesk",
      title: "Radno vrijeme i kontakt",
      body: "Radimo ponedjeljak-petak 08:00-20:00, subotom 08:00-13:00."
    });
  }, restoreList);
  stubMethod(aiService, "generateReply", async (_message, _context, options = {}) => ({
    decision: "safe_answer",
    reply:
      options.reasoningResult?.activeDomain === "support_info"
        ? "Radimo od ponedjeljka do petka 08:00-20:00, a subotom 08:00-13:00."
        : "Knjige možete donijeti u antikvarijat ili poslati popis za procjenu.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const firstResponse = await invokeRoute("post", "/webhook/zendesk", {
        body: {
          ticket_id: seeded.ticketId,
          audit_id: "fb-a1",
          channel: "facebook"
        }
      });
      assert.equal(firstResponse.statusCode, 200);
      const firstJson = firstResponse.body;
      assert.equal(firstJson.action, "customer_reply_sent");
      assert.equal(firstJson.channelType, "facebook");
      assert.equal(fakeZendesk.state.publicReplies.at(-1).metadata.libar_task_intent, "buyback");

      const duplicateResponse = await invokeRoute("post", "/webhook/zendesk", {
        body: {
          ticket_id: seeded.ticketId,
          audit_id: "fb-a1",
          channel: "facebook"
        }
      });
      const duplicateJson = duplicateResponse.body;
      assert.equal(duplicateJson.reason, "duplicate_webhook");

      const ticket = fakeZendesk.state.tickets.get(seeded.ticketId);
      const requesterId = ticket.summary.requesterId;
      ticket.audits.push({
        id: 9999,
        author_id: requesterId,
        created_at: new Date(Date.now() + 5000).toISOString(),
        via: { channel: "facebook" },
        metadata: { custom: {} },
        events: [
          {
            id: 9999,
            type: "Comment",
            author_id: requesterId,
            public: true,
            via: { channel: "facebook" },
            body: "Koje vam je radno vrijeme?",
            plain_body: "Koje vam je radno vrijeme?",
            html_body: "Koje vam je radno vrijeme?",
            attachments: []
          }
        ]
      });

      const shiftResponse = await invokeRoute("post", "/webhook/zendesk", {
        body: {
          ticket_id: seeded.ticketId,
          audit_id: "fb-a2",
          channel: "facebook"
        }
      });
      assert.equal(shiftResponse.statusCode, 200);
      const shiftJson = shiftResponse.body;
      assert.equal(shiftJson.channelType, "facebook");
      assert.equal(fakeZendesk.state.publicReplies.at(-1).metadata.libar_task_intent, "support_info");
      const latestInternalNote = fakeZendesk.state.internalNotes.at(-1).body;
      assert.match(latestInternalNote, /Kanal: facebook/);
      assert.match(latestInternalNote, /Ishod:/);
      assert.match(latestInternalNote, /Korišteni izvori:/);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("email webhook blocks spam before automation", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();
  const seeded = fakeZendesk.seedInboundTicket({
    channel: "email",
    requesterName: "Spam Sender",
    requesterEmail: "spam@example.com",
    message: "Guest post opportunity for your website"
  });

  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: true,
    classification: "spam",
    reason: "guest_post_pitch",
    matchedSignals: ["guest_post_pitch"],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);

  try {
    await withRuntimeReset(async () => {
      const response = await invokeRoute("post", "/webhook/zendesk", {
        body: {
          ticket_id: seeded.ticketId,
          audit_id: "em-a1",
          channel: "email"
        }
      });
      assert.equal(response.statusCode, 200);

      const json = response.body;
      assert.equal(json.action, "ignored_spam");
      assert.equal(json.channelType, "email");
      assert.match(fakeZendesk.state.internalNotes.at(-1).body, /Spam filter \(email\)/);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("web lifecycle resolve flow solves ticket and blocks further replies on old thread", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "solveTicket", fakeZendesk.solveTicket, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "onedrive",
    title: "Otkup knjiga - postupak",
    body: "Knjige možete donijeti u antikvarijat ili poslati popis za procjenu."
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    reply: "Knjige možete donijeti u antikvarijat ili poslati popis za procjenu.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Želim prodati knjige",
          entryIntent: "otkup_knjiga",
          entryFlowVersion: "v1"
        }
      });
      const startJson = startResponse.body;

      const resolvePromptResponse = await invokeRoute("post", "/api/chat/message", {
        body: {
          sessionId: startJson.sessionId,
          message: "hvala, riješeno je"
        }
      });
      assert.equal(resolvePromptResponse.statusCode, 200);
      assert.equal(resolvePromptResponse.body.resolutionPrompt?.show, true);

      const resolveResponse = await invokeRoute("post", "/api/chat/resolve", {
        body: {
          sessionId: startJson.sessionId,
          confirmed: true
        }
      });
      assert.equal(resolveResponse.statusCode, 200);
      assert.equal(resolveResponse.body.action, "ticket_solved");
      assert.equal(resolveResponse.body.conversationState.tone, "resolved");

      const followUpResponse = await invokeRoute("post", "/api/chat/message", {
        body: {
          sessionId: startJson.sessionId,
          message: "Imam još jedno pitanje"
        }
      });
      assert.equal(followUpResponse.statusCode, 409);
      assert.equal(followUpResponse.body.conversationState.tone, "resolved");
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("zendesk event webhook flips sessions into human_active and resolved states", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "solveTicket", fakeZendesk.solveTicket, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(zendeskService, "verifyWebhookToken", () => true, restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Radno vrijeme i kontakt",
    body: "Radimo ponedjeljak-petak 08:00-20:00."
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    reply: "Radimo ponedjeljak-petak 08:00-20:00.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Koje vam je radno vrijeme?",
          entryIntent: "opci_upit",
          entryFlowVersion: "v1"
        }
      });
      const startJson = startResponse.body;

      fakeZendesk.addHumanReply({
        ticketId: startJson.ticketId,
        body: "Naš tim preuzima razgovor."
      });

      const humanEventResponse = await invokeRoute("post", "/webhook/zendesk/events", {
        headers: {
          "x-zendesk-webhook-token": "valid"
        },
        body: {
          ticket_id: startJson.ticketId
        }
      });
      assert.equal(humanEventResponse.statusCode, 200);
      assert.equal(humanEventResponse.body.updatedSessions, 1);

      const sessionAfterHuman = await invokeRoute("get", "/api/chat/session/:sessionId", {
        params: {
          sessionId: startJson.sessionId
        }
      });
      assert.equal(sessionAfterHuman.body.session.conversationState.tone, "human-active");

      fakeZendesk.state.tickets.get(startJson.ticketId).summary.status = "solved";
      const resolvedEventResponse = await invokeRoute("post", "/webhook/zendesk/events", {
        headers: {
          "x-zendesk-webhook-token": "valid"
        },
        body: {
          ticket_id: startJson.ticketId
        }
      });
      assert.equal(resolvedEventResponse.statusCode, 200);

      const sessionAfterResolved = await invokeRoute("get", "/api/chat/session/:sessionId", {
        params: {
          sessionId: startJson.sessionId
        }
      });
      assert.equal(sessionAfterResolved.body.session.conversationState.tone, "resolved");
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("zendesk event webhook rejects invalid tokens", async () => {
  const restoreList = [];

  stubMethod(zendeskService, "verifyWebhookToken", () => false, restoreList);

  try {
    await withRuntimeReset(async () => {
      const response = await invokeRoute("post", "/webhook/zendesk/events", {
        headers: {
          "x-zendesk-webhook-token": "invalid"
        },
        body: {
          ticket_id: 123
        }
      });

      assert.equal(response.statusCode, 401);
      assert.match(response.body.error, /Invalid Zendesk webhook token/);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("chat stream sends initial session update and subsequent broadcast", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(productService, "searchProducts", async () => null, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Radno vrijeme i kontakt",
    body: "Radimo ponedjeljak-petak 08:00-20:00."
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    reply: "Radimo ponedjeljak-petak 08:00-20:00.",
    clarifying_question: "",
    reason: "context_supported"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Koje vam je radno vrijeme?",
          entryIntent: "opci_upit",
          entryFlowVersion: "v1"
        }
      });
      const startJson = startResponse.body;

      const streamResponse = await invokeRoute("get", "/api/chat/stream/:sessionId", {
        params: {
          sessionId: startJson.sessionId
        }
      });
      assert.equal(streamResponse.statusCode, 200);
      assert.ok(streamResponse.writes.some((chunk) => chunk.includes("event: session_update")));

      const writesBeforeMessage = streamResponse.writes.length;
      await invokeRoute("post", "/api/chat/message", {
        body: {
          sessionId: startJson.sessionId,
          message: "A gdje se nalazite?"
        }
      });
      assert.ok(streamResponse.writes.length > writesBeforeMessage);
      assert.ok(streamResponse.writes.filter((chunk) => chunk.includes("event: session_update")).length >= 2);

      streamResponse.req?.emit?.("close");
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("knowledge failure falls back to soft handoff instead of route crash", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => {
    throw new Error("Knowledge backend unavailable");
  }, restoreList);

  try {
    await withRuntimeReset(async () => {
      const response = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Koje vam je radno vrijeme?",
          entryIntent: "opci_upit",
          entryFlowVersion: "v1"
        }
      });

      assert.equal(response.statusCode, 200);
      const latestAssistant = [...response.body.messages].reverse().find((message) => message.role === "assistant");
      assert.match(latestAssistant.content, /Ne želim|Ne zelim/);
      assert.equal(response.body.conversationState.tone, "awaiting-human");
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("attachment upload failure returns retryable web error instead of crashing", async () => {
  const restoreList = [];

  stubMethod(zendeskService, "uploadAttachments", async () => {
    throw new Error("Upload unavailable");
  }, restoreList);

  try {
    await withRuntimeReset(async () => {
      const response = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Ana Horvat",
          email: "ana@example.com",
          message: "Šaljem privitak"
        },
        files: [
          {
            originalname: "slika.jpg",
            mimetype: "image/jpeg",
            size: 1024,
            buffer: Buffer.from("x")
          }
        ]
      });

      assert.equal(response.statusCode, 503);
      assert.match(response.body.error, /Privitke trenutno ne možemo obraditi/);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("web restore falls back to existing session when Zendesk is temporarily unavailable", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "onedrive",
    title: "Otkup udžbenika",
    body: "Donesite knjige u antikvarijat i pripremite OIB.",
    score: 19
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => ({
    products: [],
    total: 0,
    exact: false,
    query: ""
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    confidence: 0.94,
    reply: "Udžbenike možete donijeti u antikvarijat.",
    reasoning: "kb"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Zrinko Kutnjak",
          email: "zrinko@example.com",
          message: "Želim prodati knjige"
        }
      });

      assert.equal(startResponse.statusCode, 200);

      stubMethod(zendeskService, "getTicketSummary", async () => {
        throw new Error("Zendesk unavailable");
      }, restoreList);
      stubMethod(zendeskService, "getTicketAudits", async () => {
        throw new Error("Zendesk unavailable");
      }, restoreList);

      const restoreResponse = await invokeRoute("post", "/api/chat/restore", {
        body: {
          ticketId: startResponse.body.ticketId,
          requesterId: startResponse.body.session.requesterId
        }
      });

      assert.equal(restoreResponse.statusCode, 200);
      assert.equal(restoreResponse.body.success, true);
      assert.equal(restoreResponse.body.degraded, true);
      assert.equal(restoreResponse.body.mode, "active_session");
      assert.equal(restoreResponse.body.session.ticketId, startResponse.body.ticketId);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("chat session endpoint serves stale session instead of 500 when Zendesk sync fails", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Radno vrijeme i kontakt",
    body: "Radno vrijeme je pon-pet 9-18.",
    score: 17
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => ({
    products: [],
    total: 0,
    exact: false,
    query: ""
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    confidence: 0.95,
    reply: "Radno vrijeme je pon-pet 9-18.",
    reasoning: "kb"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Zrinko Kutnjak",
          email: "zrinko@example.com",
          message: "Koje vam je radno vrijeme?"
        }
      });

      assert.equal(startResponse.statusCode, 200);

      stubMethod(zendeskService, "getTicketSummary", async () => {
        throw new Error("Zendesk unavailable");
      }, restoreList);
      stubMethod(zendeskService, "getTicketAudits", async () => {
        throw new Error("Zendesk unavailable");
      }, restoreList);

      const sessionResponse = await invokeRoute("get", "/api/chat/session/:sessionId", {
        params: {
          sessionId: startResponse.body.sessionId
        }
      });

      assert.equal(sessionResponse.statusCode, 200);
      assert.equal(sessionResponse.body.success, true);
      assert.equal(sessionResponse.body.degraded, true);
      assert.equal(sessionResponse.body.session.ticketId, startResponse.body.ticketId);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("chat start stays successful with degraded flag when final Zendesk sync fails after ticket creation", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();
  let auditFetchCount = 0;

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", async (ticketId) => {
    auditFetchCount += 1;
    if (auditFetchCount >= 1) {
      throw new Error("Zendesk audits unavailable");
    }
    return fakeZendesk.getTicketAudits(ticketId);
  }, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "zendesk",
    title: "Radno vrijeme i kontakt",
    body: "Radno vrijeme je pon-pet 9-18.",
    score: 17
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => ({
    products: [],
    total: 0,
    exact: false,
    query: ""
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    confidence: 0.95,
    reply: "Radno vrijeme je pon-pet 9-18.",
    reasoning: "kb"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const response = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Zrinko Kutnjak",
          email: "zrinko@example.com",
          message: "Koje vam je radno vrijeme?"
        }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.degraded, true);
      assert.equal(fakeZendesk.state.publicReplies.length, 1);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("chat message returns 503 when Zendesk summary is unavailable before processing", async () => {
  const restoreList = [];
  const fakeZendesk = createFakeZendesk();

  stubMethod(zendeskService, "uploadAttachments", fakeZendesk.uploadAttachments, restoreList);
  stubMethod(zendeskService, "createChatTicket", fakeZendesk.createChatTicket, restoreList);
  stubMethod(zendeskService, "addCustomerMessageToTicket", fakeZendesk.addCustomerMessageToTicket, restoreList);
  stubMethod(zendeskService, "addBotReplyToTicket", fakeZendesk.addBotReplyToTicket, restoreList);
  stubMethod(zendeskService, "addInternalNote", fakeZendesk.addInternalNote, restoreList);
  stubMethod(zendeskService, "addTagAndNote", fakeZendesk.addTagAndNote, restoreList);
  stubMethod(zendeskService, "updateConversationState", fakeZendesk.updateConversationState, restoreList);
  stubMethod(zendeskService, "getTicketSummary", fakeZendesk.getTicketSummary, restoreList);
  stubMethod(zendeskService, "getTicketAudits", fakeZendesk.getTicketAudits, restoreList);
  stubMethod(spamFilterService, "evaluateIncomingMessage", async () => ({
    shouldBlock: false,
    classification: "normal",
    reason: "not_email",
    matchedSignals: [],
    usedAiReview: false,
    aiClassification: null
  }), restoreList);
  stubMethod(knowledgeService, "searchKnowledgeDetailed", async () => buildKnowledgeResult({
    source: "onedrive",
    title: "Otkup udžbenika",
    body: "Donesite knjige u antikvarijat i pripremite OIB.",
    score: 19
  }), restoreList);
  stubMethod(productService, "searchProducts", async () => ({
    products: [],
    total: 0,
    exact: false,
    query: ""
  }), restoreList);
  stubMethod(aiService, "generateReply", async () => ({
    decision: "safe_answer",
    confidence: 0.94,
    reply: "Udžbenike možete donijeti u antikvarijat.",
    reasoning: "kb"
  }), restoreList);
  stubMethod(aiService, "generateGroundedAnswer", async () => "", restoreList);

  try {
    await withRuntimeReset(async () => {
      const startResponse = await invokeRoute("post", "/api/chat/start", {
        body: {
          name: "Zrinko Kutnjak",
          email: "zrinko@example.com",
          message: "Želim prodati knjige"
        }
      });

      assert.equal(startResponse.statusCode, 200);

      stubMethod(zendeskService, "getTicketSummary", async () => {
        throw new Error("Zendesk unavailable");
      }, restoreList);

      const response = await invokeRoute("post", "/api/chat/message", {
        body: {
          sessionId: startResponse.body.sessionId,
          message: "Koje vam je radno vrijeme?"
        }
      });

      assert.equal(response.statusCode, 503);
      assert.match(response.body.error, /Zendesk privremeno nije dostupan/i);
    });
  } finally {
    restoreMethods(restoreList);
  }
});

test("zendesk event webhook returns 503 when Zendesk fetch fails", async () => {
  const restoreList = [];

  stubMethod(zendeskService, "verifyWebhookToken", () => true, restoreList);
  stubMethod(zendeskService, "getTicketSummary", async () => {
    throw new Error("Zendesk unavailable");
  }, restoreList);
  stubMethod(zendeskService, "getTicketAudits", async () => {
    throw new Error("Zendesk unavailable");
  }, restoreList);

  try {
    await withRuntimeReset(async () => {
      const response = await invokeRoute("post", "/webhook/zendesk/events", {
        headers: {
          "x-zendesk-webhook-token": "valid-token"
        },
        body: {
          ticket_id: 12345
        }
      });

      assert.equal(response.statusCode, 503);
      assert.match(response.body.error, /Zendesk event webhook trenutno nije dostupan/i);
    });
  } finally {
    restoreMethods(restoreList);
  }
});
