const test = require("node:test");
const assert = require("node:assert/strict");

const { RentCarsScraper } = require("../src/rentcars/scraper");

const insuranceTarget = {
  requestedLocation: "Warszawa",
  location: "Warszawa, Lotnisko-Okecie",
  value: "1",
  sortOrder: "price_insurance",
  priceMode: "insurance"
};

const baseTarget = {
  ...insuranceTarget,
  sortOrder: "price",
  priceMode: "base"
};

test("numeric rental total wins over a daily formatted price", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    price: {
      formatted: "120 PLN / day",
      total: 360,
      currency: "PLN"
    },
    insurance: { total: 60 }
  }, insuranceTarget, "network");

  assert.equal(offer.totalPrice, 420);
  assert.equal(offer.basePrice, 360);
  assert.equal(offer.protectedPrice, 420);
  assert.equal(offer.currency, "PLN");
});

test("daily-only display price is not treated as a rental total", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    price: { formatted: "120 PLN / day" },
    insurance: { total: 60 }
  }, insuranceTarget, "network");

  assert.equal(offer, null);
});

test("Polish daily-only display price is not treated as a rental total", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    price: { formatted: "120 PLN / dzie\u0144" },
    insurance: { total: 60 }
  }, insuranceTarget, "network");

  assert.equal(offer, null);
});

test("daily-marked price object amount cannot bypass rental-total rejection", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    price: { formatted: "120 PLN / day", amount: 120 },
    insurance: { total: 60 }
  }, insuranceTarget, "network");

  assert.equal(offer, null);
});

test("price string and amount object remain supported", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const candidates = [
    { providerName: "Provider A", price: "360 PLN" },
    { providerName: "Provider A", price: { amount: 360, currency: "PLN" } }
  ];

  for (const candidate of candidates) {
    const offer = scraper.normalizeOfferCandidate(candidate, baseTarget, "network");
    assert.equal(offer.totalPrice, 360);
    assert.equal(offer.currency, "PLN");
  }
});

test("generic features require transmission context", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    totalPrice: 360,
    features: ["Manual transmission", "Automatic climate control"]
  }, baseTarget, "network");

  assert.equal(offer.transmission, "manual");
});

test("generic automatic feature without transmission context stays unknown", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    totalPrice: 360,
    features: ["Automatic climate control"]
  }, baseTarget, "network");

  assert.equal(offer.transmission, "");
});

test("structured features bind transmission to its specific key", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    totalPrice: 360,
    features: { transmission: "manual", climate: "automatic" }
  }, baseTarget, "network");

  assert.equal(offer.transmission, "manual");
});

test("labeled transmission feature objects remain supported", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offer = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    totalPrice: 360,
    features: { name: "Transmission", value: "automatic" }
  }, baseTarget, "network");

  assert.equal(offer.transmission, "automatic");
});

test("explicit transmission fields keep Polish and English values", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const cases = [
    ["Automatic", "automatic"],
    ["Automatyczna", "automatic"],
    ["Manual", "manual"],
    ["Manualna", "manual"]
  ];

  for (const [transmission, expected] of cases) {
    const offer = scraper.normalizeOfferCandidate({
      providerName: "Provider A",
      totalPrice: 360,
      transmission
    }, baseTarget, "network");
    assert.equal(offer.transmission, expected);
  }
});

test("vehicle and model names cannot supply provider identity", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const modelOnlyCandidates = [
    { carName: "Toyota Yaris", totalPrice: 360 },
    { vehicleName: "Toyota Yaris", totalPrice: 360 },
    { modelName: "Toyota Yaris", totalPrice: 360 },
    { car: { name: "Toyota Yaris" }, totalPrice: 360 },
    { vehicle: { name: "Toyota Yaris" }, totalPrice: 360 },
    { model: { name: "Toyota Yaris" }, totalPrice: 360 }
  ];

  for (const candidate of modelOnlyCandidates) {
    assert.equal(scraper.normalizeOfferCandidate(candidate, baseTarget, "network"), null);
  }
});

test("payload extraction rejects model-only records and keeps supplier fields", () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const offers = scraper.extractOffersFromUnknownPayload({
    results: [
      { modelName: "Toyota Yaris", totalPrice: 360 },
      { supplierName: "Provider A", carName: "Toyota Corolla", totalPrice: 420 }
    ]
  }, baseTarget, "network");

  assert.deepEqual(
    offers.map((offer) => [offer.provider, offer.totalPrice]),
    [["Provider A", 420]]
  );
});

test("DOM extraction preserves a standalone manual label beside automatic climate", async () => {
  const scraper = new RentCarsScraper({ transmission: "any" });
  const cardText = "Manualna\nAutomatic climate control";
  const card = {
    innerText: cardText,
    textContent: cardText,
    querySelector: (selector) => {
      if (selector === ".without-protection .total-price") {
        return { textContent: "360 PLN" };
      }
      if (selector === ".with-protection .total-price") {
        return { textContent: "420 PLN" };
      }
      if (selector === "script[data-var='location']") {
        return { textContent: JSON.stringify({ companyName: "Provider A" }) };
      }
      return null;
    }
  };
  const documentMock = {
    querySelectorAll: (selector) => selector === ".car-search-result-item" ? [card] : []
  };
  const page = {
    evaluate: async (callback, argument) => {
      const originalDocument = global.document;
      global.document = documentMock;
      try {
        return callback(argument);
      } finally {
        if (originalDocument === undefined) {
          delete global.document;
        } else {
          global.document = originalDocument;
        }
      }
    }
  };

  const offers = await scraper.extractOffersFromDom(page, insuranceTarget);

  assert.equal(offers.length, 1);
  assert.equal(offers[0].provider, "Provider A");
  assert.equal(offers[0].transmission, "manual");
});
