function normalizeText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value = "") {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s#]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRecentMessages(messages = [], limit = 8) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.role !== "system" && normalizeText(message.content))
    .slice(-limit);
}

function getLatestAssistantMessage(messages = []) {
  return [...messages].reverse().find((message) => message.role === "assistant") || null;
}

function getLatestUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message.role === "user") || null;
}

function collectRecentUserMessages(messages = [], limit = 4) {
  return [...messages]
    .reverse()
    .filter((message) => message.role === "user" && normalizeText(message.content))
    .slice(0, limit)
    .reverse();
}

function detectIntentFromText(text = "") {
  const normalized = normalizeComparableText(text);

  if (!normalized) {
    return "";
  }

  if (
    /(povrat|refund|reklamacij|ostecen|oštećen|kriva knjiga|krivu knjigu|prevara|placanj|plaćanj)/.test(
      normalized
    )
  ) {
    return "reklamacija_problem";
  }

  if (/(otkup|prodati knjig|prodaju knjig|procjen|procjenu|vrednovanj)/.test(normalized)) {
    return "otkup_knjiga";
  }

  if (/(dostav|isporuk|preuzimanj|slanje|kurir|posta|pošta)/.test(normalized)) {
    return "dostava";
  }

  if (/(narudzb|narudžb|broj narudzbe|broj narudžbe|status narudzbe|status narudžbe)/.test(normalized)) {
    return "narudzba";
  }

  if (/(udzben|udžben|knjig|isbn|autor|naslov)/.test(normalized)) {
    return "opci_upit";
  }

  return "";
}

function extractOrderReference(text = "") {
  const raw = normalizeText(text);
  const match =
    raw.match(/#\s?\d{3,}/) ||
    raw.match(/\b(?:narud[žz]be?|order)\s*[:#-]?\s*([a-z0-9-]{3,})\b/i) ||
    raw.match(/\b\d{5,}\b/);

  if (!match) {
    return "";
  }

  return normalizeText(match[0] || match[1] || "");
}

function extractLocation(text = "") {
  const raw = normalizeText(text);
  const match =
    raw.match(/\bu\s+([A-ZČĆŽŠĐ][\p{L}-]+(?:\s+[A-ZČĆŽŠĐ][\p{L}-]+){0,2})/u) ||
    raw.match(/\bza\s+([A-ZČĆŽŠĐ][\p{L}-]+(?:\s+[A-ZČĆŽŠĐ][\p{L}-]+){0,2})/u);

  return normalizeText(match?.[1] || "");
}

function extractBookDescription(text = "") {
  const raw = normalizeText(text);

  if (!raw) {
    return "";
  }

  const quoted = raw.match(/"([^"]{3,120})"/);
  if (quoted?.[1]) {
    return normalizeText(quoted[1]);
  }

  const bookLike = raw.match(
    /\b(\d+\s+(?:knjiga|udžbenika|udzbenika)|školsk[ei]\s+udžbenik[ae]?|strucn[ei]\s+knjig[ae]|stručn[ei]\s+knjig[ae])\b/i
  );

  return normalizeText(bookLike?.[1] || "");
}

function extractQuantity(text = "") {
  const raw = normalizeComparableText(text);
  const match = raw.match(/\b(\d+)\s+(?:knjig|udzbenik|udžbenik|naslov)/);

  return match?.[1] || "";
}

function extractIssueDescription(text = "") {
  const raw = normalizeText(text);

  if (!raw) {
    return "";
  }

  if (raw.length <= 20) {
    return "";
  }

  return raw;
}

function buildConversationFacts(intent, messages = []) {
  const userMessages = collectRecentUserMessages(messages, 4);
  const mergedUserText = userMessages.map((message) => message.content).join(" ");
  const facts = [];

  const orderReference = extractOrderReference(mergedUserText);
  const location = extractLocation(mergedUserText);
  const bookDescription = extractBookDescription(mergedUserText);
  const quantity = extractQuantity(mergedUserText);

  if (intent === "narudzba" || orderReference) {
    if (orderReference) {
      facts.push(`Broj narudžbe: ${orderReference}`);
    }
  }

  if (intent === "dostava" && location) {
    facts.push(`Lokacija dostave: ${location}`);
  }

  if (intent === "otkup_knjiga") {
    if (bookDescription) {
      facts.push(`Knjige za otkup: ${bookDescription}`);
    }

    if (quantity) {
      facts.push(`Količina: ${quantity}`);
    }
  }

  if (intent === "reklamacija_problem") {
    const description = extractIssueDescription(mergedUserText);

    if (description) {
      facts.push(`Opis problema: ${description.slice(0, 180)}`);
    }
  }

  return [...new Set(facts)];
}

function detectRiskFlags(text = "") {
  const normalized = normalizeComparableText(text);
  const flags = [];

  if (/(povrat|refund)/.test(normalized)) {
    flags.push("refund");
  }

  if (/(placanj|plaćanj|kartic|racun|račun|naplat)/.test(normalized)) {
    flags.push("payment");
  }

  if (/(reklamacij|ostecen|oštećen|kriva knjiga|pogresna posiljka|pogrešna pošiljka)/.test(normalized)) {
    flags.push("complaint");
  }

  if (/(prevara|odvjetnik|inspekcij|prijav)/.test(normalized)) {
    flags.push("legal_or_abuse");
  }

  if (/(ljut|katastrof|uzas|užas|ne radi|nikad vise|nikad više)/.test(normalized)) {
    flags.push("negative_sentiment");
  }

  return [...new Set(flags)];
}

function isFollowUpMessage(text = "") {
  const normalized = normalizeComparableText(text);

  if (!normalized) {
    return false;
  }

  if (normalized.split(" ").length <= 6) {
    return true;
  }

  return /^(a|a za|a sto|a što|i|i za|sto ako|što ako|koliko|ima li|jel|je li|moze li|može li)\b/.test(
    normalized
  );
}

function inferTopicAnchor(messages = [], session = {}) {
  const latestAssistant = getLatestAssistantMessage(messages);

  if (Array.isArray(latestAssistant?.products) && latestAssistant.products.length > 0) {
    return {
      type: "product",
      value: latestAssistant.products.map((product) => product.title).filter(Boolean).slice(0, 2)
    };
  }

  if (Array.isArray(session.lastProductTitles) && session.lastProductTitles.length > 0) {
    return {
      type: "product",
      value: session.lastProductTitles.slice(0, 2)
    };
  }

  if (session.lastStandaloneQuery) {
    return {
      type: "query",
      value: session.lastStandaloneQuery
    };
  }

  const latestUser = getLatestUserMessage(messages);

  if (latestUser?.content) {
    return {
      type: "query",
      value: latestUser.content
    };
  }

  return null;
}

function buildStandaloneQuery({
  message,
  intent,
  facts,
  isFollowUp,
  topicAnchor,
  pendingClarification = null,
  session = {}
}) {
  const normalizedMessage = normalizeText(message);
  const factText = facts.join(" | ");
  const parts = [];

  if (pendingClarification?.baseQuery) {
    parts.push(pendingClarification.baseQuery);
  } else if (isFollowUp && topicAnchor?.type === "product" && topicAnchor.value.length > 0) {
    parts.push(`Proizvod: ${topicAnchor.value.join(", ")}`);
  } else if (isFollowUp && topicAnchor?.value) {
    parts.push(`Tema razgovora: ${topicAnchor.value}`);
  } else if (!isFollowUp && session.lastStandaloneQuery && normalizedMessage.length < 30) {
    parts.push(`Tema razgovora: ${session.lastStandaloneQuery}`);
  }

  if (intent) {
    parts.push(`Namjera: ${intent}`);
  }

  parts.push(normalizedMessage);

  if (factText) {
    parts.push(`Poznate činjenice: ${factText}`);
  }

  return parts.filter(Boolean).join("\n");
}

function buildMissingSlots(intent, messages = [], pendingClarification = null) {
  const userMessages = collectRecentUserMessages(messages, 4);
  const mergedUserText = userMessages.map((message) => message.content).join(" ");
  const orderReference = extractOrderReference(mergedUserText);
  const location = extractLocation(mergedUserText);
  const bookDescription = extractBookDescription(mergedUserText);
  const quantity = extractQuantity(mergedUserText);
  const issueDescription = extractIssueDescription(mergedUserText);
  const missingSlots = [];

  if (intent === "narudzba") {
    if (!orderReference) {
      missingSlots.push("order_reference");
    }
  }

  if (intent === "dostava") {
    const hasSpecificQuestion = /\?/.test(mergedUserText) || /(rok|cijena|koliko|kada|kurir|preuzimanje)/i.test(mergedUserText);

    if (!location && !hasSpecificQuestion) {
      missingSlots.push("delivery_scope");
    }
  }

  if (intent === "otkup_knjiga" && !bookDescription && !quantity) {
    missingSlots.push("book_details");
  }

  if (intent === "reklamacija_problem" && !issueDescription) {
    missingSlots.push("issue_description");
  }

  if (
    pendingClarification?.slotKey &&
    missingSlots.includes(pendingClarification.slotKey) &&
    pendingClarification.attemptCount >= 1
  ) {
    return {
      missingSlots,
      canAskAgain: false
    };
  }

  return {
    missingSlots,
    canAskAgain: true
  };
}

function buildClarifyingQuestion(intent, slotKey) {
  if (slotKey === "order_reference") {
    return "Možete li mi poslati broj narudžbe da odmah pogledam o čemu se radi?";
  }

  if (slotKey === "delivery_scope") {
    return "Što vas točno zanima oko dostave, primjerice rok, cijena ili mjesto isporuke?";
  }

  if (slotKey === "book_details") {
    return "Možete li ukratko napisati koje knjige nudite za otkup ili barem koliko ih otprilike imate?";
  }

  if (slotKey === "issue_description") {
    return "Možete li mi u jednoj rečenici napisati što se točno dogodilo s narudžbom?";
  }

  if (intent === "opci_upit") {
    return "Možete li mi samo malo preciznije napisati što vas zanima?";
  }

  return "";
}

function buildResponsePlan({ intent, missingSlots, riskFlags, isFollowUp, standaloneQuery }) {
  const steps = [];

  if (missingSlots.length > 0) {
    steps.push("Tražiti jednu ključnu informaciju prije odgovora.");
  } else {
    steps.push("Pokušati odgovoriti izravno na temelju konteksta.");
  }

  if (isFollowUp) {
    steps.push("Tretirati poruku kao nastavak prethodne teme.");
  }

  if (riskFlags.length > 0) {
    steps.push("Održati stroži prag sigurnosti zbog osjetljive teme.");
  }

  if (standaloneQuery) {
    steps.push(`Standalone upit za retrieval: ${standaloneQuery.slice(0, 180)}`);
  }

  return {
    intent: intent || "opci_upit",
    nextStep: missingSlots[0] || "answer",
    steps
  };
}

function analyzeConversation({
  message,
  messages = [],
  entryIntent = "",
  pendingClarification = null,
  session = {}
} = {}) {
  const normalizedMessage = normalizeText(message);
  const recentMessages = getRecentMessages(messages, 8);
  const combinedText = [...recentMessages.map((item) => item.content), normalizedMessage].join(" ");
  const detectedIntent = detectIntentFromText(normalizedMessage) || detectIntentFromText(combinedText) || entryIntent || session.lastResolvedIntent || "opci_upit";
  const riskFlags = detectRiskFlags(combinedText);
  const followUp = isFollowUpMessage(normalizedMessage);
  const topicAnchor = inferTopicAnchor(recentMessages, session);
  const facts = buildConversationFacts(detectedIntent, [...recentMessages, { role: "user", content: normalizedMessage }]);
  const { missingSlots, canAskAgain } = buildMissingSlots(
    detectedIntent,
    [...recentMessages, { role: "user", content: normalizedMessage }],
    pendingClarification
  );
  const clarifyingQuestion = missingSlots.length > 0 && canAskAgain
    ? buildClarifyingQuestion(detectedIntent, missingSlots[0])
    : "";
  const standaloneQuery = buildStandaloneQuery({
    message: normalizedMessage,
    intent: detectedIntent,
    facts,
    isFollowUp: followUp,
    topicAnchor,
    pendingClarification,
    session
  });
  const responsePlan = buildResponsePlan({
    intent: detectedIntent,
    missingSlots,
    riskFlags,
    isFollowUp: followUp,
    standaloneQuery
  });

  return {
    originalMessage: normalizedMessage,
    resolvedUserIntent: detectedIntent,
    standaloneQuery,
    conversationFacts: facts,
    missingSlots,
    clarifyingQuestion,
    riskFlags,
    isFollowUp: followUp,
    canAskClarifyingQuestion: Boolean(clarifyingQuestion),
    shouldPreferHuman:
      riskFlags.includes("refund") ||
      riskFlags.includes("payment") ||
      riskFlags.includes("legal_or_abuse") ||
      riskFlags.includes("complaint"),
    responsePlan,
    topicAnchor,
    usedMemory: Boolean(followUp && topicAnchor?.value),
    summary: [
      `Intent: ${detectedIntent}`,
      facts.length > 0 ? `Facts: ${facts.join("; ")}` : "",
      followUp ? "Poruka je follow-up na raniju temu." : "",
      riskFlags.length > 0 ? `Risk: ${riskFlags.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join(" ")
  };
}

module.exports = {
  analyzeConversation
};
