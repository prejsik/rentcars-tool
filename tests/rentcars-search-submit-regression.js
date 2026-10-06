const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { RentCarsScraper, shouldRetryLocationOutcome } = require("../src/rentcars/scraper");

function searchPage(t, { buttonAfter = 0, resultAfter = 0, clickError = null, validation = false } = {}) {
  let polls = 0;
  let clicks = 0;
  let clickedAt = null;
  const hidden = { first() { return this; }, filter() { return this; }, isVisible: async () => false };
  const button = {
    first() { return this; },
    isVisible: async () => clicks === 0 && polls >= buttonAfter,
    click: async () => { clicks++; if (clickError) throw clickError; clickedAt = polls; }
  };
  const scraper = new RentCarsScraper({ timeoutMs: 60 });
  scraper.acceptCookies = async () => {};
  scraper.dismissObstructiveOverlays = async () => {};
  scraper.looksLikeSearchPage = async () => clickedAt != null && polls - clickedAt >= resultAfter;
  scraper.hasPickupLocationValidationError = async () => validation && clicks > 0;
  const page = {
    locator: selector => selector === "#elementsubmit" ? button : hidden,
    getByRole: () => hidden,
    waitForLoadState: async () => {},
    waitForTimeout: async () => { polls++; t.mock.timers.tick(10); }
  };
  return { scraper, page, clicks: () => clicks };
}

test("search waits for a delayed button instead of treating it as absent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const fixture = searchPage(t, { buttonAfter: 2 });
  await fixture.scraper.submitSearch(fixture.page);
  assert.equal(fixture.clicks(), 1);
});

test("search waits for delayed results after one click", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const fixture = searchPage(t, { resultAfter: 3 });
  await fixture.scraper.submitSearch(fixture.page);
  assert.equal(fixture.clicks(), 1);
});

test("search preserves click errors rather than misreporting a missing button", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const error = new Error("Click timed out: element detached");
  const fixture = searchPage(t, { clickError: error });
  await assert.rejects(fixture.scraper.submitSearch(fixture.page), error);
  assert.equal(fixture.clicks(), 1);
});

test("search distinguishes an unresponsive submission from a missing button", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const fixture = searchPage(t, { resultAfter: Infinity });
  await assert.rejects(fixture.scraper.submitSearch(fixture.page), /Search submission timed out/);
  assert.equal(fixture.clicks(), 1);
});

test("search still rejects invalid pickup and actually missing controls", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const invalid = searchPage(t, { validation: true, resultAfter: Infinity });
  await assert.rejects(invalid.scraper.submitSearch(invalid.page), /Pick-up location was not accepted/);
  const missing = searchPage(t, { buttonAfter: Infinity });
  await assert.rejects(missing.scraper.submitSearch(missing.page), /Could not find the RentCars.pl search button/);
  assert.equal(missing.clicks(), 0);
});

test("Playwright navigation Timeout from failed daily runs is eligible for a local retry", () => {
  for (const message of [
    "page.goto: Timeout 30000ms exceeded.",
    "locator.click: Timeout 30000ms exceeded.",
    "Search submission timed out waiting for RentCars.pl results."
  ]) {
    assert.equal(shouldRetryLocationOutcome({ error: new Error(message) }), true, message);
  }
  assert.equal(shouldRetryLocationOutcome({ error: new Error("Unsupported configuration value.") }), false);
});

test("a navigation timeout retries only the failed airport within the same scenario", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-timeout-retry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(chromium, "launch", async () => ({ close: async () => {} }));
  t.mock.method(console, "log", () => {});
  const scraper = new RentCarsScraper({ artifactsDir: directory, locationConcurrency: 2,
    sortOrders: ["price_insurance"] });
  scraper.resolveLocationSearchTargets = async () => [
    { requestedLocation: "Krakow", location: "Krakow airport", value: "1" },
    { requestedLocation: "Katowice", location: "Katowice airport", value: "2" }
  ];
  const calls = { Krakow: 0, Katowice: 0 };
  scraper.runSingleLocation = async (_browser, target) => {
    calls[target.requestedLocation]++;
    if (target.requestedLocation === "Krakow" && calls.Krakow === 1) {
      return { ok: false, error: new Error("page.goto: Timeout 30000ms exceeded.") };
    }
    const offer = { provider: "Test provider", totalPrice: 100, currency: "PLN" };
    return { ok: true, results: [offer], cheapest: offer, mmCoverageComplete: true };
  };
  const result = await scraper.run();
  assert.deepEqual(calls, { Krakow: 2, Katowice: 1 });
  assert.equal(result.successfulCheckCount, 2);
  assert.deepEqual(result.failures, []);
  assert.ok(result.expectedTargets.every((target) => target.mmCoverageComplete));
});
