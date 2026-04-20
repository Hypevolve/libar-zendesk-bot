const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const knowledgeService = require("../services/knowledgeService");
const aiService = require("../services/aiService");
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

test("resolveAutomatedOutcome still escalates when knowledge score is too weak for deterministic fallback", async () => {
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
      "Trebam pomoć oko nečeg nejasnog.",
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
