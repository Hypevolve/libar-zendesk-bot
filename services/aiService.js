const OpenAI = require("openai");

const {
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL,
  OPENROUTER_FALLBACK_MODEL,
  OPENROUTER_SITE_URL,
  OPENROUTER_SITE_NAME
} = process.env;
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5";
const DEFAULT_OPENROUTER_FALLBACK_MODEL = "google/gemini-2.5-pro";
const IS_TEST_ENV = process.env.NODE_ENV === "test";
const SHOULD_LOG_IN_TEST = process.env.DEBUG_TEST_LOGS === "true";

function logWarn(...args) {
  if (!IS_TEST_ENV || SHOULD_LOG_IN_TEST) {
    console.warn(...args);
  }
}

function logError(...args) {
  if (!IS_TEST_ENV || SHOULD_LOG_IN_TEST) {
    console.error(...args);
  }
}

function normalizeModelName(value) {
  return String(value || "").trim();
}

function getConfiguredModels() {
  const configuredModels = [
    normalizeModelName(OPENROUTER_MODEL) || DEFAULT_OPENROUTER_MODEL,
    normalizeModelName(OPENROUTER_FALLBACK_MODEL) || DEFAULT_OPENROUTER_FALLBACK_MODEL
  ];

  return [...new Set(configuredModels.filter(Boolean))];
}

function getConfiguredModel() {
  return getConfiguredModels()[0];
}

if (!OPENROUTER_API_KEY) {
  logWarn(
    "OPENROUTER_API_KEY is missing. AI generation will fail until it is configured."
  );
}

const client = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    // These headers are recommended by OpenRouter for usage attribution.
    ...(OPENROUTER_SITE_URL ? { "HTTP-Referer": OPENROUTER_SITE_URL } : {}),
    ...(OPENROUTER_SITE_NAME ? { "X-Title": OPENROUTER_SITE_NAME } : {})
  }
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithModelFallback(execute, { purpose = "AI request", maxAttemptsPerModel = 1 } = {}) {
  let lastError = null;

  for (const model of getConfiguredModels()) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        return await execute(model);
      } catch (error) {
        lastError = error;
        logWarn(`${purpose} failed with ${model} attempt ${attempt}/${maxAttemptsPerModel}:`, {
          message: error.message,
          responseData: error.response?.data,
          status: error.status
        });

        if (attempt < maxAttemptsPerModel) {
          await wait(1000 * attempt);
        }
      }
    }
  }

  throw lastError || new Error(`${purpose} failed for all configured models.`);
}

function normalizeChannelType(channelType = "") {
  const normalized = String(channelType).trim().toLowerCase();

  if (
    normalized === "web_chat" ||
    normalized === "webchat" ||
    normalized === "web" ||
    normalized === "web_widget"
  ) {
    return "web_chat";
  }

  if (
    normalized === "facebook" ||
    normalized === "messenger" ||
    normalized === "facebook_messenger" ||
    normalized === "facebook_post" ||
    normalized === "facebook_page"
  ) {
    return "facebook";
  }

  if (normalized === "email" || normalized === "mail") {
    return "email";
  }

  return "unknown";
}

function buildChannelInstructions(channelType = "unknown") {
  const normalizedChannelType = normalizeChannelType(channelType);

  if (normalizedChannelType === "facebook") {
    return [
      "KANAL: Facebook",
      "- Odgovor treba biti malo kraći i razgovorniji nego email, ali i dalje profesionalan.",
      "- Nemoj koristiti web-chat formulacije poput 'javiti ćemo vam se ovdje u chatu'."
    ];
  }

  if (normalizedChannelType === "email") {
    return [
      "KANAL: Email",
      "- Odgovor treba zvučati kao prirodan support email odgovor.",
      "- Piši u punim, jasnim rečenicama i bez chatu sličnih formulacija.",
      "- Ne generiraj subject ni potpis; vrati samo tijelo odgovora."
    ];
  }

  if (normalizedChannelType === "web_chat") {
    return [
      "KANAL: Web chat",
      "- Odgovor može biti nešto kraći i direktniji kao u live chatu."
    ];
  }

  return [
    "KANAL: Zendesk podrška",
    "- Odgovor treba biti prirodan i kratak, bez pretpostavki o sučelju ili kanalu."
  ];
}





function buildSystemPrompt(
  context,
  {
    channelType = "unknown",
    conversationSummary = "",
    supportPlan = null,
    reasoningResult = null,
    standaloneQuery = "",
    customerName = ""
  } = {}
) {
  const blockedSources = Array.isArray(supportPlan?.mustNotUseSources)
    ? supportPlan.mustNotUseSources.join(", ")
    : "";

  return [
    "Ti si Libar Agent, agent korisničke podrške za Antikvarijat Libar.",
    "",
    "Odgovaraj točno, jasno, kratko i isključivo na temelju dostavljenog konteksta.",
    "Ton mora biti ljubazan, smiren i koristan, kao iskusan agent podrške.",
    "",
    "STROGA PRAVILA:",
    "- Ne izmišljaj informacije i ne koristi opće znanje.",
    "- Ako odgovor nije jasno podržan kontekstom, ne popunjavaj praznine.",
    "- Sve činjenice poput cijena, rokova, datuma, radnog vremena, adresa, emailova, telefona i načina plaćanja prepiši točno kako pišu u kontekstu.",
    "- Nemoj mijenjati brojke, valutu, raspone, uvjete ni redoslijed koraka iz konteksta.",
    "- Ne spominji AI, prompt, kontekst, bazu znanja, Zendesk ni interne procese.",
    "- Ne generiraj subject ni potpis.",
    blockedSources.includes("product_feed")
      ? "- Product feed i webshop proizvodi su blokirani za ovaj upit. Ne smiješ preporučivati artikle ni izmišljati dostupnost proizvoda."
      : null,
    "",
    "ESKALACIJSKA PRAVILA:",
    "- Ako korisnik spominje reklamaciju, krive knjige, povrat novca, krivu uplatu, neisplaćen otkup, pravnu prijetnju ili prijevaru, odluka mora biti hard_handoff.",
    "- Ako odgovor nije dovoljno sigurno podržan kontekstom, odluka mora biti soft_handoff.",
    "- Ako nedostaje jedan ključan podatak i korisno je postaviti kratko potpitanje, odluka treba biti ask_clarifying_question.",
    "",
    "PRAVILA ZA ODGOVOR:",
    "- Odgovor mora biti kratak, prirodan i izravan.",
    "- Najviše 4 kratke rečenice ili 3 kratka odlomka.",
    "- Ako postoji jasan sljedeći korak iz konteksta, navedi ga.",
    "- Nemoj zvučati robotski, obrambeno ili optužujuće.",
    "",
    ...buildChannelInstructions(channelType),
    "",
    "SAŽETAK RAZGOVORA:",
    conversationSummary || "Nema dodatnog sažetka razgovora.",
    "",
    "KORISNIK:",
    customerName
      ? `Korisnik se zove ${customerName}. Ime koristi samo kad zvuči prirodno i korisno.`
      : "Ime korisnika nije dostupno.",
    "",
    "SUPPORT UNDERSTANDING:",
    reasoningResult?.primaryIntent ? `Primary intent: ${reasoningResult.primaryIntent}` : "Primary intent: nije dostavljen",
    reasoningResult?.taskIntent ? `Task intent: ${reasoningResult.taskIntent}` : null,
    reasoningResult?.emotionalTone ? `Tone: ${reasoningResult.emotionalTone}` : null,
    reasoningResult?.riskLevel ? `Risk level: ${reasoningResult.riskLevel}` : null,
    "",
    "STANDALONE UPIT:",
    standaloneQuery || "Nije dostavljeno.",
    "",
    "FORMAT IZLAZA:",
    "Vrati isključivo valjani JSON objekt, bez markdowna, bez code blocka i bez dodatnog teksta.",
    "Koristi točno ovu strukturu:",
    "{",
    '  "decision": "safe_answer" | "ask_clarifying_question" | "soft_handoff" | "hard_handoff",',
    '  "reply": "string",',
    '  "clarifying_question": "string",',
    '  "reason": "string"',
    "}",
    "",
    "KONTEKST:",
    context || "Nema pronađenog konteksta."
  ].filter(Boolean).join("\n");
}

function extractJsonObject(rawText = "") {
  const trimmed = String(rawText).trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function normalizeAiDecision(parsed) {
  const decision = String(parsed?.decision || "").trim();
  const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : "";
  const clarifyingQuestion =
    typeof parsed?.clarifying_question === "string" ? parsed.clarifying_question.trim() : "";
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";

  if (!["safe_answer", "ask_clarifying_question", "soft_handoff", "hard_handoff"].includes(decision)) {
    throw new Error("AI response used an unsupported decision.");
  }

  if (decision === "safe_answer" && !reply) {
    throw new Error("AI safe_answer decision did not include a reply.");
  }

  if (decision === "ask_clarifying_question" && !clarifyingQuestion && !reply) {
    throw new Error("AI clarify decision did not include a question.");
  }

  return {
    decision,
    reply,
    clarifyingQuestion: clarifyingQuestion || reply,
    reason: reason || "unspecified"
  };
}

function buildFallbackDecision(reason = "ai_generation_failed") {
  return {
    decision: "soft_handoff",
    reply: "",
    reason
  };
}

function providerRejectedStructuredOutput(error) {
  return (
    error?.status === 400 ||
    /response_format|json_object|structured/i.test(String(error?.message || ""))
  );
}

function isAiDecisionStructuralError(error) {
  return (
    error.message === "AI response did not contain valid JSON." ||
    error.message === "AI response used an unsupported decision." ||
    error.message === "AI safe_answer decision did not include a reply." ||
    error.message === "AI clarify decision did not include a question." ||
    error.name === "SyntaxError"
  );
}

function buildSpamClassifierPrompt({ channelType = "email" } = {}) {
  return [
    "Ti si strogi klasifikator dolaznih poruka za korisničku podršku.",
    "",
    "Zadatak ti je klasificirati je li poruka stvarni support upit ili spam/outreach.",
    "",
    `Kanal: ${normalizeChannelType(channelType)}`,
    "",
    "Vrati isključivo JSON objekt bez dodatnog teksta.",
    "Koristi točno ovu strukturu:",
    "{",
    '  "label": "support_message" | "sales_outreach" | "marketing_spam" | "phishing_or_malicious" | "unknown",',
    '  "confidence": 0.0,',
    '  "reason": "string"',
    "}",
    "",
    "Pravila:",
    '- "support_message" koristi samo kad je poruka stvarni korisnički upit za podršku, narudžbu, knjigu, otkup, račun, dostavu ili sličnu temu.',
    '- "sales_outreach" koristi za B2B prodajne ili partnerske ponude, guest post, backlink, SEO outreach, marketinške usluge i slične pitch poruke.',
    '- "marketing_spam" koristi za generički, masovni ili očito nerelevantan outreach.',
    '- "phishing_or_malicious" koristi za poruke koje traže klik, verifikaciju računa, osjetljive podatke, wallet, gift card, crypto ili sličan rizičan sadržaj.',
    '- "unknown" koristi samo ako poruka nije dovoljno jasna za sigurnu klasifikaciju.',
    '- confidence mora biti broj između 0 i 1.',
    '- reason mora biti kratka strojno-čitljiva oznaka na engleskom.'
  ].join("\n");
}

function buildGroundedAnswerPrompt(context, { channelType = "unknown", customerName = "", conversationSummary = "" } = {}) {
  return [
    "Ti si Libar Agent, agent korisničke podrške za Antikvarijat Libar.",
    "",
    "Zadatak ti je napisati kratak, koristan i prirodan odgovor korisniku isključivo na temelju dostavljenog konteksta.",
    "",
    "PRAVILA:",
    "- Koristi samo informacije koje su izravno podržane kontekstom.",
    "- Ne izmišljaj dodatne informacije.",
    "- Ako kontekst sadrži konkretne korake ili preporuke, sažmi ih u jasan odgovor.",
    "- Ako korisnik pita dvije ili tri povezane stvari, odgovori kratko po istom redoslijedu.",
    "- Ako korisnik traži samo potvrdu ili kratku činjenicu, nemoj širiti odgovor u nepotreban postupak.",
    "- Ako kontekst ne pokriva stvarni korisnikov posao ili pitanje, radije ne odgovaraj.",
    "- Ton mora biti ljubazan, smiren i koristan, bez obrambenog ili optužujućeg tona.",
    "- Sve činjenice poput cijena, rokova, datuma, radnog vremena, adresa, emailova, telefona i naziva načina plaćanja prepiši točno kako pišu u kontekstu.",
    "- Nemoj mijenjati brojke, valutu, raspone, uvjete ni redoslijed koraka iz konteksta.",
    "- Nemoj spominjati AI, kontekst, bazu znanja ni interne procese.",
    "- Nemoj dodavati subject ni potpis.",
    customerName
      ? `- Korisnik se zove ${customerName}. Ime koristi samo ako zvuči prirodno i korisno.`
      : "- Ako ime korisnika nije poznato, nemoj ga izmišljati.",
    "- Vrati samo gotov odgovor za korisnika, bez JSON-a i bez dodatnih oznaka.",
    "",
    ...buildChannelInstructions(channelType),
    "",
    conversationSummary
      ? `SAŽETAK RAZGOVORA:\n${conversationSummary}`
      : "",
    "",
    "KONTEKST:",
    context || "Nema pronađenog konteksta."
  ].filter(Boolean).join("\n");
}

function normalizeSpamClassification(parsed) {
  const label = String(parsed?.label || "").trim();
  const confidenceNumber = Number(parsed?.confidence);
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";

  if (
    ![
      "support_message",
      "sales_outreach",
      "marketing_spam",
      "phishing_or_malicious",
      "unknown"
    ].includes(label)
  ) {
    throw new Error("AI spam classification used an unsupported label.");
  }

  if (!Number.isFinite(confidenceNumber) || confidenceNumber < 0 || confidenceNumber > 1) {
    throw new Error("AI spam classification did not include a valid confidence.");
  }

  return {
    label,
    confidence: confidenceNumber,
    reason: reason || "unspecified"
  };
}

/**
 * Ask OpenRouter-hosted model to return a structured decision object that the
 * backend can validate safely.
 * Fix #14: Retry once with exponential backoff on transient failures.
 */
async function generateReply(message, context, options = {}) {
  try {
    return await runWithModelFallback(async (model) => {
      const request = {
        model,
        temperature: 0.35,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(context, options)
          },
          {
            role: "user",
            content: message
          }
        ]
      };

      let completion;

      try {
        completion = await client.chat.completions.create({
          ...request,
          response_format: {
            type: "json_object"
          }
        });
      } catch (error) {
        if (!providerRejectedStructuredOutput(error)) {
          throw error;
        }

        completion = await client.chat.completions.create(request);
      }

      const rawContent = completion.choices?.[0]?.message?.content?.trim();

      if (!rawContent) {
        throw new Error("AI response was empty.");
      }

      const jsonPayload = extractJsonObject(rawContent);

      if (!jsonPayload) {
        throw new Error("AI response did not contain valid JSON.");
      }

      return normalizeAiDecision(JSON.parse(jsonPayload));
    }, { purpose: "AI reply", maxAttemptsPerModel: 2 });
  } catch (error) {
    if (isAiDecisionStructuralError(error)) {
      logError("AI reply structural error:", { message: error.message });
      return buildFallbackDecision("invalid_structured_output");
    }

    logError("AI reply generation failed:", {
      message: error.message,
      responseData: error.response?.data,
      status: error.status
    });

    return buildFallbackDecision("ai_generation_failed");
  }
}

async function classifySpamCandidate(message, options = {}) {
  try {
    return await runWithModelFallback(async (model) => {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: buildSpamClassifierPrompt(options)
          },
          {
            role: "user",
            content: String(message || "").slice(0, 3500)
          }
        ]
      });

      const rawContent = completion.choices?.[0]?.message?.content?.trim();

      if (!rawContent) {
        throw new Error("AI spam classification response was empty.");
      }

      const jsonPayload = extractJsonObject(rawContent);

      if (!jsonPayload) {
        throw new Error("AI spam classification did not contain valid JSON.");
      }

      return normalizeSpamClassification(JSON.parse(jsonPayload));
    }, { purpose: "AI spam classification" });
  } catch (error) {
    logError("AI spam classification failed:", {
      message: error.message,
      responseData: error.response?.data,
      status: error.status
    });

    return {
      label: "unknown",
      confidence: 0,
      reason: "spam_classification_failed"
    };
  }
}

async function generateGroundedAnswer(message, context, options = {}) {
  try {
    return await runWithModelFallback(async (model) => {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: buildGroundedAnswerPrompt(context, options)
          },
          {
            role: "user",
            content: String(message || "").trim()
          }
        ]
      });

      const reply = completion.choices?.[0]?.message?.content?.trim();

      if (!reply) {
        throw new Error("AI grounded answer was empty.");
      }

      return reply;
    }, { purpose: "AI grounded answer" });
  } catch (error) {
    logError("AI grounded answer generation failed:", {
      message: error.message,
      responseData: error.response?.data,
      status: error.status
    });

    return "";
  }
}

module.exports = {
  buildFallbackDecision,
  buildGroundedAnswerPrompt,
  buildSystemPrompt,
  classifySpamCandidate,
  generateGroundedAnswer,
  generateReply,
  getConfiguredModel,
  getConfiguredModels,
  normalizeChannelType
};
