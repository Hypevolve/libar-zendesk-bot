const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

function loadFreshZendeskService({ env = {}, client } = {}) {
  const originalEnv = {
    ZENDESK_SUBDOMAIN: process.env.ZENDESK_SUBDOMAIN,
    ZENDESK_EMAIL: process.env.ZENDESK_EMAIL,
    ZENDESK_API_TOKEN: process.env.ZENDESK_API_TOKEN,
    ZENDESK_WEBHOOK_TOKEN: process.env.ZENDESK_WEBHOOK_TOKEN
  };
  const originalCreate = axios.create;

  process.env.ZENDESK_SUBDOMAIN = env.ZENDESK_SUBDOMAIN ?? "hypevolve";
  process.env.ZENDESK_EMAIL = env.ZENDESK_EMAIL ?? "agent@libar.hr";
  process.env.ZENDESK_API_TOKEN = env.ZENDESK_API_TOKEN ?? "super-secret-token";
  process.env.ZENDESK_WEBHOOK_TOKEN = env.ZENDESK_WEBHOOK_TOKEN ?? "hook-secret";

  axios.create = () =>
    client || {
      get: async () => ({ data: {} }),
      put: async () => ({ data: {} }),
      post: async () => ({ data: {} })
    };

  delete require.cache[require.resolve("../services/zendeskService")];
  const service = require("../services/zendeskService");

  return {
    service,
    restore() {
      axios.create = originalCreate;

      for (const [key, value] of Object.entries(originalEnv)) {
        if (typeof value === "undefined") {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      delete require.cache[require.resolve("../services/zendeskService")];
    }
  };
}

test("zendesk config summary masks secrets and webhook verification uses configured token", () => {
  const { service, restore } = loadFreshZendeskService({
    env: {
      ZENDESK_SUBDOMAIN: "libar",
      ZENDESK_EMAIL: "agent@libar.hr",
      ZENDESK_API_TOKEN: "1234567890TOKEN",
      ZENDESK_WEBHOOK_TOKEN: "webhook-123"
    }
  });

  try {
    const summary = service.getZendeskConfigSummary();

    assert.equal(summary.baseURL, "https://libar.zendesk.com");
    assert.equal(summary.email, "agent@libar.hr");
    assert.match(summary.tokenPreview, /^123\*\*\*KEN$/);
    assert.equal(service.verifyWebhookToken("webhook-123"), true);
    assert.equal(service.verifyWebhookToken("wrong"), false);
  } finally {
    restore();
  }
});

test("getPublicTicketComments keeps only public comments", async () => {
  const client = {
    get: async (url) => {
      if (url.includes("/comments.json")) {
        return {
          data: {
            comments: [
              { id: 1, body: "Javni odgovor", public: true },
              { id: 2, body: "Interna bilješka", public: false },
              { id: 3, body: "Drugi javni odgovor" }
            ]
          }
        };
      }

      throw new Error(`Unexpected GET ${url}`);
    },
    put: async () => ({ data: {} }),
    post: async () => ({ data: {} })
  };

  const { service, restore } = loadFreshZendeskService({ client });

  try {
    const comments = await service.getPublicTicketComments(123);
    assert.deepEqual(comments.map((comment) => comment.id), [1, 3]);
  } finally {
    restore();
  }
});

test("searchHelpCenterDetailed is exported for knowledge service integration", () => {
  const { service, restore } = loadFreshZendeskService();

  try {
    assert.equal(typeof service.searchHelpCenterDetailed, "function");
  } finally {
    restore();
  }
});

test("Zendesk API errors preserve rate-limit status metadata", async () => {
  const client = {
    get: async () => ({ data: {} }),
    put: async () => {
      const error = new Error("Request failed with status code 429");
      error.response = {
        status: 429,
        data: { errors: [{ title: "Rate Limited" }] }
      };
      throw error;
    },
    post: async () => ({ data: {} })
  };

  const { service, restore } = loadFreshZendeskService({ client });

  try {
    await assert.rejects(
      service.addBotReplyToTicket(123, "Test reply"),
      (error) => error?.status === 429
    );
  } finally {
    restore();
  }
});
