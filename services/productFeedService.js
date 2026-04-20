const axios = require("axios");
const { normalizeForComparison, normalizeWhitespace } = require("./textUtils");

const PRODUCT_FEED_URL =
  process.env.PRODUCT_FEED_URL ||
  "https://antikvarijat-libar.com/wp-content/uploads/sync/proizvodi_ai_learning.json";
const PRODUCT_FEED_CACHE_TTL_MS = Number(process.env.PRODUCT_FEED_CACHE_TTL_MS) || 10 * 60 * 1000;
const PRODUCT_FEED_TIMEOUT_MS = Number(process.env.PRODUCT_FEED_TIMEOUT_MS) || 8000;

const STOP_WORDS = new Set([
  "a",
  "al",
  "ali",
  "autor",
  "autora",
  "da",
  "dali",
  "da li",
  "for",
  "i",
  "ili",
  "imam",
  "imate",
  "imate li",
  "imam li",
  "iz",
  "je",
  "jel",
  "knjiga",
  "knjige",
  "kupiti",
  "kupnja",
  "kupnju",
  "me",
  "mi",
  "molim",
  "na",
  "od",
  "sam",
  "su",
  "te",
  "to",
  "trazim",
  "treba",
  "trebam",
  "u",
  "udbenik",
  "udzbenik",
  "udzbenike",
  "vas",
  "zanima",
  "zanimaju"
]);

let cachedProducts = null;
let cacheExpiresAt = 0;
let inFlightPromise = null;

function normalizeArray(values = []) {
  return Array.isArray(values) ? values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean) : [];
}

function normalizeProductRecord(entry = {}) {
  const title = normalizeWhitespace(entry.naziv || "");
  const authors = normalizeArray(entry.autori);
  const isbn = normalizeWhitespace(entry.isbn || "");
  const buyLink =
    entry?.kupnja?.link ||
    (title
      ? `https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=${encodeURIComponent(title)}`
      : "");
  const sellLink = isbn
    ? `https://antikvarijat-libar.com/otkup-udzbenika/?tab=tab-form&pretraga_isbn=${encodeURIComponent(isbn)}`
    : entry?.otkup?.link || "";

  return {
    id: String(entry.sifra || entry.registarski_broj || isbn || title || Math.random()),
    title,
    titleNormalized: normalizeForComparison(title),
    authors,
    authorsNormalized: authors.map((author) => normalizeForComparison(author)),
    isbn,
    isbnNormalized: normalizeForComparison(isbn),
    imageUrl: normalizeWhitespace(entry.slika_url || ""),
    publisher: normalizeWhitespace(entry.nakladnik || ""),
    subject: normalizeWhitespace(entry.predmet || ""),
    grade: normalizeWhitespace(entry.razred || ""),
    type: normalizeWhitespace(entry.vrsta || ""),
    availableForPurchase: Boolean(entry?.kupnja?.dostupno),
    stockCount: Number.isFinite(Number(entry?.kupnja?.broj_zaliha))
      ? Number(entry.kupnja.broj_zaliha)
      : null,
    buyPriceEur: Number.isFinite(Number(entry?.kupnja?.cijena_eur))
      ? Number(entry.kupnja.cijena_eur)
      : null,
    buyLink,
    sellLink,
    buybackAvailable: Boolean(entry?.otkup?.dostupno),
    buybackPriceEur: Number.isFinite(Number(entry?.otkup?.cijena_eur))
      ? Number(entry.otkup.cijena_eur)
      : null
  };
}

function tokenize(text = "") {
  return normalizeForComparison(text)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function preprocessQuery(query = "") {
  return normalizeWhitespace(
    String(query || "")
      .replace(/\r/g, " ")
      .replace(/^(pozdrav|bok|dobar dan|poštovani|postovani|hej|hello|hi)[,!.:\s-]*/i, "")
      .replace(
        /\b(imate li|imate|da li imate|dali imate|jel imate|trazim|tražim|treba mi|zanima me|zanimaju me|ima li|molim vas|možete li|mozete li)\b/gi,
        " "
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

function formatPriceLabel(priceEur) {
  return Number.isFinite(priceEur) ? `${priceEur.toFixed(2).replace(".", ",")} EUR` : "";
}

function buildMetaLine(product) {
  return [product.subject, product.grade, product.type, product.publisher]
    .filter(Boolean)
    .join(" • ");
}

function buildAvailabilityLabel(product) {
  if (!product.availableForPurchase) {
    return "Trenutno nedostupno";
  }

  if (Number.isFinite(product.stockCount) && product.stockCount > 0) {
    return `Na zalihi: ${product.stockCount}`;
  }

  return "Dostupno za kupnju";
}

function buildSearchableFields(product) {
  return {
    title: product.titleNormalized,
    authors: product.authorsNormalized.join(" "),
    isbn: product.isbnNormalized,
    meta: normalizeForComparison(
      [product.subject, product.grade, product.type, product.publisher].filter(Boolean).join(" ")
    )
  };
}

function scoreProduct(product, rawQuery = "") {
  const query = preprocessQuery(rawQuery);
  const queryNormalized = normalizeForComparison(query);
  const queryTokens = tokenize(query);

  if (!queryNormalized) {
    return 0;
  }

  const fields = buildSearchableFields(product);
  let score = 0;

  if (product.isbnNormalized && queryNormalized === product.isbnNormalized) {
    return 1000;
  }

  if (queryNormalized.length >= 8 && fields.title === queryNormalized) {
    score += 250;
  }

  if (queryNormalized.length >= 8 && fields.title.includes(queryNormalized)) {
    score += 190;
  }

  if (queryTokens.length > 0) {
    const titleTokens = tokenize(product.title);
    const authorTokens = tokenize(product.authors.join(" "));
    const metaTokens = tokenize([product.subject, product.grade, product.type, product.publisher].join(" "));

    let titleMatches = 0;
    let authorMatches = 0;
    let metaMatches = 0;

    for (const token of queryTokens) {
      if (titleTokens.includes(token)) {
        titleMatches += 1;
        score += 38;
      } else if (fields.title.includes(token)) {
        titleMatches += 1;
        score += 26;
      }

      if (authorTokens.includes(token) || fields.authors.includes(token)) {
        authorMatches += 1;
        score += 22;
      }

      if (metaTokens.includes(token) || fields.meta.includes(token)) {
        metaMatches += 1;
        score += 8;
      }
    }

    if (queryTokens.length === 1 && titleMatches === 0 && authorMatches === 0) {
      return 0;
    }

    if (queryTokens.length >= 2 && titleMatches + authorMatches >= Math.ceil(queryTokens.length / 2)) {
      score += 30;
    }

    if (queryTokens.length >= 4 && titleMatches + authorMatches >= 3) {
      score += 50;
    }

    if (queryTokens.length >= 5 && titleMatches + authorMatches === 0) {
      return 0;
    }
  }

  if (product.availableForPurchase) {
    score += 4;
  }

  return score;
}

function buildProductCards(products = []) {
  return products.map((product) => ({
    id: product.id,
    title: product.title,
    imageUrl: product.imageUrl || "",
    metaLine: buildMetaLine(product),
    availabilityLabel: buildAvailabilityLabel(product),
    availabilityTone: product.availableForPurchase ? "available" : "unavailable",
    priceLabel: product.availableForPurchase
      ? formatPriceLabel(product.buyPriceEur)
      : "Trenutno nije dostupno",
    buyLink: product.buyLink || "",
    sellLink: product.sellLink || "",
    buyButtonLabel: product.availableForPurchase ? "Otvori kupnju" : "Provjeri artikl",
    sellButtonLabel: "Otkup"
  }));
}

async function fetchProductFeed(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && Array.isArray(cachedProducts) && now < cacheExpiresAt) {
    return cachedProducts;
  }

  if (!forceRefresh && inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = axios
    .get(PRODUCT_FEED_URL, {
      timeout: PRODUCT_FEED_TIMEOUT_MS
    })
    .then((response) => {
      const rows = Array.isArray(response?.data) ? response.data : [];
      cachedProducts = rows.map((entry) => normalizeProductRecord(entry)).filter((entry) => entry.title);
      cacheExpiresAt = Date.now() + PRODUCT_FEED_CACHE_TTL_MS;
      return cachedProducts;
    })
    .finally(() => {
      inFlightPromise = null;
    });

  return inFlightPromise;
}

async function searchProductsDetailed(query, { maxResults = 3, minScore = 60 } = {}) {
  const products = await fetchProductFeed();
  const scored = products
    .map((product) => ({
      product,
      score: scoreProduct(product, query)
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults);

  if (scored.length === 0) {
    return null;
  }

  const topScore = scored[0].score;
  const topProducts = scored.map((entry) => entry.product);
  const cards = buildProductCards(topProducts);

  return {
    query,
    topScore,
    matchCount: topProducts.length,
    products: cards,
    rawProducts: topProducts,
    zendeskSummary: topProducts
      .map((product, index) => {
        const availability = product.availableForPurchase ? "dostupno za kupnju" : "trenutno nedostupno";
        return `${index + 1}. ${product.title} | ${availability} | ${product.buyLink}`;
      })
      .join("\n")
  };
}

function resetProductFeedCache() {
  cachedProducts = null;
  cacheExpiresAt = 0;
  inFlightPromise = null;
}

module.exports = {
  fetchProductFeed,
  searchProductsDetailed,
  resetProductFeedCache,
  __internal: {
    normalizeProductRecord,
    preprocessQuery,
    scoreProduct,
    buildProductCards,
    formatPriceLabel,
    buildAvailabilityLabel
  }
};
