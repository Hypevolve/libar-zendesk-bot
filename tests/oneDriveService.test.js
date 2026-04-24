const test = require("node:test");
const assert = require("node:assert/strict");
const { knowledgeRegressionCases } = require("./fixtures/knowledgeRegressionDataset");
const {
  createDocItem,
  loadFreshOneDriveService
} = require("./helpers/oneDriveTestHarness");

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

test("searchOneDriveDetailed retrieves delivery options for paraphrased 'dostavne opcije' queries", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Top6.docx"),
      createDocItem("Libar_HelpCenter_Clanci7-15.docx"),
      createDocItem("Libar_HelpCenter_Clanci16-18.docx")
    ]
  });

  try {
    const result = await service.searchOneDriveDetailed("Koje dostavne opcije nudite?");

    assert.ok(result?.context, "expected context for delivery-options paraphrase");
    assert.match(result.context, /(GLS|MBE)/i);
    assert.match(result.context, /(BOXNOW|paketomat)/i);
    assert.match(result.context, /(5,97 EUR|3,50 EUR|osobno preuzimanje)/i);
  } finally {
    restore();
  }
});

test("searchOneDriveDetailed retrieves buyer workflow guidance for real product-support phrasing", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Top6.docx"),
      createDocItem("Libar_HelpCenter_Clanci7-15.docx"),
      createDocItem("Libar_HelpCenter_Clanci16-18.docx")
    ]
  });

  const cases = [
    {
      query: "Kako provjeriti dostupnost po trgovinama?",
      patterns: [/knjiga nije dostupna|provjerite dostupnost na webu|stanje zaliha/i]
    },
    {
      query: "Pozdrav. Kako završiti kupnju.",
      patterns: [/Kako naručiti udžbenike|dodajte ga u košaricu|pretraživanje/i]
    },
    {
      query: "Odradila sam točke 1 i 2 i ne znam šta da stisnem da ubacim u ko@aricu jer ju ne vidim.",
      patterns: [/Kako naručiti udžbenike|dodajte ga u košaricu|pretraživanje/i]
    },
    {
      query: "Jel mogu naručiti knjigu i da mi dođe dostavom na kućnu adresu",
      patterns: [/Kako naručiti udžbenike|Dostava|GLS|MBE/i]
    },
    {
      query: "Ja sam upisala bar kod i pise mi nedostupno, ne mogu dodati u košaru.. zašto",
      patterns: [/knjiga nije dostupna|stanje zaliha|provjerite dostupnost/i]
    },
    {
      query: "Kako da vam ubacim sliku što mi treba",
      patterns: [/fotografiju|info@antikvarijat-libar\.com|Messenger|chata/i]
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

test("searchOneDriveDetailed resolves 1000 user-question regressions against the KB export set", async () => {
  const { service, restore } = loadFreshOneDriveService({
    items: [
      createDocItem("Libar_HelpCenter_Top6.docx"),
      createDocItem("Libar_HelpCenter_Clanci7-15.docx"),
      createDocItem("Libar_HelpCenter_Clanci16-18.docx")
    ]
  });

  try {
    assert.equal(knowledgeRegressionCases.length, 1000, "expected exactly 1000 generated regression questions");
    const groupCounts = new Map();
    const channelCounts = new Map();
    const startedAt = Date.now();

    for (const testCase of knowledgeRegressionCases) {
      groupCounts.set(testCase.groupId, (groupCounts.get(testCase.groupId) || 0) + 1);
      channelCounts.set(testCase.channel, (channelCounts.get(testCase.channel) || 0) + 1);

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

    const durationMs = Date.now() - startedAt;

    assert.equal(groupCounts.size, 25, "expected regression coverage for all 25 fact groups");

    for (const [groupId, count] of groupCounts.entries()) {
      assert.equal(count, 40, `expected exactly 40 generated questions for group ${groupId}`);
    }

    assert.deepEqual(
      Object.fromEntries([...channelCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
      {
        email: 250,
        facebook: 250,
        web_chat: 500
      },
      "expected deterministic balanced channel distribution"
    );

    assert.ok(durationMs < 30_000, `expected full 1000-question regression to finish under 30s, got ${durationMs}ms`);
  } finally {
    restore();
  }
});
