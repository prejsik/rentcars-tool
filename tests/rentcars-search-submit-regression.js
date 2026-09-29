const test = require("node:test");
const assert = require("node:assert/strict");
const { RentCarsScraper } = require("../src/rentcars/scraper");

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
