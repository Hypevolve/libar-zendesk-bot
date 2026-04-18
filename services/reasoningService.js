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
    .replace(/[^\p{L}\p{N}\s#-]/gu, " ")
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

function collectRecentUserMessages(messages = [], limit = 5) {
  return [...messages]
    .reverse()
    .filter((message) => message.role === "user" && normalizeText(message.content))
    .slice(0, limit)
    .reverse();
}

function extractOrderReference(text = "") {
  const raw = normalizeText(text);
  const match =
    raw.match(/#\s?\d{3,}/) ||
    raw.match(/\b(?:narud[žz]be?|order)\s*[:#-]?\s*([a-z0-9-]{3,})\b/i) ||
    raw.match(/\b\d{5,}\b/);

  return normalizeText(match?.[0] || match?.[1] || "");
}

function extractCity(text = "") {
  const raw = normalizeText(text);
  const match =
    raw.match(/\bu\s+([A-ZČĆŽŠĐ][\p{L}-]+(?:\s+[A-ZČĆŽŠĐ][\p{L}-]+){0,2})/u) ||
    raw.match(/\bza\s+([A-ZČĆŽŠĐ][\p{L}-]+(?:\s+[A-ZČĆŽŠĐ][\p{L}-]+){0,2})/u);

  return normalizeText(match?.[1] || "");
}

function extractIsbn(text = "") {
  const raw = String(text || "");
  const match = raw.match(/\b(?:97[89][-\s]?)?\d(?:[-\s]?\d){8,15}\b/);
  return normalizeText(match?.[0] || "").replace(/[^\dxX]/g, "").toUpperCase();
}

function extractQuantity(text = "") {
  const normalized = normalizeComparableText(text);
  const match = normalized.match(/\b(\d+)\s+(?:knjig|udžbenik|udzbenik|naslov)/);
  return match?.[1] || "";
}

function extractQuotedValue(text = "") {
  const quoted = String(text || "").match(/"([^"]{2,160})"/);
  return normalizeText(quoted?.[1] || "");
}

function extractBookTitle(text = "") {
  const quoted = extractQuotedValue(text);

  if (quoted) {
    return quoted;
  }

  const raw = normalizeText(text);
  const titleMatch =
    raw.match(/\b(?:knjigu|knjiga|naslov|udžbenik|udzbenik)\s+([A-ZČĆŽŠĐ0-9][^?.!,]{2,120})/u) ||
    raw.match(/\bimate li\s+([A-ZČĆŽŠĐ0-9][^?.!,]{2,120})/u);

  return normalizeText(titleMatch?.[1] || "").replace(/\s+(još|jos|na stanju|cijena)$/i, "");
}

function extractAuthor(text = "") {
  const raw = normalizeText(text);
  const match = raw.match(/\b(?:autor|od)\s+([A-ZČĆŽŠĐ][\p{L}.-]+(?:\s+[A-ZČĆŽŠĐ][\p{L}.-]+){0,2})/u);
  return normalizeText(match?.[1] || "");
}

function detectIssueType(text = "") {
  const normalized = normalizeComparableText(text);

  if (/(kriva knjiga|pogresna posiljka|pogresan naslov|ostecen|oštećen|poderan|fali)/.test(normalized)) {
    return "wrong_or_damaged_item";
  }

  if (/(kasni|nije stigl|gdje je|status)/.test(normalized)) {
    return "delivery_or_status";
  }

  if (/(povrat|refund|reklamacij)/.test(normalized)) {
    return "refund_or_claim";
  }

  if (/(placanj|plaćanj|kartic|racun|račun)/.test(normalized)) {
    return "payment";
  }

  return "";
}

function detectPolicyTopic(text = "") {
  const normalized = normalizeComparableText(text);

  if (/(dostav|isporuk|kurir|pošta|posta|rok)/.test(normalized)) {
    return "delivery";
  }

  if (/(otkup|procjen|procjenu|bonus|prodati knjig)/.test(normalized)) {
    return "buyback";
  }

  if (/(povrat|refund|reklamacij)/.test(normalized)) {
    return "refund";
  }

  return "";
}

function detectEmotionalTone(text = "") {
  const normalized = normalizeComparableText(text);

  if (/(ljut|uzas|užas|katastrof|sramota|nikad vise|nikad više|jako sam ljut|grozno)/.test(normalized)) {
    return "frustrated";
  }

  if (/(hvala|super|odlicno|odlično)/.test(normalized)) {
    return "positive";
  }

  if (/(molim|mozete li|možete li|zanima me|trebam)/.test(normalized)) {
    return "neutral";
  }

  return "neutral";
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

  return /^(a|a za|a sto|a što|i|i za|sto ako|što ako|koliko|ima li|jel|je li|moze li|može li|a cijena|a cijena\?)\b/.test(
    normalized
  );
}

function inferTopicAnchor(messages = [], session = {}) {
  const latestAssistant = getLatestAssistantMessage(messages);

  if (Array.isArray(latestAssistant?.products) && latestAssistant.products.length > 0) {
    return {
      type: "product",
      value: latestAssistant.products.map((product) => product.title).filter(Boolean).slice(0, 3)
    };
  }

  if (Array.isArray(session.lastProductTitles) && session.lastProductTitles.length > 0) {
    return {
      type: "product",
      value: session.lastProductTitles.slice(0, 3)
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

function buildIntentScores(text = "", contextText = "") {
  const normalized = normalizeComparableText(`${text} ${contextText}`);
  const scores = {
    dostava_info: 0,
    narudzba_status: 0,
    narudzba_problem: 0,
    reklamacija_povrat: 0,
    otkup_upit: 0,
    product_availability: 0,
    product_pricing: 0,
    general_support: 0,
    small_talk_or_closure: 0
  };

  if (!normalized) {
    scores.general_support = 1;
    return scores;
  }

  if (/(hvala|ok|riješeno|rijeseno|super|odlicno|odlično)/.test(normalized) && normalized.split(" ").length <= 4) {
    scores.small_talk_or_closure += 10;
  }

  if (/(dostav|isporuk|kurir|pošta|posta|rok dostave|cijena dostave|preuzimanj)/.test(normalized)) {
    scores.dostava_info += 8;
  }

  if (/(gdje mi je|status narudzbe|status narudžbe|kad ce stici|kad će stići)/.test(normalized)) {
    scores.narudzba_status += 9;
  }

  if (/(problem s narudzbom|problem s narudžbom|ne mogu promijeniti|krivo narucio|krivo naručio)/.test(normalized)) {
    scores.narudzba_problem += 9;
  }

  if (/(narudzb|narudžb)/.test(normalized)) {
    scores.narudzba_status += 3;
    scores.narudzba_problem += 3;
  }

  if (/(problem|gresk|grešk|ne radi|ne mogu|zapelo|krivo)/.test(normalized)) {
    scores.narudzba_problem += 4;
    scores.general_support += 2;
  }

  if (/(reklamacij|povrat|refund|kriva knjiga|ostecen|oštećen|zelim povrat|želim povrat)/.test(normalized)) {
    scores.reklamacija_povrat += 12;
  }

  if (/(otkup|prodati knjig|procjen|procjenu|vrednovanj|bonus 10)/.test(normalized)) {
    scores.otkup_upit += 10;
  }

  if (/(imate li|ima li|na stanju|dostupn|trazim|tražim|isbn|autor|naslov|rabljene?)/.test(normalized)) {
    scores.product_availability += 7;
  }

  if (/(cijena|koliko kosta|koliko košta|koliko je)/.test(normalized)) {
    scores.product_pricing += 6;
    scores.dostava_info += 3;
  }

  if (/(knjig|udžben|udzben|isbn|autor|naslov)/.test(normalized)) {
    scores.product_availability += 3;
  }

  if (Object.values(scores).every((value) => value === 0)) {
    scores.general_support = 2;
  } else {
    scores.general_support += 1;
  }

  return scores;
}

function rankIntents(scores = {}) {
  return Object.entries(scores)
    .sort((left, right) => right[1] - left[1])
    .map(([intent, score]) => ({ intent, score }));
}

function detectMixedIntentOrdering(message = "") {
  const raw = normalizeText(message);
  const parts = raw.split(/\s+i\s+/i).map((part) => normalizeText(part)).filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const rankedParts = parts
    .map((part) => rankIntents(buildIntentScores(part))[0])
    .filter(Boolean);

  if (rankedParts.length < 2) {
    return null;
  }

  const first = rankedParts[0];
  const second = rankedParts[1];

  if (!first?.intent || !second?.intent || first.intent === second.intent) {
    return null;
  }

  return {
    primaryIntent: first.intent,
    secondaryIntent: second.intent
  };
}

function deriveCustomerGoal(intent, entities = {}, message = "") {
  switch (intent) {
    case "dostava_info":
      return entities.city
        ? `Saznati uvjete dostave za ${entities.city}`
        : "Saznati uvjete dostave";
    case "narudzba_status":
      return entities.order_reference
        ? `Provjeriti status narudžbe ${entities.order_reference}`
        : "Provjeriti status narudžbe";
    case "narudzba_problem":
      return entities.order_reference
        ? `Riješiti problem s narudžbom ${entities.order_reference}`
        : "Riješiti problem s narudžbom";
    case "reklamacija_povrat":
      return "Pokrenuti reklamaciju ili povrat";
    case "otkup_upit":
      return "Saznati uvjete otkupa knjiga";
    case "product_availability":
      return entities.book_title
        ? `Provjeriti dostupnost naslova ${entities.book_title}`
        : "Provjeriti dostupnost knjige";
    case "product_pricing":
      return entities.book_title
        ? `Provjeriti cijenu za naslov ${entities.book_title}`
        : "Provjeriti cijenu knjige";
    case "small_talk_or_closure":
      return "Zatvoriti ili kratko zaključiti razgovor";
    default:
      return normalizeText(message) ? `Pomoći oko upita: ${normalizeText(message).slice(0, 100)}` : "Pomoći korisniku";
  }
}

function mapLegacyIntent(intent = "") {
  switch (intent) {
    case "dostava_info":
      return "dostava";
    case "narudzba_status":
    case "narudzba_problem":
      return "narudzba";
    case "reklamacija_povrat":
      return "reklamacija_problem";
    case "otkup_upit":
      return "otkup_knjiga";
    default:
      return "opci_upit";
  }
}

function mergeEntityValue(currentValue = "", fallbackValue = "") {
  return currentValue || fallbackValue || "";
}

function extractEntitiesFromText(text = "") {
  return {
    city: extractCity(text),
    order_reference: extractOrderReference(text),
    book_title: extractBookTitle(text),
    isbn: extractIsbn(text),
    author: extractAuthor(text),
    quantity: extractQuantity(text),
    issue_type: detectIssueType(text),
    policy_topic: detectPolicyTopic(text)
  };
}

function buildEntities(message = "", messages = [], options = {}) {
  const currentEntities = extractEntitiesFromText(message);
  const topicAnchor = options.topicAnchor || null;

  if (
    !currentEntities.book_title &&
    options.allowHistory &&
    topicAnchor?.type === "product" &&
    Array.isArray(topicAnchor.value) &&
    topicAnchor.value[0]
  ) {
    currentEntities.book_title = normalizeText(topicAnchor.value[0]);
  }

  if (!options.allowHistory) {
    return currentEntities;
  }

  const historyText = collectRecentUserMessages(messages, 4)
    .map((item) => item.content)
    .join(" ");
  const historyEntities = extractEntitiesFromText(historyText);

  return {
    city: mergeEntityValue(currentEntities.city, historyEntities.city),
    order_reference: mergeEntityValue(currentEntities.order_reference, historyEntities.order_reference),
    book_title: mergeEntityValue(currentEntities.book_title, historyEntities.book_title),
    isbn: mergeEntityValue(currentEntities.isbn, historyEntities.isbn),
    author: mergeEntityValue(currentEntities.author, historyEntities.author),
    quantity: mergeEntityValue(currentEntities.quantity, historyEntities.quantity),
    issue_type: mergeEntityValue(currentEntities.issue_type, historyEntities.issue_type),
    policy_topic: mergeEntityValue(currentEntities.policy_topic, historyEntities.policy_topic)
  };
}

function buildConversationFacts(reasoningResult = {}) {
  const facts = [];
  const entities = reasoningResult.entities || {};

  if (entities.city) {
    facts.push(`Grad: ${entities.city}`);
  }

  if (entities.order_reference) {
    facts.push(`Broj narudžbe: ${entities.order_reference}`);
  }

  if (entities.book_title) {
    facts.push(`Naslov: ${entities.book_title}`);
  }

  if (entities.quantity) {
    facts.push(`Količina: ${entities.quantity}`);
  }

  if (entities.issue_type) {
    facts.push(`Tip problema: ${entities.issue_type}`);
  }

  if (entities.policy_topic) {
    facts.push(`Tema pravila: ${entities.policy_topic}`);
  }

  return facts;
}

function buildMissingSlots(intent, entities = {}, message = "", pendingClarification = null) {
  const normalized = normalizeComparableText(message);
  const missingSlots = [];
  const hasSpecificQuestion = /\?/.test(message) || /(koliko|kada|rok|traj|cijena|moze li|može li|kako)/i.test(message);

  if (intent === "narudzba_status" && !entities.order_reference) {
    missingSlots.push("order_reference");
  }

  if (intent === "narudzba_problem") {
    if (!entities.order_reference) {
      missingSlots.push("order_reference");
    }

    if (!entities.issue_type && normalized.split(" ").length <= 4) {
      missingSlots.push("issue_description");
    }
  }

  if (intent === "dostava_info") {
    const hasSpecificQuestion = /\?/.test(message) || /(rok|cijena|koliko|kada|kurir|preuzimanje)/i.test(message);

    if (!entities.city && !hasSpecificQuestion) {
      missingSlots.push("delivery_scope");
    }
  }

  if (intent === "otkup_upit" && !entities.book_title && !entities.quantity && !hasSpecificQuestion) {
    missingSlots.push("book_details");
  }

  if (intent === "reklamacija_povrat" && !entities.issue_type && normalized.split(" ").length <= 5) {
    missingSlots.push("issue_description");
  }

  if (pendingClarification?.slotKey && missingSlots.includes(pendingClarification.slotKey)) {
    return {
      missingSlots,
      canAskAgain: Number(pendingClarification.attemptCount || 0) < 1
    };
  }

  return {
    missingSlots,
    canAskAgain: true
  };
}

function buildClarifyingQuestion(slotKey, reasoningResult = {}) {
  const firstName = reasoningResult.customerName || "";
  const prefix = reasoningResult.shouldUseCustomerName && firstName ? `${firstName}, ` : "";

  if (slotKey === "order_reference") {
    return `${prefix}možete li mi poslati broj narudžbe?`;
  }

  if (slotKey === "delivery_scope") {
    return `${prefix}što vas točno zanima oko dostave, primjerice rok, cijena ili mjesto isporuke?`;
  }

  if (slotKey === "book_details") {
    return `${prefix}možete li ukratko napisati koje knjige nudite za otkup ili barem koliko ih otprilike imate?`;
  }

  if (slotKey === "issue_description") {
    return `${prefix}možete li ukratko napisati što se točno dogodilo?`;
  }

  return `${prefix}možete li mi samo malo preciznije napisati što vam treba?`;
}

function buildStandaloneQuery({
  message,
  reasoningResult,
  topicAnchor,
  pendingClarification = null,
  session = {},
  isFollowUp = false
}) {
  const normalizedMessage = normalizeText(message);
  const facts = buildConversationFacts(reasoningResult);
  const parts = [];

  if (pendingClarification?.baseQuery) {
    parts.push(pendingClarification.baseQuery);
  } else if (isFollowUp && topicAnchor?.type === "product" && Array.isArray(topicAnchor.value)) {
    parts.push(`Proizvod: ${topicAnchor.value.join(", ")}`);
  } else if (isFollowUp && topicAnchor?.value) {
    parts.push(`Tema razgovora: ${topicAnchor.value}`);
  } else if (!isFollowUp && session.lastStandaloneQuery && normalizedMessage.length < 30) {
    parts.push(`Tema razgovora: ${session.lastStandaloneQuery}`);
  }

  if (reasoningResult.primaryIntent) {
    parts.push(`Namjera: ${reasoningResult.primaryIntent}`);
  }

  parts.push(normalizedMessage);

  if (facts.length > 0) {
    parts.push(`Poznate činjenice: ${facts.join(" | ")}`);
  }

  return parts.filter(Boolean).join("\n");
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
  const mixedIntentOrdering = detectMixedIntentOrdering(normalizedMessage);
  const isFollowUp = isFollowUpMessage(normalizedMessage);
  const allowHistory = Boolean(isFollowUp || pendingClarification?.slotKey);
  const topicAnchor = inferTopicAnchor(recentMessages, session);
  const entities = buildEntities(normalizedMessage, recentMessages, { allowHistory, topicAnchor });
  const primaryScores = buildIntentScores(normalizedMessage);
  const primaryRanked = rankIntents(primaryScores);
  const fallbackScores = allowHistory ? buildIntentScores(normalizedMessage, combinedText) : primaryScores;
  const ranked = allowHistory ? rankIntents(fallbackScores) : primaryRanked;
  const mappedEntryIntent = entryIntent ? mapLegacyIntent(entryIntent) : "";
  const clarificationIntent = normalizeText(pendingClarification?.intent || "");
  const previousIntent = normalizeText(session?.workingMemory?.activeIntent || "");
  const canReusePreviousIntent =
    isFollowUp &&
    previousIntent &&
    previousIntent !== "small_talk_or_closure" &&
    (primaryRanked[0]?.score || 0) < 6;
  const primaryIntent =
    ((clarificationIntent &&
      (entities[pendingClarification?.slotKey] ||
        (pendingClarification?.slotKey === "issue_description" && normalizedMessage.length > 8)))
      ? clarificationIntent
      : mixedIntentOrdering?.primaryIntent) ||
    (canReusePreviousIntent
      ? previousIntent
      : null) ||
    ((primaryRanked[0]?.score || 0) > 0
      ? primaryRanked[0].intent
      : (ranked[0]?.score || 0) > 0
        ? ranked[0].intent
      : mappedEntryIntent || previousIntent || "general_support");
  const secondaryIntent =
    mixedIntentOrdering?.secondaryIntent ||
    ((primaryRanked[1]?.score || 0) >= 6 && primaryRanked[1]?.intent !== primaryIntent
      ? primaryRanked[1].intent
      : null);
  const topicShiftDetected = Boolean(
    session?.workingMemory?.activeIntent &&
      primaryIntent &&
      session.workingMemory.activeIntent !== primaryIntent &&
      !isFollowUp
  );
  const riskFlags = detectRiskFlags(normalizedMessage);
  const emotionalTone = detectEmotionalTone(normalizedMessage);
  const intentConfidence = Math.min(
    0.98,
    Math.max(
      primaryIntent === "general_support" ? 0.42 : 0.55,
      (primaryRanked[0]?.score || ranked[0]?.score || 0) /
        Math.max(
          (primaryRanked[0]?.score || ranked[0]?.score || 0) +
            (primaryRanked[1]?.score || ranked[1]?.score || 0) +
            4,
          12
        )
    )
  );
  const { missingSlots, canAskAgain } = buildMissingSlots(
    primaryIntent,
    entities,
    normalizedMessage,
    pendingClarification
  );
  const customerGoal = deriveCustomerGoal(primaryIntent, entities, normalizedMessage);
  const riskLevel =
    riskFlags.includes("legal_or_abuse") ||
    riskFlags.includes("payment") ||
    riskFlags.includes("refund") ||
    primaryIntent === "reklamacija_povrat"
      ? "high"
      : riskFlags.includes("complaint") || emotionalTone === "frustrated"
        ? "medium"
        : "low";
  const reasoningResult = {
    primaryIntent,
    secondaryIntent,
    intentConfidence,
    entities,
    customerGoal,
    emotionalTone,
    riskLevel,
    missingSlots,
    topicShiftDetected
  };
  const standaloneQuery = buildStandaloneQuery({
    message: normalizedMessage,
    reasoningResult,
    topicAnchor,
    pendingClarification,
    session,
    isFollowUp
  });
  const conversationFacts = buildConversationFacts(reasoningResult);
  const clarifyingQuestion =
    missingSlots.length > 0 && canAskAgain
      ? buildClarifyingQuestion(missingSlots[0], {
          ...reasoningResult,
          customerName: session?.workingMemory?.customerProfile?.firstName || "",
          shouldUseCustomerName: emotionalTone === "frustrated"
        })
      : "";

  return {
    reasoningResult,
    originalMessage: normalizedMessage,
    resolvedUserIntent: mapLegacyIntent(primaryIntent),
    standaloneQuery,
    conversationFacts,
    missingSlots,
    clarifyingQuestion,
    riskFlags,
    isFollowUp,
    canAskClarifyingQuestion: Boolean(clarifyingQuestion),
    shouldPreferHuman: riskLevel === "high",
    topicAnchor,
    usedMemory: Boolean(isFollowUp && topicAnchor?.value),
    summary: [
      `Intent: ${primaryIntent}`,
      secondaryIntent ? `Secondary intent: ${secondaryIntent}` : "",
      conversationFacts.length > 0 ? `Facts: ${conversationFacts.join("; ")}` : "",
      topicShiftDetected ? "Detected topic shift." : "",
      riskFlags.length > 0 ? `Risk: ${riskFlags.join(", ")}` : "",
      `Tone: ${emotionalTone}`
    ]
      .filter(Boolean)
      .join(" ")
  };
}

module.exports = {
  analyzeConversation,
  buildClarifyingQuestion,
  buildConversationFacts,
  buildEntities,
  deriveCustomerGoal,
  mapLegacyIntent,
  normalizeComparableText,
  normalizeText
};
