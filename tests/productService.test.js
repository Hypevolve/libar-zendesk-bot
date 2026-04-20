const test = require("node:test");
const assert = require("node:assert/strict");

const axios = require("axios");

function loadFreshProductService() {
  delete require.cache[require.resolve("../services/productService")];
  return require("../services/productService");
}

test("normalizeIsbn strips separators and uppercases x", () => {
  const productService = loadFreshProductService();
  assert.equal(productService.normalizeIsbn("978-953-0-ABCx"), "9789530X");
});

test("formatPrice formats valid euro values and ignores invalid ones", () => {
  const productService = loadFreshProductService();
  assert.equal(productService.formatPrice(null), "");
  assert.match(productService.formatPrice(12.5), /12,50/);
});

test("searchProducts returns strong ISBN match from product feed", async () => {
  const originalGet = axios.get;
  axios.get = async () => ({
    data: [
      {
        sifra: "1",
        naziv: "Algebra 1",
        isbn: "9789530001111",
        autori: ["Autor A"],
        kupnja: {
          link: "https://example.com/algebra-1",
          cijena_eur: 14.9,
          dostupno: true,
          broj_zaliha: 3
        },
        otkup: {
          link: "https://example.com/otkup/algebra-1",
          dostupno: true
        }
      }
    ]
  });

  try {
    const productService = loadFreshProductService();
    const result = await productService.searchProducts("Imate li 978-953-0001111?");

    assert.equal(result.source, "product_feed");
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].title, "Algebra 1");
    assert.equal(result.products[0].sellLink, "https://example.com/otkup/algebra-1");
  } finally {
    axios.get = originalGet;
  }
});

test("searchProducts returns null for weak generic match", async () => {
  const originalGet = axios.get;
  axios.get = async () => ({
    data: [
      {
        sifra: "1",
        naziv: "Biologija za 1. razred",
        isbn: "111",
        kupnja: {
          link: "https://example.com/biologija",
          cijena_eur: 10,
          dostupno: true,
          broj_zaliha: 2
        }
      }
    ]
  });

  try {
    const productService = loadFreshProductService();
    const result = await productService.searchProducts("knjige");
    assert.equal(result, null);
  } finally {
    axios.get = originalGet;
  }
});

test("searchProducts fails soft on feed retrieval error", async () => {
  const originalGet = axios.get;
  axios.get = async () => {
    throw new Error("feed unavailable");
  };

  try {
    const productService = loadFreshProductService();
    const result = await productService.searchProducts("Algebra 1");
    assert.equal(result, null);
  } finally {
    axios.get = originalGet;
  }
});

test("buildProductResponse and internal summary include useful card info", () => {
  const productService = loadFreshProductService();
  const products = [
    {
      title: "Algebra 1",
      priceLabel: "14,90 EUR",
      buyLink: "https://example.com/algebra-1"
    }
  ];

  assert.match(productService.buildProductResponse(products), /Našao sam ovaj udžbenik/i);
  assert.match(productService.buildProductInternalSummary(products), /Algebra 1 \| 14,90 EUR \| https:\/\/example.com\/algebra-1/);
});
