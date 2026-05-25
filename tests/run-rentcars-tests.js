const assert = require("node:assert/strict");

const { loadConfig } = require("../src/rentcars/config");
const { parseMoney, toCsv } = require("../src/rentcars/utils");
const { RentCarsScraper, findRentCarsLocationMatches } = require("../src/rentcars/scraper");
const { buildHtmlReport } = require("../src/rentcars/reportHtml");
const { buildRootPayload } = require("../src/rentcars/run");
const { mergePayloads } = require("../src/rentcars/mergeResults");

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
  assert.equal(config.maxAdditionalResultPages, 1);
  assert.match(config.outputCsv, /rentcars-results-/);
  assert.match(config.artifactsDir, /artifacts[\\/]rentcars$/);
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

runTest("city location expansion keeps only RentCars airport pickup points", () => {
  const options = [
    { value: "1", label: "Warszawa, Centrum" },
    { value: "2", label: "Warszawa, Lotnisko-Modlin" },
    { value: "3", label: "Warszawa, Lotnisko-Ok\u0119cie" },
    { value: "4", label: "Krak\u00f3w, Centrum" },
    { value: "5", label: "Krak\u00f3w, Lotnisko-Balice" }
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
  assert.match(html, /top1_offer/);
  assert.match(html, /top1_daily_price/);
  assert.match(html, /TM Flota \(5\)/);
  assert.match(html, /99\.50 PLN\/day/);
  assert.match(html, /Warszawa, Centrum/);
  assert.match(html, /MM Cars Rental \(4\.5\)/);
  assert.match(html, /class="mm/);
  assert.match(html, /Execution duration: 1m 1s \(61000 ms\)/);
  assert.doesNotMatch(html, /Toyota Aygo/);
});

runTest("buildHtmlReport marks MM Cars Rental red when top1 beats top2 by more than 5 PLN per day", () => {
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
                total_price: 210.01,
                currency: "PLN",
                rental_days: 2
              }
            ]
          }
        }
      }
    ]
  });

  assert.match(html, /class="mm mm-top1-gap">MM Cars Rental \(4\.5\)/);
  assert.match(html, /class="mm mm-top1-gap">99\.00 PLN\/day/);
});

runTest("buildHtmlReport does not mark MM Cars Rental red at exactly 5 PLN per day ahead", () => {
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
                total_price: 208,
                currency: "PLN",
                rental_days: 2
              }
            ]
          }
        }
      }
    ]
  });

  assert.doesNotMatch(html, /<td class="mm mm-top1-gap"/);
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
  assert.match(html, /Partial report: 0 \/ 270 scenarios completed/);
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
            results: [{ total_price: 300 }],
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
            results: [{ total_price: 200 }],
            top_3_by_location: { "Warszawa, Lotnisko-Modlin": { price_insurance: [] } },
            errors: []
          }
        ]
      }
    }
  ], {
    expectedScenarioCount: 2,
    startedAt: "2026-05-14T03:00:00.000Z",
    generatedAt: "2026-05-14T03:01:30.000Z",
    locations: ["Warszawa"],
    sortOrders: ["price_insurance"],
    baseUrl: "https://rentcars.pl"
  });

  assert.equal(payload.scenario_count, 2);
  assert.equal(payload.completed_scenario_count, 2);
  assert.equal(payload.expected_scenario_count, 2);
  assert.equal(payload.is_partial, false);
  assert.equal(payload.execution_duration_ms, 90000);
  assert.deepEqual(payload.scenarios.map((scenario) => scenario.scenario_id), ["2026-06-01-2", "2026-06-02-3"]);
  assert.equal(payload.scenarios[0].results.length, 1);
});

if (!process.exitCode) {
  console.log("All RentCars tests passed.");
}
