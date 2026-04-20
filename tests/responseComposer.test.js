const test = require("node:test");
const assert = require("node:assert/strict");

const { composeDeterministicReply } = require("../services/responseComposer");

function buildKnowledge({
  source = "zendesk",
  title,
  body,
  isStrong = true
}) {
  return {
    articles: [
      {
        source,
        title,
        body,
        score: 18,
        rankingScore: 18
      }
    ],
    quality: {
      isStrong,
      isWeak: !isStrong
    },
    primarySource: source
  };
}

test("composeDeterministicReply extracts support info sentences for strong KB hits", () => {
  const reply = composeDeterministicReply({
    conversation: {
      standaloneQuery: "Koje vam je radno vrijeme subotom?",
      reasoningResult: {
        taskIntent: "support_info",
        actionIntent: "ask_info"
      }
    },
    knowledge: buildKnowledge({
      title: "Radno vrijeme i kontakt",
      body:
        "Antikvarijat Libar radi ponedjeljak do petak od 08:00 do 20:00. " +
        "Subotom radimo od 08:00 do 13:00. " +
        "Za dodatne informacije javite se telefonom."
    })
  });

  assert.match(reply, /Subotom radimo od 08:00 do 13:00/i);
  assert.doesNotMatch(reply, /bonus/i);
});

test("composeDeterministicReply does not leak article title and keeps procedural continuation", () => {
  const reply = composeDeterministicReply({
    conversation: {
      standaloneQuery: "Želim prodati knjige, koji je postupak?",
      reasoningResult: {
        taskIntent: "buyback",
        actionIntent: "ask_how_to"
      }
    },
    knowledge: buildKnowledge({
      source: "onedrive",
      title: "ČLANAK 1 — ZA PRODAVAČE",
      body:
        "Otkup je proces u kojem nam prodajete udžbenike koji Vam više nisu potrebni. " +
        "Nudimo dva načina otkupa: " +
        "Najbrži način je skeniranje barkod brojeva ili njihovo ručno upisivanje. " +
        "Sporiji način je fotografiranje udžbenika i slanje putem maila ili Messengera."
    })
  });

  assert.doesNotMatch(reply, /ČLANAK 1/i);
  assert.match(reply, /dva načina otkupa/i);
  assert.match(reply, /Najbrži način/i);
});

test("composeDeterministicReply keeps buyback bonus guidance when present", () => {
  const reply = composeDeterministicReply({
    conversation: {
      standaloneQuery: "Kako ide otkup i imam li bonus?",
      reasoningResult: {
        taskIntent: "buyback",
        actionIntent: "request_estimate"
      }
    },
    knowledge: buildKnowledge({
      source: "onedrive",
      title: "Otkup knjiga",
      body:
        "Za procjenu pošaljite popis ili fotografije knjiga. " +
        "Za veće količine odobravamo bonus na procijenjenu vrijednost."
    })
  });

  assert.match(reply, /pošaljite popis ili fotografije knjiga/i);
  assert.match(reply, /bonus/i);
});

test("composeDeterministicReply returns null for weak knowledge", () => {
  const reply = composeDeterministicReply({
    conversation: {
      standaloneQuery: "Koja je cijena dostave?",
      reasoningResult: {
        taskIntent: "delivery",
        actionIntent: "ask_info"
      }
    },
    knowledge: buildKnowledge({
      title: "Dostava",
      body: "Dostava ovisi o lokaciji.",
      isStrong: false
    })
  });

  assert.equal(reply, null);
});

test("composeDeterministicReply skips mixed support-info and buyback question to avoid stitched answer", () => {
  const reply = composeDeterministicReply({
    conversation: {
      standaloneQuery: "Koje vam je radno vrijeme i gdje se nalazite, te da li otkupljujete knjige?",
      reasoningResult: {
        taskIntent: "support_info",
        actionIntent: "ask_general_info"
      }
    },
    knowledge: {
      articles: [
        {
          source: "zendesk",
          title: "Radno vrijeme i kontakt",
          body: "Nalazimo se u Osijeku. Radimo ponedjeljak do petak od 08:00 do 20:00.",
          score: 18,
          rankingScore: 18
        },
        {
          source: "onedrive",
          title: "Otkup knjiga",
          body: "Otkup je proces u kojem prodajete udžbenike. Nakon potvrde naloga knjige treba zapakirati i predati dostavljaču.",
          score: 16,
          rankingScore: 16
        }
      ],
      quality: {
        isStrong: true,
        isWeak: false
      },
      primarySource: "zendesk"
    }
  });

  assert.equal(reply, null);
});
