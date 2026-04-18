/**
 * Shared text normalization utilities used across all services.
 * Consolidates the duplicate normalizeText implementations into
 * clearly named, purpose-specific variants.
 */

/**
 * Basic whitespace normalization — collapses runs of whitespace
 * into single spaces and trims. Does NOT change case or strip
 * diacritics.
 */
function normalizeWhitespace(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Diacritic-aware lowercase normalization suitable for fuzzy
 * comparisons (spam filtering, simple matching).
 * Removes combining diacritical marks via NFD decomposition.
 */
function normalizeLowercase(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Full search-ready normalization — strips HTML, lowercases,
 * removes diacritics and non-alphanumeric characters.
 * Used for search indexing and scoring.
 */
function normalizeForSearch(text = "", { stripHtmlContent = true } = {}) {
  const base = stripHtmlContent ? stripHtml(text) : String(text);

  return base
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Intent/comparison normalization — lowercases, strips diacritics,
 * and replaces non-letter/number characters with spaces.
 * Used by the reasoning service for intent detection regexes.
 */
function normalizeForComparison(value = "") {
  return normalizeWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s#-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

module.exports = {
  normalizeWhitespace,
  normalizeLowercase,
  normalizeForSearch,
  normalizeForComparison,
  stripHtml
};
