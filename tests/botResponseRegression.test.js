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
    context: "Izvor 1 (Zendesk Help Center):\nNaslov: Povrat\nSadržaj: Povrat zahtijeva ručnu provjeru.",
    articles: [
      {
        title: "Povrat",
        body: "Povrat zahtijeva ručnu provjeru.",
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
      "Treba mi pomoć oko povrata.",
      { channelType: "web_chat" }
    );

    assert.ok(knowledge);
    assert.equal(knowledge.primarySource, "zendesk");
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "knowledge_fallback");
    assert.equal(outcome.customerMessage, "Povrat zahtijeva ručnu provjeru.");

    const note = __internal.buildAutopilotNote({
      outcome,
      userMessage: "Treba mi pomoć oko povrata.",
      knowledge,
      channelType: "web_chat"
    });

    assert.match(note, /Korišteni dokument: Povrat/);
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

test("resolveAutomatedOutcome returns product cards and links when product feed finds a clear match", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const originalSearchProductsDetailed = productFeedService.searchProductsDetailed;

  knowledgeService.searchKnowledgeDetailed = async () => null;
  aiService.generateGroundedAnswer = async () => "";
  productFeedService.searchProductsDetailed = async () => ({
    topScore: 220,
    matchCount: 1,
    rawProducts: [
      {
        title: "SOLUTIONS 3rd ed. INTERMEDIATE",
        availableForPurchase: true,
        stockCount: 12,
        buyPriceEur: 8.55
      }
    ],
    products: [
      {
        id: "12",
        title: "SOLUTIONS 3rd ed. INTERMEDIATE",
        imageUrl: "https://example.test/solutions.jpg",
        metaLine: "Engleski jezik • 2. razred • radna bilježnica",
        priceLabel: "8,55 EUR",
        buyLink: "https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=SOLUTIONS+3rd+ed.+INTERMEDIATE",
        sellLink: "https://antikvarijat-libar.com/otkup-udzbenika/?tab=tab-form&pretraga_isbn=9780194563819"
      }
    ],
    zendeskSummary: "1. SOLUTIONS 3rd ed. INTERMEDIATE | dostupno za kupnju"
  });

  try {
    const { outcome } = await __internal.resolveAutomatedOutcome(
      {},
      "Trebam SOLUTIONS intermediate workbook od Tim Falle",
      { channelType: "web_chat" }
    );

    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "product_feed_match");
    assert.equal(outcome.source, "product_feed");
    assert.equal(outcome.taskIntent, "product_lookup");
    assert.equal(outcome.products.length, 1);
    assert.match(outcome.customerMessage, /Trenutno je dostupan/i);
    assert.match(outcome.customerMessage, /8,55 EUR/i);
    assert.match(outcome.customerMessage, /kupi-udzbenike/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
});

test("resolveAutomatedOutcome sends website-guided fallback for product lookup when product feed has no match", async () => {
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
    assert.equal(outcome.reason, "product_lookup_fallback");
    assert.equal(outcome.source, "website_links");
    assert.match(outcome.customerMessage, /provjeriti dostupnost udžbenika na našem webu/i);
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

    assert.equal(productLookupCalled, true);
    assert.equal(outcome.type, "safe_answer");
    assert.equal(outcome.reason, "product_lookup_fallback");
    assert.match(outcome.customerMessage, /kupi-udzbenike/i);
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
    assert.equal(outcome.type, "ask_clarifying_question");
    assert.equal(outcome.reason, "buyback_clarification");
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
    assert.match(outcome.customerMessage, /broj narudžbe|email/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome asks a clarifying question for generic buyback intent instead of escalating", async () => {
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

    assert.equal(outcome.type, "ask_clarifying_question");
    assert.equal(outcome.reason, "buyback_clarification");
    assert.match(outcome.customerMessage, /barkod|fotografije|otkupa/i);
    assert.match(outcome.customerMessage, /prodaj-udzbenike/i);
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
    assert.equal(outcome.type, "ask_clarifying_question");
    assert.equal(outcome.reason, "buyback_clarification");
    assert.match(outcome.customerMessage, /prodaj-udzbenike/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
    productFeedService.searchProductsDetailed = originalSearchProductsDetailed;
  }
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
