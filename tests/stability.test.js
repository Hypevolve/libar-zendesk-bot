const test = require("node:test");
const assert = require("node:assert/strict");

const reasoningService = require("../services/reasoningService");
const plannerService = require("../services/plannerService");
const memoryService = require("../services/memoryService");

function analyze(message, options = {}) {
  const conversation = reasoningService.analyzeConversation({
    message,
    messages: options.messages || [],
    session: options.session || {},
    pendingClarification: options.pendingClarification || null
  });

  const supportPlan = plannerService.buildSupportPlan({
    reasoningResult: conversation.reasoningResult,
    session: options.session || {},
    hasAttachments: options.hasAttachments || false
  });

  return {
    conversation,
    supportPlan
  };
}

test("attachments always force hard handoff in planner", () => {
  const { supportPlan } = analyze("Šaljem slike problema", {
    hasAttachments: true
  });

  assert.equal(supportPlan.route, "handoff_hard");
  assert.equal(supportPlan.responseMode, "escalate");
});

test("payment issue is treated as high risk", () => {
  const { conversation, supportPlan } = analyze("Imam problem s plaćanjem karticom");

  assert.equal(conversation.reasoningResult.riskLevel, "high");
  assert.equal(supportPlan.route, "handoff_hard");
});

test("legal threat is treated as high risk", () => {
  const { conversation, supportPlan } = analyze("Prijavit ću vas inspekciji");

  assert.equal(conversation.reasoningResult.riskLevel, "high");
  assert.equal(supportPlan.route, "handoff_hard");
});

test("topic shift after clarification drops stale secondary intent", () => {
  const { conversation, supportPlan } = analyze("Zanima me dostava za Split", {
    session: {
      workingMemory: {
        activeIntent: "narudzba_problem"
      }
    },
    pendingClarification: {
      slotKey: "order_reference",
      intent: "narudzba_problem",
      baseQuery: "Imam problem s narudžbom",
      attemptCount: 1
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "dostava_info");
  assert.equal(conversation.reasoningResult.secondaryIntent, null);
  assert.equal(supportPlan.route, "zendesk_knowledge");
});

test("product follow-up keeps product routing from previous assistant products", () => {
  const { conversation, supportPlan } = analyze("Ima li je još na stanju?", {
    messages: [
      {
        role: "assistant",
        content: "Našao sam ovaj udžbenik.",
        products: [{ title: "Algebra 1" }]
      }
    ],
    session: {
      lastProductTitles: ["Algebra 1"],
      workingMemory: {
        activeIntent: "product_availability"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "product_availability");
  assert.equal(conversation.reasoningResult.entities.book_title, "Algebra 1");
  assert.equal(supportPlan.route, "product_feed");
});

test("closure message does not request a clarification question", () => {
  const { conversation, supportPlan } = analyze("hvala");

  assert.equal(conversation.reasoningResult.primaryIntent, "small_talk_or_closure");
  assert.equal(conversation.clarifyingQuestion, "");
  assert.equal(supportPlan.nextBestAction, "close_or_acknowledge");
});

test("working memory survives serialize/parse roundtrip", () => {
  const memory = memoryService.buildWorkingMemory({
    session: {
      requesterName: "Ana Horvat",
      requesterEmail: "ana@example.com",
      pendingClarification: {
        slotKey: "order_reference",
        attemptCount: 1
      }
    },
    conversation: {
      reasoningResult: {
        primaryIntent: "narudzba_problem",
        secondaryIntent: "",
        emotionalTone: "neutral"
      },
      missingSlots: ["order_reference"],
      resolvedSlots: [],
      standaloneQuery: "Imam problem s narudžbom",
      supportPlan: {
        route: "clarify"
      }
    },
    outcome: {
      type: "ask_clarifying_question"
    }
  });

  const parsed = memoryService.parseWorkingMemoryNote(memoryService.serializeWorkingMemory(memory));

  assert.equal(parsed.activeIntent, "narudzba_problem");
  assert.equal(parsed.customerProfile.name, "Ana Horvat");
  assert.deepEqual(parsed.openSlots, ["order_reference"]);
});

test("equivalent memories ignore updatedAt timestamp", () => {
  const left = {
    activeIntent: "dostava_info",
    secondaryIntent: "",
    openSlots: [],
    resolvedSlots: [],
    lastStandaloneQuery: "Dostava za Split",
    lastRoute: "zendesk_knowledge",
    lastAnswerType: "safe_answer",
    lastKnowledgeSource: "zendesk",
    lastProductContext: [],
    clarificationTurnCount: 0,
    customerProfile: {
      name: "Ana Horvat",
      firstName: "Ana",
      email: "ana@example.com",
      source: "zendesk_requester"
    },
    supportHistory: {
      lastIssueCategory: "dostava_info",
      lastEmotionalTone: "neutral",
      lastHandoffReason: "",
      lastSuccessfulSource: "zendesk"
    },
    updatedAt: "2026-04-18T12:00:00.000Z"
  };
  const right = {
    ...left,
    updatedAt: "2026-04-18T12:05:00.000Z"
  };

  assert.equal(memoryService.areEquivalentWorkingMemories(left, right), true);
});

test("extractLatestWorkingMemory returns newest valid snapshot from audits", () => {
  const oldMemory = memoryService.serializeWorkingMemory({
    activeIntent: "dostava_info"
  });
  const newMemory = memoryService.serializeWorkingMemory({
    activeIntent: "product_availability"
  });
  const audits = [
    {
      events: [{ type: "Comment", body: oldMemory }]
    },
    {
      events: [{ type: "Comment", body: newMemory }]
    }
  ];

  const latest = memoryService.extractLatestWorkingMemory(audits);

  assert.equal(latest.activeIntent, "product_availability");
});

test("customer profile falls back to previous memory when no fresh requester data exists", () => {
  const memory = memoryService.buildWorkingMemory({
    session: {},
    conversation: {
      reasoningResult: {
        primaryIntent: "general_support",
        secondaryIntent: "",
        emotionalTone: "neutral"
      },
      missingSlots: [],
      resolvedSlots: [],
      standaloneQuery: "Opći upit",
      supportPlan: {
        route: "zendesk_knowledge"
      }
    },
    outcome: {
      type: "safe_answer"
    },
    previousMemory: {
      customerProfile: {
        name: "Marko Marić",
        firstName: "Marko",
        email: "marko@example.com",
        source: "zendesk_requester"
      }
    }
  });

  assert.equal(memory.customerProfile.name, "Marko Marić");
  assert.equal(memory.customerProfile.email, "marko@example.com");
});

test("specific product query stays on product feed route", () => {
  const { conversation, supportPlan } = analyze('Imate li knjigu "Gospodarska matematika"?');

  assert.equal(conversation.reasoningResult.primaryIntent, "product_availability");
  assert.equal(supportPlan.route, "product_feed");
});

test("buyback opening without details asks exactly one slot question", () => {
  const { conversation, supportPlan } = analyze("Želim prodati knjige");

  assert.deepEqual(conversation.missingSlots, ["book_details"]);
  assert.equal(supportPlan.route, "clarify");
  assert.match(conversation.clarifyingQuestion.toLowerCase(), /koje knjige|koliko ih/);
});
