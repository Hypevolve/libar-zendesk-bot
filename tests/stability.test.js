const test = require("node:test");
const assert = require("node:assert/strict");

const reasoningService = require("../services/reasoningService");
const plannerService = require("../services/plannerService");
const memoryService = require("../services/memoryService");
const knowledgeService = require("../services/knowledgeService");

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

test("working memory persists structured intent fields", () => {
  const memory = memoryService.buildWorkingMemory({
    session: {},
    conversation: {
      reasoningResult: {
        primaryIntent: "otkup_upit",
        secondaryIntent: "",
        taskIntent: "buyback",
        actionIntent: "ask_how_to",
        subjectType: "buyback_process",
        emotionalTone: "neutral",
        entities: {
          book_title: ""
        }
      },
      intentEvidence: ["buyback_keywords", "procedural_or_policy_question"],
      missingSlots: [],
      standaloneQuery: "Kako mogu prodati knjige?",
      supportPlan: {
        route: "onedrive_knowledge",
        mustNotUseSources: ["product_feed"]
      }
    },
    outcome: {
      type: "safe_answer"
    }
  });

  assert.equal(memory.activeTaskIntent, "buyback");
  assert.equal(memory.activeDomain, "buyback");
  assert.equal(memory.activeUserJob, "ask_how_to");
  assert.equal(memory.activeSubjectType, "buyback_process");
  assert.equal(memory.lastAnsweredQuestionType, "procedural");
  assert.equal(memory.lastAnswerabilityClass, "answer_now");
  assert.deepEqual(memory.lastIntentEvidence, ["buyback_keywords", "procedural_or_policy_question"]);
  assert.equal(memory.supportHistory.lastBlockedSource, "product_feed");
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

  const serialized = memoryService.serializeWorkingMemory(memory);
  const parsed = memoryService.parseWorkingMemoryNote(serialized);

  assert.equal(parsed.activeIntent, "narudzba_problem");
  assert.equal(parsed.customerProfile.name, "Ana Horvat");
  assert.deepEqual(parsed.openSlots, ["order_reference"]);
  assert.match(serialized, /AI memory snapshot/);
  assert.match(serialized, /deflate64:/);
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

test("buyback opening without details defaults to knowledge route without clarification", () => {
  const { conversation, supportPlan } = analyze("Želim prodati knjige");

  assert.deepEqual(conversation.missingSlots, []);
  assert.equal(conversation.reasoningResult.activeDomain, "buyback");
  assert.equal(conversation.reasoningResult.answerabilityClass, "answer_now");
  assert.equal(conversation.reasoningResult.sourceContract, "support_only");
  assert.equal(supportPlan.route, "onedrive_knowledge");
});

test("planner enforces buyback entry lock as support-only source policy", () => {
  const { conversation, supportPlan } = analyze("Imam 4 knjige. Kako da ih prodam?", {
    session: {
      entryTopicLock: "buyback",
      entryTopicSourcePolicy: {
        allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        blockedSources: ["product_feed"]
      }
    }
  });

  assert.equal(conversation.reasoningResult.taskIntent, "buyback");
  assert.equal(supportPlan.route, "onedrive_knowledge");
  assert.ok(supportPlan.mustNotUseSources.includes("product_feed"));
});

test("support info intent is treated as support-only source policy", () => {
  const { conversation, supportPlan } = analyze("Radite li subotom?");

  assert.equal(conversation.reasoningResult.primaryIntent, "support_info");
  assert.equal(conversation.reasoningResult.sourceContract, "support_only");
  assert.equal(supportPlan.route, "zendesk_knowledge");
  assert.ok(supportPlan.mustNotUseSources.includes("product_feed"));
  assert.ok(supportPlan.selectedSources.includes("website_knowledge"));
});

test("knowledge merge respects source blocking and reranks buyback article first", () => {
  const knowledge = knowledgeService.mergeKnowledgeResults(
    {
      zendeskKnowledge: {
        articles: [
          {
            title: "Opće informacije o knjigama",
            score: 12,
            body: "Knjige i naslovi iz ponude.",
            source: "zendesk"
          }
        ]
      },
      oneDriveKnowledge: {
        articles: [
          {
            title: "Otkup knjiga - postupak",
            score: 11,
            body: "Za otkup pošaljite popis naslova i procjenu.",
            source: "onedrive"
          }
        ]
      }
    },
    {
      allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
      blockedSources: ["product_feed"],
      sourcePriority: ["onedrive_knowledge", "zendesk_knowledge"],
      taskIntent: "buyback",
      actionIntent: "ask_how_to",
      subjectType: "buyback_process",
      questionType: "procedural"
    }
  );

  assert.equal(knowledge.primarySource, "onedrive");
  assert.equal(knowledge.articles[0].title, "Otkup knjiga - postupak");
  assert.equal(knowledge.quality.relevanceMatch, true);
  assert.equal(knowledge.quality.jobMatch, true);
  assert.equal(knowledge.quality.contextConsistency, true);
});

test("knowledge merge prefers direct support info article for operating hours", () => {
  const knowledge = knowledgeService.mergeKnowledgeResults(
    {
      zendeskKnowledge: {
        articles: [
          {
            title: "Radno vrijeme i kontakt",
            score: 10,
            body: "Ponedjeljak - petak 08:00 - 20:00. Subota 08:00 - 13:00. Županijska 17, Osijek.",
            source: "zendesk"
          }
        ]
      },
      oneDriveKnowledge: {
        articles: [
          {
            title: "Otkup knjiga - postupak",
            score: 11,
            body: "Za otkup pošaljite popis naslova i procjenu.",
            source: "onedrive"
          }
        ]
      }
    },
    {
      allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
      blockedSources: ["product_feed"],
      sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
      activeDomain: "support_info",
      taskIntent: "support_info",
      actionIntent: "ask_general_info",
      subjectType: "support_info",
      questionType: "info"
    }
  );

  assert.equal(knowledge.primarySource, "zendesk");
  assert.equal(knowledge.articles[0].title, "Radno vrijeme i kontakt");
  assert.equal(knowledge.quality.domainMatch, true);
  assert.equal(knowledge.quality.directAnswerability, true);
  assert.equal(knowledge.quality.contextConsistency, true);
});

test("knowledge merge can surface website page as relevant support source", () => {
  const knowledge = knowledgeService.mergeKnowledgeResults(
    {
      zendeskKnowledge: {
        articles: [
          {
            title: "Opće informacije",
            score: 8,
            body: "Pogledajte informacije o poslovnici.",
            source: "zendesk"
          }
        ]
      },
      websiteKnowledge: {
        articles: [
          {
            title: "Kontakt",
            score: 14,
            body: "Kontakt stranica s adresom, radnim vremenom i osnovnim podacima.",
            source: "website",
            url: "https://antikvarijat-libar.com/kontakt/"
          }
        ]
      }
    },
    {
      allowedSources: ["zendesk_knowledge", "website_knowledge", "onedrive_knowledge"],
      blockedSources: ["product_feed"],
      sourcePriority: ["zendesk_knowledge", "website_knowledge", "onedrive_knowledge"],
      taskIntent: "support_info",
      activeDomain: "support_info",
      actionIntent: "ask_general_info"
    }
  );

  assert.equal(knowledge.primarySource, "website");
  assert.equal(knowledge.articles[0].url, "https://antikvarijat-libar.com/kontakt/");
  assert.equal(knowledge.quality.relevanceMatch, true);
  assert.equal(knowledge.quality.contextConsistency, true);
});

test("knowledge merge flags conflicting support info between zendesk and onedrive", () => {
  const knowledge = knowledgeService.mergeKnowledgeResults(
    {
      zendeskKnowledge: {
        articles: [
          {
            title: "Radno vrijeme i kontakt",
            score: 18,
            body: "Radno vrijeme: 08:00-20:00. Email: info@libar.hr",
            source: "zendesk"
          }
        ]
      },
      oneDriveKnowledge: {
        articles: [
          {
            title: "Poslovnica informacije",
            score: 18,
            body: "Radno vrijeme: 09:00-18:00. Email: podrska@libar.hr",
            source: "onedrive"
          }
        ]
      }
    },
    {
      allowedSources: ["onedrive_knowledge", "zendesk_knowledge"],
      sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
      activeDomain: "support_info",
      taskIntent: "support_info",
      actionIntent: "ask_general_info",
      subjectType: "support_info",
      questionType: "info"
    }
  );

  assert.equal(knowledge.quality.hasConflict, true);
  assert.ok(knowledge.quality.conflictFields.includes("hours"));
  assert.ok(knowledge.quality.conflictFields.includes("email"));
});

test("knowledge source allowlist can fully disable zendesk retrieval candidates", () => {
  const knowledge = knowledgeService.mergeKnowledgeResults(
    {
      zendeskKnowledge: {
        articles: [
          {
            title: "Zendesk članak",
            score: 30,
            body: "Opći članak",
            source: "zendesk"
          }
        ]
      },
      oneDriveKnowledge: {
        articles: [
          {
            title: "OneDrive dokument",
            score: 8,
            body: "Specifičan dokument",
            source: "onedrive"
          }
        ]
      }
    },
    {
      allowedSources: ["onedrive_knowledge"]
    }
  );

  assert.equal(knowledge.articles.length, 1);
  assert.equal(knowledge.primarySource, "onedrive");
});
