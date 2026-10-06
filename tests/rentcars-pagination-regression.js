const test = require("node:test");
const assert = require("node:assert/strict");

const { RentCarsScraper } = require("../src/rentcars/scraper");
const { loadConfig } = require("../src/rentcars/config");
const path = require("node:path");

function offer(provider, transmission) {
  return {
    provider,
    totalPrice: 200,
    priceVerified: true,
    transmission
  };
}

function resultPage(initialResults = ["initial result"]) {
  let results = [...initialResults];
  return {
    url: () => "https://rentcars.pl/search/test",
    waitForLoadState: async () => {},
    locator: () => ({
      evaluateAll: async () => [...results]
    }),
    getResults: () => [...results],
    setResults: (nextResults) => {
      results = [...nextResults];
    }
  };
}

const target = {
  location: "Warszawa",
  sortOrder: "price_insurance",
  priceMode: "insurance"
};

test("default search reads past repeated MM cars until three automatic providers are found", async () => {
  const scraper = new RentCarsScraper(loadConfig([
    "--config", path.join(__dirname, "../rentcars.config.example.json")
  ]));
  const page = resultPage();
  const pages = [
    offer("MM Cars Rental", "manual"),
    offer("MM Cars Rental", "automatic"),
    offer("INTER FLEET", "automatic"),
    offer("INTER FLEET", "manual"),
    offer("GB Rent Warszawa", "automatic")
  ];
  let clicks = 0;
  scraper.findLoadMoreControl = async () => ({ locator: { click: async () => {
    page.setResults([`page ${++clicks}`]);
  } }, href: "" });
  scraper.waitForResults = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [pages[clicks - 1]];
  const offers = [offer("MM Cars Rental", "automatic")];
  const coverage = await scraper.loadAdditionalResultPages(page, target, { getOffers: () => [] }, offers);
  assert.equal(clicks, 5);
  assert.deepEqual([...new Set(offers.map(row => row.provider))], ["MM Cars Rental", "INTER FLEET", "GB Rent Warszawa"]);
  assert.deepEqual(coverage, { mmCoverageComplete: true, rankingCoverageComplete: true });
});

test("a reached page limit preserves observed MM but marks unfinished competitor coverage", async () => {
  const scraper = new RentCarsScraper({ transmission: "any", maxAdditionalResultPages: 1, timeoutMs: 1000 });
  const page = resultPage();
  let clicks = 0;
  scraper.findLoadMoreControl = async () => ({ locator: { click: async () => {
    page.setResults([`page ${++clicks}`]);
  } }, href: "" });
  scraper.waitForResults = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [offer("MM Cars Rental", "manual")];
  const coverage = await scraper.loadAdditionalResultPages(page, target, { getOffers: () => [] },
    [offer("MM Cars Rental", "automatic")]);
  assert.equal(clicks, 1);
  assert.deepEqual(coverage, { mmCoverageComplete: true, rankingCoverageComplete: false });
});

test("exhausted results with fewer than three providers are complete", async () => {
  const scraper = new RentCarsScraper({ transmission: "any", maxAdditionalResultPages: 10 });
  scraper.findLoadMoreControl = async () => null;
  const coverage = await scraper.loadAdditionalResultPages(resultPage(), target, { getOffers: () => [] },
    [offer("MM Cars Rental", "automatic")]);
  assert.deepEqual(coverage, { mmCoverageComplete: true, rankingCoverageComplete: true });
});

test("an oversized pagination setting cannot cause an unbounded search for competitors", async () => {
  const scraper = new RentCarsScraper({ transmission: "any", maxAdditionalResultPages: 100, timeoutMs: 1000 });
  const page = resultPage();
  let clicks = 0;
  scraper.findLoadMoreControl = async () => ({ locator: { click: async () => {
    page.setResults([`page ${++clicks}`]);
  } }, href: "" });
  scraper.waitForResults = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [offer("MM Cars Rental", "automatic")];
  const coverage = await scraper.loadAdditionalResultPages(page, target, { getOffers: () => [] },
    [offer("MM Cars Rental", "automatic")]);
  assert.equal(clicks, 10);
  assert.deepEqual(coverage, { mmCoverageComplete: true, rankingCoverageComplete: false });
});

test("all-cars pagination separately fills automatic competitor and MM coverage", async () => {
  const scraper = new RentCarsScraper({
    transmission: "any",
    maxAdditionalResultPages: 1,
    timeoutMs: 1000
  });
  let clickCount = 0;
  const page = resultPage(["initial results"]);
  scraper.findLoadMoreControl = async () => ({
    locator: {
      click: async () => {
        clickCount += 1;
        page.setResults(["next results"]);
      }
    },
    href: ""
  });
  scraper.waitForResults = async () => {};
  scraper.waitForCollectorOffers = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [
    offer("Automatic C", "automatic"),
    offer("MM Cars Rental", "automatic")
  ];

  const accumulatedOffers = [
    offer("MM Cars Rental", "manual"),
    offer("Manual A", "manual"),
    offer("Automatic A", "automatic"),
    offer("Automatic B", "automatic")
  ];
  const complete = await scraper.loadAdditionalResultPages(
    page,
    target,
    { getOffers: () => [] },
    accumulatedOffers
  );

  assert.deepEqual(complete, { mmCoverageComplete: true, rankingCoverageComplete: true });
  assert.equal(clickCount, 1);
  assert.equal(accumulatedOffers.at(-2).provider, "Automatic C");
  assert.equal(accumulatedOffers.at(-1).provider, "MM Cars Rental");
});

test("all-cars MM coverage stays incomplete when only manual MM is known and more pages remain", async () => {
  const scraper = new RentCarsScraper({
    transmission: "any",
    maxAdditionalResultPages: 1,
    timeoutMs: 1000
  });
  let clickCount = 0;
  const page = resultPage(["initial results"]);
  const loadMoreControl = {
    locator: {
      click: async () => {
        clickCount += 1;
        page.setResults(["next results"]);
      }
    },
    href: ""
  };
  scraper.findLoadMoreControl = async () => loadMoreControl;
  scraper.waitForResults = async () => {};
  scraper.waitForCollectorOffers = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [];

  const complete = await scraper.loadAdditionalResultPages(
    page,
    target,
    { getOffers: () => [] },
    [
      offer("MM Cars Rental", "manual"),
      offer("Automatic A", "automatic"),
      offer("Automatic B", "automatic"),
      offer("Automatic C", "automatic")
    ]
  );

  assert.equal(clickCount, 1);
  assert.deepEqual(complete, { mmCoverageComplete: false, rankingCoverageComplete: true });
});

test("MM plus two other providers completes both all-cars views without another click", async () => {
  const scraper = new RentCarsScraper({
    transmission: "any",
    maxAdditionalResultPages: 1,
    timeoutMs: 1000
  });
  let loadMoreChecks = 0;
  scraper.findLoadMoreControl = async () => {
    loadMoreChecks += 1;
    return { locator: { click: async () => {} }, href: "" };
  };
  scraper.waitForResults = async () => {};
  scraper.waitForCollectorOffers = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [];

  const complete = await scraper.loadAdditionalResultPages(
    resultPage(),
    target,
    { getOffers: () => [] },
    [
      offer("MM Cars Rental", "automatic"),
      offer("Automatic A", "automatic"),
      offer("Automatic B", "automatic")
    ]
  );

  assert.deepEqual(complete, { mmCoverageComplete: true, rankingCoverageComplete: true });
  assert.equal(loadMoreChecks, 0);
});

test("pagination accepts a delayed DOM-only result replacement without collector growth", async () => {
  const scraper = new RentCarsScraper({
    transmission: "automatic",
    maxAdditionalResultPages: 1,
    timeoutMs: 1000,
    speedMode: "turbo"
  });
  const collector = scraper.createResponseCollector();
  collector.add([
    offer("MM Cars Rental", "automatic"),
    offer("Automatic A", "automatic")
  ]);
  scraper.collectorWaitTimeoutMs = () => 1200;

  const page = resultPage(["MM Cars Rental", "Automatic A"]);

  scraper.findLoadMoreControl = async () => ({
    locator: {
      click: async () => {
        setTimeout(() => page.setResults(["MM Cars Rental", "Automatic A", "Automatic B"]), 20);
      }
    },
    href: ""
  });
  scraper.waitForResults = async () => {};

  scraper.collectOffersFromCurrentPage = async () => {
    return page.getResults().includes("Automatic B")
      ? [offer("Automatic B", "automatic")]
      : [];
  };

  const accumulatedOffers = [];
  const startedAt = Date.now();
  const complete = await scraper.loadAdditionalResultPages(
    page,
    target,
    collector,
    accumulatedOffers
  );
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(complete, { mmCoverageComplete: true, rankingCoverageComplete: true });
  assert.equal(accumulatedOffers.at(-1).provider, "Automatic B");
  assert.ok(elapsedMs < 900, `DOM-only update waited ${elapsedMs} ms`);
});

test("a disappearing load-more control is not exhaustion without new result evidence", async () => {
  const scraper = new RentCarsScraper({
    transmission: "automatic",
    maxAdditionalResultPages: 1,
    timeoutMs: 1000,
    speedMode: "turbo"
  });
  scraper.collectorWaitTimeoutMs = () => 50;

  let loadMoreChecks = 0;
  scraper.findLoadMoreControl = async () => {
    loadMoreChecks += 1;
    return loadMoreChecks === 1
      ? { locator: { click: async () => {} }, href: "" }
      : null;
  };
  scraper.waitForResults = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [];

  const complete = await scraper.loadAdditionalResultPages(
    resultPage(["Automatic A", "Automatic B"]),
    target,
    { getOffers: () => [offer("Automatic A", "automatic"), offer("Automatic B", "automatic")] },
    []
  );

  assert.equal(loadMoreChecks, 1);
  assert.deepEqual(complete, { mmCoverageComplete: false, rankingCoverageComplete: false });
});

test("failed pre-click DOM inspection cannot turn unchanged cards into new result evidence", async () => {
  const scraper = new RentCarsScraper({ transmission: "automatic", maxAdditionalResultPages: 1, timeoutMs: 1000 });
  scraper.collectorWaitTimeoutMs = () => 30;
  let inspections = 0;
  const page = {
    url: () => "https://rentcars.pl/search/test",
    waitForLoadState: async () => {},
    locator: () => ({ evaluateAll: async () => {
      if (++inspections === 1) throw new Error("DOM unavailable");
      return ["unchanged cards"];
    } })
  };
  let clicked = false;
  scraper.findLoadMoreControl = async () => clicked ? null
    : { locator: { click: async () => { clicked = true; } }, href: "" };
  scraper.waitForResults = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [offer("Other", "automatic")];
  const complete = await scraper.loadAdditionalResultPages(page, target, { getOffers: () => [] }, []);
  assert.deepEqual(complete, { mmCoverageComplete: false, rankingCoverageComplete: false });
});

test("new collected offers are accepted without a DOM change", async () => {
  const scraper = new RentCarsScraper({ transmission: "automatic", maxAdditionalResultPages: 1, timeoutMs: 1000 });
  const collector = scraper.createResponseCollector();
  collector.add([offer("MM Cars Rental", "automatic"), offer("Other A", "automatic")]);
  scraper.findLoadMoreControl = async () => ({ locator: { click: async () => {
    setTimeout(() => collector.add([offer("Other B", "automatic")]), 20);
  } }, href: "" });
  scraper.waitForResults = async () => {};
  scraper.collectOffersFromCurrentPage = async () => [];
  const complete = await scraper.loadAdditionalResultPages(resultPage(), target, collector, []);
  assert.deepEqual(complete, { mmCoverageComplete: true, rankingCoverageComplete: true });
  assert.equal(collector.getOffers().length, 3);
});
