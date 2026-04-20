const test = require("node:test");
const assert = require("node:assert/strict");

const searchUtils = require("../services/searchUtils");

test("preprocessSearchQuery removes greeting boilerplate and appends conversation facts", () => {
  const result = searchUtils.preprocessSearchQuery("Dobar dan, molim vas koje vam je radno vrijeme?", {
    conversationFacts: ["support_info", "radno vrijeme"]
  });

  assert.match(result, /^koje vam je radno vrijeme\?/);
  assert.match(result, /support_info/);
  assert.match(result, /radno vrijeme/);
  assert.match(result, /otvoreni/);
});

test("scoreSearchText rewards exact phrase and token coverage", () => {
  const strong = searchUtils.scoreSearchText(
    "Radno vrijeme antikvarijata Libar je pon-pet 9-18 i subotom 9-13.",
    "radno vrijeme Libar"
  );
  const weak = searchUtils.scoreSearchText(
    "Prodaja udžbenika i otkup knjiga.",
    "radno vrijeme Libar"
  );

  assert.ok(strong > weak);
  assert.ok(strong > 0);
});

test("preprocessSearchQuery expands support aliases into retrieval hints", () => {
  const result = searchUtils.preprocessSearchQuery("Gdje se nalazite i koji vam je kontakt?", {
    retrievalHints: ["support_info"]
  });

  assert.match(result, /adresa/i);
  assert.match(result, /kontakt/i);
  assert.match(result, /telefon/i);
});

test("findBestExcerpt prefers the most relevant segment and keeps nearby context", () => {
  const text = [
    "<p>Antikvarijat Libar otkupljuje udžbenike.</p>",
    "<p>Radno vrijeme poslovnice je ponedjeljak do petak od 9 do 18 sati.</p>",
    "<p>Subotom radimo od 9 do 13 sati.</p>"
  ].join("\n\n");

  const excerpt = searchUtils.findBestExcerpt(text, "radno vrijeme", 200);

  assert.match(excerpt, /radno vrijeme poslovnice/i);
  assert.match(excerpt, /Subotom radimo/i);
});

test("findBestExcerpt falls back to truncated plain text when there is no relevant match", () => {
  const text = "<p>Jedan</p><p>Dva</p><p>Tri</p>";
  const excerpt = searchUtils.findBestExcerpt(text, "nepostojece", 8);

  assert.equal(excerpt, "Jedan\n D...");
});

test("tokenize and truncateText normalize expected search inputs", () => {
  assert.deepEqual(searchUtils.tokenize("Školski udžbenik 1"), ["kolski", "udz", "benik"]);
  assert.equal(searchUtils.truncateText("abcdefghijk", 5), "abcde...");
  assert.equal(searchUtils.stripHtml("<div>Pozdrav<br>svima</div>"), "Pozdrav\nsvima");
});
