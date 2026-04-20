const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const { knowledgeRegressionCases } = require("./fixtures/knowledgeRegressionDataset");

const KNOWLEDGE_DIR = "/Users/zrinko/Downloads/Bot Knowledge Base";

function loadFreshOneDriveService({ items }) {
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

    const filePath = path.join(KNOWLEDGE_DIR, matchedItem.name);
    return {
      data: fs.readFileSync(filePath)
    };
  };

  delete require.cache[require.resolve("../services/oneDriveService")];
  const service = require("../services/oneDriveService");

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

      delete require.cache[require.resolve("../services/oneDriveService")];
    }
  };
}

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

test("searchOneDriveDetailed can retrieve facts from later sections of large KB exports", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Top6.docx"),
      createDocItem("Libar_HelpCenter_Clanci7-15.docx"),
      createDocItem("Libar_HelpCenter_Clanci16-18.docx")
    ]
  });

  try {
    const r1Result = await service.searchOneDriveDetailed("Kako mogu dobiti R1 račun?");
    assert.ok(r1Result?.context, "expected context for R1 query");
    assert.match(r1Result.context, /R1 račun/i);
    assert.match(r1Result.context, /nije automatski/i);
    assert.match(r1Result.context, /info@antikvarijat-libar\.com/i);

    const aircashResult = await service.searchOneDriveDetailed("Isplaćujete li na Aircash?");
    assert.ok(aircashResult?.context, "expected context for Aircash query");
    assert.match(aircashResult.context, /Aircash/i);
    assert.match(aircashResult.context, /nije dostupna|ne vršimo isplatu/i);
  } finally {
    restore();
  }
});

test("fetchFolderDocuments keeps full DOCX content instead of truncating large KB exports", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Clanci7-15.docx")
    ]
  });

  try {
    const documents = await service.fetchFolderDocuments();
    const combinedArticleExport = documents.find((entry) => entry.title === "Libar_HelpCenter_Clanci7-15.docx");

    assert.ok(combinedArticleExport, "expected combined KB export to be ingested");
    assert.ok(combinedArticleExport.body.length > 10000, "expected full document body to remain available");
    assert.match(combinedArticleExport.body, /ČLANAK 12/i);
    assert.match(combinedArticleExport.body, /R1 račun/i);
    assert.match(combinedArticleExport.body, /ČLANAK 14/i);
    assert.match(combinedArticleExport.body, /Aircash/i);
  } finally {
    restore();
  }
});

test("searchOneDriveDetailed returns exact KB facts across the full Help Center export set", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Top6.docx"),
      createDocItem("Libar_HelpCenter_Clanci7-15.docx"),
      createDocItem("Libar_HelpCenter_Clanci16-18.docx")
    ]
  });

  const cases = [
    {
      query: "Kolika je dostava za BOXNOW paketomat?",
      patterns: [/3,50 EUR/i, /BOXNOW/i]
    },
    {
      query: "Kolika je dostava na kućnu adresu GLS ili MBE?",
      patterns: [/5,97 EUR/i, /(GLS|MBE)/i]
    },
    {
      query: "Koje je radno vrijeme poslovnice subotom?",
      patterns: [/08:00\s*[–-]\s*13:00/i, /Subota/i]
    },
    {
      query: "Otkupljujete li knjige za osnovnu školu?",
      patterns: [/osnovn\w*\s+škol/i, /ne otkupljujemo/i]
    },
    {
      query: "Koliko košta dostava kod online otkupa ako šaljem 3 knjige?",
      patterns: [/2,70 EUR/i, /3 ili manje knjiga/i]
    },
    {
      query: "Mogu li donijeti knjige bez najave?",
      patterns: [/ne zahtijeva prethodnu najavu/i, /Županijsku 17/i]
    },
    {
      query: "Mogu li sam odnijeti paket u GLS ili BOXNOW paketomat kod online otkupa?",
      patterns: [/nemamo tu opciju/i]
    },
    {
      query: "Kako mogu pratiti pošiljku?",
      patterns: [/tracking broj/i, /link za praćenje/i]
    },
    {
      query: "Mogu li platiti na rate?",
      patterns: [/(2 do 6 rata)/i, /(PBZ|ZABA)/i]
    },
    {
      query: "Što ako knjiga koju želim nije dostupna?",
      patterns: [/kontaktirajte nas|kontaktirajte/i, /(031-201-230|info@antikvarijat-libar\.com)/i]
    }
  ];

  try {
    for (const testCase of cases) {
      const result = await service.searchOneDriveDetailed(testCase.query);

      assert.ok(result?.context, `expected context for query: ${testCase.query}`);

      for (const pattern of testCase.patterns) {
        assert.match(
          result.context,
          pattern,
          `expected ${pattern} in context for query: ${testCase.query}`
        );
      }
    }
  } finally {
    restore();
  }
});

test("searchOneDriveDetailed resolves 100 user-question regressions against the KB export set", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Top6.docx"),
      createDocItem("Libar_HelpCenter_Clanci7-15.docx"),
      createDocItem("Libar_HelpCenter_Clanci16-18.docx")
    ]
  });

  try {
    assert.equal(knowledgeRegressionCases.length, 100, "expected exactly 100 generated regression questions");

    for (const testCase of knowledgeRegressionCases) {
      const result = await service.searchOneDriveDetailed(testCase.query);

      assert.ok(result?.context, `expected context for [${testCase.channel}] ${testCase.query}`);

      for (const pattern of testCase.patterns) {
        assert.match(
          result.context,
          pattern,
          `expected ${pattern} in context for [${testCase.channel}] ${testCase.query}`
        );
      }
    }
  } finally {
    restore();
  }
});
