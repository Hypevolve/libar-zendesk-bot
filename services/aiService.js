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

function buildSystemPrompt(context, { channelType = "unknown" } = {}) {
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
    "",
    "ESKALACIJSKA PRAVILA:",
    "- Ako je korisnik ljut, žali se, spominje plaćanje, povrat novca, reklamaciju, problem s narudžbom ili drugu osjetljivu situaciju, odluka mora biti hard_handoff.",
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
    "- Nemoj koristiti generičke fraze bez informacijske vrijednosti.",
    "- Ako korisnik pita kako nešto napraviti, odgovor treba biti proceduralan i konkretan.",
    "- Kad je prikladno, koristi blage prirodne formulacije poput 'Možete', 'Ako želite', 'Pošaljite' ili 'Javite'.",
    "- Nemoj zvučati kao da čitaš pravila ili internu proceduru.",
    "",
    ...buildChannelInstructions(channelType),
    "",
    "FORMAT IZLAZA:",
    "Vrati isključivo valjani JSON objekt, bez markdowna, bez code blocka i bez dodatnog teksta.",
    "Koristi točno ovu strukturu:",
    '{',
    '  "decision": "safe_answer" | "soft_handoff" | "hard_handoff",',
    '  "reply": "string",',
    '  "reason": "string"',
    '}',
    'Pravila za JSON izlaz:',
    '- Ako je decision = safe_answer, reply mora sadržavati gotov odgovor za korisnika na hrvatskom.',
    '- Ako je decision = soft_handoff, reply mora biti prazan string.',
    '- Ako je decision = hard_handoff, reply mora biti prazan string.',
    '- reason mora biti kratka strojno-čitljiva oznaka na engleskom, npr. "context_supported", "insufficient_context", "complaint_or_payment".',
    '- Nemoj vraćati ništa osim JSON objekta.',
    "",
    "KONTEKST:",
    context || "Nema pronađenog konteksta."
  ].join("\n");
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
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";

  if (!["safe_answer", "soft_handoff", "hard_handoff"].includes(decision)) {
    throw new Error("AI response used an unsupported decision.");
  }

  if (decision === "safe_answer" && !reply) {
    throw new Error("AI safe_answer decision did not include a reply.");
  }

  return {
    decision,
    reply,
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
 */
async function generateReply(message, context, options = {}) {
  try {
    const completion = await client.chat.completions.create({
      model: OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
      temperature: 0.2,
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
    console.error("AI reply generation failed:", {
      message: error.message,
      responseData: error.response?.data,
      status: error.status
    });

    if (
      error.message === "AI response did not contain valid JSON." ||
      error.message === "AI response used an unsupported decision." ||
      error.message === "AI safe_answer decision did not include a reply." ||
      error.name === "SyntaxError"
    ) {
      return buildFallbackDecision("invalid_structured_output");
    }

    return buildFallbackDecision("ai_generation_failed");
  }
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

module.exports = {
  buildSystemPrompt,
  buildFallbackDecision,
  classifySpamCandidate,
  generateReply,
  normalizeChannelType
};
