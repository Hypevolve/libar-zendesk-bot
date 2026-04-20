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
    activeTaskIntent:
      conversation?.reasoningResult?.taskIntent ||
      previousMemory?.activeTaskIntent ||
      "",
    activeSubjectType:
      conversation?.reasoningResult?.subjectType ||
      previousMemory?.activeSubjectType ||
      "",
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
  return [
    MEMORY_START,
    JSON.stringify(memory),
    MEMORY_END
  ].join("\n");
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
  session.requesterName =
    normalizeText(memory.customerProfile?.name) || session.requesterName || "";
  session.requesterEmail =
    normalizeText(memory.customerProfile?.email) || session.requesterEmail || "";

  if (Array.isArray(memory.openSlots) && memory.openSlots.length > 0) {
    session.pendingClarification = {
      slotKey: memory.openSlots[0],
      intent: memory.activeIntent || "",
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
    openSlots: Array.isArray(memory.openSlots) ? memory.openSlots : [],
    resolvedSlots: Array.isArray(memory.resolvedSlots) ? memory.resolvedSlots : [],
    lastStandaloneQuery: memory.lastStandaloneQuery || "",
    lastRoute: memory.lastRoute || "",
    lastAnswerType: memory.lastAnswerType || "",
    lastKnowledgeSource: memory.lastKnowledgeSource || "",
    lastProductContext: Array.isArray(memory.lastProductContext) ? memory.lastProductContext : [],
    clarificationTurnCount: Number(memory.clarificationTurnCount || 0),
    activeTaskIntent: memory.activeTaskIntent || "",
    activeSubjectType: memory.activeSubjectType || "",
    lastResolvedEntity: memory.lastResolvedEntity || "",
    lastIntentEvidence: Array.isArray(memory.lastIntentEvidence) ? memory.lastIntentEvidence : [],
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
