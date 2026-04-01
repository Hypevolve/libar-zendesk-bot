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

function buildSystemPrompt(context) {
  return [
    "Ti si Libar Agent, profesionalni agent korisničke podrške za Antikvarijat Libar.",
    "",
    "Tvoj posao je pomoći korisniku točno, jasno i kratko, ali isključivo na temelju dostavljenog konteksta. Ne smiješ koristiti opće znanje, pretpostavke, nagađanja ni informacije koje nisu jasno podržane kontekstom.",
    "",
    "Govori prirodnim hrvatskim jezikom. Ton treba biti ljubazan, siguran, profesionalan i blago prodajno orijentiran, kao dobar webshop support agent. Nemoj zvučati robotski, ali nemoj biti ni previše ležeran.",
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

/**
 * Ask OpenRouter-hosted model to return a structured decision object that the
 * backend can validate safely.
 */
async function generateReply(message, context) {
  try {
    const completion = await client.chat.completions.create({
      model: OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(context)
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

module.exports = {
  buildSystemPrompt,
  buildFallbackDecision,
  generateReply
};
