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
  assert.equal(conversation.reasoningResult.taskIntent, "delivery");
  assert.equal(conversation.reasoningResult.entities.city, "Dubrovnik");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
  assert.ok(conversation.supportPlan.mustNotUseSources.includes("product_feed"));
});

test("operating hours resolves to support info domain", () => {
  const conversation = analyze("Koje vam je radno vrijeme?");

  assert.equal(conversation.reasoningResult.primaryIntent, "support_info");
  assert.equal(conversation.reasoningResult.taskIntent, "support_info");
  assert.equal(conversation.reasoningResult.activeDomain, "support_info");
  assert.equal(conversation.reasoningResult.actionIntent, "ask_general_info");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
  assert.ok(conversation.supportPlan.mustNotUseSources.includes("product_feed"));
});

test("address question resolves to support info domain", () => {
  const conversation = analyze("Gdje se nalazite?");

  assert.equal(conversation.reasoningResult.primaryIntent, "support_info");
  assert.equal(conversation.reasoningResult.activeDomain, "support_info");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("order status and order problem split into different intents", () => {
  const status = analyze("Gdje mi je narudžba #12345?");
  const problem = analyze("Imam problem s narudžbom #12345");

  assert.equal(status.reasoningResult.primaryIntent, "narudzba_status");
  assert.equal(problem.reasoningResult.primaryIntent, "narudzba_problem");
  assert.equal(status.supportPlan.responseMode, "procedural_answer");
  assert.equal(problem.supportPlan.toneMode, "warm_reassuring");
});

test("complaint stays warm but asks for missing operational detail before escalation", () => {
  const conversation = analyze("Stigla mi je kriva knjiga i jako sam ljut");

  assert.equal(conversation.reasoningResult.primaryIntent, "reklamacija_povrat");
  assert.equal(conversation.reasoningResult.emotionalTone, "frustrated");
  assert.equal(conversation.supportPlan.route, "clarify");
  assert.equal(conversation.supportPlan.toneMode, "deescalation");
  assert.ok(conversation.reasoningResult.missingSlots.includes("order_reference"));
  assert.match(conversation.clarifyingQuestion.toLowerCase(), /broj narudžbe|broj narudzbe/);
});

test("refund request remains high-risk and routes to hard handoff", () => {
  const conversation = analyze("Želim povrat novca za narudžbu #12345");

  assert.equal(conversation.reasoningResult.primaryIntent, "reklamacija_povrat");
  assert.equal(conversation.reasoningResult.riskLevel, "high");
  assert.equal(conversation.supportPlan.route, "handoff_hard");
});

test("refund policy question stays knowledge-answerable and does not hard escalate", () => {
  const conversation = analyze("Koji je rok za povrat i zamjenu?");

  assert.equal(conversation.reasoningResult.primaryIntent, "reklamacija_povrat");
  assert.equal(conversation.reasoningResult.actionIntent, "ask_timeline");
  assert.notEqual(conversation.reasoningResult.riskLevel, "high");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
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
  assert.ok(conversation.intentEvidence.includes("mixed_intent_detected"));
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

test("new product query does not inherit old delivery intent", () => {
  const conversation = analyze(
    "Zanima me knjiga gospodarska matematika",
    {
      messages: [
        { role: "user", content: "Kolika je dostava za Dubrovnik?" },
        { role: "assistant", content: "Dostava za Dubrovnik ..." }
      ],
      session: {
        lastStandaloneQuery: "Kolika je dostava za Dubrovnik?",
        workingMemory: {
          activeIntent: "dostava_info",
          customerProfile: {
            name: "Zrinko Kutnjak",
            firstName: "Zrinko"
          }
        }
      }
    }
  );

  assert.equal(conversation.reasoningResult.primaryIntent, "product_availability");
  assert.equal(conversation.reasoningResult.entities.city, "");
  assert.equal(conversation.supportPlan.route, "product_feed");
});

test("delivery follow-up keeps previous support intent", () => {
  const conversation = analyze("A za Dubrovnik?", {
    messages: [
      { role: "user", content: "Kolika je dostava u Split?" },
      { role: "assistant", content: "Dostava u Split ..." }
    ],
    session: {
      lastStandaloneQuery: "Kolika je dostava u Split?",
      workingMemory: {
        activeIntent: "dostava_info"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "dostava_info");
  assert.equal(conversation.reasoningResult.entities.city, "Dubrovnik");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("clarification answer preserves original order-problem intent", () => {
  const conversation = analyze("Broj je #12345", {
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

  assert.equal(conversation.reasoningResult.primaryIntent, "narudzba_problem");
  assert.equal(conversation.reasoningResult.entities.order_reference, "#12345");
});

test("specific buyback follow-up does not keep asking for book list", () => {
  const conversation = analyze("A koliko traje procjena?", {
    messages: [
      { role: "user", content: "Želim prodati knjige" },
      { role: "assistant", content: "Možete li ukratko napisati koje knjige nudite za otkup?" }
    ],
    session: {
      workingMemory: {
        activeIntent: "otkup_upit"
      }
    },
    pendingClarification: {
      slotKey: "book_details",
      intent: "otkup_upit",
      baseQuery: "Želim prodati knjige",
      attemptCount: 1
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "otkup_upit");
  assert.equal(conversation.reasoningResult.actionIntent, "request_estimate");
  assert.equal(conversation.reasoningResult.journeyStage, "clarification_answer");
  assert.deepEqual(conversation.missingSlots, []);
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("short scheduling question is not treated as closure noise", () => {
  const conversation = analyze("može li sutra?");

  assert.notEqual(conversation.reasoningResult.primaryIntent, "small_talk_or_closure");
});

test("product follow-up inherits previous product title from topic anchor", () => {
  const conversation = analyze("Ima li je još na stanju?", {
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
  assert.equal(conversation.reasoningResult.taskIntent, "product_lookup");
  assert.equal(conversation.reasoningResult.entities.book_title, "Algebra 1");
  assert.equal(conversation.supportPlan.route, "product_feed");
});

test("how to sell books resolves to procedural buyback intent", () => {
  const conversation = analyze("Kako mogu prodati knjige?");

  assert.equal(conversation.reasoningResult.primaryIntent, "otkup_upit");
  assert.equal(conversation.reasoningResult.taskIntent, "buyback");
  assert.equal(conversation.reasoningResult.activeDomain, "buyback");
  assert.equal(conversation.reasoningResult.actionIntent, "ask_how_to");
  assert.equal(conversation.reasoningResult.questionType, "procedural");
  assert.equal(conversation.reasoningResult.answerabilityClass, "answer_now");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("buyback entry lock keeps support routing for generic sell-books opening", () => {
  const conversation = analyze("Želim prodati knjige", {
    session: {
      entryTopicLock: "buyback",
      entryTopicSourcePolicy: {
        allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        blockedSources: ["product_feed"]
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "otkup_upit");
  assert.equal(conversation.reasoningResult.taskIntent, "buyback");
  assert.ok(conversation.supportPlan.mustNotUseSources.includes("product_feed"));
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("buyback follow-up with quantity stays in buyback under entry lock", () => {
  const conversation = analyze("Imam 4 knjige. Kako da ih prodam?", {
    session: {
      entryTopicLock: "buyback",
      entryTopicSourcePolicy: {
        allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        blockedSources: ["product_feed"]
      },
      workingMemory: {
        activeIntent: "otkup_upit",
        activeTaskIntent: "buyback"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "otkup_upit");
  assert.equal(conversation.reasoningResult.taskIntent, "buyback");
  assert.equal(conversation.reasoningResult.actionIntent, "ask_how_to");
  assert.notEqual(conversation.supportPlan.route, "product_feed");
});

test("book valuation stays on buyback intent and not product lookup", () => {
  const conversation = analyze("Koliko vrijede ove knjige?");

  assert.equal(conversation.reasoningResult.primaryIntent, "otkup_upit");
  assert.equal(conversation.reasoningResult.actionIntent, "request_estimate");
  assert.notEqual(conversation.supportPlan.route, "product_feed");
});

test("buyback follow-up about textbooks stays in buyback domain", () => {
  const conversation = analyze("A za udžbenike?", {
    messages: [
      { role: "user", content: "Želim prodati knjige" },
      { role: "assistant", content: "Možete poslati popis naslova za otkup." }
    ],
    session: {
      entryTopicLock: "buyback",
      entryTopicSourcePolicy: {
        allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        blockedSources: ["product_feed"]
      },
      lastStandaloneQuery: "Želim prodati knjige",
      workingMemory: {
        activeIntent: "otkup_upit",
        activeDomain: "buyback",
        activeTaskIntent: "buyback",
        activeUserJob: "ask_how_to"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "otkup_upit");
  assert.equal(conversation.reasoningResult.activeDomain, "buyback");
  assert.equal(conversation.reasoningResult.sourceContract, "support_only");
  assert.notEqual(conversation.supportPlan.route, "product_feed");
});

test("buyback to operating-hours follow-up becomes support info shift", () => {
  const conversation = analyze("Koje vam je radno vrijeme?", {
    messages: [
      { role: "user", content: "Želim prodati knjige" },
      { role: "assistant", content: "Možete ih donijeti u poslovnicu ili poslati online." }
    ],
    session: {
      entryTopicLock: "buyback",
      entryTopicSourcePolicy: {
        allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        blockedSources: ["product_feed"]
      },
      lastStandaloneQuery: "Želim prodati knjige",
      workingMemory: {
        activeIntent: "otkup_upit",
        activeDomain: "buyback",
        activeTaskIntent: "buyback",
        activeUserJob: "ask_how_to"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "support_info");
  assert.equal(conversation.reasoningResult.activeDomain, "support_info");
  assert.equal(conversation.reasoningResult.topicShiftType, "support_to_support_shift");
  assert.equal(conversation.reasoningResult.sourceContract, "support_only");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("complaint to loyalty-program follow-up becomes support info shift", () => {
  const conversation = analyze("A kako funkcionira loyalty program?", {
    messages: [
      { role: "user", content: "Koji je rok za povrat i zamjenu?" },
      { role: "assistant", content: "Provjeravam uvjete povrata." }
    ],
    session: {
      lastStandaloneQuery: "Koji je rok za povrat i zamjenu?",
      workingMemory: {
        activeIntent: "reklamacija_povrat",
        activeDomain: "complaint",
        activeTaskIntent: "complaint"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "support_info");
  assert.equal(conversation.reasoningResult.activeDomain, "support_info");
  assert.equal(conversation.supportPlan.route, "onedrive_knowledge");
});

test("delivery to product topic shift switches to product lookup", () => {
  const conversation = analyze("A imate li i Algebra 1?", {
    messages: [
      { role: "user", content: "Kolika je dostava za Zagreb?" },
      { role: "assistant", content: "Dostava za Zagreb ..." }
    ],
    session: {
      lastStandaloneQuery: "Kolika je dostava za Zagreb?",
      workingMemory: {
        activeIntent: "dostava_info",
        activeTaskIntent: "delivery",
        activeSubjectType: "shipment"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "product_availability");
  assert.equal(conversation.reasoningResult.taskIntent, "product_lookup");
  assert.equal(conversation.reasoningResult.topicShiftDetected, true);
});

test("explicit product lookup can break buyback lock", () => {
  const conversation = analyze('Imate li knjigu "Algebra 1"?', {
    session: {
      entryTopicLock: "buyback",
      entryTopicSourcePolicy: {
        allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        blockedSources: ["product_feed"]
      },
      workingMemory: {
        activeIntent: "otkup_upit",
        activeTaskIntent: "buyback"
      }
    }
  });

  assert.equal(conversation.reasoningResult.primaryIntent, "product_availability");
  assert.equal(conversation.isExplicitProductLookup, true);
});
