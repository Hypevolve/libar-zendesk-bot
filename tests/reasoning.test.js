const test = require("node:test");
const assert = require("node:assert/strict");

const reasoningService = require("../services/reasoningService");
const plannerService = require("../services/plannerService");
const memoryService = require("../services/memoryService");

function analyze(message, options = {}) {
  const result = reasoningService.analyzeConversation({
    message,
    messages: options.messages || [],
    session: options.session || {},
    pendingClarification: options.pendingClarification || null
  });

  return {
    ...result,
    supportPlan: plannerService.buildSupportPlan({
      reasoningResult: result.reasoningResult,
      session: options.session || {},
      hasAttachments: options.hasAttachments || false
    })
  };
}

test("support vs product disambiguation stays on knowledge route", () => {
  const conversation = analyze("Kolika je dostava za Dubrovnik?");

  assert.equal(conversation.reasoningResult.primaryIntent, "dostava_info");
  assert.equal(conversation.reasoningResult.entities.city, "Dubrovnik");
  assert.equal(conversation.supportPlan.route, "zendesk_knowledge");
  assert.ok(conversation.supportPlan.mustNotUseSources.includes("product_feed"));
});

test("order status and order problem split into different intents", () => {
  const status = analyze("Gdje mi je narudžba #12345?");
  const problem = analyze("Imam problem s narudžbom #12345");

  assert.equal(status.reasoningResult.primaryIntent, "narudzba_status");
  assert.equal(problem.reasoningResult.primaryIntent, "narudzba_problem");
  assert.equal(status.supportPlan.responseMode, "procedural_answer");
  assert.equal(problem.supportPlan.toneMode, "warm_reassuring");
});

test("complaint de-escalation routes to hard handoff", () => {
  const conversation = analyze("Stigla mi je kriva knjiga i jako sam ljut");

  assert.equal(conversation.reasoningResult.primaryIntent, "reklamacija_povrat");
  assert.equal(conversation.reasoningResult.emotionalTone, "frustrated");
  assert.equal(conversation.supportPlan.route, "handoff_hard");
  assert.equal(conversation.supportPlan.toneMode, "deescalation");
});

test("clarification is short and concrete for vague problem", () => {
  const conversation = analyze("Imam problem");

  assert.equal(conversation.supportPlan.route, "clarify");
  assert.ok(conversation.clarifyingQuestion.length < 90);
  assert.match(conversation.clarifyingQuestion.toLowerCase(), /možete li|mozete li/);
});

test("mixed intent handling prefers clarification over single-source answer", () => {
  const conversation = analyze('Kolika je dostava i imate li knjigu "Algebra 1"?');

  assert.equal(conversation.reasoningResult.primaryIntent, "dostava_info");
  assert.equal(conversation.reasoningResult.secondaryIntent, "product_availability");
  assert.equal(conversation.supportPlan.route, "clarify");
});

test("name usage is sparse and enabled only when context warrants it", () => {
  const conversation = analyze("Imam problem s narudžbom", {
    session: {
      requesterName: "Ana Horvat",
      workingMemory: {
        customerProfile: {
          name: "Ana Horvat",
          firstName: "Ana"
        }
      }
    }
  });

  assert.equal(conversation.supportPlan.shouldUseCustomerName, true);
});

test("memory continuity restores pending clarification", () => {
  const memory = memoryService.buildWorkingMemory({
    session: {
      requesterName: "Ana Horvat",
      pendingClarification: {
        slotKey: "order_reference",
        attemptCount: 1
      }
    },
    conversation: {
      reasoningResult: {
        primaryIntent: "narudzba_status",
        secondaryIntent: "",
        emotionalTone: "neutral"
      },
      missingSlots: ["order_reference"],
      resolvedSlots: [],
      standaloneQuery: "Status narudžbe",
      supportPlan: {
        route: "clarify"
      }
    },
    outcome: {
      type: "ask_clarifying_question"
    },
    previousMemory: null
  });
  const session = {};

  memoryService.applyWorkingMemoryToSession(session, memory);

  assert.equal(session.pendingClarification.slotKey, "order_reference");
  assert.equal(session.lastResolvedIntent, "narudzba_status");
});

test("closure/noise avoids retrieval routes", () => {
  const conversation = analyze("hvala");

  assert.equal(conversation.reasoningResult.primaryIntent, "small_talk_or_closure");
  assert.equal(conversation.supportPlan.nextBestAction, "close_or_acknowledge");
  assert.ok(conversation.supportPlan.mustNotUseSources.includes("zendesk_knowledge"));
});
