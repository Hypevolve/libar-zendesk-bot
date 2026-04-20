const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const KNOWLEDGE_DIR = "/Users/zrinko/Downloads/Bot Knowledge Base";
const DEFAULT_DOC_NAMES = [
  "Libar_HelpCenter_Top6.docx",
  "Libar_HelpCenter_Clanci7-15.docx",
  "Libar_HelpCenter_Clanci16-18.docx"
];

function createDocItem(name) {
  return {
    id: name,
    name,
    size: fs.statSync(path.join(KNOWLEDGE_DIR, name)).size,
    file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    parentReference: { path: "/drive/root:/Knowledge" },
    webUrl: `https://example.test/${encodeURIComponent(name)}`,
    "@microsoft.graph.downloadUrl": `https://download.test/${encodeURIComponent(name)}`
  };
}

function createDefaultDocItems() {
  return DEFAULT_DOC_NAMES.map((name) => createDocItem(name));
}

function loadFreshOneDriveService({ items = createDefaultDocItems() } = {}) {
  const originalEnv = {
    ONEDRIVE_TENANT_ID: process.env.ONEDRIVE_TENANT_ID,
    ONEDRIVE_CLIENT_ID: process.env.ONEDRIVE_CLIENT_ID,
    ONEDRIVE_CLIENT_SECRET: process.env.ONEDRIVE_CLIENT_SECRET,
    ONEDRIVE_DRIVE_ID: process.env.ONEDRIVE_DRIVE_ID,
    ONEDRIVE_FOLDER_ID: process.env.ONEDRIVE_FOLDER_ID,
    ONEDRIVE_SITE_ID: process.env.ONEDRIVE_SITE_ID,
    ONEDRIVE_FOLDER_URL: process.env.ONEDRIVE_FOLDER_URL
  };
  const originalCreate = axios.create;
  const originalPost = axios.post;
  const originalGet = axios.get;

  process.env.ONEDRIVE_TENANT_ID = "tenant";
  process.env.ONEDRIVE_CLIENT_ID = "client";
  process.env.ONEDRIVE_CLIENT_SECRET = "secret";
  process.env.ONEDRIVE_DRIVE_ID = "drive";
  process.env.ONEDRIVE_FOLDER_ID = "folder";
  delete process.env.ONEDRIVE_SITE_ID;
  delete process.env.ONEDRIVE_FOLDER_URL;

  axios.create = () => ({
    get: async () => ({
      data: {
        value: items
      }
    })
  });

  axios.post = async () => ({
    data: {
      access_token: "token",
      expires_in: 3600
    }
  });

  axios.get = async (url) => {
    const matchedItem = items.find((item) => item["@microsoft.graph.downloadUrl"] === url);

    if (!matchedItem) {
      throw new Error(`Unexpected download URL: ${url}`);
    }

    return {
      data: fs.readFileSync(path.join(KNOWLEDGE_DIR, matchedItem.name))
    };
  };

  delete require.cache[require.resolve("../../services/oneDriveService")];
  const service = require("../../services/oneDriveService");

  return {
    service,
    restore() {
      axios.create = originalCreate;
      axios.post = originalPost;
      axios.get = originalGet;

      for (const [key, value] of Object.entries(originalEnv)) {
        if (typeof value === "undefined") {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      delete require.cache[require.resolve("../../services/oneDriveService")];
    }
  };
}

module.exports = {
  DEFAULT_DOC_NAMES,
  KNOWLEDGE_DIR,
  createDefaultDocItems,
  createDocItem,
  loadFreshOneDriveService
};
