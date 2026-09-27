const test = require("node:test");
const assert = require("node:assert/strict");
const { buildScenarioPayload } = require("../src/rentcars/run");

function mappedOffer(basePrice, protectedPrice) {
  const payload = buildScenarioPayload({
    config: { sortOrders: ["price_insurance"] },
    scenarioConfig: {
      pickupDate: "2026-09-27", pickupTime: "10:00",
      dropoffDate: "2026-09-30", dropoffTime: "10:00",
      baseUrl: "https://rentcars.pl"
    },
    durationDays: 3,
    results: [{
      provider: "MM Cars Rental", pickupLocation: "Warszawa, Lotnisko-Okecie",
      location: "Warszawa", sortOrder: "price_insurance", priceMode: "insurance",
      totalPrice: 420, basePrice, protectedPrice,
      priceVerified: true, currency: "PLN", transmission: "automatic", source: "network"
    }],
    failures: []
  });
  return payload.results[0];
}

test("missing optional prices never fabricate an insurance surcharge", () => {
  for (const missing of [null, undefined, "", " "]) {
    const noBase = mappedOffer(missing, 420);
    assert.equal(noBase.base_price, null);
    assert.equal(noBase.insured_price, 420);
    assert.equal(noBase.insurance_surcharge, null);
    const noInsured = mappedOffer(360, missing);
    assert.equal(noInsured.insured_price, null);
    assert.equal(noInsured.insurance_surcharge, null);
  }
});

test("explicit prices including zero retain their insurance difference", () => {
  assert.equal(mappedOffer("360", "420").insurance_surcharge, 60);
  assert.equal(mappedOffer(0, 60).insurance_surcharge, 60);
});
