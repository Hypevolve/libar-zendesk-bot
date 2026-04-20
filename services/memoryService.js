const zlib = require("node:zlib");

const { normalizeWhitespace } = require("./textUtils");

const MEMORY_START = "[LIBAR_MEMORY_V1]";
const MEMORY_END = "[/LIBAR_MEMORY_V1]";

function normalizeText(value = "") {
  return normalizeWhitespace(value);
}

function getFirstName(name = "") {
  const normalized = normalizeText(name);

  if (!normalized) {
    return "";
  }

  return normalized.split(" ")[0] || "";
}

function deriveActiveDomain(taskIntent = "") {
  switch (String(taskIntent || "").trim()) {
    case "buyback":
    case "support_info":
    case "delivery":
    case "product_lookup":
    case "complaint":
    case "closure":
      return String(taskIntent || "").trim();
    case "order_status":
    case "order_issue":
      return "order";
    default:
      return "";
  }
}

function deriveQuestionType(actionIntent = "") {
  switch (String(actionIntent || "").trim()) {
    case "ask_how_to":
      return "procedural";
    case "ask_policy":
      return "policy";
    case "check_status":
      return "status";
    case "check_availability":
    case "check_price":
      return "lookup";
    case "request_estimate":
      return "estimate";
    default:
      return "";
  }
}

function buildCustomerProfile({ session = null, ticketSummary = null, previousMemory = null } = {}) {
  const previousProfile = previousMemory?.customerProfile || {};
  const name =
    normalizeText(ticketSummary?.requesterName) ||
    normalizeText(session?.requesterName) ||
    normalizeText(previousProfile.name);
  const email =
    normalizeText(ticketSummary?.requesterEmail) ||
    normalizeText(session?.requesterEmail) ||
    normalizeText(previousProfile.email);

  return {
    name,
    firstName: getFirstName(name) || normalizeText(previousProfile.firstName),
    email,
    source:
      ticketSummary?.requesterName || ticketSummary?.requesterEmail
        ? "zendesk_requester"
        : previousProfile.source || "unknown"
  };
}

function buildWorkingMemory({
  session = null,
  conversation = null,
  outcome = null,
  knowledge = null,
  ticketSummary = null,
  previousMemory = null
} = {}) {
  const customerProfile = buildCustomerProfile({
    session,
    ticketSummary,
    previousMemory
  });

  return {
    activeIntent:
      conversation?.reasoningResult?.primaryIntent ||
      conversation?.resolvedUserIntent ||
      session?.lastResolvedIntent ||
      previousMemory?.activeIntent ||
      "opci_upit",
    secondaryIntent:
      conversation?.reasoningResult?.secondaryIntent ||
      previousMemory?.secondaryIntent ||
      "",
    activeDomain:
      conversation?.reasoningResult?.activeDomain ||
      deriveActiveDomain(conversation?.reasoningResult?.taskIntent) ||
      previousMemory?.activeDomain ||
      "",
    activeTaskIntent:
      conversation?.reasoningResult?.taskIntent ||
      previousMemory?.activeTaskIntent ||
      "",
    activeUserJob:
      conversation?.reasoningResult?.actionIntent ||
      previousMemory?.activeUserJob ||
      "",
    activeSubjectType:
      conversation?.reasoningResult?.subjectType ||
      previousMemory?.activeSubjectType ||
      "",
    activeReferenceType:
      conversation?.reasoningResult?.entities?.order_reference
        ? "order"
        : conversation?.reasoningResult?.entities?.city
          ? "city"
          : conversation?.reasoningResult?.entities?.book_title
            ? "book"
            : previousMemory?.activeReferenceType || "",
    activeReferenceValue:
      conversation?.reasoningResult?.entities?.order_reference ||
      conversation?.reasoningResult?.entities?.city ||
      conversation?.reasoningResult?.entities?.book_title ||
      previousMemory?.activeReferenceValue ||
      "",
    entryTopicLock:
      session?.entryTopicLock ||
      previousMemory?.entryTopicLock ||
      "",
    entryTopicSourcePolicy:
      session?.entryTopicSourcePolicy ||
      previousMemory?.entryTopicSourcePolicy ||
      null,
    openSlots:
      outcome?.type === "ask_clarifying_question"
        ? conversation?.missingSlots || []
        : Array.isArray(previousMemory?.openSlots) && outcome?.type === "human_reply"
          ? previousMemory.openSlots
          : [],
    resolvedSlots:
      Array.isArray(conversation?.resolvedSlots) && conversation.resolvedSlots.length > 0
        ? conversation.resolvedSlots
        : Array.isArray(previousMemory?.resolvedSlots)
          ? previousMemory.resolvedSlots
          : [],
    lastStandaloneQuery:
      conversation?.standaloneQuery ||
      session?.lastStandaloneQuery ||
      previousMemory?.lastStandaloneQuery ||
      "",
    lastRoute:
      conversation?.supportPlan?.route ||
      outcome?.route ||
      previousMemory?.lastRoute ||
      "",
    lastAnswerType: outcome?.type || previousMemory?.lastAnswerType || "unknown",
    lastKnowledgeSource:
      outcome?.source ||
      knowledge?.primarySource ||
      session?.lastKnowledgeSource ||
      previousMemory?.lastKnowledgeSource ||
      "none",
    lastProductContext:
      Array.isArray(outcome?.products) && outcome.products.length > 0
        ? outcome.products.map((product) => product.title).filter(Boolean).slice(0, 3)
        : Array.isArray(session?.lastProductTitles) && session.lastProductTitles.length > 0
          ? session.lastProductTitles.slice(0, 3)
          : Array.isArray(previousMemory?.lastProductContext)
            ? previousMemory.lastProductContext.slice(0, 3)
            : [],
    clarificationTurnCount:
      outcome?.type === "ask_clarifying_question"
        ? Number(session?.pendingClarification?.attemptCount || 0) + 1
        : 0,
    lastResolvedEntity:
      conversation?.reasoningResult?.entities?.book_title ||
      conversation?.reasoningResult?.entities?.order_reference ||
      conversation?.reasoningResult?.entities?.city ||
      previousMemory?.lastResolvedEntity ||
      "",
    lastIntentEvidence:
      Array.isArray(conversation?.intentEvidence) && conversation.intentEvidence.length > 0
        ? conversation.intentEvidence.slice(0, 6)
        : Array.isArray(previousMemory?.lastIntentEvidence)
          ? previousMemory.lastIntentEvidence.slice(0, 6)
          : [],
    lastAnsweredQuestionType:
      conversation?.reasoningResult?.questionType ||
      deriveQuestionType(conversation?.reasoningResult?.actionIntent) ||
      previousMemory?.lastAnsweredQuestionType ||
      "",
    lastAnswerabilityClass:
      conversation?.reasoningResult?.answerabilityClass ||
      (conversation?.reasoningResult?.riskLevel === "high"
        ? "handoff"
        : Array.isArray(conversation?.missingSlots) && conversation.missingSlots.length > 0
          ? "ask_one_question"
          : conversation?.reasoningResult?.taskIntent
            ? "answer_now"
            : "") ||
      previousMemory?.lastAnswerabilityClass ||
      "",
    lastSupportInfoIntent:
      conversation?.reasoningResult?.activeDomain === "support_info"
        ? conversation?.reasoningResult?.primaryIntent || "support_info"
        : previousMemory?.lastSupportInfoIntent || "",
    topicShiftHistory:
      conversation?.reasoningResult?.topicShiftDetected
        ? [
            ...(Array.isArray(previousMemory?.topicShiftHistory) ? previousMemory.topicShiftHistory.slice(-4) : []),
            {
              from: previousMemory?.activeDomain || previousMemory?.activeIntent || "",
              to: conversation?.reasoningResult?.activeDomain || conversation?.reasoningResult?.primaryIntent || "",
              type: conversation?.reasoningResult?.topicShiftType || "",
              at: new Date().toISOString()
            }
          ]
        : Array.isArray(previousMemory?.topicShiftHistory)
          ? previousMemory.topicShiftHistory.slice(-5)
          : [],
    customerProfile,
    supportHistory: {
      lastIssueCategory:
        conversation?.reasoningResult?.primaryIntent ||
        previousMemory?.supportHistory?.lastIssueCategory ||
        "",
      lastEmotionalTone:
        conversation?.reasoningResult?.emotionalTone ||
        previousMemory?.supportHistory?.lastEmotionalTone ||
        "neutral",
      lastHandoffReason:
        outcome?.type === "soft_handoff" || outcome?.type === "hard_handoff"
          ? outcome.reason || ""
          : previousMemory?.supportHistory?.lastHandoffReason || "",
      lastSuccessfulSource:
        outcome?.type === "safe_answer"
          ? outcome?.source || knowledge?.primarySource || previousMemory?.supportHistory?.lastSuccessfulSource || ""
          : previousMemory?.supportHistory?.lastSuccessfulSource || "",
      lastBlockedSource:
        Array.isArray(conversation?.supportPlan?.mustNotUseSources) &&
        conversation.supportPlan.mustNotUseSources.length > 0
          ? conversation.supportPlan.mustNotUseSources[0]
          : previousMemory?.supportHistory?.lastBlockedSource || ""
    },
    updatedAt: new Date().toISOString()
  };
}

function serializeWorkingMemory(memory = {}) {
  const serializedJson = JSON.stringify(memory);
  const compressedPayload = zlib
    .deflateRawSync(Buffer.from(serializedJson, "utf8"))
    .toString("base64url");

  return [
    "AI memory snapshot",
    `Intent: ${memory.activeIntent || "unknown"}`,
    memory.activeDomain ? `Domena: ${memory.activeDomain}` : null,
    memory.lastRoute ? `Ruta: ${memory.lastRoute}` : null,
    memory.lastKnowledgeSource ? `Izvor: ${memory.lastKnowledgeSource}` : null,
    Array.isArray(memory.openSlots) && memory.openSlots.length > 0
      ? `Otvoreni slotovi: ${memory.openSlots.join(", ")}`
      : null,
    MEMORY_START,
    `deflate64:${compressedPayload}`,
    MEMORY_END
  ]
    .filter(Boolean)
    .join("\n");
}

function parseWorkingMemoryNote(noteText = "") {
  const raw = String(noteText || "");
  const start = raw.indexOf(MEMORY_START);
  const end = raw.indexOf(MEMORY_END);

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const payload = raw.slice(start + MEMORY_START.length, end).trim();

  if (!payload) {
    return null;
  }

  try {
    if (payload.startsWith("deflate64:")) {
      const encoded = payload.slice("deflate64:".length).trim();

      if (!encoded) {
        return null;
      }

      const inflated = zlib.inflateRawSync(Buffer.from(encoded, "base64url")).toString("utf8");
      return JSON.parse(inflated);
    }

    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
}

function getAuditCommentBodies(audit = {}) {
  const commentEvents = Array.isArray(audit.events)
    ? audit.events.filter((event) => event?.type === "Comment")
    : [];

  return commentEvents
    .map((event) => [event.body, event.plain_body, event.html_body].filter(Boolean))
    .flat();
}

function extractLatestWorkingMemory(audits = []) {
  for (const audit of [...audits].reverse()) {
    const bodies = getAuditCommentBodies(audit);

    for (const body of bodies) {
      const parsed = parseWorkingMemoryNote(body);

      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function applyWorkingMemoryToSession(session, memory = null) {
  if (!session || !memory) {
    return session;
  }

  session.lastResolvedIntent = memory.activeIntent || session.lastResolvedIntent || "";
  session.lastStandaloneQuery = memory.lastStandaloneQuery || session.lastStandaloneQuery || "";
  session.lastKnowledgeSource = memory.lastKnowledgeSource || session.lastKnowledgeSource || "";
  session.lastProductTitles = Array.isArray(memory.lastProductContext)
    ? memory.lastProductContext.slice(0, 3)
    : session.lastProductTitles || [];
  session.lastResolvedEntity = memory.lastResolvedEntity || session.lastResolvedEntity || "";
  session.entryTopicLock = memory.entryTopicLock || session.entryTopicLock || "";
  session.entryTopicSourcePolicy = memory.entryTopicSourcePolicy || session.entryTopicSourcePolicy || null;
  session.requesterName =
    normalizeText(memory.customerProfile?.name) || session.requesterName || "";
  session.requesterEmail =
    normalizeText(memory.customerProfile?.email) || session.requesterEmail || "";

  if (Array.isArray(memory.openSlots) && memory.openSlots.length > 0) {
    session.pendingClarification = {
      slotKey: memory.openSlots[0],
      intent: memory.activeIntent || "",
      activeDomain: memory.activeDomain || "",
      activeTaskIntent: memory.activeTaskIntent || "",
      userJob: memory.activeUserJob || "",
      expectedAnswerType: memory.lastAnsweredQuestionType || "",
      sourceContract:
        memory.activeDomain && memory.activeDomain !== "product_lookup"
          ? "support_only"
          : memory.activeTaskIntent === "product_lookup"
            ? "product_allowed"
            : "knowledge_first",
      baseQuery: memory.lastStandaloneQuery || "",
      attemptCount: Number(memory.clarificationTurnCount || 0),
      askedAt: memory.updatedAt || null
    };
  } else {
    session.pendingClarification = null;
  }

  session.workingMemory = memory;
  return session;
}

function normalizeComparableMemory(memory = {}) {
  return {
    activeIntent: memory.activeIntent || "",
    secondaryIntent: memory.secondaryIntent || "",
    activeDomain: memory.activeDomain || "",
    openSlots: Array.isArray(memory.openSlots) ? memory.openSlots : [],
    resolvedSlots: Array.isArray(memory.resolvedSlots) ? memory.resolvedSlots : [],
    lastStandaloneQuery: memory.lastStandaloneQuery || "",
    lastRoute: memory.lastRoute || "",
    lastAnswerType: memory.lastAnswerType || "",
    lastKnowledgeSource: memory.lastKnowledgeSource || "",
    lastProductContext: Array.isArray(memory.lastProductContext) ? memory.lastProductContext : [],
    clarificationTurnCount: Number(memory.clarificationTurnCount || 0),
    activeTaskIntent: memory.activeTaskIntent || "",
    activeUserJob: memory.activeUserJob || "",
    activeSubjectType: memory.activeSubjectType || "",
    activeReferenceType: memory.activeReferenceType || "",
    activeReferenceValue: memory.activeReferenceValue || "",
    entryTopicLock: memory.entryTopicLock || "",
    entryTopicSourcePolicy: memory.entryTopicSourcePolicy || null,
    lastResolvedEntity: memory.lastResolvedEntity || "",
    lastIntentEvidence: Array.isArray(memory.lastIntentEvidence) ? memory.lastIntentEvidence : [],
    lastAnsweredQuestionType: memory.lastAnsweredQuestionType || "",
    lastAnswerabilityClass: memory.lastAnswerabilityClass || "",
    lastSupportInfoIntent: memory.lastSupportInfoIntent || "",
    topicShiftHistory: Array.isArray(memory.topicShiftHistory) ? memory.topicShiftHistory : [],
    customerProfile: {
      name: normalizeText(memory.customerProfile?.name),
      firstName: normalizeText(memory.customerProfile?.firstName),
      email: normalizeText(memory.customerProfile?.email),
      source: normalizeText(memory.customerProfile?.source)
    },
    supportHistory: {
      lastIssueCategory: normalizeText(memory.supportHistory?.lastIssueCategory),
      lastEmotionalTone: normalizeText(memory.supportHistory?.lastEmotionalTone),
      lastHandoffReason: normalizeText(memory.supportHistory?.lastHandoffReason),
      lastSuccessfulSource: normalizeText(memory.supportHistory?.lastSuccessfulSource),
      lastBlockedSource: normalizeText(memory.supportHistory?.lastBlockedSource)
    }
  };
}

function areEquivalentWorkingMemories(left = null, right = null) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return JSON.stringify(normalizeComparableMemory(left)) === JSON.stringify(normalizeComparableMemory(right));
}

module.exports = {
  applyWorkingMemoryToSession,
  areEquivalentWorkingMemories,
  buildWorkingMemory,
  extractLatestWorkingMemory,
  getFirstName,
  parseWorkingMemoryNote,
  serializeWorkingMemory
};
