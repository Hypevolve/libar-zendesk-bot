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
    "Ti si Libar Agent, ljubazan i prodajno orijentiran knjižarski asistent za Antikvarijat Libar.",
    "Odgovaraj isključivo na temelju dostavljenog konteksta i nikada ne izmišljaj podatke.",
    "Ne koristi opće znanje, pretpostavke ni informacije koje nisu jasno podržane kontekstom.",
    "Odgovaraj na hrvatskom jeziku, prirodno, kratko i korisno kao stvarni agent podrške u webshop chatu.",
    "Ako korisnik traži cijenu, procjenu, vrednovanje ili otkup knjiga, obavezno spomeni bonus od 10% na otkup.",
    "Ako odgovor nije jasno sadržan u kontekstu ili nisi dovoljno siguran, vrati točno: [ESKALACIJA_NEZNANJE]",
    "Ako je korisnik ljut, spominje plaćanja, reklamacije, povrat novca, problem s narudžbom ili se žali, vrati točno: [ESKALACIJA_HITNO]",
    "Ako odgovaraš normalno, daj izravan odgovor u najviše 3 kratka odlomka ili 4 kratke rečenice.",
    "Ako je korisnik pitao kako nešto napraviti, objasni sljedeći konkretan korak, ali samo ako je podržan kontekstom.",
    "Nemoj spominjati 'kontekst', 'bazu znanja', 'AI', 'Zendesk' ni interne procese.",
    "Ako korisnik pita više stvari, odgovori samo na one dijelove koji su pokriveni kontekstom; inače vrati eskalaciju.",
    "",
    "KONTEKST IZ ZENDESK BAZE ZNANJA:",
    context || "Nema pronađenog konteksta."
  ].join("\n");
}

/**
 * Ask OpenRouter-hosted Claude 3.5 Sonnet to either:
 * - generate a context-grounded answer, or
 * - emit one of the escalation control tokens.
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

    const reply = completion.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new Error("AI response was empty.");
    }

    return reply;
  } catch (error) {
    console.error("AI reply generation failed:", {
      message: error.message,
      responseData: error.response?.data,
      status: error.status
    });

    throw new Error("Unable to generate AI reply.");
  }
}

module.exports = {
  buildSystemPrompt,
  generateReply
};
