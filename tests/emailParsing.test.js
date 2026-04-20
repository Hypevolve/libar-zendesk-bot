const test = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";

const { __internal } = require("../index");

test("quoted email reply keeps only latest customer question", () => {
  const normalized = __internal.normalizeZendeskCommentContent({
    plain_body: [
      "Koje vam je radno vrijeme?",
      "",
      "On Mon, Apr 20, 2026 at 10:00 AM Antikvarijat Libar <info@example.com> wrote:",
      "> Radimo od ponedjeljka do petka."
    ].join("\n")
  });

  assert.equal(normalized, "Koje vam je radno vrijeme?");
});

test("forwarded email strips original message header block", () => {
  const normalized = __internal.normalizeZendeskCommentContent({
    plain_body: [
      "Molim vas adresu poslovnice.",
      "",
      "-----Original Message-----",
      "From: Antikvarijat Libar <info@example.com>",
      "Sent: Monday, April 20, 2026 8:00 AM",
      "Subject: Radno vrijeme",
      "",
      "Radimo od ponedjeljka do petka."
    ].join("\n")
  });

  assert.equal(normalized, "Molim vas adresu poslovnice.");
});

test("email signature is removed from normalized content", () => {
  const normalized = __internal.normalizeZendeskCommentContent({
    plain_body: [
      "Zanima me imate li osobno preuzimanje.",
      "",
      "Lijep pozdrav,",
      "Ana Horvat",
      "Mob: 091 123 4567"
    ].join("\n")
  });

  assert.equal(normalized, "Zanima me imate li osobno preuzimanje.");
});

test("attachment email keeps latest question before quoted thread", () => {
  const normalized = __internal.normalizeZendeskCommentContent({
    html_body: [
      "<div>Šaljem privitak i zanima me status narudžbe.</div>",
      "<div><br></div>",
      "<div>From: Antikvarijat Libar &lt;info@example.com&gt;</div>",
      "<div>Subject: Narudžba</div>"
    ].join("")
  });

  assert.equal(normalized, "Šaljem privitak i zanima me status narudžbe.");
});
