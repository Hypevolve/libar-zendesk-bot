const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const productFeedService = require("../services/productFeedService");

test("searchProductsDetailed returns strong product matches with buy and sell links", async () => {
  const originalGet = axios.get;

  axios.get = async () => ({
    data: [
      {
        sifra: 12,
        registarski_broj: 12,
        isbn: "9780194563819",
        slika_url: "https://example.test/solutions.jpg",
        naziv: "SOLUTIONS 3rd ed. INTERMEDIATE",
        autori: ["Tim Falla", "Paul A. Davies"],
        vrsta: "radna bilježnica",
        nakladnik: "Oxford",
        predmet: "Engleski jezik",
        razred: "2. razred, 3. razred",
        kupnja: {
          link: "https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=SOLUTIONS+3rd+ed.+INTERMEDIATE",
          cijena_eur: 8.55,
          dostupno: true,
          broj_zaliha: 82
        },
        otkup: {
          link: "https://antikvarijat-libar.com/otkup-udzbenika/?tab=tab-form&pretraga_isbn=9780194563819",
          cijena_eur: 2,
          dostupno: false
        }
      },
      {
        sifra: 99,
        registarski_broj: 99,
        isbn: "3850150222916",
        slika_url: "https://example.test/latin.jpg",
        naziv: "LINGUAE LATINAE ELEMENTA",
        autori: ["Jadranka Bagarić"],
        vrsta: "radna bilježnica",
        nakladnik: "Školska knjiga",
        predmet: "Latinski jezik",
        razred: "1. razred",
        kupnja: {
          link: "https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=LINGUAE+LATINAE+ELEMENTA",
          cijena_eur: 9.49,
          dostupno: true,
          broj_zaliha: 16
        },
        otkup: {
          link: "https://antikvarijat-libar.com/otkup-udzbenika/?tab=tab-form&pretraga_isbn=3850150222916",
          cijena_eur: 1.8,
          dostupno: true
        }
      }
    ]
  });

  productFeedService.resetProductFeedCache();

  try {
    const result = await productFeedService.searchProductsDetailed(
      "Trebam Solutions intermediate workbook od Tim Falle"
    );

    assert.ok(result);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].title, "SOLUTIONS 3rd ed. INTERMEDIATE");
    assert.match(result.products[0].availabilityLabel, /^Na zalihi:\s+\d+$/);
    assert.equal(result.products[0].availabilityTone, "available");
    assert.equal(result.products[0].priceLabel, "8,55 EUR");
    assert.equal(result.products[0].buyButtonLabel, "Otvori kupnju");
    assert.match(result.products[0].buyLink, /kupi-udzbenike/);
    assert.match(result.products[0].sellLink, /pretraga_isbn=9780194563819/);
  } finally {
    axios.get = originalGet;
    productFeedService.resetProductFeedCache();
  }
});

test("searchProductsDetailed does not return noisy matches for generic single-word queries", async () => {
  const originalGet = axios.get;

  axios.get = async () => ({
    data: [
      {
        sifra: 1,
        registarski_broj: 1,
        isbn: "9780194563819",
        naziv: "SOLUTIONS 3rd ed. INTERMEDIATE",
        autori: ["Tim Falla"],
        vrsta: "radna bilježnica",
        nakladnik: "Oxford",
        predmet: "Engleski jezik",
        razred: "2. razred",
        kupnja: {
          link: "https://antikvarijat-libar.com/kupi-udzbenike/?pretraga=SOLUTIONS+3rd+ed.+INTERMEDIATE",
          cijena_eur: 8.55,
          dostupno: true,
          broj_zaliha: 82
        },
        otkup: {
          link: "https://antikvarijat-libar.com/otkup-udzbenika/?tab=tab-form&pretraga_isbn=9780194563819",
          cijena_eur: 2,
          dostupno: false
        }
      }
    ]
  });

  productFeedService.resetProductFeedCache();

  try {
    const result = await productFeedService.searchProductsDetailed("Engleski");
    assert.equal(result, null);
  } finally {
    axios.get = originalGet;
    productFeedService.resetProductFeedCache();
  }
});
