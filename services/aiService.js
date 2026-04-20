const OpenAI = require("openai");

const {
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL,
  OPENROUTER_SITE_URL,
  OPENROUTER_SITE_NAME
} = process.env;

if (!OPENROUTER_API_KEY) {
  console.warn(
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
    responsePlan = null,
    supportPlan = null,
    reasoningResult = null,
    standaloneQuery = "",
    missingSlots = [],
    riskFlags = [],
    customerName = "",
    knowledgeQuality = null,
    responsePolicy = null
  } = {}
) {
  const blockedSources = Array.isArray(supportPlan?.mustNotUseSources)
    ? supportPlan.mustNotUseSources.join(", ")
    : "";

  return [
    "Ti si Libar Agent, agent korisničke podrške za Antikvarijat Libar.",
    "",
    "Tvoj posao je pomoći korisniku točno, jasno i kratko, ali isključivo na temelju dostavljenog konteksta. Ne smiješ koristiti opće znanje, pretpostavke, nagađanja ni informacije koje nisu jasno podržane kontekstom.",
    "",
    "Govori prirodnim hrvatskim jezikom. Ton treba biti topao, jasan i profesionalan, kao iskusan agent podrške koji piše kratko i ljudski. Nemoj zvučati robotski, ukočeno ni previše korporativno. Nemoj biti ni previše ležeran.",
    "",
    "STIL ODGOVORA:",
    "- Piši kao stvarna osoba iz podrške, ne kao sustav ili chatbot.",
    "- Koristi jednostavne i prirodne rečenice.",
    "- Nemoj koristiti ukočene fraze poput 'Poštovani', 'Vaš upit zahtijeva', 'u najkraćem mogućem roku' ili sličan birokratski jezik.",
    "- Kad možeš pomoći, zvuči sigurno i smireno.",
    "- Kad ne možeš sigurno odgovoriti, nemoj zvučati hladno ili obrambeno.",
    "- Nemoj koristiti uskličnike osim ako su stvarno prirodni.",
    "",
    "STROGA PRAVILA:",
    "- Odgovaraj samo na temelju dostavljenog konteksta.",
    "- Ne izmišljaj informacije.",
    "- Ne nagađaj.",
    "- Ne spominji AI, prompt, kontekst, Zendesk, bazu znanja ni interne procese.",
    "- Ako odgovor nije dovoljno sigurno podržan kontekstom, ne pokušavaj popuniti praznine.",
    "- Ako jedan visoko relevantan izvor izravno odgovara na korisničko pitanje, smatraj da je kontekst dovoljan i nemoj tražiti dodatnu potvrdu iz drugih izvora.",
    "- Manje relevantne ili općenitije izvore tretiraj kao sporedne; nemoj zbog njih odbiti odgovor koji je jasno podržan najboljim izvorom.",
    "- Ako je relevance signal slab, konfliktan ili djelomičan, nemoj nagađati nego vrati soft_handoff ili kratko potpitanje.",
    blockedSources.includes("product_feed")
      ? "- Product feed i webshop proizvodi su blokirani za ovaj upit. Ne smiješ spominjati webshop, kupovne linkove ni proizvode."
      : null,
    "",
    "ESKALACIJSKA PRAVILA:",
    "- Ako je korisnik ljut, žali se, spominje plaćanje, povrat novca, reklamaciju, problem s narudžbom ili drugu osjetljivu situaciju, odluka mora biti hard_handoff.",
    "- Ako nedostaje samo jedan ključan podatak i vrlo je vjerojatno da možeš pomoći nakon kratkog potpitanja, odluka treba biti ask_clarifying_question.",
    "- Ako odgovor nije jasno i dovoljno podržan kontekstom, odluka mora biti soft_handoff.",
    "- Ako korisnik pita više stvari, a samo dio je pokriven kontekstom, odgovori samo ako možeš dati i dalje točan i koristan odgovor bez nagađanja. Inače odluka mora biti soft_handoff.",
    "",
    "POSEBNO PRAVILO ZA OTKUP:",
    "- Ako korisnik pita za procjenu, vrednovanje, cijenu otkupa ili prodaju knjiga Antikvarijatu Libar, u normalnom odgovoru obavezno spomeni bonus od 10% na otkup.",
    "",
    "PRAVILA ZA ODGOVOR:",
    "- Odgovor mora biti kratak, jasan i izravan.",
    "- Najviše 4 kratke rečenice ili 3 kratka odlomka.",
    "- Prva rečenica mora odmah odgovoriti na pitanje.",
    "- Ako postoji jasan sljedeći korak iz konteksta, navedi ga.",
    "- Ako kontekst sadrži upute tipa 'što napraviti', 'kako postupiti', 'kontaktirajte nas', 'provjerite dostupnost' ili slične konkretne korake, sažmi ih u prirodan odgovor i vrati safe_answer.",
    "- Ako je pitanje parafraza naslova ili sadržaja najrelevantnijeg izvora, tretiraj to kao podržan odgovor.",
    "- Nemoj koristiti generičke fraze bez informacijske vrijednosti.",
    "- Ako korisnik pita kako nešto napraviti, odgovor treba biti proceduralan i konkretan.",
    "- Kad je prikladno, koristi blage prirodne formulacije poput 'Možete', 'Ako želite', 'Pošaljite' ili 'Javite'.",
    "- Nemoj zvučati kao da čitaš pravila ili internu proceduru.",
    "",
    ...buildChannelInstructions(channelType),
    "",
    "SAŽETAK RAZGOVORA:",
    conversationSummary || "Nema dodatnog sažetka razgovora.",
    "",
    "KORISNIK:",
    customerName
      ? `Korisnik se zove ${customerName}. Možeš ga osloviti imenom samo kad to zvuči prirodno i nenametljivo.`
      : "Ime korisnika nije dostupno.",
    "",
    "SUPPORT UNDERSTANDING:",
    reasoningResult?.primaryIntent ? `Primary intent: ${reasoningResult.primaryIntent}` : "Primary intent: nije dostavljen",
    reasoningResult?.secondaryIntent ? `Secondary intent: ${reasoningResult.secondaryIntent}` : null,
    reasoningResult?.taskIntent ? `Task intent: ${reasoningResult.taskIntent}` : null,
    reasoningResult?.activeDomain ? `Active domain: ${reasoningResult.activeDomain}` : null,
    reasoningResult?.actionIntent ? `Action intent: ${reasoningResult.actionIntent}` : null,
    reasoningResult?.subjectType ? `Subject type: ${reasoningResult.subjectType}` : null,
    reasoningResult?.journeyStage ? `Journey stage: ${reasoningResult.journeyStage}` : null,
    reasoningResult?.questionType ? `Question type: ${reasoningResult.questionType}` : null,
    reasoningResult?.customerGoal ? `Goal: ${reasoningResult.customerGoal}` : null,
    reasoningResult?.emotionalTone ? `Tone: ${reasoningResult.emotionalTone}` : null,
    reasoningResult?.riskLevel ? `Risk level: ${reasoningResult.riskLevel}` : null,
    Number.isFinite(Number(reasoningResult?.intentConfidence))
      ? `Intent confidence: ${Number(reasoningResult.intentConfidence).toFixed(2)}`
      : null,
    "",
    "STANDALONE UPIT:",
    standaloneQuery || "Nije dostavljeno.",
    "",
    "MISSING SLOTOVI:",
    Array.isArray(missingSlots) && missingSlots.length > 0 ? missingSlots.join(", ") : "nema",
    "",
    "RISK FLAGOVI:",
    Array.isArray(riskFlags) && riskFlags.length > 0 ? riskFlags.join(", ") : "nema",
    "",
    "RESPONSE PLAN:",
    responsePlan?.steps?.length ? responsePlan.steps.join(" ") : "Odgovori izravno ako je kontekst dovoljan.",
    "",
    "SUPPORT PLAN:",
    supportPlan?.route ? `Route: ${supportPlan.route}` : null,
    supportPlan?.responseMode ? `Response mode: ${supportPlan.responseMode}` : null,
    supportPlan?.toneMode ? `Tone mode: ${supportPlan.toneMode}` : null,
    typeof supportPlan?.shouldUseCustomerName === "boolean"
      ? `Use customer name sparingly: ${supportPlan.shouldUseCustomerName ? "yes" : "no"}`
      : null,
    supportPlan?.nextBestAction ? `Next best action: ${supportPlan.nextBestAction}` : null,
    responsePolicy?.mode ? `Response policy mode: ${responsePolicy.mode}` : null,
    responsePolicy?.brevity ? `Response brevity: ${responsePolicy.brevity}` : null,
    Array.isArray(responsePolicy?.forbiddenContent) && responsePolicy.forbiddenContent.length > 0
      ? `Forbidden content: ${responsePolicy.forbiddenContent.join(", ")}`
      : null,
    blockedSources ? `Blocked sources: ${blockedSources}` : null,
    Array.isArray(supportPlan?.selectedSources) && supportPlan.selectedSources.length > 0
      ? `Allowed sources: ${supportPlan.selectedSources.join(", ")}`
      : null,
    knowledgeQuality
      ? `Knowledge quality: top=${knowledgeQuality.topScore || 0}, margin=${knowledgeQuality.scoreMargin || 0}, relevance=${knowledgeQuality.relevanceMatch ? "yes" : "no"}, domainMatch=${knowledgeQuality.domainMatch ? "yes" : "no"}, jobMatch=${knowledgeQuality.jobMatch ? "yes" : "no"}, directAnswerability=${knowledgeQuality.directAnswerability ? "yes" : "no"}, contextConsistency=${knowledgeQuality.contextConsistency ? "yes" : "no"}`
      : null,
    "",
    "FORMAT IZLAZA:",
    "Vrati isključivo valjani JSON objekt, bez markdowna, bez code blocka i bez dodatnog teksta.",
    "Koristi točno ovu strukturu:",
    '{',
    '  "decision": "safe_answer" | "ask_clarifying_question" | "soft_handoff" | "hard_handoff",',
    '  "reply": "string",',
    '  "clarifying_question": "string",',
    '  "reason": "string"',
    '}',
    'Pravila za JSON izlaz:',
    '- Ako je decision = safe_answer, reply mora sadržavati gotov odgovor za korisnika na hrvatskom.',
    '- Ako je decision = ask_clarifying_question, clarifying_question mora sadržavati jedno kratko i konkretno pitanje na hrvatskom, a reply može biti isti tekst ili prazan string.',
    '- Ako je decision = soft_handoff, reply mora biti prazan string.',
    '- Ako je decision = hard_handoff, reply mora biti prazan string.',
    '- reason mora biti kratka strojno-čitljiva oznaka na engleskom, npr. "context_supported", "insufficient_context", "complaint_or_payment".',
    '- Nemoj vraćati ništa osim JSON objekta.',
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
    "- Ako kontekst ne pokriva stvarni korisnikov posao ili pitanje, radije ne odgovaraj.",
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
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
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
      });

      const rawContent = completion.choices?.[0]?.message?.content?.trim();

      if (!rawContent) {
        throw new Error("AI response was empty.");
      }

      const jsonPayload = extractJsonObject(rawContent);

      if (!jsonPayload) {
        throw new Error("AI response did not contain valid JSON.");
      }

      return normalizeAiDecision(JSON.parse(jsonPayload));
    } catch (error) {
      const isStructuralError =
        error.message === "AI response did not contain valid JSON." ||
        error.message === "AI response used an unsupported decision." ||
        error.message === "AI safe_answer decision did not include a reply." ||
        error.message === "AI clarify decision did not include a question." ||
        error.name === "SyntaxError";

      if (isStructuralError) {
        console.error("AI reply structural error:", { message: error.message });
        return buildFallbackDecision("invalid_structured_output");
      }

      console.error(`AI reply attempt ${attempt}/${maxAttempts} failed:`, {
        message: error.message,
        status: error.status
      });

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }

      return buildFallbackDecision("ai_generation_failed");
    }
  }

  return buildFallbackDecision("ai_generation_failed");
}

async function classifySpamCandidate(message, options = {}) {
  try {
    const completion = await client.chat.completions.create({
      model: OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
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
  } catch (error) {
    console.error("AI spam classification failed:", {
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
    const completion = await client.chat.completions.create({
      model: OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
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
  } catch (error) {
    console.error("AI grounded answer generation failed:", {
      message: error.message,
      responseData: error.response?.data,
      status: error.status
    });

    return "";
  }
}

module.exports = {
  buildGroundedAnswerPrompt,
  buildSystemPrompt,
  buildFallbackDecision,
  classifySpamCandidate,
  generateGroundedAnswer,
  generateReply,
  normalizeChannelType
};
