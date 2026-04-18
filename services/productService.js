const axios = require("axios");

const PRODUCT_FEED_URL =
  process.env.PRODUCT_FEED_URL ||
  "https://antikvarijat-libar.com/wp-content/uploads/sync/proizvodi_ai_learning.json";
const PRODUCT_FEED_TTL_MS = Number(process.env.PRODUCT_FEED_TTL_MS) || 30 * 60 * 1000;
const PRODUCT_MAX_RESULTS = Number(process.env.PRODUCT_MAX_RESULTS) || 3;

let cachedProducts = [];
let cacheExpiresAt = 0;
let inflightFetch = null;

function normalizeWhitespace(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value = "") {
  return normalizeWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeIsbn(value = "") {
  return String(value || "").replace(/[^0-9xX]/g, "").toUpperCase();
}

function buildSearchTokens(value = "") {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function buildMetaLine(product) {
  const authorLabel = Array.isArray(product.authors) ? product.authors.slice(0, 2).join(", ") : "";

  if (authorLabel) {
    return authorLabel;
  }

  return [product.subject, product.grade].filter(Boolean).join(" · ");
}

function normalizeProduct(rawProduct = {}) {
  const buy = rawProduct.kupnja && typeof rawProduct.kupnja === "object" ? rawProduct.kupnja : {};
  const sell = rawProduct.otkup && typeof rawProduct.otkup === "object" ? rawProduct.otkup : {};
  const title = normalizeWhitespace(rawProduct.naziv);

  if (!title) {
    return null;
  }

  const authors = Array.isArray(rawProduct.autori)
    ? rawProduct.autori.map((author) => normalizeWhitespace(author)).filter(Boolean)
    : [];

  const product = {
    id: rawProduct.sifra || rawProduct.registarski_broj || title,
    title,
    isbn: normalizeIsbn(rawProduct.isbn),
    imageUrl: normalizeWhitespace(rawProduct.slika_url),
    authors,
    type: normalizeWhitespace(rawProduct.vrsta),
    publisher: normalizeWhitespace(rawProduct.nakladnik),
    subject: normalizeWhitespace(rawProduct.predmet),
    grade: normalizeWhitespace(rawProduct.razred),
    buy: {
      link: normalizeWhitespace(buy.link),
      priceEur: Number.isFinite(Number(buy.cijena_eur)) ? Number(buy.cijena_eur) : null,
      available: typeof buy.dostupno === "boolean" ? buy.dostupno : null,
      stock: Number.isFinite(Number(buy.broj_zaliha)) ? Number(buy.broj_zaliha) : null
    },
    sell: {
      link: normalizeWhitespace(sell.link),
      priceEur: Number.isFinite(Number(sell.cijena_eur)) ? Number(sell.cijena_eur) : null,
      available: typeof sell.dostupno === "boolean" ? sell.dostupno : null
    }
  };

  product.metaLine = buildMetaLine(product);
  product.searchText = normalizeSearchText(
    [
      product.title,
      product.isbn,
      product.authors.join(" "),
      product.type,
      product.publisher,
      product.subject,
      product.grade
    ]
      .filter(Boolean)
      .join(" ")
  );

  return product;
}

async function fetchProductsFromFeed() {
  const response = await axios.get(PRODUCT_FEED_URL, {
    timeout: 15000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024
  });

  const rawProducts = Array.isArray(response.data) ? response.data : [];
  return rawProducts.map(normalizeProduct).filter(Boolean);
}

async function ensureFreshProducts() {
  if (Date.now() < cacheExpiresAt && cachedProducts.length > 0) {
    return cachedProducts;
  }

  if (inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = fetchProductsFromFeed()
    .then((products) => {
      cachedProducts = products;
      cacheExpiresAt = Date.now() + PRODUCT_FEED_TTL_MS;
      return cachedProducts;
    })
    .finally(() => {
      inflightFetch = null;
    });

  return inflightFetch;
}

function scoreProductAgainstQuery(product, queryText) {
  const normalizedQuery = normalizeSearchText(queryText);

  if (!normalizedQuery) {
    return 0;
  }

  const queryIsbn = normalizeIsbn(queryText);
  const queryTokens = buildSearchTokens(queryText);
  let score = 0;

  if (queryIsbn && product.isbn) {
    if (product.isbn === queryIsbn) {
      score += 120;
    } else if (
      queryIsbn.length >= 8 &&
      (product.isbn.includes(queryIsbn) || queryIsbn.includes(product.isbn))
    ) {
      score += 90;
    }
  }

  if (product.searchText.includes(normalizedQuery)) {
    score += 50;
  }

  const titleText = normalizeSearchText(product.title);
  if (titleText === normalizedQuery) {
    score += 35;
  } else if (titleText.startsWith(normalizedQuery)) {
    score += 25;
  }

  for (const token of queryTokens) {
    if (product.isbn && token === normalizeSearchText(product.isbn)) {
      score += 24;
      continue;
    }

    if (titleText.includes(token)) {
      score += token.length >= 5 ? 12 : 8;
      continue;
    }

    if (product.subject && normalizeSearchText(product.subject).includes(token)) {
      score += 5;
      continue;
    }

    if (product.grade && normalizeSearchText(product.grade).includes(token)) {
      score += 4;
      continue;
    }

    if (
      Array.isArray(product.authors) &&
      product.authors.some((author) => normalizeSearchText(author).includes(token))
    ) {
      score += 5;
    }
  }

  return score;
}

function isStrongProductMatch(match) {
  if (!match || !match.product) {
    return false;
  }

  const exactIsbnMatch = match.queryIsbn && match.product.isbn && match.queryIsbn === match.product.isbn;
  if (exactIsbnMatch) {
    return true;
  }

  return match.score >= 24;
}

function formatPrice(priceEur) {
  if (!Number.isFinite(priceEur)) {
    return "";
  }

  return new Intl.NumberFormat("hr-HR", {
    style: "currency",
    currency: "EUR"
  }).format(priceEur);
}

function formatProductForCard(product) {
  return {
    id: product.id,
    title: product.title,
    isbn: product.isbn || "",
    imageUrl: product.imageUrl || "",
    metaLine: product.metaLine || "",
    priceLabel: formatPrice(product.buy.priceEur),
    buyLink: product.buy.link || "",
    buyAvailable: product.buy.available,
    buyStock: product.buy.stock,
    sellLink: product.isbn && product.sell.link ? product.sell.link : "",
    sellAvailable: product.sell.available
  };
}

function buildProductResponse(products = []) {
  return [
    products.length === 1
      ? "Našao sam ovaj udžbenik."
      : "Našao sam nekoliko relevantnih udžbenika.",
    "Cijena i dostupnost mogu odstupati, pa ih prije kupnje provjerite na webshop linku."
  ].join("\n");
}

function buildProductInternalSummary(products = []) {
  return products
    .map((product) => {
      const parts = [product.title];

      if (product.priceLabel) {
        parts.push(product.priceLabel);
      }

      if (product.buyLink) {
        parts.push(product.buyLink);
      }

      return parts.join(" | ");
    })
    .join("\n");
}

async function searchProducts(query, options = {}) {
  const normalizedQuery = normalizeWhitespace(query);

  if (!normalizedQuery) {
    return null;
  }

  try {
    const products = await ensureFreshProducts();
    const queryIsbn = normalizeIsbn(normalizedQuery);
    const rankedMatches = products
      .map((product) => ({
        product,
        score: scoreProductAgainstQuery(product, normalizedQuery),
        queryIsbn
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || String(left.product.title).localeCompare(right.product.title))
      .slice(0, options.limit || PRODUCT_MAX_RESULTS);

    if (rankedMatches.length === 0 || !isStrongProductMatch(rankedMatches[0])) {
      return null;
    }

    const resultProducts = rankedMatches.map((match) => formatProductForCard(match.product));

    return {
      source: "product_feed",
      topScore: rankedMatches[0].score,
      totalMatches: rankedMatches.length,
      products: resultProducts,
      replyText: buildProductResponse(resultProducts),
      zendeskSummary: buildProductInternalSummary(resultProducts)
    };
  } catch (error) {
    console.error("Product feed retrieval failed:", {
      message: error.message,
      responseData: error.response?.data
    });

    return null;
  }
}

module.exports = {
  PRODUCT_FEED_TTL_MS,
  buildProductInternalSummary,
  buildProductResponse,
  formatPrice,
  normalizeIsbn,
  searchProducts
};
