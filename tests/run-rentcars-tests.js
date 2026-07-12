const assert = require("node:assert/strict");
const fs = require("node:fs");

const { loadConfig } = require("../src/rentcars/config");
const { parseMoney, toCsv } = require("../src/rentcars/utils");
const {
  RentCarsScraper,
  filterOffersByTransmissionPreference,
  findRentCarsLocationMatches,
  selectBestOffersForTransmissionViews,
  shouldRetryLocationOutcome
} = require("../src/rentcars/scraper");
const { buildHtmlReport } = require("../src/rentcars/reportHtml");
const { buildWorkbook } = require("../src/rentcars/reportXlsx");
const { buildRootPayload, buildScenarioPayload, progressLine } = require("../src/rentcars/run");
const { mergePayloads } = require("../src/rentcars/mergeResults");
const { defaultLocationCities, expectedAirportCount } = require("../src/rentcars/locations");

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

runTest("parseMoney handles Polish zloty prices", () => {
  assert.deepEqual(parseMoney("od 199,00 z\u0142 za dzie\u0144"), {
    value: 199,
    currency: "Z\u0141",
    raw: "od 199,00 z\u0142 za dzie\u0144"
  });
});

runTest("loadConfig uses RentCars defaults and output folders", () => {
  const config = loadConfig([
    "--locations=Warszawa",
    "--pickup-date",
    "2026-05-15",
    "--pickup-time",
    "10:00",
    "--dropoff-date",
    "2026-05-17",
    "--dropoff-time",
    "10:00"
  ]);

  assert.equal(config.baseUrl, "https://rentcars.pl");
  assert.deepEqual(config.locations, ["Warszawa"]);
  assert.deepEqual(config.sortOrders, ["price_insurance"]);
  assert.equal(config.transmission, "any");
  assert.equal(config.maxAdditionalResultPages, 1);
  assert.match(config.outputCsv, /rentcars-results-/);
  assert.match(config.artifactsDir, /artifacts[\\/]rentcars$/);
});

runTest("shared location catalog is the default and includes nine airport checks", () => {
  const config = loadConfig(["--config=rentcars.config.example.json"]);

  assert.deepEqual(config.locations, defaultLocationCities());
  assert.equal(expectedAirportCount(config.locations), 9);
});

runTest("loadConfig supports one rolling start date and duration 2", () => {
  const config = loadConfig([
    "--location",
    "Warszawa",
    "--pickup-date",
    "2026-05-15",
    "--pickup-time",
    "10:00",
    "--dropoff-date",
    "2026-05-17",
    "--dropoff-time",
    "10:00",
    "--rolling-days=1",
    "--durations-days=2"
  ]);

  assert.equal(config.rollingDays, 1);
  assert.deepEqual(config.durationDays, [2]);
  assert.equal(config.pickupDateOptions.length, 1);
  assert.match(config.pickupDateOptions[0], /^\d{4}-\d{2}-\d{2}$/);
});

runTest("CLI locations override config locations for quick local smoke tests", () => {
  const config = loadConfig([
    "--config=rentcars.config.example.json",
    "--locations=Warszawa"
  ]);

  assert.deepEqual(config.locations, ["Warszawa"]);
});

runTest("CLI start dates override rolling dates for manual local runs", () => {
  const config = loadConfig([
    "--config=rentcars.config.example.json",
    "--locations=Warszawa",
    "--start-dates=2026-06-10,2026-06-12",
    "--durations-days=2,4"
  ]);

  assert.deepEqual(config.pickupDateOptions, ["2026-06-10", "2026-06-12"]);
  assert.deepEqual(config.durationDays, [2, 4]);
});

runTest("CLI durations override config durations for manual local runs", () => {
  const config = loadConfig([
    "--config=rentcars.config.example.json",
    "--locations=Warszawa",
    "--start-dates=2026-06-10",
    "--durations-days=5"
  ]);

  assert.deepEqual(config.durationDays, [5]);
});

runTest("CLI rolling days override config rolling days", () => {
  const config = loadConfig([
    "--config=rentcars.config.example.json",
    "--locations=Warszawa",
    "--rolling-days=1",
    "--durations-days=2"
  ]);

  assert.equal(config.rollingDays, 1);
  assert.equal(config.pickupDateOptions.length, 1);
});

runTest("CLI max additional result pages overrides config", () => {
  const config = loadConfig([
    "--config=rentcars.config.example.json",
    "--locations=Warszawa",
    "--max-additional-result-pages=2"
  ]);

  assert.equal(config.maxAdditionalResultPages, 2);
});

runTest("CLI transmission accepts the all-cars mode", () => {
  const config = loadConfig([
    "--config=rentcars.config.example.json",
    "--locations=Warszawa",
    "--transmission=any"
  ]);

  assert.equal(config.transmission, "any");
});

runTest("toCsv writes RentCars pickup and sort metadata", () => {
  const csv = toCsv([
    {
      requestedLocation: "Warszawa",
      location: "Warszawa, Centrum",
      pickupLocationId: "16",
      sortOrder: "price",
      priceMode: "base",
      durationDays: 2,
      provider: "TM Flota",
      providerRating: 5,
      totalPrice: 199,
      currency: "PLN",
      source: "dom"
    }
  ]);

  assert.match(csv, /^requested_location,location,pickup_location_id,sort_order,price_mode,duration_days,pickup_date,dropoff_date,provider,provider_rating,daily_price,currency,source/);
  assert.match(csv, /Warszawa,"Warszawa, Centrum",16,price,base,2,,,TM Flota,5,99\.50,PLN,dom/);
});

runTest("scraper module exports RentCarsScraper", () => {
  assert.equal(typeof RentCarsScraper, "function");
});

runTest("automatic transmission filtering drops known manual offers", () => {
  const offers = filterOffersByTransmissionPreference([
    { provider: "A", totalPrice: 100, transmission: "manual" },
    { provider: "B", totalPrice: 110, transmission: "automatic" },
    { provider: "C", totalPrice: 120, transmission: "" }
  ], "automatic");

  assert.deepEqual(offers.map((offer) => offer.provider), ["B"]);
});

runTest("automatic transmission filtering keeps unknown offers when no automatic metadata exists", () => {
  const offers = filterOffersByTransmissionPreference([
    { provider: "A", totalPrice: 100, transmission: "manual" },
    { provider: "B", totalPrice: 110, transmission: "" },
    { provider: "C", totalPrice: 120 }
  ], "automatic");

  assert.deepEqual(offers.map((offer) => offer.provider), ["B", "C"]);
});

runTest("all-cars collection preserves a provider's cheapest offer per transmission", () => {
  const offers = selectBestOffersForTransmissionViews([
    { provider: "A", totalPrice: 100, transmission: "manual", priceVerified: true },
    { provider: "A", totalPrice: 120, transmission: "automatic", priceVerified: true },
    { provider: "B", totalPrice: 110, transmission: "automatic", priceVerified: true }
  ], {
    location: "Warszawa, Lotnisko-Okecie",
    sortOrder: "price_insurance",
    priceMode: "insurance"
  }, 25, []);

  assert.deepEqual(
    offers.map((offer) => [offer.provider, offer.totalPrice, offer.transmission]),
    [
      ["A", 100, "manual"],
      ["B", 110, "automatic"],
      ["A", 120, "automatic"]
    ]
  );
});

runTest("all-cars collection keeps automatic leaders outside the all-cars provider limit", () => {
  const offers = selectBestOffersForTransmissionViews([
    { provider: "Manual Leader", totalPrice: 100, transmission: "manual", priceVerified: true },
    { provider: "Automatic Leader", totalPrice: 110, transmission: "automatic", priceVerified: true }
  ], {
    location: "Warszawa, Lotnisko-Okecie",
    sortOrder: "price_insurance",
    priceMode: "insurance"
  }, 1, []);

  assert.deepEqual(
    offers.map((offer) => offer.provider),
    ["Manual Leader", "Automatic Leader"]
  );
});

runTest("transient RentCars form failures are eligible for retry", () => {
  assert.equal(shouldRetryLocationOutcome({ error: new Error("Could not find the RentCars.pl search button.") }), true);
  assert.equal(shouldRetryLocationOutcome({ error: new Error("Could not select pick-up location from autocomplete.") }), true);
  assert.equal(shouldRetryLocationOutcome({ error: new Error("Unsupported configuration value.") }), false);
});

runTest("insurance mode rejects an ambiguous network total and accepts an explicit protected price", () => {
  const scraper = new RentCarsScraper({ transmission: "automatic" });
  const target = {
    requestedLocation: "Warszawa",
    location: "Warszawa, Lotnisko-Okęcie",
    value: "1",
    sortOrder: "price_insurance",
    priceMode: "insurance"
  };

  assert.equal(scraper.normalizeOfferCandidate({ providerName: "Provider A", totalPrice: 150 }, target, "network"), null);
  const verified = scraper.normalizeOfferCandidate({
    providerName: "Provider A",
    totalPrice: 150,
    protectedPrice: 219
  }, target, "network");
  assert.equal(verified.totalPrice, 219);
  assert.equal(verified.basePrice, 150);
  assert.equal(verified.protectedPrice, 219);
  assert.equal(verified.priceVerified, true);
});

runTest("city location expansion keeps only RentCars airport pickup points", () => {
  const options = [
    { value: "1", label: "Warszawa, Centrum" },
    { value: "2", label: "Warszawa, Lotnisko-Modlin" },
    { value: "3", label: "Warszawa, Lotnisko-Ok\u0119cie" },
    { value: "4", label: "Krak\u00f3w, Centrum" },
    { value: "5", label: "Krak\u00f3w, Lotnisko-Balice" },
    { value: "6", label: "Bydgoszcz, Centrum" },
    { value: "7", label: "Bydgoszcz, Lotnisko-Szwederowo" },
    { value: "8", label: "\u0141\u00f3d\u017a, Centrum" },
    { value: "9", label: "\u0141\u00f3d\u017a, Lotnisko-Lublinek" }
  ];

  assert.deepEqual(
    findRentCarsLocationMatches("Warszawa", options).map((option) => option.label),
    ["Warszawa, Lotnisko-Modlin", "Warszawa, Lotnisko-Ok\u0119cie"]
  );
  assert.deepEqual(
    findRentCarsLocationMatches("Krakow", options).map((option) => option.label),
    ["Krak\u00f3w, Lotnisko-Balice"]
  );
  assert.deepEqual(
    findRentCarsLocationMatches("Bydgoszcz", options).map((option) => option.label),
    ["Bydgoszcz, Lotnisko-Szwederowo"]
  );
  assert.deepEqual(
    findRentCarsLocationMatches("Lodz", options).map((option) => option.label),
    ["\u0141\u00f3d\u017a, Lotnisko-Lublinek"]
  );
  assert.deepEqual(
    findRentCarsLocationMatches("Warszawa, Centrum", options).map((option) => option.label),
    ["Warszawa, Centrum"]
  );
});

runTest("buildHtmlReport renders RentCars title and top offer columns", () => {
  const html = buildHtmlReport({
    generated_at: "2026-05-04T16:00:00.000Z",
    execution_started_at: "2026-05-04T15:59:00.000Z",
    execution_duration_ms: 61000,
    time_zone: "Europe/Warsaw",
    source_url: "https://rentcars.pl",
    locations: ["Warszawa"],
    scenarios: [
      {
        scenario_id: "2026-05-15-2",
        start_day_label: "2026-05-15",
        pickup_date: "2026-05-15T10:00:00",
        dropoff_date: "2026-05-17T10:00:00",
        rental_days: 2,
        sort_orders: [
          { order: "suggested", label: "sugerowane" },
          { order: "price", label: "po cenie" }
        ],
        top_3_by_location: {
          "Warszawa, Centrum": {
            suggested: [
              {
                requested_location: "Warszawa",
                location: "Warszawa, Centrum",
                pickup_location: "Warszawa, Centrum",
                provider_name: "TM Flota",
                provider_rating: 5,
                total_price: 199,
                currency: "PLN",
                rental_days: 2
              },
              {
                requested_location: "Warszawa",
                location: "Warszawa, Centrum",
                pickup_location: "Warszawa, Centrum",
                provider_name: "MM Cars Rental",
                provider_rating: 4.5,
                total_price: 215,
                currency: "PLN",
                rental_days: 2
              }
            ],
            price: []
          }
        }
      }
    ]
  });

  assert.match(html, /RentCars\.pl report/);
  assert.match(html, /Top 1 firma/);
  assert.match(html, /Top 1 PLN\/d/);
  assert.match(html, /TM Flota \(5\)/);
  assert.match(html, /99\.50 PLN\/day/);
  assert.match(html, /Warszawa, Centrum/);
  assert.match(html, /MM Cars Rental \(4\.5\)/);
  assert.match(html, /offer-view-(?:automatic|all) mm/);
  assert.match(html, /\.mm-close \{\s+background: var\(--red-bg\);/);
  assert.match(html, /\.mm-top1-gap \{\s+background: var\(--blue-bg\);/);
  assert.match(html, /Top1: \+10 PLN\/d/);
  assert.match(html, /Top1: \+20 PLN\/d/);
  assert.match(html, /Top1: \+30 PLN\/d/);
  assert.match(html, /Execution duration: 1m 1s \(61000 ms\)/);
  assert.doesNotMatch(html, /Toyota Aygo/);
});

runTest("buildHtmlReport switches between all cars and automatics and opens with all cars", () => {
  const html = buildHtmlReport({
    locations: ["Warszawa"],
    scenarios: [{
      scenario_id: "2026-07-12-2",
      start_day_label: "2026-07-12",
      pickup_date: "2026-07-12T10:00:00",
      dropoff_date: "2026-07-14T10:00:00",
      rental_days: 2,
      expected_locations: ["Warszawa, Lotnisko-Okecie"],
      sort_orders: [{ order: "price_insurance", label: "po cenie z ubezpieczeniem" }],
      results: [
        { pickup_location: "Warszawa, Lotnisko-Okecie", sort_order: "price_insurance", provider_name: "Manual One", total_price: 180, currency: "PLN", rental_days: 2, transmission: "manual" },
        { pickup_location: "Warszawa, Lotnisko-Okecie", sort_order: "price_insurance", provider_name: "Automatic One", total_price: 200, currency: "PLN", rental_days: 2, transmission: "automatic" },
        { pickup_location: "Warszawa, Lotnisko-Okecie", sort_order: "price_insurance", provider_name: "MM Cars Rental", total_price: 220, currency: "PLN", rental_days: 2, transmission: "automatic" }
      ]
    }]
  });

  assert.match(html, /<body data-offer-view="all">/);
  assert.match(html, /id="filter-transmission"/);
  assert.match(html, /id="filter-location-type"/);
  assert.match(html, /id="filter-date"/);
  assert.match(html, /id="filter-location"/);
  assert.match(html, /id="filter-duration"/);
  assert.match(html, /id="filter-state"/);
  assert.match(html, /id="filter-top1"/);
  assert.match(html, /<details class="multi-filter" id="filter-location"/);
  assert.match(html, /<details class="multi-filter" id="filter-duration"/);
  assert.match(html, /<details class="multi-filter" id="filter-state"/);
  assert.match(html, /<details class="multi-filter" id="filter-top1"/);
  assert.match(html, /input type="checkbox" value="2"/);
  assert.match(html, /selectedValues\(control\)/);
  assert.match(html, /<option value="all">Wszystkie auta<\/option>\s*<option value="automatic">Tylko automaty<\/option>/);
  assert.match(html, /offer-view-all">Manual One<\/span>/);
  assert.match(html, /offer-view-automatic">Automatic One<\/span>/);
  assert.doesNotMatch(html, /offer-view-automatic">Manual One<\/span>/);
  assert.match(html, /offer-view-automatic rank-cell">Top 2<\/span>/);
  assert.match(html, /offer-view-all rank-cell">Top 3<\/span>/);
  assert.match(html, /data-date="2026-07-12" data-duration="2"/);
  assert.match(html, /data-mm-state-automatic="close" data-mm-state-all="close"/);
});

runTest("buildHtmlReport marks MM Cars Rental top1 when top2 is more than 10 PLN per day higher", () => {
  const html = buildHtmlReport({
    generated_at: "2026-05-04T16:00:00.000Z",
    locations: ["Warszawa"],
    scenarios: [
      {
        scenario_id: "2026-05-15-2",
        start_day_label: "2026-05-15",
        pickup_date: "2026-05-15T10:00:00",
        dropoff_date: "2026-05-17T10:00:00",
        rental_days: 2,
        sort_orders: [{ order: "price", label: "po cenie" }],
        top_3_by_location: {
          "Warszawa, Lotnisko-Okecie": {
            price: [
              {
                provider_name: "MM Cars Rental",
                provider_rating: 4.5,
                total_price: 198,
                currency: "PLN",
                rental_days: 2
              },
              {
                provider_name: "TOPCARS",
                provider_rating: 4.3,
                total_price: 218.01,
                currency: "PLN",
                rental_days: 2
              }
            ]
          }
        }
      }
    ]
  });

  assert.match(html, /offer-view-all mm mm-top1-gap">MM Cars Rental \(4\.5\)/);
  assert.match(html, /offer-view-all mm mm-top1-gap">99\.00 PLN\/day/);
});

runTest("buildHtmlReport does not mark MM Cars Rental top1 at exactly 10 PLN per day ahead", () => {
  const html = buildHtmlReport({
    generated_at: "2026-05-04T16:00:00.000Z",
    locations: ["Warszawa"],
    scenarios: [
      {
        scenario_id: "2026-05-15-2",
        start_day_label: "2026-05-15",
        pickup_date: "2026-05-15T10:00:00",
        dropoff_date: "2026-05-17T10:00:00",
        rental_days: 2,
        sort_orders: [{ order: "price", label: "po cenie" }],
        top_3_by_location: {
          "Warszawa, Lotnisko-Okecie": {
            price: [
              {
                provider_name: "MM Cars Rental",
                provider_rating: 4.5,
                total_price: 198,
                currency: "PLN",
                rental_days: 2
              },
              {
                provider_name: "TOPCARS",
                provider_rating: 4.3,
                total_price: 218,
                currency: "PLN",
                rental_days: 2
              }
            ]
          }
        }
      }
    ]
  });

  assert.doesNotMatch(html, /offer-view-(?:automatic|all) mm mm-top1-gap/);
});

runTest("buildHtmlReport uses the DiscoverCars 30 PLN top1 tier", () => {
  const html = buildHtmlReport({
    locations: ["Warszawa"],
    scenarios: [{
      start_day_label: "2026-07-12",
      pickup_date: "2026-07-12T10:00:00",
      dropoff_date: "2026-07-14T10:00:00",
      rental_days: 2,
      sort_orders: [{ order: "price_insurance" }],
      top_3_by_location: {
        "Warszawa, Lotnisko-Okecie": {
          price_insurance: [
            { provider_name: "MM Cars Rental", total_price: 198, currency: "PLN", rental_days: 2 },
            { provider_name: "TOPCARS", total_price: 260, currency: "PLN", rental_days: 2 }
          ]
        }
      }
    }]
  });

  assert.match(html, /data-mm-state-all="top1-gap-30"/);
  assert.match(html, /offer-view-all mm mm-top1-gap-30/);
});

runTest("buildRootPayload and HTML report mark partial scheduled snapshots", () => {
  const payload = buildRootPayload({
    config: {
      baseUrl: "https://rentcars.pl",
      locations: ["Warszawa"],
      sortOrders: ["price_insurance"]
    },
    scenarios: [],
    startedAt: "2026-05-13T01:00:00.000Z",
    durationMs: 1000,
    expectedScenarioCount: 270
  });
  const html = buildHtmlReport(payload);

  assert.equal(payload.is_partial, true);
  assert.equal(payload.expected_scenario_count, 270);
  assert.match(html, /Partial report: 0 \/ 270 scenarios/);
});

runTest("completed scenarios with failed airport checks are reported as complete with errors", () => {
  const config = {
    baseUrl: "https://rentcars.pl",
    locations: ["Warszawa"],
    sortOrders: ["price_insurance"]
  };
  const scenarioConfig = {
    ...config,
    pickupDate: "2026-07-10",
    pickupTime: "10:00",
    dropoffDate: "2026-07-12",
    dropoffTime: "10:00"
  };
  const expectedTargets = [
    {
      requestedLocation: "Warszawa",
      location: "Warszawa, Lotnisko-Modlin",
      pickupLocationId: "47",
      sortOrder: "price_insurance",
      sortLabel: "po cenie z ubezpieczeniem",
      priceMode: "insurance"
    },
    {
      requestedLocation: "Warszawa",
      location: "Warszawa, Lotnisko-Okęcie",
      pickupLocationId: "1",
      sortOrder: "price_insurance",
      sortLabel: "po cenie z ubezpieczeniem",
      priceMode: "insurance"
    }
  ];
  const scenario = buildScenarioPayload({
    config,
    scenarioConfig,
    durationDays: 2,
    expectedTargets,
    results: [{
      requestedLocation: "Warszawa",
      pickupLocation: "Warszawa, Lotnisko-Okęcie",
      pickupLocationId: "1",
      sortOrder: "price_insurance",
      sortLabel: "po cenie z ubezpieczeniem",
      priceMode: "insurance",
      provider: "MM Cars Rental",
      totalPrice: 219,
      basePrice: 150,
      protectedPrice: 219,
      priceVerified: true,
      currency: "PLN",
      source: "dom"
    }],
    failures: [{
      requestedLocation: "Warszawa",
      location: "Warszawa, Lotnisko-Modlin",
      sortOrder: "price_insurance",
      sortLabel: "po cenie z ubezpieczeniem",
      attemptCount: 3,
      error: "Could not find the RentCars.pl search button."
    }]
  });
  const payload = buildRootPayload({
    config,
    scenarios: [scenario],
    startedAt: "2026-07-09T01:00:00.000Z",
    durationMs: 1000,
    expectedScenarioCount: 1,
    expectedCheckCount: 2
  });
  const html = buildHtmlReport(payload);

  assert.equal(payload.run_status, "complete_with_errors");
  assert.equal(payload.is_partial, false);
  assert.equal(payload.successful_check_count, 1);
  assert.equal(payload.failed_check_count, 1);
  assert.equal(scenario.results[0].insurance_surcharge, 69);
  assert.match(html, /Complete with errors/);
  assert.match(html, /Warszawa, Lotnisko-Modlin/);
  assert.match(html, /Error after 3 attempt\(s\): Could not find the RentCars\.pl search button/);
});

runTest("progress output includes percentage, elapsed time, and ETA", () => {
  assert.equal(progressLine(2, 10, 60000), "PROGRESS 2/10 (20%) | elapsed 1m 0s | ETA 4m 0s");
});

runTest("push smoke cannot deploy Pages or notify Telegram", () => {
  const daily = fs.readFileSync(".github/workflows/rentcars-daily.yml", "utf8");
  const smoke = fs.readFileSync(".github/workflows/rentcars-smoke.yml", "utf8");

  assert.doesNotMatch(daily, /^  push:/m);
  assert.match(smoke, /^  push:/m);
  assert.doesNotMatch(smoke, /deploy-pages|Notify Telegram|github-pages/i);
});

runTest("daily Telegram message preserves blank lines between links", () => {
  const daily = fs.readFileSync(".github/workflows/rentcars-daily.yml", "utf8");

  assert.match(daily, /printf -v message 'RentCars\.pl: run finished/);
  assert.match(daily, /printf -v section 'Current HTML report:\\n%sreport\.html\\n\\n'/);
  assert.match(daily, /printf -v section 'Artifact backup:\\n%s\\n\\n'/);
  assert.doesNotMatch(daily, /message\+=\$\(printf/);
});

runTest("daily merge installs dependencies before generating the Excel summary", () => {
  const daily = fs.readFileSync(".github/workflows/rentcars-daily.yml", "utf8");
  const mergeJob = daily.slice(daily.indexOf("  merge:"));
  const installIndex = mergeJob.indexOf("run: npm ci");
  const workbookIndex = mergeJob.indexOf("Generate RentCars.pl Excel summary");

  assert.ok(installIndex >= 0);
  assert.ok(workbookIndex > installIndex);
});

runTest("Excel summary contains all pricing and data-quality sheets", () => {
  const workbook = buildWorkbook({
    generated_at: "2026-07-09T12:00:00.000Z",
    source_url: "https://rentcars.pl",
    run_status: "complete",
    completed_scenario_count: 1,
    expected_scenario_count: 1,
    expected_check_count: 1,
    successful_check_count: 1,
    failed_check_count: 0,
    missing_check_count: 0,
    sort_orders: ["price_insurance"],
    scenarios: [{
      start_date: "2026-07-10",
      rental_days: 2,
      expected_locations: ["Warszawa, Lotnisko-Okęcie"],
      sort_orders: [{ order: "price_insurance" }],
      errors: [],
      results: [
        {
          pickup_location: "Warszawa, Lotnisko-Okęcie",
          sort_order: "price_insurance",
          provider_name: "MM Cars Rental",
          total_price: 200,
          daily_price: 100,
          rental_days: 2,
          currency: "PLN"
        },
        {
          pickup_location: "Warszawa, Lotnisko-Okęcie",
          sort_order: "price_insurance",
          provider_name: "Provider B",
          total_price: 230,
          daily_price: 115,
          rental_days: 2,
          currency: "PLN"
        }
      ]
    }]
  });

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    "Overview",
    "Recommendations",
    "By airport",
    "By duration",
    "Opportunities",
    "Top1 competitors",
    "Details",
    "Data quality"
  ]);
  assert.ok(workbook.getWorksheet("Details").rowCount >= 5);
  assert.equal(workbook.getWorksheet("Overview").getCell("B5").value, "complete");
});

runTest("mergePayloads combines matrix chunks into one sorted root report", () => {
  const payload = mergePayloads([
    {
      file: "rentcars-results-2026-06-02.json",
      payload: {
        generated_at: "2026-05-14T03:02:00.000Z",
        source_url: "https://rentcars.pl",
        time_zone: "Europe/Warsaw",
        locations: ["Warszawa"],
        sort_orders: ["price_insurance"],
        expected_scenario_count: 1,
        scenarios: [
          {
            scenario_id: "2026-06-02-3",
            start_date: "2026-06-02",
            rental_days: 3,
            results: [{ total_price: 300, pickup_location: "Warszawa, Lotnisko-Okecie", sort_order: "price_insurance" }],
            top_3_by_location: { "Warszawa, Lotnisko-Okecie": { price_insurance: [] } },
            errors: []
          }
        ]
      }
    },
    {
      file: "rentcars-results-2026-06-01.json",
      payload: {
        generated_at: "2026-05-14T03:01:00.000Z",
        expected_scenario_count: 1,
        scenarios: [
          {
            scenario_id: "2026-06-01-2",
            start_date: "2026-06-01",
            rental_days: 2,
            results: [],
            top_3_by_location: {},
            errors: []
          },
          {
            scenario_id: "2026-06-01-2",
            start_date: "2026-06-01",
            rental_days: 2,
            results: [{ total_price: 200, pickup_location: "Warszawa, Lotnisko-Modlin", sort_order: "price_insurance" }],
            top_3_by_location: { "Warszawa, Lotnisko-Modlin": { price_insurance: [] } },
            errors: []
          }
        ]
      }
    }
  ], {
    expectedScenarioCount: 2,
    expectedCheckCount: 2,
    startedAt: "2026-05-14T03:00:00.000Z",
    generatedAt: "2026-05-14T03:01:30.000Z",
    locations: ["Warszawa"],
    sortOrders: ["price_insurance"],
    baseUrl: "https://rentcars.pl"
  });

  assert.equal(payload.scenario_count, 2);
  assert.equal(payload.completed_scenario_count, 2);
  assert.equal(payload.expected_scenario_count, 2);
  assert.equal(payload.expected_check_count, 2);
  assert.equal(payload.successful_check_count, 2);
  assert.equal(payload.failed_check_count, 0);
  assert.equal(payload.run_status, "complete");
  assert.equal(payload.is_partial, false);
  assert.equal(payload.execution_duration_ms, 90000);
  assert.deepEqual(payload.scenarios.map((scenario) => scenario.scenario_id), ["2026-06-01-2", "2026-06-02-3"]);
  assert.equal(payload.scenarios[0].results.length, 1);
});

if (!process.exitCode) {
  console.log("All RentCars tests passed.");
}
