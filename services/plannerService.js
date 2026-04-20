const { getFirstName } = require("./memoryService");

function normalizeIntent(intent = "") {
  return String(intent || "").trim();
}

function getEntryTopicPolicy(session = {}) {
  const lock = String(
    session?.entryTopicLock ||
      session?.workingMemory?.entryTopicLock ||
      ""
  ).trim();

  switch (lock) {
    case "buyback":
      return {
        route: "onedrive_knowledge",
        selectedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        sourcePriority: ["onedrive_knowledge", "zendesk_knowledge"],
        mustNotUseSources: ["product_feed"],
        mergeStrategy: "support_only",
        preferredTaskIntent: "buyback"
      };
    case "delivery":
      return {
        route: "zendesk_knowledge",
        selectedSources: ["zendesk_knowledge", "onedrive_knowledge"],
        sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: ["product_feed"],
        mergeStrategy: "support_only",
        preferredTaskIntent: "delivery"
      };
    case "order_status":
    case "order_issue":
    case "complaint":
      return {
        route: "zendesk_knowledge",
        selectedSources: ["zendesk_knowledge", "onedrive_knowledge"],
        sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: ["product_feed"],
        mergeStrategy: "support_only",
        preferredTaskIntent: lock
      };
    case "product_lookup":
      return {
        route: "product_feed",
        selectedSources: ["product_feed"],
        sourcePriority: ["product_feed", "zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: [],
        mergeStrategy: "product_first",
        preferredTaskIntent: "product_lookup"
      };
    default:
      return null;
  }
}

function buildSourcePlan(primaryIntent, secondaryIntent = null) {
  if (
    secondaryIntent &&
    ((primaryIntent.startsWith("product_") && !secondaryIntent.startsWith("product_")) ||
      (!primaryIntent.startsWith("product_") && secondaryIntent.startsWith("product_")))
  ) {
    return {
      route: "clarify",
      selectedSources: [],
      sourcePriority: [],
      mustNotUseSources: [],
      mergeStrategy: "disambiguate_before_lookup"
    };
  }

  switch (primaryIntent) {
    case "product_availability":
      return {
        route: "product_feed",
        selectedSources: ["product_feed"],
        sourcePriority: ["product_feed", "zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: [],
        mergeStrategy: "product_first"
      };
    case "product_pricing":
      return {
        route: "product_feed",
        selectedSources: ["product_feed"],
        sourcePriority: ["product_feed", "zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: [],
        mergeStrategy: "product_first"
      };
    case "dostava_info":
      return {
        route: "zendesk_knowledge",
        selectedSources: ["zendesk_knowledge", "onedrive_knowledge"],
        sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: ["product_feed"],
        mergeStrategy: "support_only"
      };
    case "otkup_upit":
      return {
        route: "onedrive_knowledge",
        selectedSources: ["onedrive_knowledge", "zendesk_knowledge"],
        sourcePriority: ["onedrive_knowledge", "zendesk_knowledge"],
        mustNotUseSources: ["product_feed"],
        mergeStrategy: "support_only"
      };
    case "narudzba_status":
    case "narudzba_problem":
    case "reklamacija_povrat":
      return {
        route: "zendesk_knowledge",
        selectedSources: ["zendesk_knowledge", "onedrive_knowledge"],
        sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: ["product_feed"],
        mergeStrategy: "support_only"
      };
    case "small_talk_or_closure":
      return {
        route: "clarify",
        selectedSources: [],
        sourcePriority: [],
        mustNotUseSources: ["product_feed", "zendesk_knowledge", "onedrive_knowledge"],
        mergeStrategy: "no_lookup"
      };
    default:
      return {
        route: "zendesk_knowledge",
        selectedSources: ["zendesk_knowledge", "onedrive_knowledge"],
        sourcePriority: ["zendesk_knowledge", "onedrive_knowledge"],
        mustNotUseSources: [],
        mergeStrategy: "support_only"
      };
  }
}

function shouldUseCustomerName(reasoningResult = {}, session = {}) {
  const firstName = getFirstName(
    session?.requesterName ||
      session?.workingMemory?.customerProfile?.name ||
      session?.workingMemory?.customerProfile?.firstName
  );

  if (!firstName) {
    return false;
  }

  if (reasoningResult?.emotionalTone === "frustrated") {
    return true;
  }

  if (Array.isArray(reasoningResult?.missingSlots) && reasoningResult.missingSlots.length > 0) {
    return true;
  }

  return false;
}

function buildSupportPlan({ reasoningResult = {}, session = {}, hasAttachments = false } = {}) {
  const primaryIntent = normalizeIntent(reasoningResult.primaryIntent);
  const secondaryIntent = normalizeIntent(reasoningResult.secondaryIntent);
  const defaultSourcePlan = buildSourcePlan(primaryIntent, secondaryIntent);
  const lockedPolicy = getEntryTopicPolicy(session);
  const useLockedPolicy = Boolean(lockedPolicy);
  const sourcePlan = useLockedPolicy ? lockedPolicy : defaultSourcePlan;
  const missingSlots = Array.isArray(reasoningResult.missingSlots) ? reasoningResult.missingSlots : [];
  const isClosure = primaryIntent === "small_talk_or_closure";
  const isComplaint =
    primaryIntent === "reklamacija_povrat" ||
    primaryIntent === "narudzba_problem" ||
    reasoningResult.riskLevel === "high";
  const toneMode =
    reasoningResult.emotionalTone === "frustrated"
      ? "deescalation"
      : isComplaint
        ? "warm_reassuring"
        : primaryIntent.startsWith("narudzba_")
          ? "concise_transactional"
          : "neutral_helpful";

  let route = sourcePlan.route;
  let responseMode = "direct_answer";
  let nextBestAction = "answer_now";

  if (hasAttachments) {
    route = "handoff_hard";
    responseMode = "escalate";
    nextBestAction = "handoff_now";
  } else if (reasoningResult.riskLevel === "high") {
    route = "handoff_hard";
    responseMode = "escalate";
    nextBestAction = "handoff_now";
  } else if (isClosure) {
    route = "clarify";
    responseMode = "direct_answer";
    nextBestAction = "close_or_acknowledge";
  } else if (missingSlots.length > 0) {
    route = "clarify";
    responseMode = "clarify";
    nextBestAction = "ask_missing_detail";
  } else if (route === "clarify") {
    responseMode = "clarify";
    nextBestAction = "disambiguate";
  } else if (primaryIntent === "narudzba_status" || primaryIntent === "dostava_info" || primaryIntent === "otkup_upit") {
    responseMode = "procedural_answer";
  } else if (isComplaint) {
    responseMode = "reassurance_then_answer";
  }

  return {
    route,
    responseMode,
    toneMode,
    shouldUseCustomerName: shouldUseCustomerName(reasoningResult, session),
    nextBestAction,
    selectedSources: sourcePlan.selectedSources,
    sourcePriority: sourcePlan.sourcePriority,
    mustNotUseSources: sourcePlan.mustNotUseSources,
    mergeStrategy: sourcePlan.mergeStrategy
  };
}

module.exports = {
  buildSupportPlan
};
