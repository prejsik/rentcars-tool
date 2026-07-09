#!/usr/bin/env node

const path = require("path");
const { loadConfig, printHelp: printConfigHelp } = require("./config");
const { RentCarsScraper } = require("./scraper");
const { dailyPrice, normalizeWhitespace, writeTextFile } = require("./utils");
const { expectedAirportCount } = require("./locations");

function parseRunnerArgs(argv) {
  const runner = {
    savePath: null,
    jsonOnly: false,
    help: false
  };
  const configArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--json") {
      runner.jsonOnly = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      runner.help = true;
      configArgs.push("--help");
      continue;
    }

    if (token === "--save") {
      const nextValue = argv[index + 1];
      if (nextValue && !nextValue.startsWith("--")) {
        runner.savePath = nextValue;
        index += 1;
      } else {
        runner.savePath = path.join("output", "rentcars-results-latest.json");
      }
      continue;
    }

    if (token.startsWith("--save=")) {
      runner.savePath = token.slice("--save=".length);
      continue;
    }

    if (token === "--output-json") {
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        throw new Error("Missing value for argument: --output-json");
      }
      runner.savePath = nextValue;
      index += 1;
      continue;
    }

    if (token.startsWith("--output-json=")) {
      runner.savePath = token.slice("--output-json=".length);
      continue;
    }

    configArgs.push(token);
  }

  return { runner, configArgs };
}

function addDaysToIsoDate(dateString, daysToAdd) {
  const baseDate = new Date(`${dateString}T00:00:00Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() + daysToAdd);
  return baseDate.toISOString().slice(0, 10);
}

function toIsoLocalDateTime(date, time) {
  return `${date}T${time}:00`;
}

function normalizeCurrency(value) {
  const raw = normalizeWhitespace(value).toUpperCase();
  if (!raw) {
    return "";
  }
  if (raw === "ZL" || raw === "Z\u0141") {
    return "PLN";
  }
  return raw;
}

function normalizeProviderName(value) {
  const name = normalizeWhitespace(value);
  const comparable = name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/sp\.?\s*z\s*o\.?\s*o\.?/g, "sp z o o");
  if (comparable.includes("mm service lease polska")) {
    return "MM Cars Rental";
  }
  return name;
}

function normalizeTransmissionName(value) {
  const raw = normalizeWhitespace(value).toLowerCase();
  if (raw === "automatic" || /automatyczna|automatic|automat\b/i.test(raw)) {
    return "automatic";
  }
  if (raw === "manual" || /manualna|manual\b|r\u0119czna|reczna/i.test(raw)) {
    return "manual";
  }
  return raw;
}

function mapOffer(row, scenario) {
  const pickupLocation = row.pickupLocation || row.location;
  const totalPrice = Number(row.totalPrice);
  const basePrice = Number.isFinite(Number(row.basePrice)) ? Number(row.basePrice) : null;
  const insuredPrice = Number.isFinite(Number(row.protectedPrice)) ? Number(row.protectedPrice) : null;
  return {
    location: pickupLocation,
    requested_location: row.requestedLocation || row.location,
    pickup_location: pickupLocation,
    pickup_location_id: row.pickupLocationId || "",
    sort_order: row.sortOrder || "suggested",
    sort_label: row.sortLabel || "sugerowane",
    price_mode: row.priceMode || "base",
    transmission: normalizeTransmissionName(row.transmission),
    provider_name: normalizeProviderName(row.provider),
    provider_rating: Number.isFinite(row.providerRating) ? row.providerRating : null,
    total_price: totalPrice,
    base_price: basePrice,
    insured_price: insuredPrice,
    insurance_surcharge: basePrice != null && insuredPrice != null
      ? Number((insuredPrice - basePrice).toFixed(2))
      : null,
    price_verified: row.priceVerified === true,
    daily_price: dailyPrice(totalPrice, scenario.durationDays),
    currency: normalizeCurrency(row.currency),
    rental_days: scenario.durationDays,
    pickup_date: toIsoLocalDateTime(scenario.pickupDate, scenario.pickupTime),
    dropoff_date: toIsoLocalDateTime(scenario.dropoffDate, scenario.dropoffTime),
    source: row.source || "",
    source_url: scenario.baseUrl
  };
}

function sortOrderLabel(sortOrder) {
  const labels = {
    suggested: "sugerowane",
    price: "po cenie",
    price_insurance: "po cenie z ubezpieczeniem"
  };
  return labels[sortOrder] || sortOrder;
}

function providerRatingText(rating) {
  const numeric = Number(rating);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function groupTopOffersByLocation(results, sortOrders) {
  const grouped = new Map();

  for (const result of results) {
    const key = normalizeWhitespace(result.pickup_location || result.location).toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(result);
  }

  const top3ByLocation = {};
  for (const [key, rows] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const location = rows[0]?.pickup_location || rows[0]?.location || key;
    top3ByLocation[location] = {};
    for (const sortOrder of sortOrders) {
      top3ByLocation[location][sortOrder] = [...rows]
        .filter((row) => (row.sort_order || "suggested") === sortOrder)
        .sort((left, right) => Number(left.total_price) - Number(right.total_price))
        .slice(0, 3);
    }
  }

  return top3ByLocation;
}

function buildScenarioPayload({ config, scenarioConfig, durationDays, results, failures, expectedTargets = [] }) {
  const mappedResults = results
    .map((row) => mapOffer(row, {
      durationDays,
      pickupDate: scenarioConfig.pickupDate,
      pickupTime: scenarioConfig.pickupTime,
      dropoffDate: scenarioConfig.dropoffDate,
      dropoffTime: scenarioConfig.dropoffTime,
      baseUrl: scenarioConfig.baseUrl
    }))
    .filter((row) => Number.isFinite(row.total_price))
    .sort((left, right) => left.total_price - right.total_price);

  const sortOrders = Array.isArray(config.sortOrders) && config.sortOrders.length
    ? config.sortOrders
    : ["price_insurance"];
  const top3ByLocation = groupTopOffersByLocation(mappedResults, sortOrders);
  const cheapestByLocation = {};
  const top3PlusMmByLocation = {};

  for (const location of Object.keys(top3ByLocation)) {
    const locationRows = mappedResults
      .filter((row) => normalizeWhitespace(row.pickup_location || row.location).toLowerCase() === normalizeWhitespace(location).toLowerCase())
      .sort((left, right) => Number(left.total_price) - Number(right.total_price));
    cheapestByLocation[location] = locationRows[0] || null;
    top3PlusMmByLocation[location] = {
      top_3_by_sort: top3ByLocation[location] || {},
      mm_cars_rental: null
    };
  }

  const normalizedExpectedTargets = expectedTargets.map((target) => ({
    requested_location: target.requestedLocation || target.location || "",
    location: target.location || "",
    pickup_location_id: target.pickupLocationId || "",
    sort_order: target.sortOrder || "",
    sort_label: target.sortLabel || "",
    price_mode: target.priceMode || ""
  }));
  const expectedLocations = [...new Set(normalizedExpectedTargets
    .map((target) => normalizeWhitespace(target.location))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const failedCheckCount = failures.length;
  const expectedCheckCount = normalizedExpectedTargets.length
    || new Set(mappedResults.map((row) => `${row.pickup_location}|${row.sort_order}`)).size + failedCheckCount;
  const successfulCheckCount = Math.max(0, expectedCheckCount - failedCheckCount);

  return {
    scenario_id: `${scenarioConfig.pickupDate}-${durationDays}`,
    start_date: scenarioConfig.pickupDate,
    start_day_label: scenarioConfig.pickupDate,
    pickup_date: toIsoLocalDateTime(scenarioConfig.pickupDate, scenarioConfig.pickupTime),
    dropoff_date: toIsoLocalDateTime(scenarioConfig.dropoffDate, scenarioConfig.dropoffTime),
    rental_days: durationDays,
    expected_locations: expectedLocations,
    expected_targets: normalizedExpectedTargets,
    expected_check_count: expectedCheckCount,
    completed_check_count: successfulCheckCount + failedCheckCount,
    successful_check_count: successfulCheckCount,
    failed_check_count: failedCheckCount,
    run_status: failedCheckCount > 0 ? "complete_with_errors" : "complete",
    sort_orders: sortOrders.map((order) => ({
      order,
      label: sortOrderLabel(order)
    })),
    results: mappedResults,
    errors: failures.map((failure) => ({
      location: failure.location,
      requested_location: failure.requestedLocation || failure.location,
      sort_order: failure.sortOrder || "",
      sort_label: failure.sortLabel || "",
      attempt_count: Number(failure.attemptCount) || 1,
      error: failure.error
    })),
    cheapest_by_location: cheapestByLocation,
    cheapest_overall: mappedResults[0] || null,
    top_3_by_location: top3ByLocation,
    top_3_plus_mm_by_location: top3PlusMmByLocation
  };
}

function buildRootPayload({
  config,
  scenarios,
  startedAt,
  durationMs,
  expectedScenarioCount = scenarios.length,
  expectedCheckCount = scenarios.reduce((sum, scenario) => sum + Number(scenario.expected_check_count || 0), 0)
}) {
  const successfulCheckCount = scenarios.reduce(
    (sum, scenario) => sum + Number(scenario.successful_check_count || 0),
    0
  );
  const failedCheckCount = scenarios.reduce(
    (sum, scenario) => sum + Number(scenario.failed_check_count ?? scenario.errors?.length ?? 0),
    0
  );
  const completedCheckCount = successfulCheckCount + failedCheckCount;
  const isPartial = scenarios.length < expectedScenarioCount || completedCheckCount < expectedCheckCount;
  const runStatus = isPartial
    ? "partial"
    : failedCheckCount > 0
      ? "complete_with_errors"
      : "complete";

  return {
    generated_at: new Date().toISOString(),
    scraper: "rentcars",
    source_url: config.baseUrl,
    time_zone: "Europe/Warsaw",
    locations: config.locations,
    sort_orders: config.sortOrders,
    scenario_count: scenarios.length,
    expected_scenario_count: expectedScenarioCount,
    completed_scenario_count: scenarios.length,
    expected_check_count: expectedCheckCount,
    completed_check_count: completedCheckCount,
    successful_check_count: successfulCheckCount,
    failed_check_count: failedCheckCount,
    missing_check_count: Math.max(0, expectedCheckCount - completedCheckCount),
    run_status: runStatus,
    has_errors: failedCheckCount > 0,
    is_partial: isPartial,
    execution_duration_ms: durationMs,
    execution_started_at: startedAt,
    scenarios
  };
}

function printScenarioTable(payload, locations) {
  const rows = [];
  const scenarioLocations = Object.keys(payload.top_3_by_location || {});
  for (const location of scenarioLocations) {
    const bySort = payload.top_3_by_location?.[location] || {};
    const sortOrders = payload.sort_orders?.map((item) => item.order) || Object.keys(bySort);
    for (const sortOrder of sortOrders) {
      const top3 = bySort[sortOrder] || [];
      rows.push({
        location,
        sort: sortOrderLabel(sortOrder),
        top1: formatOffer(top3[0]),
        top2: formatOffer(top3[1]),
        top3: formatOffer(top3[2])
      });
    }
  }
  console.table(rows);
}

function formatOffer(offer) {
  if (!offer) {
    return "Not available";
  }
  const providerName = normalizeWhitespace(offer.provider_name);
  const rating = providerRatingText(offer.provider_rating);
  const displayName = rating ? `${providerName} (${rating})` : providerName;
  const pricePerDay = dailyPrice(offer.total_price, offer.rental_days);
  const priceText = pricePerDay == null
    ? "Not available"
    : `${pricePerDay.toFixed(2)} ${offer.currency || ""}/day`.trim();
  return `${displayName} | ${priceText}`.trim();
}

function writePayloadSnapshot(runner, payload, jsonOnly) {
  if (!runner.savePath) {
    return;
  }

  const targetPath = path.resolve(runner.savePath);
  writeTextFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (!jsonOnly) {
    const partialLabel = payload.is_partial ? "partial " : "";
    console.log(`Saved ${partialLabel}JSON to ${targetPath}`);
  }
}

function formatProgressDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

function progressLine(completed, total, elapsedMs) {
  const remaining = Math.max(0, total - completed);
  const etaMs = completed > 0 ? (elapsedMs / completed) * remaining : 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
  return `PROGRESS ${completed}/${total} (${percent}%) | elapsed ${formatProgressDuration(elapsedMs)} | ETA ${formatProgressDuration(etaMs)}`;
}

async function main() {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const { runner, configArgs } = parseRunnerArgs(process.argv.slice(2));
  const config = loadConfig(configArgs);

  if (runner.help || config.help) {
    printConfigHelp();
    process.stdout.write("\nRunner options:\n  --json\n  --save[=PATH]\n  --output-json PATH\n");
    return;
  }

  const scenarios = [];
  const expectedScenarioCount = config.pickupDateOptions.length * config.durationDays.length;
  const expectedCheckCount = expectedScenarioCount
    * expectedAirportCount(config.locations)
    * Math.max(1, config.sortOrders.length);

  for (const pickupDate of config.pickupDateOptions) {
    for (const durationDays of config.durationDays) {
      const dropoffDate = addDaysToIsoDate(pickupDate, durationDays);
      const scenarioConfig = {
        ...config,
        pickupDate,
        dropoffDate,
        artifactsDir: path.join(config.artifactsDir, `start-${pickupDate}`, `days-${durationDays}`)
      };

      if (!runner.jsonOnly) {
        console.log(`RentCars.pl ${pickupDate} ${config.pickupTime} -> ${dropoffDate} ${config.dropoffTime} (${durationDays} days)`);
      }

      const scraper = new RentCarsScraper(scenarioConfig);
      const { results, failures, expectedTargets } = await scraper.run();
      const scenarioPayload = buildScenarioPayload({
        config,
        scenarioConfig,
        durationDays,
        results,
        failures,
        expectedTargets
      });

      scenarios.push(scenarioPayload);
      if (!runner.jsonOnly) {
        console.log(progressLine(scenarios.length, expectedScenarioCount, Date.now() - startedAtMs));
      }
      writePayloadSnapshot(runner, buildRootPayload({
        config,
        scenarios,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        expectedScenarioCount,
        expectedCheckCount
      }), runner.jsonOnly);

      if (!runner.jsonOnly) {
        printScenarioTable(scenarioPayload, config.locations);
        if (scenarioPayload.errors.length) {
          console.log(`Errors: ${scenarioPayload.errors.map((item) => `${item.location}: ${item.error}`).join(" | ")}`);
        }
        console.log("");
      }
    }
  }

  const payload = buildRootPayload({
    config,
    scenarios,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    expectedScenarioCount,
    expectedCheckCount
  });

  if (runner.jsonOnly) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }

  writePayloadSnapshot(runner, payload, runner.jsonOnly);

  const hasResults = scenarios.some((scenario) => scenario.results.length > 0);
  if (!hasResults) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().then(() => {
    process.exit(process.exitCode || 0);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  buildRootPayload,
  buildScenarioPayload,
  parseRunnerArgs,
  progressLine
};
