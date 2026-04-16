const aiService = require("./aiService");

const ENABLE_EMAIL_SPAM_CLASSIFIER = String(
  process.env.ENABLE_EMAIL_SPAM_CLASSIFIER ?? "true"
).trim().toLowerCase() !== "false";
const EMAIL_SPAM_AI_MIN_CONFIDENCE = Number(process.env.EMAIL_SPAM_AI_MIN_CONFIDENCE) || 0.75;

const HARD_SPAM_TAGS = new Set(["spam", "suspended"]);
const SUPPORT_HINT_TOKENS = [
  "narudž",
  "dostav",
  "račun",
  "racun",
  "uplat",
  "plać",
  "plac",
  "otkup",
  "procjen",
  "knjig",
  "strip",
  "gramofon",
  "pošilj",
  "posilj",
  "povrat",
  "reklamac",
  "problem",
  "upit",
  "webshop",
  "antikvarijat",
  "libar"
];
const HARD_SPAM_PATTERNS = [
  { name: "guest_post_pitch", regex: /\bguest post|sponsored post|paid post\b/i, score: 3 },
  { name: "backlink_pitch", regex: /\bbacklink|link exchange|dofollow|domain authority\b/i, score: 3 },
  { name: "seo_service_pitch", regex: /\bseo services?|seo expert|improve your rankings|boost your traffic\b/i, score: 3 },
  { name: "phishing_verification", regex: /\bverify your account|confirm your password|wallet|seed phrase|gift card\b/i, score: 4 },
  { name: "crypto_spam", regex: /\bcrypto|blockchain|binance|wallet address\b/i, score: 4 },
  { name: "adult_or_casino", regex: /\bcasino|betting|adult traffic|porn\b/i, score: 4 }
];
const LIKELY_SPAM_PATTERNS = [
  { name: "generic_outreach", regex: /\bi came across your website|collaboration opportunity|partnership proposal\b/i, score: 2 },
  { name: "marketing_agency_pitch", regex: /\bmarketing agency|lead generation|digital marketing|outreach campaign\b/i, score: 2 },
  { name: "mass_email_language", regex: /\bdear sir\/madam|dear website owner|hello admin\b/i, score: 2 },
  { name: "contact_me_elsewhere", regex: /\btelegram|whatsapp|signal\b/i, score: 2 }
];

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function countRegexMatches(text, regex) {
  const matches = text.match(new RegExp(regex.source, `${regex.flags.includes("g") ? regex.flags : `${regex.flags}g`}`));
  return matches ? matches.length : 0;
}

function extractUrlCount(text) {
  const matches = String(text).match(/https?:\/\/|www\./gi);
  return matches ? matches.length : 0;
}

function hasSupportSignals(text) {
  const normalized = normalizeText(text);
  return SUPPORT_HINT_TOKENS.some((token) => normalized.includes(token));
}

function evaluateHeuristics(message, ticketSummary) {
  const normalizedMessage = normalizeText(message);
  const tags = Array.isArray(ticketSummary?.tags) ? ticketSummary.tags.map((tag) => String(tag).toLowerCase()) : [];
  const matchedSignals = [];

  if (tags.some((tag) => HARD_SPAM_TAGS.has(tag))) {
    return {
      classification: "spam",
      score: 99,
      reason: "existing_spam_tag",
      matchedSignals: ["existing_spam_tag"]
    };
  }

  let score = 0;
  const urlCount = extractUrlCount(message);
  const supportSignalsPresent = hasSupportSignals(normalizedMessage);
  const questionCount = countRegexMatches(message, /\?/g);

  if (urlCount >= 3) {
    score += 4;
    matchedSignals.push("many_links");
  } else if (urlCount === 2) {
    score += 2;
    matchedSignals.push("multiple_links");
  }

  for (const pattern of HARD_SPAM_PATTERNS) {
    if (pattern.regex.test(message)) {
      score += pattern.score;
      matchedSignals.push(pattern.name);
    }
  }

  for (const pattern of LIKELY_SPAM_PATTERNS) {
    if (pattern.regex.test(message)) {
      score += pattern.score;
      matchedSignals.push(pattern.name);
    }
  }

  if (questionCount === 0 && normalizedMessage.length > 350) {
    score += 1;
    matchedSignals.push("long_no_question");
  }

  if (!supportSignalsPresent && normalizedMessage.length > 180) {
    score += 1;
    matchedSignals.push("no_support_signals");
  }

  if (supportSignalsPresent) {
    score = Math.max(0, score - 2);
    matchedSignals.push("support_signal_detected");
  }

  if (score >= 5) {
    return {
      classification: "spam",
      score,
      reason: matchedSignals[0] || "heuristic_spam_match",
      matchedSignals
    };
  }

  if (score >= 3) {
    return {
      classification: "likely_spam",
      score,
      reason: matchedSignals[0] || "heuristic_possible_spam",
      matchedSignals
    };
  }

  return {
    classification: "normal",
    score,
    reason: "no_spam_signals",
    matchedSignals
  };
}

function shouldBlockClassifierResult(classification) {
  if (!classification) {
    return false;
  }

  if (
    classification.label === "marketing_spam" ||
    classification.label === "phishing_or_malicious"
  ) {
    return classification.confidence >= EMAIL_SPAM_AI_MIN_CONFIDENCE;
  }

  if (classification.label === "sales_outreach") {
    return classification.confidence >= 0.85;
  }

  return false;
}

async function evaluateIncomingMessage({ channelType, message, ticketSummary }) {
  const normalizedChannelType = aiService.normalizeChannelType(channelType);

  if (normalizedChannelType !== "email") {
    return {
      shouldBlock: false,
      classification: "normal",
      reason: "channel_not_eligible",
      matchedSignals: [],
      usedAiReview: false,
      aiClassification: null
    };
  }

  const heuristics = evaluateHeuristics(message, ticketSummary);

  if (heuristics.classification === "spam") {
    return {
      shouldBlock: true,
      classification: "spam",
      reason: heuristics.reason,
      matchedSignals: heuristics.matchedSignals,
      usedAiReview: false,
      aiClassification: null
    };
  }

  if (heuristics.classification !== "likely_spam" || !ENABLE_EMAIL_SPAM_CLASSIFIER) {
    return {
      shouldBlock: false,
      classification: heuristics.classification,
      reason: heuristics.reason,
      matchedSignals: heuristics.matchedSignals,
      usedAiReview: false,
      aiClassification: null
    };
  }

  const aiClassification = await aiService.classifySpamCandidate(message, {
    channelType: normalizedChannelType
  });
  const shouldBlock = shouldBlockClassifierResult(aiClassification);

  return {
    shouldBlock,
    classification: shouldBlock ? "spam" : "normal",
    reason: shouldBlock ? aiClassification.reason : heuristics.reason,
    matchedSignals: heuristics.matchedSignals,
    usedAiReview: true,
    aiClassification
  };
}

function buildSpamFilterNote(result, channelType = "email") {
  const parts = [
    `Spam filter (${aiService.normalizeChannelType(channelType)}): poruka je preskočena prije AI odgovora.`,
    `Razlog: ${result.reason}`
  ];

  if (Array.isArray(result.matchedSignals) && result.matchedSignals.length > 0) {
    parts.push(`Heuristike: ${result.matchedSignals.join(", ")}`);
  }

  if (result.aiClassification) {
    parts.push(
      `AI klasifikacija: ${result.aiClassification.label} (${result.aiClassification.confidence.toFixed(2)})`
    );
  }

  return parts.join("\n");
}

module.exports = {
  buildSpamFilterNote,
  evaluateIncomingMessage
};
