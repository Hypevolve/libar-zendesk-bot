const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const aiService = require("../services/aiService");
const knowledgeService = require("../services/knowledgeService");
const { __internal } = require("../index");

test("grounded answer prompt adapts instructions for web, facebook, and email", () => {
  const context = "Radno vrijeme poslovnice je 08:00 – 20:00 od ponedjeljka do petka.";

  const webPrompt = aiService.buildGroundedAnswerPrompt(context, { channelType: "web_chat" });
  assert.match(webPrompt, /KANAL: Web chat/i);
  assert.match(webPrompt, /kraći i direktniji/i);

  const facebookPrompt = aiService.buildGroundedAnswerPrompt(context, { channelType: "facebook" });
  assert.match(facebookPrompt, /KANAL: Facebook/i);
  assert.match(facebookPrompt, /malo kraći i razgovorniji/i);
  assert.match(facebookPrompt, /Nemoj koristiti web-chat formulacije/i);

  const emailPrompt = aiService.buildGroundedAnswerPrompt(context, { channelType: "email" });
  assert.match(emailPrompt, /KANAL: Email/i);
  assert.match(emailPrompt, /prirodan support email odgovor/i);
  assert.match(emailPrompt, /bez chatu sličnih formulacija/i);
});

test("resolveAutomatedOutcome uses grounded answers across web, facebook, and email", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;
  const recordedCalls = [];

  knowledgeService.searchKnowledgeDetailed = async (query) => ({
    context: `KB za: ${query}`,
    articles: [{ title: "Mock KB", body: "Mock body", score: 99 }]
  });

  aiService.generateGroundedAnswer = async (message, context, options = {}) => {
    recordedCalls.push({ message, context, options });
    return `Odgovor za ${options.channelType}`;
  };

  try {
    for (const channelType of ["web_chat", "facebook", "email"]) {
      const result = await __internal.resolveAutomatedOutcome(
        { requesterName: "Ana" },
        "Koje vam je radno vrijeme?",
        { channelType }
      );

      assert.equal(result.outcome.type, "safe_answer");
      assert.equal(result.outcome.reason, "grounded_answer");
      assert.equal(result.outcome.customerMessage, `Odgovor za ${channelType}`);
    }

    assert.deepEqual(
      recordedCalls.map((entry) => entry.options.channelType),
      ["web_chat", "facebook", "email"]
    );
    assert.ok(recordedCalls.every((entry) => entry.context.includes("KB za: Koje vam je radno vrijeme?")));
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome uses deterministic fallback copy across channels when KB hit is strong but model answer is missing", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Postoji kontekst, ali generator ne uspijeva složiti odgovor.",
    articles: [{ title: "Mock KB", body: "Radimo ponedjeljkom do petka od 08:00 do 20:00.", score: 99 }],
    topScore: 99
  });

  aiService.generateGroundedAnswer = async () => null;

  try {
    const webResult = await __internal.resolveAutomatedOutcome({}, "Pitanje", { channelType: "web_chat" });
    assert.equal(webResult.outcome.type, "safe_answer");
    assert.equal(webResult.outcome.reason, "knowledge_fallback");
    assert.equal(webResult.outcome.customerMessage, "Radimo ponedjeljkom do petka od 08:00 do 20:00.");

    const facebookResult = await __internal.resolveAutomatedOutcome({}, "Pitanje", { channelType: "facebook" });
    assert.equal(facebookResult.outcome.type, "safe_answer");
    assert.equal(facebookResult.outcome.reason, "knowledge_fallback");
    assert.equal(facebookResult.outcome.customerMessage, "Radimo ponedjeljkom do petka od 08:00 do 20:00.");

    const emailResult = await __internal.resolveAutomatedOutcome({}, "Pitanje", { channelType: "email" });
    assert.equal(emailResult.outcome.type, "safe_answer");
    assert.equal(emailResult.outcome.reason, "knowledge_fallback");
    assert.equal(emailResult.outcome.customerMessage, "Radimo ponedjeljkom do petka od 08:00 do 20:00.");
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome returns channel-specific handoff copy when KB hit is too weak and model answer is missing", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  knowledgeService.searchKnowledgeDetailed = async () => ({
    context: "Postoji kontekst, ali rezultat je slab.",
    articles: [{ title: "Mock KB", body: "Mock body", score: 2 }],
    topScore: 2
  });

  aiService.generateGroundedAnswer = async () => null;

  try {
    const webResult = await __internal.resolveAutomatedOutcome({}, "Pitanje", { channelType: "web_chat" });
    assert.equal(webResult.outcome.type, "hard_handoff");
    assert.match(webResult.outcome.customerMessage, /javit ćemo vam se ovdje/i);

    const facebookResult = await __internal.resolveAutomatedOutcome({}, "Pitanje", { channelType: "facebook" });
    assert.equal(facebookResult.outcome.type, "hard_handoff");
    assert.match(facebookResult.outcome.customerMessage, /javiti.*ovdje/i);

    const emailResult = await __internal.resolveAutomatedOutcome({}, "Pitanje", { channelType: "email" });
    assert.equal(emailResult.outcome.type, "hard_handoff");
    assert.doesNotMatch(emailResult.outcome.customerMessage, /ovdje/i);
    assert.match(emailResult.outcome.customerMessage, /pregledamo detalje/i);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});

test("resolveAutomatedOutcome bypasses KB lookup for attachments and keeps channel-specific copy", async () => {
  const originalSearchKnowledgeDetailed = knowledgeService.searchKnowledgeDetailed;
  const originalGenerateGroundedAnswer = aiService.generateGroundedAnswer;

  let knowledgeCalled = false;
  let generationCalled = false;

  knowledgeService.searchKnowledgeDetailed = async () => {
    knowledgeCalled = true;
    return null;
  };

  aiService.generateGroundedAnswer = async () => {
    generationCalled = true;
    return "should not happen";
  };

  try {
    const webResult = await __internal.resolveAutomatedOutcome({}, "Šaljem privitak", {
      hasAttachments: true,
      channelType: "web_chat"
    });
    assert.equal(webResult.reason, "attachments_present");
    assert.match(webResult.outcome.customerMessage, /privitci su stigli/i);

    const facebookResult = await __internal.resolveAutomatedOutcome({}, "Šaljem privitak", {
      hasAttachments: true,
      channelType: "facebook"
    });
    assert.equal(facebookResult.reason, "attachments_present");
    assert.match(facebookResult.outcome.customerMessage, /javiti vam se ovdje/i);

    const emailResult = await __internal.resolveAutomatedOutcome({}, "Šaljem privitak", {
      hasAttachments: true,
      channelType: "email"
    });
    assert.equal(emailResult.reason, "attachments_present");
    assert.doesNotMatch(emailResult.outcome.customerMessage, /ovdje/i);
    assert.match(emailResult.outcome.customerMessage, /Hvala na poslanom privitku/i);

    assert.equal(knowledgeCalled, false);
    assert.equal(generationCalled, false);
  } finally {
    knowledgeService.searchKnowledgeDetailed = originalSearchKnowledgeDetailed;
    aiService.generateGroundedAnswer = originalGenerateGroundedAnswer;
  }
});
