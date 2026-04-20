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
