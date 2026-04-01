const axios = require("axios");

const {
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN
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
    tokenPreview: maskSecret(ZENDESK_API_TOKEN)
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

/**
 * Remove HTML tags and compress whitespace so articles become safe, compact AI context.
 * This is intentionally simple and dependency-free for a boilerplate project.
 */
function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize text for lightweight keyword relevance scoring.
 * This is not a vector search engine, but it is a material upgrade over
 * "top 3 search hits" because it evaluates the broader article corpus.
 */
function normalizeText(text = "") {
  return stripHtml(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text = "") {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2);
}

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
function scoreArticle(article, query) {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(query);
  const title = normalizeText(article.title || "");
  const searchText = normalizeText(createArticleSearchText(article));

  if (!normalizedQuery || queryTokens.length === 0 || !searchText) {
    return 0;
  }

  let score = 0;

  if (title.includes(normalizedQuery)) {
    score += 15;
  }

  if (searchText.includes(normalizedQuery)) {
    score += 10;
  }

  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 4;
    }

    if (searchText.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function truncateText(text, maxLength = 1800) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trim()}...`;
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
  try {
    const allArticles = await fetchAllHelpCenterArticles();

    if (allArticles.length === 0) {
      return null;
    }

    const rankedArticles = allArticles
      .map((article) => ({
        article,
        score: scoreArticle(article, query)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, HELP_CENTER_CONTEXT_ARTICLES);

    if (rankedArticles.length === 0) {
      return null;
    }

    const context = rankedArticles
      .map(({ article, score }, index) => {
        const title = stripHtml(article.title || "Bez naslova");
        const body = truncateText(stripHtml(article.body || ""));

        return [
          `Članak ${index + 1}:`,
          `Naslov: ${title}`,
          `Relevantnost: ${score}`,
          `Sadržaj: ${body}`
        ].join("\n");
      })
      .join("\n\n");

    return context || null;
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
  uploadTokens = []
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
        requester: {
          name: requesterName,
          email: requesterEmail
        },
        additional_tags: ["webshop_chat", "ai_chat"]
      }
    });

    const ticket = response.data?.ticket;

    return {
      ticketId: ticket?.id,
      requesterId: ticket?.requester_id
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
    uploadTokens
  });
}

/**
 * Persist an AI response into the Zendesk ticket as a public comment authored
 * by the API agent account.
 */
async function addBotReplyToTicket(ticketId, replyText) {
  return replyToTicket(ticketId, replyText, true, {
    additionalTags: ["ai_replied"]
  });
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
  const results = [];

  for (const file of files) {
    results.push(await uploadAttachment(file));
  }

  return results;
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
  addTagAndNote,
  addBotReplyToTicket,
  addCustomerMessageToTicket,
  createChatTicket,
  fetchAllHelpCenterArticles,
  getZendeskConfigSummary,
  getPublicTicketComments,
  normalizeText,
  replyToTicket,
  scoreArticle,
  searchHelpCenter,
  stripHtml,
  testZendeskTicketAccess,
  uploadAttachments
};
