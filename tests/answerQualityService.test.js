const test = require("node:test");
const assert = require("node:assert/strict");

const { validateAnswerQuality } = require("../services/answerQualityService");

test("validateAnswerQuality rejects internal marker leakage", () => {
  const result = validateAnswerQuality({
    answer: "Standalone upit: A koje vam je radno vrijeme? [LIBAR_MEMORY_V1]",
    outcomeType: "safe_answer"
  });

  assert.equal(result.isValid, false);
  assert.equal(result.reason, "internal_marker_leak");
});

test("validateAnswerQuality rejects source dump style answers", () => {
  const result = validateAnswerQuality({
    answer: "Članak dokument naslov radno vrijeme dostava adresa",
    outcomeType: "safe_answer"
  });

  assert.equal(result.isValid, false);
  assert.equal(result.reason, "source_dump");
});

test("validateAnswerQuality rejects strong-knowledge answer with low overlap", () => {
  const result = validateAnswerQuality({
    answer: "Javite nam se kasnije.",
    outcomeType: "safe_answer",
    conversation: {
      reasoningResult: {
        taskIntent: "support_info"
      }
    },
    knowledge: {
      quality: {
        isStrong: true
      },
      articles: [
        {
          title: "Radno vrijeme i kontakt",
          body: "Radimo ponedjeljak-petak 08:00-20:00 i subotom 08:00-13:00."
        }
      ]
    }
  });

  assert.equal(result.isValid, false);
  assert.equal(result.reason, "low_knowledge_overlap");
});

test("validateAnswerQuality accepts grounded support answer", () => {
  const result = validateAnswerQuality({
    answer: "Radimo ponedjeljak-petak 08:00-20:00, a subotom 08:00-13:00.",
    outcomeType: "safe_answer",
    conversation: {
      reasoningResult: {
        taskIntent: "support_info"
      }
    },
    knowledge: {
      quality: {
        isStrong: true
      },
      articles: [
        {
          title: "Radno vrijeme i kontakt",
          body: "Radimo ponedjeljak-petak 08:00-20:00 i subotom 08:00-13:00."
        }
      ]
    }
  });

  assert.equal(result.isValid, true);
});

test("validateAnswerQuality rejects partial coverage for multi-part support question", () => {
  const result = validateAnswerQuality({
    answer: "Radimo ponedjeljak-petak 08:00-20:00 i subotom 08:00-13:00.",
    outcomeType: "safe_answer",
    conversation: {
      standaloneQuery: "Koje vam je radno vrijeme i gdje se nalazite, te da li otkupljujete knjige?",
      reasoningResult: {
        taskIntent: "support_info"
      }
    },
    knowledge: {
      quality: {
        isStrong: false
      },
      articles: []
    }
  });

  assert.equal(result.isValid, false);
  assert.equal(result.reason, "partial_topic_coverage");
});

test("validateAnswerQuality rejects generic support summary when exact address is requested", () => {
  const result = validateAnswerQuality({
    answer:
      "Stranica s kontakt informacijama, adresom poslovnice, radnim vremenom te osnovnim kanalima za javljanje kupaca i prodavatelja.",
    outcomeType: "safe_answer",
    conversation: {
      standaloneQuery: "Koja vam je adresa i gdje se nalazite?",
      reasoningResult: {
        taskIntent: "support_info"
      }
    },
    knowledge: {
      quality: {
        isStrong: true
      },
      articles: [
        {
          title: "Kontakt",
          body: "Stranica s kontakt informacijama, adresom poslovnice i radnim vremenom."
        }
      ]
    }
  });

  assert.equal(result.isValid, false);
  assert.equal(result.reason, "missing_concrete_support_fact");
});
