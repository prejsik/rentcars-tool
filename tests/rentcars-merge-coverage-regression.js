const test = require("node:test");
const assert = require("node:assert/strict");

const { mergePayloads } = require("../src/rentcars/mergeResults");
const { buildMmAvailabilityAlert } = require("../src/rentcars/telegramSummary");

const startDate = "2026-09-10";
const location = "Warszawa, Lotnisko-Okecie";
const sortOrder = "price_insurance";

function expectedTarget(mmCoverageComplete) {
  const target = {
    location,
    sort_order: sortOrder
  };
  if (typeof mmCoverageComplete === "boolean") {
    target.mm_coverage_complete = mmCoverageComplete;
  }
  return target;
}

function scenario({ provider, price, mmCoverageComplete, failed = false }) {
  return {
    scenario_id: `${startDate}-2`,
    start_date: startDate,
    rental_days: 2,
    expected_targets: [expectedTarget(mmCoverageComplete)],
    expected_check_count: 1,
    successful_check_count: failed ? 0 : 1,
    failed_check_count: failed ? 1 : 0,
    results: failed ? [] : [{
      provider_name: provider,
      pickup_location: location,
      sort_order: sortOrder,
      total_price: price,
      rental_days: 2,
      transmission: "automatic"
    }],
    errors: failed ? [{
      location,
      sort_order: sortOrder,
      error: "temporary failure"
    }] : []
  };
}

function mergeAttempts(...attempts) {
  return mergePayloads(attempts.map((attempt, index) => ({
    file: `attempt-${index + 1}.json`,
    payload: { scenarios: [attempt] }
  })), {
    expectedScenarioCount: 1,
    expectedCheckCount: 1,
    startedAt: "2026-09-10T06:00:00.000Z",
    generatedAt: "2026-09-10T06:05:00.000Z"
  });
}

function alertFor(payload) {
  return buildMmAvailabilityAlert(payload, {
    expectedStartDates: [startDate],
    expectedDurations: [2]
  });
}

const confirmedMissingAlert = [
  "ALERT MM Cars Rental",
  "",
  "Brak MM - pełne dane:",
  startDate
].join("\n");

const incompleteAlert = [
  "ALERT MM Cars Rental",
  "",
  "Nie można potwierdzić - niepełne dane:",
  startDate
].join("\n");

test("new incomplete success replaces old complete MM result and coverage together", () => {
  const payload = mergeAttempts(
    scenario({ provider: "MM Cars Rental", price: 200, mmCoverageComplete: true }),
    scenario({ provider: "INTER FLEET", price: 220, mmCoverageComplete: false })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["INTER FLEET"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, false);
  assert.equal(alertFor(payload), incompleteAlert);
});

test("new complete success replaces old incomplete result and confirms MM absence", () => {
  const payload = mergeAttempts(
    scenario({ provider: "INTER FLEET", price: 200, mmCoverageComplete: false }),
    scenario({ provider: "Kaizen Rent", price: 220, mmCoverageComplete: true })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["Kaizen Rent"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, true);
  assert.equal(alertFor(payload), confirmedMissingAlert);
});

test("new complete success with MM fully recovers from an incomplete absence", () => {
  const payload = mergeAttempts(
    scenario({ provider: "INTER FLEET", price: 200, mmCoverageComplete: false }),
    scenario({ provider: "MM Cars Rental", price: 220, mmCoverageComplete: true })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["MM Cars Rental"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, true);
  assert.equal(alertFor(payload), "");
});

test("failed retry preserves the previous successful result and its coverage", () => {
  const payload = mergeAttempts(
    scenario({ provider: "INTER FLEET", price: 200, mmCoverageComplete: false }),
    scenario({ mmCoverageComplete: true, failed: true })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["INTER FLEET"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, false);
  assert.deepEqual(merged.errors, []);
  assert.equal(alertFor(payload), incompleteAlert);
});

test("unknown coverage remains unknown when its successful attempt is accepted", () => {
  const payload = mergeAttempts(
    scenario({ provider: "MM Cars Rental", price: 200, mmCoverageComplete: true }),
    scenario({ provider: "INTER FLEET", price: 220 })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["INTER FLEET"]);
  assert.equal(Object.hasOwn(merged.expected_targets[0], "mm_coverage_complete"), false);
  assert.equal(alertFor(payload), confirmedMissingAlert);
});
