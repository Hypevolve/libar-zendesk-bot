const axios = require("axios");
const {
  findBestExcerpt,
  normalizeText,
  preprocessSearchQuery,
  scoreSearchText,
  stripHtml,
  tokenize,
  truncateText
} = require("./searchUtils");

const {
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN,
  ZENDESK_WEBHOOK_TOKEN
} = process.env;

const HELP_CENTER_CACHE_TTL_MS = Number(process.env.HELP_CENTER_CACHE_TTL_MS) || 5 * 60 * 1000;
const HELP_CENTER_CONTEXT_ARTICLES = Number(process.env.HELP_CENTER_CONTEXT_ARTICLES) || 5;

if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_API_TOKEN) {
  console.warn(
    "Zendesk environment variables are missing. API calls will fail until they are configured."
  );
}

function sanitizeEnvValue(value = "") {
  return String(value).trim();
}

function maskSecret(value = "") {
  const normalized = sanitizeEnvValue(value);

  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= 6) {
    return "***";
  }

  return `${normalized.slice(0, 3)}***${normalized.slice(-3)}`;
}

function hasPlaceholderValue(value = "") {
  const normalized = sanitizeEnvValue(value).toLowerCase();

  return [
    "",
    "your-subdomain",
    "agent@example.com",
    "your-zendesk-api-token",
    "tvoj_email",
    "tvoj_zendesk_api_token"
  ].includes(normalized);
}

async function getRequesterProfile(requesterId) {
  if (!requesterId) {
    return {
      id: null,
      name: "",
      email: ""
    };
  }

  try {
    validateZendeskConfig();

    const response = await zendeskClient.get(`/api/v2/users/${requesterId}.json`);
    const user = response.data?.user || {};

    return {
      id: user.id || requesterId,
      name: sanitizeEnvValue(user.name),
      email: sanitizeEnvValue(user.email)
    };
  } catch (error) {
    console.error("Failed to fetch Zendesk requester profile:", {
      requesterId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    return {
      id: requesterId,
      name: "",
      email: ""
    };
  }
}

function validateZendeskConfig() {
  if (hasPlaceholderValue(ZENDESK_SUBDOMAIN)) {
    throw new Error(
      "Zendesk config error: ZENDESK_SUBDOMAIN is missing or still uses a placeholder value."
    );
  }

  if (hasPlaceholderValue(ZENDESK_EMAIL) || !sanitizeEnvValue(ZENDESK_EMAIL).includes("@")) {
    throw new Error(
      "Zendesk config error: ZENDESK_EMAIL must be a real agent email address."
    );
  }

  if (hasPlaceholderValue(ZENDESK_API_TOKEN)) {
    throw new Error(
      "Zendesk config error: ZENDESK_API_TOKEN is missing or still uses a placeholder value."
    );
  }
}

function buildZendeskApiError(actionLabel, error, extra = {}) {
  const status = error.response?.status;
  const responseData = error.response?.data;

  if (status === 401) {
    return new Error(
      `${actionLabel} failed: Zendesk authentication failed (401). Check ZENDESK_EMAIL and ZENDESK_API_TOKEN in .env. ZENDESK_EMAIL must be the real agent email, and the client automatically sends it as email/token.`
    );
  }

  if (status === 403) {
    return new Error(
      `${actionLabel} failed: Zendesk denied access (403). Check Help Center permissions, API permissions, or Cloudflare restrictions.`
    );
  }

  const details = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";

  return new Error(
    `${actionLabel} failed${status ? ` with status ${status}` : ""}.${details}`
  );
}

function getZendeskConfigSummary() {
  return {
    baseURL: `https://${sanitizeEnvValue(ZENDESK_SUBDOMAIN)}.zendesk.com`,
    email: sanitizeEnvValue(ZENDESK_EMAIL),
    tokenPreview: maskSecret(ZENDESK_API_TOKEN),
    webhookTokenConfigured: Boolean(sanitizeEnvValue(ZENDESK_WEBHOOK_TOKEN))
  };
}

const zendeskClient = axios.create({
  baseURL: `https://${sanitizeEnvValue(ZENDESK_SUBDOMAIN)}.zendesk.com`,
  auth: {
    // Zendesk Basic Auth format for API tokens is email/token as the username.
    username: `${sanitizeEnvValue(ZENDESK_EMAIL)}/token`,
    password: sanitizeEnvValue(ZENDESK_API_TOKEN)
  },
  headers: {
    "Content-Type": "application/json"
  },
  timeout: 15000
});

// In-memory cache so the app does not re-download the full Help Center on every ticket.
const helpCenterCache = {
  articles: null,
  expiresAt: 0
};

function createArticleSearchText(article) {
  return [
    article.title || "",
    article.body || "",
    Array.isArray(article.label_names) ? article.label_names.join(" ") : "",
    article.section_name || "",
    article.category_name || ""
  ].join(" ");
}

/**
 * Simple lexical scoring across the full KB.
 * Exact phrase matches get the biggest boost, then title matches, then body coverage.
 */
function scoreArticle(article, query, options = {}) {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(query);
  const title = normalizeText(article.title || "");
  const searchText = normalizeText(createArticleSearchText(article));
  const conversationTerms = Array.isArray(options.conversationTerms)
    ? options.conversationTerms.map((term) => normalizeText(term)).filter(Boolean)
    : [];

  if (!normalizedQuery || queryTokens.length === 0 || !searchText) {
    return 0;
  }

  let score = scoreSearchText(searchText, query);

  if (title.includes(normalizedQuery)) {
    score += 15;
  }

  score += scoreSearchText(article.title || "", query) * 2;

  for (const term of conversationTerms) {
    if (!term) {
      continue;
    }

    if (searchText.includes(term) || title.includes(term)) {
      score += 2;
    }
  }

  return score;
}

function dedupeRankedArticles(rankedArticles) {
  const seenKeys = new Set();

  return rankedArticles.filter(({ article }) => {
    const key = normalizeText(`${article.title || ""} ${stripHtml(article.body || "").slice(0, 240)}`);

    if (!key || seenKeys.has(key)) {
      return false;
    }

    seenKeys.add(key);
    return true;
  });
}

/**
 * Download the complete Help Center article corpus using Zendesk pagination.
 * We cache the result briefly in memory because article data changes far less often
 * than tickets arrive.
 */
async function fetchAllHelpCenterArticles() {
  validateZendeskConfig();

  const now = Date.now();

  if (helpCenterCache.articles && helpCenterCache.expiresAt > now) {
    return helpCenterCache.articles;
  }

  const allArticles = [];
  let nextPageUrl = "/api/v2/help_center/articles.json?page[size]=100";

  while (nextPageUrl) {
    const response = await zendeskClient.get(nextPageUrl);
    const pageArticles = Array.isArray(response.data?.articles) ? response.data.articles : [];

    allArticles.push(...pageArticles);
    nextPageUrl = response.data?.next_page || null;
  }

  const publishedArticles = allArticles.filter((article) => !article.draft);

  helpCenterCache.articles = publishedArticles;
  helpCenterCache.expiresAt = now + HELP_CENTER_CACHE_TTL_MS;

  return publishedArticles;
}

/**
 * Read the wider Zendesk Help Center corpus, rank articles locally, and return
 * the best-matching context block for the AI.
 * Returns null when no article appears relevant.
 */
async function searchHelpCenter(query) {
  const result = await searchHelpCenterDetailed(query);
  return result?.context || null;
}

async function searchHelpCenterDetailed(query, options = {}) {
  try {
    const searchQuery = preprocessSearchQuery(query, options);
    const allArticles = await fetchAllHelpCenterArticles();

    if (allArticles.length === 0) {
      return null;
    }

    const rankedArticles = allArticles
      .map((article) => ({
        article,
        score: scoreArticle(article, searchQuery, options),
        excerpt: findBestExcerpt(article.body || "", searchQuery, 900)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    const uniqueRankedArticles = dedupeRankedArticles(rankedArticles)
      .slice(0, HELP_CENTER_CONTEXT_ARTICLES);

    if (uniqueRankedArticles.length === 0) {
      return null;
    }

    const context = uniqueRankedArticles
      .map(({ article, score, excerpt }, index) => {
        const title = stripHtml(article.title || "Bez naslova");
        const body = excerpt || truncateText(stripHtml(article.body || ""));

        return [
          `Članak ${index + 1}:`,
          `Naslov: ${title}`,
          `Relevantnost: ${score}`,
          `Sadržaj: ${body}`
        ].join("\n");
      })
      .join("\n\n");

    return {
      context: context || null,
      articles: uniqueRankedArticles.map(({ article, score, excerpt }) => ({
        id: article.id,
        title: stripHtml(article.title || "Bez naslova"),
        score,
        body: excerpt || truncateText(stripHtml(article.body || ""))
      })),
      topScore: uniqueRankedArticles[0]?.score || 0,
      totalMatches: uniqueRankedArticles.length
    };
  } catch (error) {
    console.error("Zendesk Help Center retrieval failed:", {
      message: error.message,
      responseData: error.response?.data
    });

    // Fail soft: knowledge retrieval issues should not crash the app.
    return null;
  }
}

/**
 * Update a ticket by adding a tag and an internal note in one request.
 * This is used for both attachment escalations and AI escalations.
 */
async function addTagAndNote(ticketId, tag, noteText) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.put(`/api/v2/tickets/${ticketId}.json`, {
      ticket: {
        additional_tags: [tag],
        comment: {
          public: false,
          body: noteText
        }
      }
    });

    return response.data;
  } catch (error) {
    console.error("Failed to add Zendesk tag and note:", {
      ticketId,
      tag,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to add tag and note to ticket", error, {
      ticketId,
      tag
    });
  }
}

async function addInternalNote(ticketId, noteText, additionalTags = []) {
  return replyToTicket(ticketId, noteText, false, {
    additionalTags
  });
}

/**
 * Add a comment to the Zendesk ticket.
 * The default use case here is internal notes (shadow mode), but the function
 * also supports public replies by flipping isPublic to true if needed later.
 */
async function replyToTicket(ticketId, replyText, isPublic = false, options = {}) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.put(`/api/v2/tickets/${ticketId}.json`, {
      ticket: {
        comment: {
          public: isPublic,
          body: replyText,
          ...(options.authorId ? { author_id: options.authorId } : {}),
          ...(options.uploadTokens?.length ? { uploads: options.uploadTokens } : {})
        },
        ...(options.metadata
          ? {
              metadata: {
                custom: options.metadata
              }
            }
          : {}),
        ...(options.additionalTags?.length ? { additional_tags: options.additionalTags } : {})
      }
    });

    return response.data;
  } catch (error) {
    console.error("Failed to reply to Zendesk ticket:", {
      ticketId,
      isPublic,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to add reply to ticket", error, {
      ticketId,
      isPublic
    });
  }
}

/**
 * Create a customer-facing Zendesk ticket that will act as the backing store
 * for a webshop chat conversation.
 */
async function createChatTicket({
  requesterName,
  requesterEmail,
  initialMessage,
  subject,
  uploadTokens = [],
  externalId = null,
  additionalTags = []
}) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.post("/api/v2/tickets.json", {
      ticket: {
        subject: subject || "Webshop chat conversation",
        comment: {
          public: true,
          body: initialMessage,
          ...(uploadTokens.length ? { uploads: uploadTokens } : {})
        },
        metadata: {
          custom: {
            libar_message_role: "customer",
            libar_message_origin: "webchat"
          }
        },
        requester: {
          name: requesterName,
          email: requesterEmail
        },
        ...(externalId ? { external_id: externalId } : {}),
        additional_tags: [...new Set(["webshop_chat", "ai_chat", "ai_active", ...additionalTags])]
      }
    });

    const ticket = response.data?.ticket;

    return {
      ticketId: ticket?.id,
      requesterId: ticket?.requester_id,
      externalId: ticket?.external_id || externalId || null
    };
  } catch (error) {
    console.error("Failed to create Zendesk chat ticket:", {
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to create webshop chat ticket", error);
  }
}

/**
 * Persist a customer message into the Zendesk ticket as a public comment.
 * The author is explicitly set to the requester so agents can see the flow
 * as an actual conversation instead of bot-authored notes only.
 */
async function addCustomerMessageToTicket(ticketId, requesterId, messageText, uploadTokens = []) {
  return replyToTicket(ticketId, messageText, true, {
    authorId: requesterId,
    uploadTokens,
    metadata: {
      libar_message_role: "customer",
      libar_message_origin: "webchat"
    }
  });
}

/**
 * Persist an AI response into the Zendesk ticket as a public comment authored
 * by the API agent account.
 */
function resolveBotReplyOrigin(channelType = "web_chat") {
  const normalizedChannelType = String(channelType).trim().toLowerCase();

  if (normalizedChannelType === "facebook") {
    return "facebook_ai";
  }

  if (normalizedChannelType === "email") {
    return "email_ai";
  }

  if (normalizedChannelType === "web_chat" || normalizedChannelType === "webchat") {
    return "webchat_ai";
  }

  return "zendesk_ai";
}

async function addBotReplyToTicket(ticketId, replyText, options = {}) {
  const channelType = options.channelType || "web_chat";

  return replyToTicket(ticketId, replyText, true, {
    additionalTags: [...new Set(["ai_replied", ...(options.additionalTags || [])])],
    metadata: {
      ...(options.metadata || {}),
      libar_message_role: "assistant",
      libar_message_origin: resolveBotReplyOrigin(channelType)
    }
  });
}

async function setTicketTags(ticketId, nextTags = []) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.put(`/api/v2/tickets/${ticketId}.json`, {
      ticket: {
        tags: nextTags
      }
    });

    return response.data;
  } catch (error) {
    console.error("Failed to set Zendesk ticket tags:", {
      ticketId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to set ticket tags", error, { ticketId });
  }
}

async function updateConversationState(ticketId, nextState, extraTags = []) {
  const ticket = await getTicketSummary(ticketId);
  const stateTags = new Set([
    "ai_active",
    "awaiting_human",
    "awaiting_customer_detail",
    "human_active",
    "resolved"
  ]);
  const nextTags = (ticket.tags || []).filter((tag) => !stateTags.has(tag));

  if (nextState) {
    nextTags.push(nextState);
  }

  for (const tag of extraTags) {
    if (tag && !nextTags.includes(tag)) {
      nextTags.push(tag);
    }
  }

  return setTicketTags(ticketId, nextTags);
}

async function solveTicket(ticketId, options = {}) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.put(`/api/v2/tickets/${ticketId}.json`, {
      ticket: {
        status: "solved",
        ...(options.commentBody
          ? {
              comment: {
                public: true,
                body: options.commentBody
              }
            }
          : {}),
        ...(options.additionalTags?.length ? { additional_tags: options.additionalTags } : {})
      }
    });

    return response.data;
  } catch (error) {
    console.error("Failed to solve Zendesk ticket:", {
      ticketId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to solve ticket", error, { ticketId });
  }
}

async function uploadAttachment(file) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.post("/api/v2/uploads.json", file.buffer, {
      params: {
        filename: file.originalname
      },
      headers: {
        "Content-Type": file.mimetype || "application/octet-stream"
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const upload = response.data?.upload;

    return {
      token: upload?.token,
      attachment: {
        id: upload?.attachment?.id || file.originalname,
        name: upload?.attachment?.file_name || file.originalname,
        contentType: upload?.attachment?.content_type || file.mimetype,
        size: upload?.attachment?.size || file.size,
        url: upload?.attachment?.content_url || null
      }
    };
  } catch (error) {
    console.error("Failed to upload attachment to Zendesk:", {
      filename: file.originalname,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to upload attachment", error, {
      filename: file.originalname
    });
  }
}

async function uploadAttachments(files = []) {
  return Promise.all(files.map((file) => uploadAttachment(file)));
}

/**
 * Fetch the public ticket conversation so the webshop widget can stay in sync
 * with agent replies entered directly in Zendesk.
 */
async function getPublicTicketComments(ticketId) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.get(`/api/v2/tickets/${ticketId}/comments.json`, {
      params: {
        sort: "created_at"
      }
    });

    const comments = Array.isArray(response.data?.comments) ? response.data.comments : [];

    return comments.filter((comment) => comment.public !== false);
  } catch (error) {
    console.error("Failed to fetch Zendesk ticket comments:", {
      ticketId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to fetch ticket comments", error, { ticketId });
  }
}

async function getTicketAudits(ticketId) {
  try {
    validateZendeskConfig();

    const audits = [];
    let nextPageUrl = `/api/v2/tickets/${ticketId}/audits.json?filter_events[]=Comment&page[size]=100`;

    while (nextPageUrl) {
      const response = await zendeskClient.get(nextPageUrl);
      const pageAudits = Array.isArray(response.data?.audits) ? response.data.audits : [];

      audits.push(...pageAudits);
      nextPageUrl = response.data?.next_page || null;
    }

    return audits;
  } catch (error) {
    console.error("Failed to fetch Zendesk ticket audits:", {
      ticketId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to fetch ticket audits", error, { ticketId });
  }
}

async function getTicketSummary(ticketId) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.get(`/api/v2/tickets/${ticketId}.json`);
    const ticket = response.data?.ticket || {};
    const requesterProfile = await getRequesterProfile(ticket.requester_id);

    return {
      id: ticket.id,
      status: ticket.status || null,
      tags: Array.isArray(ticket.tags) ? ticket.tags : [],
      assigneeId: ticket.assignee_id || null,
      requesterId: ticket.requester_id || null,
      externalId: ticket.external_id || null,
      requesterName: requesterProfile.name || "",
      requesterEmail: requesterProfile.email || ""
    };
  } catch (error) {
    console.error("Failed to fetch Zendesk ticket summary:", {
      ticketId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Unable to fetch ticket summary", error, { ticketId });
  }
}

function verifyWebhookToken(token = "") {
  const configuredToken = sanitizeEnvValue(ZENDESK_WEBHOOK_TOKEN);

  if (!configuredToken) {
    return false;
  }

  return sanitizeEnvValue(token) === configuredToken;
}

async function testZendeskTicketAccess(ticketId) {
  try {
    validateZendeskConfig();

    const response = await zendeskClient.get(`/api/v2/tickets/${ticketId}.json`);

    return {
      ok: true,
      ticketId: response.data?.ticket?.id || ticketId
    };
  } catch (error) {
    console.error("Zendesk ticket access test failed:", {
      ticketId,
      status: error.response?.status,
      message: error.message,
      responseData: error.response?.data
    });

    throw buildZendeskApiError("Zendesk ticket access test", error, { ticketId });
  }
}

module.exports = {
  addInternalNote,
  addTagAndNote,
  addBotReplyToTicket,
  addCustomerMessageToTicket,
  createChatTicket,
  fetchAllHelpCenterArticles,
  getZendeskConfigSummary,
  getPublicTicketComments,
  getRequesterProfile,
  getTicketAudits,
  getTicketSummary,
  normalizeText,
  replyToTicket,
  scoreArticle,
  searchHelpCenter,
  searchHelpCenterDetailed,
  setTicketTags,
  solveTicket,
  stripHtml,
  testZendeskTicketAccess,
  updateConversationState,
  uploadAttachments,
  verifyWebhookToken
};
