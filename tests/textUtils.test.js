const test = require("node:test");
const assert = require("node:assert/strict");

const textUtils = require("../services/textUtils");

test("normalizeWhitespace collapses spacing without changing case", () => {
  assert.equal(textUtils.normalizeWhitespace("  A   B \n C  "), "A B C");
});

test("normalizeLowercase removes diacritics", () => {
  assert.equal(textUtils.normalizeLowercase("ČćŽšĐ"), "cczsđ");
});

test("normalizeForSearch strips html punctuation and lowercases", () => {
  const normalized = textUtils.normalizeForSearch("<p>Radno vrijeme: 9-18 &amp; subota.</p>");
  assert.equal(normalized, "radno vrijeme 9 18 subota");
});

test("normalizeForComparison preserves # and hyphen while cleaning text", () => {
  const normalized = textUtils.normalizeForComparison(" Narudžba #123-AB! ");
  assert.equal(normalized, "narudzba #123-ab");
});

test("stripHtml removes script and style blocks and keeps paragraph breaks", () => {
  const html = "<style>.x{}</style><script>alert(1)</script><p>Prvi</p><p>Drugi</p>";
  assert.equal(textUtils.stripHtml(html), "Prvi\n Drugi");
});
