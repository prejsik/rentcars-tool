#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { normalizeWhitespace, uniqueStrings, writeTextFile } = require("./utils");

function parseCsv(value) {
  if (value == null || value === "") {
    return [];
  }
  return uniqueStrings(String(value).split(","));
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseMergeArgs(argv) {
  const args = {
    inputDir: "downloaded-parts",
    outputJson: path.join("output", "rentcars-results-latest.json"),
    expectedScenarioCount: null,
    expectedCheckCount: null,
    startedAt: "",
    baseUrl: "",
    locations: [],
    sortOrders: [],
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const readValue = (name) => {
      if (token.startsWith(`${name}=`)) {
        return token.slice(name.length + 1);
      }
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${name}`);
      }
      index += 1;
      return nextValue;
    };

    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--input-dir" || token.startsWith("--input-dir=")) {
      args.inputDir = readValue("--input-dir");
    } else if (token === "--output-json" || token.startsWith("--output-json=")) {
      args.outputJson = readValue("--output-json");
    } else if (token === "--expected-scenario-count" || token.startsWith("--expected-scenario-count=")) {
      args.expectedScenarioCount = toPositiveInteger(readValue("--expected-scenario-count"));
    } else if (token === "--expected-check-count" || token.startsWith("--expected-check-count=")) {
      args.expectedCheckCount = toPositiveInteger(readValue("--expected-check-count"));
    } else if (token === "--started-at" || token.startsWith("--started-at=")) {
      args.startedAt = readValue("--started-at");
    } else if (token === "--base-url" || token.startsWith("--base-url=")) {
      args.baseUrl = readValue("--base-url");
    } else if (token === "--locations" || token.startsWith("--locations=")) {
      args.locations = parseCsv(readValue("--locations"));
    } else if (token === "--sort-orders" || token.startsWith("--sort-orders=")) {
      args.sortOrders = parseCsv(readValue("--sort-orders"));
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function findJsonFiles(inputDir) {
  const root = path.resolve(inputDir);
  if (!fs.existsSync(root)) {
    return [];
  }

  const results = [];
  const visit = (targetPath) => {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(targetPath).sort()) {
        visit(path.join(targetPath, child));
      }
      return;
    }

    if (stat.isFile() && targetPath.toLowerCase().endsWith(".json")) {
      results.push(targetPath);
    }
  };

  visit(root);
  return results;
}

function readJsonPayloads(inputDir) {
  return findJsonFiles(inputDir).map((filePath) => ({
    file: filePath,
    payload: JSON.parse(fs.readFileSync(filePath, "utf8"))
  }));
}

function scenarioKey(scenario) {
  const explicit = normalizeWhitespace(scenario?.scenario_id);
  if (explicit) {
    return explicit.toLowerCase();
  }
  return [
    normalizeWhitespace(scenario?.start_date || scenario?.start_day_label || scenario?.pickup_date),
    normalizeWhitespace(scenario?.rental_days)
  ].join("|").toLowerCase();
}

function scenarioScore(scenario) {
  const results = Array.isArray(scenario?.results) ? scenario.results.length : 0;
  const locations = scenario?.top_3_by_location && typeof scenario.top_3_by_location === "object"
    ? Object.keys(scenario.top_3_by_location).length
    : 0;
  const errors = Array.isArray(scenario?.errors) ? scenario.errors.length : 0;
  return results + locations - errors;
}

function successfulCheckCountForScenario(scenario) {
  const explicit = Number(scenario?.successful_check_count);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  const successfulTargets = new Set();
  for (const result of Array.isArray(scenario?.results) ? scenario.results : []) {
    const location = normalizeWhitespace(result?.pickup_location || result?.location).toLowerCase();
    const sortOrder = normalizeWhitespace(result?.sort_order || "suggested").toLowerCase();
    if (location) {
      successfulTargets.add(`${location}|${sortOrder}`);
    }
  }
  return successfulTargets.size;
}

function sortScenarios(left, right) {
  const leftDate = normalizeWhitespace(left?.start_date || left?.start_day_label || left?.pickup_date);
  const rightDate = normalizeWhitespace(right?.start_date || right?.start_day_label || right?.pickup_date);
  const dateCompare = leftDate.localeCompare(rightDate);
  if (dateCompare !== 0) {
    return dateCompare;
  }
  return Number(left?.rental_days || 0) - Number(right?.rental_days || 0);
}

function earliestIso(values) {
  const dates = values
    .map((value) => new Date(value))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0] ? dates[0].toISOString() : "";
}

function mergePayloads(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("No RentCars JSON payloads found to merge.");
  }

  const normalizedEntries = entries.map((entry) => (
    entry && entry.payload ? entry : { file: "", payload: entry }
  ));
  const payloads = normalizedEntries.map((entry) => entry.payload).filter(Boolean);
  if (!payloads.length) {
    throw new Error("No valid RentCars JSON payloads found to merge.");
  }

  const firstPayload = payloads[0];
  const scenarioMap = new Map();

  for (const payload of payloads) {
    const scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [payload];
    for (const scenario of scenarios) {
      const key = scenarioKey(scenario);
      if (!key) {
        continue;
      }
      const existing = scenarioMap.get(key);
      if (!existing || scenarioScore(scenario) >= scenarioScore(existing)) {
        scenarioMap.set(key, scenario);
      }
    }
  }

  const scenarios = [...scenarioMap.values()].sort(sortScenarios);
  const expectedFromParts = payloads.reduce((sum, payload) => {
    const expected = toPositiveInteger(payload.expected_scenario_count);
    return sum + (expected || 0);
  }, 0);
  const expectedScenarioCount = toPositiveInteger(options.expectedScenarioCount)
    || expectedFromParts
    || scenarios.length;
  const expectedChecksFromParts = payloads.reduce((sum, payload) => {
    const expected = toPositiveInteger(payload.expected_check_count);
    return sum + (expected || 0);
  }, 0);
  const expectedCheckCount = toPositiveInteger(options.expectedCheckCount)
    || expectedChecksFromParts
    || scenarios.reduce((sum, scenario) => sum + Number(scenario.expected_check_count || 0), 0);
  const successfulCheckCount = scenarios.reduce(
    (sum, scenario) => sum + successfulCheckCountForScenario(scenario),
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
  const startedAt = options.startedAt
    || earliestIso(payloads.map((payload) => payload.execution_started_at))
    || new Date().toISOString();
  const generatedAt = options.generatedAt || new Date().toISOString();
  const startedAtMs = new Date(startedAt).getTime();
  const executionDurationMs = Number.isFinite(startedAtMs)
    ? Math.max(0, new Date(generatedAt).getTime() - startedAtMs)
    : payloads.reduce((sum, payload) => sum + (Number(payload.execution_duration_ms) || 0), 0);

  return {
    generated_at: generatedAt,
    scraper: "rentcars",
    source_url: normalizeWhitespace(options.baseUrl) || firstPayload.source_url || "https://rentcars.pl",
    time_zone: firstPayload.time_zone || "Europe/Warsaw",
    locations: options.locations?.length ? options.locations : firstPayload.locations || [],
    sort_orders: options.sortOrders?.length ? options.sortOrders : firstPayload.sort_orders || ["price_insurance"],
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
    execution_duration_ms: executionDurationMs,
    execution_started_at: startedAt,
    chunk_count: payloads.length,
    chunks: normalizedEntries.map((entry) => ({
      file: entry.file ? path.basename(entry.file) : "",
      scenario_count: Number(entry.payload?.scenario_count ?? entry.payload?.scenarios?.length ?? 0),
      expected_scenario_count: Number(entry.payload?.expected_scenario_count ?? entry.payload?.scenarios?.length ?? 0),
      completed_scenario_count: Number(entry.payload?.completed_scenario_count ?? entry.payload?.scenarios?.length ?? 0),
      expected_check_count: Number(entry.payload?.expected_check_count || 0),
      successful_check_count: Number(entry.payload?.successful_check_count || 0),
      failed_check_count: Number(entry.payload?.failed_check_count || 0),
      run_status: entry.payload?.run_status || "",
      is_partial: Boolean(entry.payload?.is_partial),
      generated_at: entry.payload?.generated_at || ""
    })),
    scenarios
  };
}

function printHelp() {
  process.stdout.write(`Usage: node src/rentcars/mergeResults.js --input-dir downloaded-parts --output-json output/rentcars-results-latest.json

Options:
  --expected-scenario-count N
  --expected-check-count N
  --started-at ISO_DATE
  --base-url URL
  --locations CSV
  --sort-orders CSV
`);
}

function main() {
  const args = parseMergeArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const entries = readJsonPayloads(args.inputDir);
  const payload = mergePayloads(entries, args);
  const targetPath = path.resolve(args.outputJson);
  writeTextFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Merged ${payload.completed_scenario_count}/${payload.expected_scenario_count} RentCars scenarios from ${payload.chunk_count} chunk file(s) into ${targetPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  findJsonFiles,
  mergePayloads,
  parseMergeArgs,
  readJsonPayloads
};
