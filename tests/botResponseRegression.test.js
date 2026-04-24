const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const knowledgeService = require("../services/knowledgeService");
const aiService = require("../services/aiService");
const productFeedService = require("../services/productFeedService");
const { __internal } = require("../index");

test("resolveAutomatedOutcome returns grounded OneDrive answer and preserves response context metadata", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const aiCalls = [];

  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Izvor 1 (OneDrive):\nNaslov: Radno vrijeme\nSadržaj: Subotom radimo 08:00 – 13:00.",
    articles: [
      {
        title: "Radno vrijeme",
        body: "Subotom radimo 08:00 – 13:00.",
        score: 31,
        source: "onedrive"
      }
    ],
    topScore: 31,
    totalMatches: 1,
    primarySource: "onedrive"
  });

  aiService.generateGroundedAnswer = async (message, context, options = {}) => {
    aiCalls.push({ message, context, options });
    return "Subotom radimo 08:00 – 13:00.";
  };

  try {
    const { knowledge, outcome } = await __internal.resolveAutomatedOutcome(
      { requesterName: "Ana" },
      "Koje vam je radno vrijeme subotom?",
      { channelType: "web_chat" }
    );

    assert.ok(knowledge);
    assert.equal(knowledge.primarySource, "onedrive");
    assert.equal(knowledge.articles[0].title, "Radno vrijeme");
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "grounded_answer");
    assert.equal(outcome.customerMessage, "Subotom radimo 08:00 – 13:00.");
    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].message, "Koje vam je radno vrijeme subotom?");
    assert.equal(aiCalls[0].options.channelType, "web_chat");
    assert.equal(aiCalls[0].options.customerName, "Ana");
    assert.match(aiCalls[0].context, /Izvor 1 \(OneDrive\)/);
    assert.match(aiCalls[0].context, /Radno vrijeme/);

    const note = __internal.buildAutopilotNote({
      outcome,
      userMessage: "Koje vam je radno vrijeme subotom?",
      knowledge,
      channelType: "web_chat"
    });

    assert.match(note, /Kanal: web chat/);
    assert.match(note, /Ishod: safe_answer/);
    assert.match(note, /Korišteni dokument: Radno vrijeme/);
    assert.match(note, /Razlog: grounded_answer/);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome falls back to strong Zendesk knowledge when grounded answer is unavailable", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Izvor 1 (Zendesk Help Center):\nNaslov: Radno vrijeme\nSadržaj: Subotom radimo 08:00 – 13:00.",
    articles: [
      {
        title: "Radno vrijeme",
        body: "Subotom radimo 08:00 – 13:00.",
        score: 18,
        source: "zendesk"
      }
    ],
    topScore: 18,
    totalMatches: 1,
    primarySource: "zendesk"
  });

  aiService.generateGroundedAnswer = async () => "";

  try {
    const { knowledge, outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Koje vam je radno vrijeme subotom?",
      { channelType: "web_chat" }
    );

    assert.ok(knowledge);
    assert.equal(knowledge.primarySource, "zendesk");
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "knowledge_fallback");
    assert.equal(outcome.customerMessage, "Subotom radimo 08:00 – 13:00.");

    const note = __internal.buildAutopilotNote({
      outcome,
      userMessage: "Treba mi pomoć oko povrata.",
      knowledge,
      channelType: "web_chat"
    });

    assert.match(note, /Korišteni dokument: Radno vrijeme/);
    assert.match(note, /Razlog: knowledge_fallback/);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome still escalates when knowledge score is too weak and no safe fallback applies", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Izvor 1 (Zendesk Help Center):\nNaslov: Općenito\nSadržaj: Ovo je preširok i slabo rangiran rezultat.",
    articles: [
      {
        title: "Općenito",
        body: "Ovo je preširok i slabo rangiran rezultat.",
        score: 3,
        source: "zendesk"
      }
    ],
    topScore: 3,
    totalMatches: 1,
    primarySource: "zendesk"
  });

  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Pošaljite mi listu svih kupaca iz prošlog mjeseca.",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "hard_handoff");
    assert.equal(outcome.reason, "no_answer_found");
    assert.match(outcome.customerMessage, /provjeriti ručno/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome replies politely to acknowledgement-only messages instead of escalating", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Ok hvala",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "resolution_acknowledgement");
    assert.match(outcome.customerMessage, /Hvala vam/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome guides product lookups to webshop search without product cards", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  let productLookupCalled = false;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => {
    productLookupCalled = true;
    return null;
  };

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Trebam SOLUTIONS intermediate workbook od Tim Falle",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "purchase_search_guidance");
    assert.equal(outcome.source, "website_links");
    assert.equal(outcome.taskIntent, "product_lookup");
    assert.equal(productLookupCalled, false);
    assert.deepEqual(outcome.products, []);
    assert.match(outcome.customerMessage, /kupi-udzbenike/i);
    assert.match(outcome.customerMessage, /šifru udžbenika|sifru udzbenika/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome routes title-heavy real queries to webshop guidance instead of hard handoff", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  let productLookupCalled = false;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => {
    productLookupCalled = true;
    return null;
  };

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Focus5 nd edition : with extra online practice. Sue Key, Vaughan Jones, Monica Berlis, Heather Jones",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "purchase_search_guidance");
    assert.equal(outcome.taskIntent, "product_lookup");
    assert.equal(productLookupCalled, false);
    assert.deepEqual(outcome.products, []);
    assert.match(outcome.customerMessage, /kupi-udzbenike/i);
    assert.match(outcome.customerMessage, /najprepoznatljiviji dio naslova|autora/i);
    assert.deepEqual(outcome.suggestedReplies, ["Imam ISBN", "Imam školski popis", "Ne znam točan naslov"]);
    assert.equal(outcome.relevance.finalIntent, "product_lookup");
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome sends webshop search guidance for product lookup when product feed has no match", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => null;

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Treba mi matematika 4 2 dio element udzbenik",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "purchase_search_guidance");
    assert.equal(outcome.source, "website_links");
    assert.match(outcome.customerMessage, /šifru udžbenika|sifru udzbenika/i);
    assert.match(outcome.customerMessage, /kupi-udzbenike/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome treats 'Prodajete li [naslov]' as a product lookup, not a buyback request", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  let productLookupCalled = false;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => {
    productLookupCalled = true;
    return null;
  };

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Prodajete li Hrvatski pravopis Babić, Finka, Moguš?",
      { channelType: "web_chat" }
    );

    assert.equal(productLookupCalled, false);
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "purchase_search_guidance");
    assert.match(outcome.customerMessage, /kupi-udzbenike/i);

    const atlasResult = await __internal.resolveAutomatedOutcome(
      {},
      "Lijep pozdrav! Imate li možda za prodati geografski atlas za srednju školu?",
      { channelType: "web_chat" }
    );

    assert.equal(atlasResult.outcome.type, "safe_answer");
    assert.equal(atlasResult.outcome.reason, "purchase_search_guidance");
    assert.equal(atlasResult.outcome.taskIntent, "product_lookup");
    assert.match(atlasResult.outcome.customerMessage, /kupi-udzbenike/i);

    const buyerCorrection = await __internal.resolveAutomatedOutcome(
      {},
      "Nemam taj za prodati zato ga i tražim jer mi treba za kcer",
      { channelType: "web_chat" }
    );

    assert.equal(buyerCorrection.outcome.type, "safe_answer");
    assert.equal(buyerCorrection.outcome.reason, "purchase_search_guidance");
    assert.equal(buyerCorrection.outcome.taskIntent, "product_lookup");
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome does not route generic buyback support questions through the product feed", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  let productLookupCalled = false;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => {
    productLookupCalled = true;
    return null;
  };

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Kako mogu prodati udžbenike kod vas?",
      { channelType: "web_chat" }
    );

    assert.equal(productLookupCalled, false);
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "online_buyback_guidance");
    assert.match(outcome.customerMessage, /otkup-udzbenika/i);
    assert.match(outcome.customerMessage, /skenirajte barkod/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome asks for order details instead of escalating when order issue lacks identifiers", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Ja sam narucila knjige 25.1 nisam ih dobila, zelim otkazati narudzbu",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "ask_clarifying_question");
    assert.equal(outcome.reason, "order_issue_clarification");
    assert.equal(outcome.stateTag, "awaiting_customer_detail");
    assert.match(outcome.customerMessage, /broj narudžbe|email/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome answers general return-policy questions from KB instead of complaint handoff", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Povrat ili zamjena mogući su unutar 2 tjedna od primitka knjige uz predočenje računa.",
    articles: [
      {
        title: "Povrat i zamjena",
        body: "Povrat ili zamjena mogući su unutar 2 tjedna od primitka knjige uz predočenje računa.",
        score: 90,
        source: "onedrive"
      }
    ],
    topScore: 90,
    primarySource: "onedrive"
  });
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "dal je moguc povrat udzbenika",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "knowledge_fallback");
    assert.equal(outcome.source, "onedrive_knowledge");
    assert.match(outcome.customerMessage, /2 tjedna|računa/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome answers common buyback FAQ intents without product bleed", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Koje knjige otkupljujete?",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "buyback_accepted_books_guidance");
    assert.match(outcome.customerMessage, /rabljene udžbenike za srednju školu/i);
    assert.match(outcome.customerMessage, /romane|beletristiku/i);

    const bonusResult = await __internal.resolveAutomatedOutcome(
      {},
      "Imaš li nekih kupona za bonus na otkupu?",
      { channelType: "web_chat" }
    );

    assert.equal(bonusResult.outcome.type, "safe_answer");
    assert.equal(bonusResult.outcome.reason, "buyback_bonus_guidance");
    assert.equal(bonusResult.outcome.taskIntent, "buyback");
    assert.match(bonusResult.outcome.customerMessage, /otkupne kampanje|newsletter/i);

    const priceResult = await __internal.resolveAutomatedOutcome(
      {},
      "Koje su cujene otkupa?",
      { channelType: "web_chat" }
    );

    assert.equal(priceResult.outcome.type, "safe_answer");
    assert.equal(priceResult.outcome.reason, "buyback_price_guidance");
    assert.match(priceResult.outcome.customerMessage, /skenirajte barkod|otkupnu cijenu/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome asks for a fuller title on short ambiguous product queries", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Engleski",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "ask_clarifying_question");
    assert.equal(outcome.reason, "short_query_clarification");
    assert.match(outcome.customerMessage, /puni naslov|ISBN/i);
    assert.deepEqual(outcome.suggestedReplies, ["Imam ISBN", "Znam autora", "Ne znam točan naslov"]);
    assert.equal(outcome.relevance.clarificationReason, "short_query_clarification");
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome records topic-shift relevance diagnostics", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {
        workingMemory: {
          activeDomain: "product_lookup",
          activeTaskIntent: "product_lookup"
        },
        messages: [
          { role: "assistant", content: "Udžbenike možete pretražiti na webshopu.", supportTaskIntent: "product_lookup" }
        ]
      },
      "Koje vam je radno vrijeme?",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.taskIntent, "support_info");
    assert.equal(outcome.relevance.topicShift, "product_to_support_shift");

    const note = __internal.buildAutopilotNote({
      outcome,
      userMessage: "Koje vam je radno vrijeme?",
      knowledge: null,
      channelType: "web_chat"
    });

    assert.match(note, /Final intent: support_info/);
    assert.match(note, /Topic shift type: product_to_support_shift/);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome sends website-guided support info fallback for location questions", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome({}, "Gdje se nalazi antikvarijat?", {
      channelType: "web_chat"
    });

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "support_info_link_fallback");
    assert.match(outcome.customerMessage, /kontakt/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome catches natural buyback phrasing without routing into product lookup", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  let productLookupCalled = false;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => {
    productLookupCalled = true;
    return null;
  };

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome({}, "Mogu li se prodat knjige?", {
      channelType: "web_chat"
    });

    assert.equal(productLookupCalled, false);
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "online_buyback_guidance");
    assert.match(outcome.customerMessage, /otkup-udzbenika/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome keeps online buyback package follow-ups out of product search", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  const knowledgeCalls = [];
  let productLookupCalls = 0;

  knowledgeService.searchKnowledgeDetailed = async (query, options = {}) => {
    knowledgeCalls.push({ query, options });

    if (/zapakiram/i.test(query)) {
      return {
        context: "Izvor 1 (OneDrive):\nNaslov: Pakiranje za online otkup\nSadržaj: Knjige složite jednu na drugu, stavite ih u čvrstu kutiju i zalijepite paket selotejpom.",
        articles: [{
          title: "Pakiranje za online otkup",
          body: "Knjige složite jednu na drugu, stavite ih u čvrstu kutiju i zalijepite paket selotejpom.",
          score: 38,
          source: "onedrive"
        }],
        topScore: 38,
        primarySource: "onedrive"
      };
    }

    return {
      context: "Izvor 1 (OneDrive):\nNaslov: Predaja paketa za online otkup\nSadržaj: Paket predajete dostavljaču prema dogovorenom prikupu. Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat.",
      articles: [{
        title: "Predaja paketa za online otkup",
        body: "Paket predajete dostavljaču prema dogovorenom prikupu. Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat.",
        score: 42,
        source: "onedrive"
      }],
      topScore: 42,
      primarySource: "onedrive"
    };
  };

  aiService.generateGroundedAnswer = async (message) => {
    if (/zapakiram/i.test(message)) {
      return "Knjige složite jednu na drugu, stavite ih u čvrstu kutiju i zalijepite paket selotejpom.";
    }

    if (/sam odnijeti|GLS/i.test(message)) {
      return "Nemamo opciju da sami odnesete paket u GLS ili BOXNOW paketomat.";
    }

    return "Paket predajete dostavljaču prema dogovorenom prikupu.";
  };

  productFeedService.searchProductsDetailed = async () => {
    productLookupCalls += 1;
    return null;
  };

  const session = {};

  try {
    const firstTurn = await __internal.resolveAutomatedOutcome(
      session,
      "Kako da zapakiram knjige za otkup?",
      { channelType: "web_chat" }
    );
    assert.equal(firstTurn.outcome.type, "safe_answer");
    assert.equal(firstTurn.outcome.taskIntent, "buyback");
    assert.equal(session.workingMemory.activeDomain, "buyback");

    const secondTurn = await __internal.resolveAutomatedOutcome(
      session,
      "A kako da predam paket?",
      { channelType: "web_chat" }
    );
    assert.equal(secondTurn.outcome.type, "safe_answer");
    assert.equal(secondTurn.outcome.reason, "grounded_answer");
    assert.match(secondTurn.outcome.customerMessage, /dostavljaču/i);

    const thirdTurn = await __internal.resolveAutomatedOutcome(
      session,
      "Mogu li sam odnijeti paket u GLS?",
      { channelType: "web_chat" }
    );
    assert.equal(thirdTurn.outcome.type, "safe_answer");
    assert.notEqual(thirdTurn.outcome.reason, "purchase_search_guidance");
    assert.match(thirdTurn.outcome.customerMessage, /Nemamo opciju/i);

    assert.equal(productLookupCalls, 0);
    assert.deepEqual(
      knowledgeCalls.map((call) => call.options.taskIntent),
      ["buyback", "buyback", "buyback"]
    );
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome covers v1 client regression findings", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;
  let productLookupCalls = 0;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => {
    productLookupCalls += 1;
    return null;
  };

  const cases = [
    {
      message: "Zaprimila sam paket i poslali ste mi krive knjige. Kako ćemo to riješiti?",
      expectedType: "hard_handoff",
      expectedState: "awaiting_human",
      expectedReason: "wrong_books_handoff",
      patterns: [/Žao mi je|ispričavamo/i, /broj narudžbe/i, /sliku računa/i, /kontakt broj/i]
    },
    {
      message: "Nisam zaprimio novac od prodaje udžbenika. Poslao sam paket prije 2 tjedna.",
      expectedType: "hard_handoff",
      expectedState: "awaiting_human",
      expectedReason: "buyback_payout_handoff",
      patterns: [/provjerit ćemo uplatu/i, /ime i prezime/i, /otkupnog naloga/i]
    },
    {
      message: "Niste mi platili otkup. Jeste li me prevarili?",
      expectedType: "hard_handoff",
      expectedState: "awaiting_human",
      expectedReason: "aggressive_complaint_handoff",
      patterns: [/Razumijem frustraciju/i, /riješit ćemo sve/i]
    },
    {
      message: "Zanima me jeste li poslali moju narudžbu?",
      expectedType: "ask_clarifying_question",
      expectedState: "awaiting_customer_detail",
      expectedReason: "order_issue_clarification",
      patterns: [/ovdje u chatu/i, /broj narudžbe/i]
    },
    {
      message: "Ali ja sam kupio knjige od vas",
      expectedType: "ask_clarifying_question",
      expectedState: "awaiting_customer_detail",
      expectedReason: "order_issue_clarification",
      patterns: [/broj narudžbe/i]
    },
    {
      message: "Trebaju mi udžbenici za 1. razred gimnazije",
      expectedType: "safe_answer",
      expectedState: "ai_active",
      expectedReason: "purchase_search_guidance",
      patterns: [/kupi-udzbenike/i, /šifru udžbenika|sifru udzbenika/i]
    },
    {
      message: "Kako mogu naručiti?",
      expectedType: "safe_answer",
      expectedState: "ai_active",
      expectedReason: "purchase_search_guidance",
      patterns: [/kupi-udzbenike/i, /naslov, autora ili nakladnika/i]
    },
    {
      message: "Želim prodati udžbenike online",
      expectedType: "safe_answer",
      expectedState: "ai_active",
      expectedReason: "online_buyback_guidance",
      patterns: [/otkup-udzbenika/i, /1\. Otvorite/i, /2\. Mobitelom skenirajte barkod/i, /3\./, /4\./]
    },
    {
      message: "Kako ću potvrditi online otkupni nalog?",
      expectedType: "hard_handoff",
      expectedState: "awaiting_human",
      expectedReason: "buyback_confirmation_handoff",
      patterns: [/provjeriti ručno/i]
    }
  ];

  try {
    for (const testCase of cases) {
      const { outcome } = await __internal.resolveAutomatedOutcome({}, testCase.message, {
        channelType: "web_chat"
      });

      assert.equal(outcome.type, testCase.expectedType, testCase.message);
      assert.equal(outcome.stateTag, testCase.expectedState, testCase.message);
      assert.equal(outcome.reason, testCase.expectedReason, testCase.message);

      for (const pattern of testCase.patterns) {
        assert.match(outcome.customerMessage, pattern, testCase.message);
      }
    }

    assert.equal(productLookupCalls, 0, "v1 regression flows should not call product feed");
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome keeps payout complaint outcome stable across session context", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";

  try {
    const message = "Nisam zaprimio novac od prodaje udžbenika.";
    const firstTurn = await __internal.resolveAutomatedOutcome({}, message, {
      channelType: "web_chat"
    });
    const secondTurn = await __internal.resolveAutomatedOutcome(
      {
        messages: [
          { role: "user", content: "Zanima me radno vrijeme." },
          { role: "assistant", content: "Radimo ponedjeljkom." }
        ],
        workingMemory: {
          activeDomain: "support_info"
        }
      },
      message,
      { channelType: "web_chat" }
    );

    assert.equal(firstTurn.outcome.type, "hard_handoff");
    assert.equal(secondTurn.outcome.type, "hard_handoff");
    assert.equal(firstTurn.outcome.reason, "buyback_payout_handoff");
    assert.equal(secondTurn.outcome.reason, "buyback_payout_handoff");
    assert.equal(firstTurn.outcome.stateTag, "awaiting_human");
    assert.equal(secondTurn.outcome.stateTag, "awaiting_human");
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("appendLocalAssistantOutcome keeps the chat usable when Zendesk write is rate-limited", () => {
  const session = {
    messages: [
      {
        id: "u1",
        role: "user",
        content: "Imate li Algebra 1?",
        createdAt: new Date("2026-04-20T19:30:00Z").toISOString(),
        attachments: []
      }
    ]
  };

  __internal.appendLocalAssistantOutcome(session, {
    type: "safe_answer",
    stateTag: "ai_active",
    reason: "product_feed_match",
    source: "product_feed",
    taskIntent: "product_lookup",
    customerMessage: "Trenutno je dostupna. Cijena je 9,90 EUR.",
    products: [
      {
        title: "Algebra 1",
        buyLink: "https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=Algebra%201"
      }
    ]
  });

  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].role, "assistant");
  assert.equal(session.messages[1].supportTaskIntent, "product_lookup");
  assert.equal(session.messages[1].products.length, 1);
  assert.equal(session.conversationState.tone, "ai-active");
});

test("isZendeskRateLimitError recognizes propagated Zendesk 429 errors", () => {
  assert.equal(__internal.isZendeskRateLimitError({ status: 429 }), true);
  assert.equal(__internal.isZendeskRateLimitError({ response: { status: 429 } }), true);
  assert.equal(__internal.isZendeskRateLimitError({ status: 503 }), false);
});

test("buildGroundedAnswerPrompt encodes answer constraints for exact facts and channel tone", () => {
  const prompt = aiService.buildGroundedAnswerPrompt(
    "Izvor 1 (OneDrive):\nNaslov: Dostava\nSadržaj: GLS dostava na kućnu adresu iznosi 5,97 EUR.",
    {
      channelType: "email",
      customerName: "Ivana",
      conversationSummary: "Korisnica pita samo za cijenu dostave."
    }
  );

  assert.match(prompt, /Sve činjenice poput cijena, rokova, datuma, radnog vremena, adresa, emailova, telefona i naziva načina plaćanja prepiši točno kako pišu u kontekstu\./);
  assert.match(prompt, /Nemoj mijenjati brojke, valutu, raspone, uvjete ni redoslijed koraka iz konteksta\./);
  assert.match(prompt, /KANAL: Email/);
  assert.match(prompt, /Ne generiraj subject ni potpis; vrati samo tijelo odgovora\./);
  assert.match(prompt, /Korisnik se zove Ivana\./);
  assert.match(prompt, /SAŽETAK RAZGOVORA:\nKorisnica pita samo za cijenu dostave\./);
  assert.match(prompt, /GLS dostava na kućnu adresu iznosi 5,97 EUR\./);
});
