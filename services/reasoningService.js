const { normalizeWhitespace, normalizeForComparison } = require("./textUtils");

function normalizeText(value = "") {
  return normalizeWhitespace(value);
}

function normalizeComparableText(value = "") {
  return normalizeForComparison(value);
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

  if (/(radno vrijeme|radno vrime|kad radite|radite li|adresa|gdje ste|gdje se nalazite|lokacija|kontakt|telefon|email|e-mail|mail|placanj|plaćanj|kartic|gotovin|osobno preuzimanje|preuzimanje u poslovnici)/.test(normalized)) {
    return "support_info";
  }

  if (/(loyalty|program vjernosti|program vjernost|vjernost|bonus program|bodov)/.test(normalized)) {
    return "support_info";
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

  // Fix #6: Strip leading acknowledgment prefixes before testing follow-up patterns.
  const stripped = normalized
    .replace(/^(ok|okej|oke|uredu|u redu|dobro|razumijem|shvacam|vazi|da|super|jasno|aha|moze|može)[,!.;:\s-]*/i, "")
    .trim();

  const testText = stripped || normalized;

  return /^(a|a za|a sto|a što|i|i za|sto ako|što ako|koliko|ima li|jel|je li|moze li|može li|a cijena|a cijena\?)\b/.test(
    testText
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

function inferJourneyStage({ normalizedMessage = "", isFollowUp = false, pendingClarification = null } = {}) {
  if (pendingClarification?.slotKey) {
    return "clarification_answer";
  }

  if (!normalizedMessage) {
    return "new_request";
  }

  if (/^(hvala|ok|riješeno|rijeseno|super|odlicno|odlično|lp|pozdrav)\b/i.test(normalizedMessage)) {
    return "closure";
  }

  return isFollowUp ? "follow_up" : "new_request";
}

function deriveTaskIntent(intent = "") {
  switch (intent) {
    case "otkup_upit":
      return "buyback";
    case "support_info":
      return "support_info";
    case "dostava_info":
      return "delivery";
    case "narudzba_status":
      return "order_status";
    case "narudzba_problem":
      return "order_issue";
    case "reklamacija_povrat":
      return "complaint";
    case "product_availability":
    case "product_pricing":
      return "product_lookup";
    case "small_talk_or_closure":
      return "closure";
    default:
      return "general_support";
  }
}

function deriveActiveDomain(taskIntent = "") {
  switch (taskIntent) {
    case "buyback":
    case "support_info":
    case "delivery":
    case "product_lookup":
    case "complaint":
    case "closure":
      return taskIntent;
    case "order_status":
    case "order_issue":
      return "order";
    default:
      return "general_support";
  }
}

function deriveSubjectType(intent = "", entities = {}, policyTopic = "") {
  if (intent === "support_info" || policyTopic === "support_info") {
    return "support_info";
  }

  if (intent === "otkup_upit") {
    return entities.book_title || entities.quantity ? "book" : "buyback_process";
  }

  if (intent === "dostava_info") {
    return "shipment";
  }

  if (intent === "narudzba_status" || intent === "narudzba_problem") {
    return "order";
  }

  if (intent === "reklamacija_povrat") {
    return "policy";
  }

  if (intent === "product_availability" || intent === "product_pricing") {
    return "book";
  }

  if (policyTopic === "buyback") {
    return "buyback_process";
  }

  return "policy";
}

function deriveActionIntent(intent = "", message = "", entities = {}) {
  const normalized = normalizeComparableText(message);

  if (intent === "small_talk_or_closure") {
    return "close";
  }

  if (intent === "narudzba_status") {
    return "check_status";
  }

  if (intent === "product_availability") {
    return "check_availability";
  }

  if (intent === "product_pricing") {
    return "check_price";
  }

  if (intent === "support_info") {
    return "ask_general_info";
  }

  if (/(kako|na koji nacin|na koji način|što trebam|sto trebam|kako ide|kako funkcionira)/.test(normalized)) {
    return "ask_how_to";
  }

  if (/(uvjeti|pravila|postupak|procedura|proces)/.test(normalized)) {
    return "ask_policy";
  }

  if (/(koliko vrijedi|koliko vrijede|procjen|vrednovanj|ponud[au]|otkupit[e]?)/.test(normalized)) {
    return "request_estimate";
  }

  if (/(koliko traje|rok|kada|kad)/.test(normalized)) {
    return "ask_timeline";
  }

  if (intent === "otkup_upit" && (entities.book_title || entities.quantity)) {
    return "start_process";
  }

  return "ask_info";
}

function classifyQuestionType(actionIntent = "", message = "") {
  if (actionIntent === "ask_general_info") {
    return "info";
  }

  if (actionIntent === "ask_how_to") {
    return "procedural";
  }

  if (actionIntent === "ask_policy") {
    return "policy";
  }

  if (actionIntent === "check_status") {
    return "status";
  }

  if (actionIntent === "check_availability" || actionIntent === "check_price") {
    return "lookup";
  }

  if (actionIntent === "request_estimate") {
    return "estimate";
  }

  if (/\?/.test(message)) {
    return "info";
  }

  return "info";
}

function buildIntentScores(text = "", contextText = "") {
  const normalized = normalizeComparableText(`${text} ${contextText}`);
  const scores = {
    support_info: 0,
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

  if (/(radno vrijeme|radno vrime|kad radite|radite li|otvoreni|subotom|nedjeljom|blagdani)/.test(normalized)) {
    scores.support_info += 12;
    scores.otkup_upit -= 4;
    scores.product_availability -= 6;
    scores.product_pricing -= 4;
  }

  if (/(adresa|gdje ste|gdje se nalazite|lokacija|kontakt|telefon|email|e-mail|mail)/.test(normalized)) {
    scores.support_info += 11;
    scores.product_availability -= 5;
  }

  if (/(loyalty|program vjernosti|program vjernost|vjernost|bonus program|bodov)/.test(normalized)) {
    scores.support_info += 14;
    scores.reklamacija_povrat -= 6;
    scores.narudzba_problem -= 4;
    scores.otkup_upit += 2;
  }

  if (/(placanj|plaćanj|kartic|gotovin|pouzece|pouzeće|osobno preuzimanje|preuzimanje u poslovnici)/.test(normalized)) {
    scores.support_info += 9;
    scores.product_pricing -= 2;
  }

  if (/(dostav|isporuk|kurir|pošta|posta|rok dostav|cijena dostav|preuzim|slanj|posiljk|pošiljk)/.test(normalized)) {
    scores.dostava_info += 8;
  }

  if (/(gdje mi je|status narudzbe|status narudžbe|kad ce stici|kad će stići|kad stize|kad stiže|koliko jos|koliko još)/.test(normalized)) {
    scores.narudzba_status += 9;
  }

  if (/(problem s narudzbom|problem s narudžbom|ne mogu promijeniti|krivo narucio|krivo naručio|krivo poslan|pogresn|pogrešn)/.test(normalized)) {
    scores.narudzba_problem += 9;
  }

  if (/(narudzb|narudžb|narucio|naručio|narucen|naručen)/.test(normalized)) {
    scores.narudzba_status += 3;
    scores.narudzba_problem += 3;
  }

  if (/(problem|gresk|grešk|ne radi|ne mogu|zapelo|krivo)/.test(normalized)) {
    scores.narudzba_problem += 4;
    scores.general_support += 2;
  }

  if (/(reklamacij|povrat|refund|kriva knjiga|ostecen|oštećen|zelim povrat|želim povrat|vracanj|vraćanj)/.test(normalized)) {
    scores.reklamacija_povrat += 12;
  }

  if (/(otkup|prodati knjig|prodajem|procjen|procjenu|vrednovanj|bonus 10)/.test(normalized)) {
    scores.otkup_upit += 10;
  }

  if (/(želim prodati|zelim prodati|kako da prodam|kako da ih prodam|imam \d+\s+knjig|koliko traje otkup|koliko traje procjen|koliko traje procjena)/.test(normalized)) {
    scores.otkup_upit += 10;
  }

  if (/(koliko vrijedi|koliko vrijede|vrijedi li|vrijede li)/.test(normalized)) {
    scores.otkup_upit += 9;
    scores.product_pricing -= 2;
  }

  if (/(imate li|ima li|na stanju|dostupn|trazim|tražim|isbn|autor|naslov|rabljene?)/.test(normalized)) {
    scores.product_availability += 7;
  }

  if (/(cijena|koliko kosta|koliko košta|koliko kostaju|koliko koštaju|koliko je)/.test(normalized)) {
    scores.product_pricing += 6;
    scores.dostava_info += 3;
  }

  if (/(knjig|udžben|udzben|isbn|autor|naslov)/.test(normalized)) {
    scores.product_availability += 3;
  }

  if (/(otkup|prodati|prodajem|procjen|procjenu|vrednovanj|nudim knjig|želim prodati|zelim prodati)/.test(normalized)) {
    scores.product_availability -= 8;
    scores.product_pricing -= 6;
  }

  if (/(imam \d+\s+knjig|kako da prodam|kako da ih prodam|koliko traje otkup|koliko traje procjen|koliko traje procjena)/.test(normalized)) {
    scores.product_availability -= 8;
    scores.product_pricing -= 5;
  }

  if (/(imate li|ima li|na stanju|isbn|autor|cijena knjige|cijena udzbenika|cijena udžbenika)/.test(normalized)) {
    scores.otkup_upit -= 6;
  }

  if (/(status|gdje je|broj narudzbe|broj narudžbe|narudzba #|narudžba #)/.test(normalized)) {
    scores.general_support -= 3;
    scores.product_availability -= 4;
    scores.product_pricing -= 3;
    scores.narudzba_status += 5;
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
    case "support_info":
      return "Dobiti opću informaciju o poslovnici ili uvjetima";
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
    case "support_info":
      return "opci_upit";
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

function mapEntryFlowIntentToPrimaryIntent(intent = "") {
  switch (intent) {
    case "kupnja_knjiga":
      return "product_availability";
    case "dostava":
      return "dostava_info";
    case "narudzba":
      return "narudzba_status";
    case "reklamacija_problem":
      return "reklamacija_povrat";
    case "otkup_knjiga":
      return "otkup_upit";
    default:
      return "general_support";
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

  if (reasoningResult.subjectType === "support_info") {
    facts.push("Tema: opće informacije");
  }

  return facts;
}

function buildMissingSlots(
  intent,
  entities = {},
  message = "",
  pendingClarification = null,
  options = {}
) {
  const normalized = normalizeComparableText(message);
  const missingSlots = [];
  const hasSpecificQuestion = /\?/.test(message) || /(koliko|kada|rok|traj|cijena|moze li|može li|kako)/i.test(message);
  const actionIntent = String(options.actionIntent || "").trim();
  const isTopicLockedToBuyback = options.entryTopicLock === "buyback";
  const isPolicyLikeQuestion = ["ask_how_to", "ask_policy", "ask_timeline"].includes(actionIntent);

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

  // Fix #18: Rename inner variable to avoid shadowing outer hasSpecificQuestion.
  if (intent === "dostava_info") {
    const hasDeliverySpecificQuestion = /\?/.test(message) || /(rok|cijena|koliko|kada|kurir|preuzimanje)/i.test(message);

    if (!entities.city && !hasDeliverySpecificQuestion) {
      missingSlots.push("delivery_scope");
    }
  }

  if (
    intent === "otkup_upit" &&
    !hasSpecificQuestion &&
    !["ask_how_to", "ask_policy", "ask_timeline", "request_estimate", "ask_info", "start_process"].includes(actionIntent) &&
    !isTopicLockedToBuyback
  ) {
    // Buyback should default to a procedural answer when knowledge supports it.
  }

  if (intent === "reklamacija_povrat") {
    if (!isPolicyLikeQuestion && !entities.order_reference) {
      missingSlots.push("order_reference");
    }

    if (!entities.issue_type && normalized.split(" ").length <= 5) {
      missingSlots.push("issue_description");
    }
  }

  // Fix #7: Detect topic shift — if the intent changed, reset canAskAgain regardless of slot match.
  if (pendingClarification?.slotKey && missingSlots.includes(pendingClarification.slotKey)) {
    const intentChanged = pendingClarification.intent && pendingClarification.intent !== intent;

    return {
      missingSlots,
      canAskAgain: intentChanged || Number(pendingClarification.attemptCount || 0) < 1
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

function isExplicitProductLookupMessage(text = "", entities = {}) {
  const normalized = normalizeComparableText(text);

  if (entities.book_title || entities.isbn || entities.author) {
    return true;
  }

  return /(imate li|ima li|na stanju|isbn|autor|tražim|trazim|kupiti|kupnja|kupio|kupnja knjiga)/.test(
    normalized
  );
}

function buildStandaloneQuery({
  message,
  reasoningResult,
  topicAnchor,
  pendingClarification = null,
  session = {},
  isFollowUp = false,
  topicShiftType = ""
}) {
  const normalizedMessage = normalizeText(message);
  const facts = buildConversationFacts(reasoningResult);
  const parts = [];

  if (pendingClarification?.baseQuery) {
    parts.push(pendingClarification.baseQuery);
  } else if (isFollowUp && topicAnchor?.type === "product" && Array.isArray(topicAnchor.value)) {
    parts.push(`Proizvod: ${topicAnchor.value.join(", ")}`);
  } else if (isFollowUp && topicShiftType !== "support_to_support_shift" && topicAnchor?.value) {
    parts.push(`Tema razgovora: ${topicAnchor.value}`);
  } else if (
    !isFollowUp &&
    topicShiftType !== "support_to_support_shift" &&
    session.lastStandaloneQuery &&
    normalizedMessage.length < 30
  ) {
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

function buildIntentEvidence(message = "", reasoningResult = {}) {
  const normalized = normalizeComparableText(message);
  const evidence = [];

  if (/(otkup|prodati|prodajem|procjen|vrednovanj|nudim knjig)/.test(normalized)) {
    evidence.push("buyback_keywords");
  }

  if (/(imate li|na stanju|isbn|autor|naslov)/.test(normalized)) {
    evidence.push("product_lookup_keywords");
  }

  if (/(kako|uvjeti|postupak|procedura|što trebam|sto trebam)/.test(normalized)) {
    evidence.push("procedural_or_policy_question");
  }

  if (/(koliko traje|rok|kada|kad)/.test(normalized)) {
    evidence.push("timeline_question");
  }

  if (/(status|gdje je|broj narudzbe|broj narudžbe)/.test(normalized)) {
    evidence.push("order_status_keywords");
  }

  if (/(radno vrijeme|kad radite|adresa|gdje ste|kontakt|telefon|email|plaćanj|plaćanje|kartic|gotovin)/.test(normalized)) {
    evidence.push("support_info_keywords");
  }

  if (reasoningResult.topicShiftDetected) {
    evidence.push("topic_shift_detected");
  }

  if (reasoningResult.secondaryIntent) {
    evidence.push("mixed_intent_detected");
  }

  if (reasoningResult.answerabilityClass) {
    evidence.push(`answerability_${reasoningResult.answerabilityClass}`);
  }

  return evidence;
}

function buildSourceContract(taskIntent = "", primaryIntent = "") {
  if (taskIntent === "product_lookup" || primaryIntent === "product_availability" || primaryIntent === "product_pricing") {
    return "product_allowed";
  }

  if (["buyback", "delivery", "order_status", "order_issue", "complaint", "support_info"].includes(taskIntent)) {
    return "support_only";
  }

  return "knowledge_first";
}

function deriveTopicShiftType({
  previousDomain = "",
  nextDomain = "",
  isExplicitProductLookup = false,
  pendingClarification = null
} = {}) {
  if (pendingClarification?.slotKey) {
    return "clarification_answer";
  }

  if (!previousDomain || !nextDomain || previousDomain === nextDomain) {
    return "same_domain_continuation";
  }

  if (previousDomain === "product_lookup" && nextDomain !== "product_lookup") {
    return "product_to_support_shift";
  }

  if (previousDomain !== "product_lookup" && nextDomain === "product_lookup" && isExplicitProductLookup) {
    return "support_to_product_shift";
  }

  return "support_to_support_shift";
}

function buildTopicShiftConfidence({
  previousIntent = "",
  primaryIntent = "",
  canReusePreviousIntent = false,
  isExplicitProductLookup = false,
  isFollowUp = false
} = {}) {
  if (!previousIntent || previousIntent === primaryIntent) {
    return isFollowUp ? 0.18 : 0;
  }

  if (isExplicitProductLookup && primaryIntent === "product_availability") {
    return 0.92;
  }

  if (canReusePreviousIntent) {
    return 0.22;
  }

  return isFollowUp ? 0.58 : 0.74;
}

function deriveAnswerabilityClass({
  taskIntent = "",
  actionIntent = "",
  riskLevel = "low",
  missingSlots = [],
  supportPlanRoute = "",
  questionType = ""
} = {}) {
  if (riskLevel === "high") {
    return "handoff";
  }

  if (supportPlanRoute === "clarify" || missingSlots.length > 0) {
    return "ask_one_question";
  }

  if (
    taskIntent === "buyback" &&
    ["ask_how_to", "ask_policy", "ask_timeline", "request_estimate", "ask_info", "start_process"].includes(actionIntent)
  ) {
    return "answer_now";
  }

  if (
    ["delivery", "order_status"].includes(taskIntent) &&
    ["procedural", "status", "info"].includes(questionType)
  ) {
    return "answer_now";
  }

  return "answer_now";
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
  const mappedEntryIntent = entryIntent ? mapEntryFlowIntentToPrimaryIntent(entryIntent) : "";
  const clarificationIntent = normalizeText(pendingClarification?.intent || "");
  const clarificationTaskIntent = normalizeText(pendingClarification?.activeTaskIntent || "");
  const previousIntent = normalizeText(session?.workingMemory?.activeIntent || "");
  const previousTaskIntent = normalizeText(session?.workingMemory?.activeTaskIntent || "");
  const activeDomainMemory = normalizeText(session?.workingMemory?.activeDomain || "");
  const canReusePreviousIntent =
    isFollowUp &&
    previousIntent &&
    previousIntent !== "small_talk_or_closure" &&
    (primaryRanked[0]?.score || 0) < 6;
  const explicitProductLookup = isExplicitProductLookupMessage(normalizedMessage, entities);
  const strongNewIntent =
    Boolean(primaryRanked[0]?.intent) &&
    primaryRanked[0].intent !== clarificationIntent &&
    Number(primaryRanked[0]?.score || 0) >= 6;
  const clarificationLooksAnswered =
    Boolean(pendingClarification?.slotKey) &&
    normalizedMessage.length > 1 &&
    !strongNewIntent &&
    (!explicitProductLookup ||
      (clarificationTaskIntent && clarificationTaskIntent === "product_lookup"));
  const primaryIntent =
    ((clarificationIntent &&
      ((entities[pendingClarification?.slotKey] ||
        (pendingClarification?.slotKey === "issue_description" && normalizedMessage.length > 8)) ||
        clarificationLooksAnswered))
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
      session.workingMemory.activeIntent !== primaryIntent
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
  const taskIntent = deriveTaskIntent(primaryIntent);
  const activeDomain = deriveActiveDomain(taskIntent);
  const subjectType = deriveSubjectType(primaryIntent, entities, entities.policy_topic);
  const actionIntent = deriveActionIntent(primaryIntent, normalizedMessage, entities);
  const questionType = classifyQuestionType(actionIntent, normalizedMessage);
  const journeyStage = inferJourneyStage({
    normalizedMessage,
    isFollowUp,
    pendingClarification
  });
  const { missingSlots, canAskAgain } = buildMissingSlots(
    primaryIntent,
    entities,
    normalizedMessage,
    pendingClarification,
    {
      actionIntent,
      entryTopicLock: session?.entryTopicLock || session?.workingMemory?.entryTopicLock || ""
    }
  );
  const sourceContract = buildSourceContract(taskIntent, primaryIntent);
  const topicShiftType = deriveTopicShiftType({
    previousDomain: activeDomainMemory || (previousTaskIntent ? deriveActiveDomain(previousTaskIntent) : ""),
    nextDomain: activeDomain,
    isExplicitProductLookup: explicitProductLookup,
    pendingClarification
  });
  const topicShiftConfidence = buildTopicShiftConfidence({
    previousIntent,
    primaryIntent,
    canReusePreviousIntent,
    isExplicitProductLookup: explicitProductLookup,
    isFollowUp
  });
  const isPolicyLikeRefundQuestion =
    primaryIntent === "reklamacija_povrat" &&
    ["ask_policy", "ask_timeline", "ask_general_info"].includes(actionIntent);
  const riskLevel =
    riskFlags.includes("legal_or_abuse") ||
    riskFlags.includes("payment") ||
    (riskFlags.includes("refund") && !isPolicyLikeRefundQuestion)
      ? "high"
      : riskFlags.includes("complaint") ||
          primaryIntent === "reklamacija_povrat" ||
          emotionalTone === "frustrated"
        ? "medium"
        : "low";
  const answerabilityClass = deriveAnswerabilityClass({
    taskIntent,
    actionIntent,
    riskLevel,
    missingSlots,
    supportPlanRoute: secondaryIntent ? "clarify" : "",
    questionType
  });
  const customerGoal = deriveCustomerGoal(primaryIntent, entities, normalizedMessage);
  const reasoningResult = {
    primaryIntent,
    secondaryIntent,
    intentConfidence,
    taskIntent,
    activeDomain:
      activeDomain ||
      activeDomainMemory ||
      (previousTaskIntent ? deriveActiveDomain(previousTaskIntent) : ""),
    actionIntent,
    subjectType,
    journeyStage,
    questionType,
    entities,
    customerGoal,
    emotionalTone,
    riskLevel,
    missingSlots,
    topicShiftDetected,
    topicShiftType,
    sourceContract,
    topicShiftConfidence,
    answerabilityClass,
    intentFrame: {
      activeDomain:
        activeDomain ||
        activeDomainMemory ||
        (previousTaskIntent ? deriveActiveDomain(previousTaskIntent) : ""),
      userJob: actionIntent,
      questionType,
      topicShiftType,
      topicShiftConfidence,
      answerabilityClass,
      sourceContract
    }
  };
  const intentEvidence = buildIntentEvidence(normalizedMessage, reasoningResult);
  const standaloneQuery = buildStandaloneQuery({
    message: normalizedMessage,
    reasoningResult,
    topicAnchor,
    pendingClarification,
    session,
    isFollowUp,
    topicShiftType
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
    intentEvidence,
    isExplicitProductLookup: isExplicitProductLookupMessage(normalizedMessage, entities),
    summary: [
      `Intent: ${primaryIntent}`,
      secondaryIntent ? `Secondary intent: ${secondaryIntent}` : "",
      taskIntent ? `Task intent: ${taskIntent}` : "",
      reasoningResult.activeDomain ? `Active domain: ${reasoningResult.activeDomain}` : "",
      actionIntent ? `Action intent: ${actionIntent}` : "",
      subjectType ? `Subject type: ${subjectType}` : "",
      questionType ? `Question type: ${questionType}` : "",
      answerabilityClass ? `Answerability: ${answerabilityClass}` : "",
      topicShiftType ? `Topic shift: ${topicShiftType}` : "",
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
  mapEntryFlowIntentToPrimaryIntent,
  mapLegacyIntent,
  normalizeComparableText,
  normalizeText
};
