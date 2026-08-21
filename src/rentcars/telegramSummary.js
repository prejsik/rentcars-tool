#!/usr/bin/env node

const fs = require("fs");
const { normalizeWhitespace, uniqueStrings } = require("./utils");

function parseList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  return uniqueStrings(String(value || "").split(","));
}

function parseDurations(value) {
  return [...new Set(parseList(value)
    .map(Number)
    .filter((duration) => Number.isInteger(duration) && duration > 0))]
    .sort((left, right) => left - right);
}

function isMmCarsProvider(value) {
  const provider = normalizeWhitespace(value).toLowerCase();
  return provider.includes("mm cars rental") || provider.includes("mm service lease polska");
}

function scenarioStartDate(scenario) {
  return normalizeWhitespace(
    scenario?.start_date || scenario?.start_day_label || scenario?.pickup_date
  ).slice(0, 10);
}

function expectedCheckCount(scenario) {
  const explicit = Number(scenario?.expected_check_count);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  if (Array.isArray(scenario?.expected_targets) && scenario.expected_targets.length > 0) {
    return scenario.expected_targets.length;
  }
  return 0;
}

function successfulCheckCount(scenario) {
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

function isScenarioFullyChecked(scenario) {
  const expected = expectedCheckCount(scenario);
  const failed = Number(scenario?.failed_check_count || 0);
  const coverageComplete = !Array.isArray(scenario?.expected_targets)
    || scenario.expected_targets.every((target) => target?.mm_coverage_complete !== false);
  return expected > 0
    && successfulCheckCount(scenario) >= expected
    && failed === 0
    && coverageComplete;
}

function buildMmAvailabilityAlert(payload, options = {}) {
  const scenarios = Array.isArray(payload?.scenarios) ? payload.scenarios : [];
  const configuredStartDates = parseList(options.expectedStartDates);
  const configuredDurations = parseDurations(options.expectedDurations);
  const expectedStartDates = configuredStartDates.length
    ? configuredStartDates
    : uniqueStrings(scenarios.map(scenarioStartDate).filter(Boolean)).sort();
  const expectedDurations = configuredDurations.length
    ? configuredDurations
    : parseDurations(scenarios.map((scenario) => scenario?.rental_days));
  const scenariosByDate = new Map();

  for (const scenario of scenarios) {
    const startDate = scenarioStartDate(scenario);
    if (!startDate) {
      continue;
    }
    if (!scenariosByDate.has(startDate)) {
      scenariosByDate.set(startDate, []);
    }
    scenariosByDate.get(startDate).push(scenario);
  }

  const confirmedMissing = [];
  const uncertainMissing = [];

  for (const startDate of expectedStartDates) {
    const dateScenarios = scenariosByDate.get(startDate) || [];
    const mmVisible = dateScenarios.some((scenario) => (
      (Array.isArray(scenario?.results) ? scenario.results : [])
        .some((offer) => isMmCarsProvider(offer?.provider_name))
    ));
    if (mmVisible) {
      continue;
    }

    const scenariosByDuration = new Map(dateScenarios.map((scenario) => [
      Number(scenario?.rental_days),
      scenario
    ]));
    const fullyChecked = expectedDurations.length > 0
      && expectedDurations.every((duration) => {
        const scenario = scenariosByDuration.get(duration);
        return scenario && isScenarioFullyChecked(scenario);
      });

    (fullyChecked ? confirmedMissing : uncertainMissing).push(startDate);
  }

  if (!confirmedMissing.length && !uncertainMissing.length) {
    return "";
  }

  const lines = ["ALERT MM Cars Rental"];
  if (confirmedMissing.length) {
    lines.push("", "Brak MM - pełne dane:", confirmedMissing.join(", "));
  }
  if (uncertainMissing.length) {
    lines.push("", "Nie można potwierdzić - niepełne dane:", uncertainMissing.join(", "));
  }
  return lines.join("\n");
}

function main() {
  const [inputPath, expectedStartDates, expectedDurations] = process.argv.slice(2);
  if (!inputPath) {
    throw new Error("Usage: node src/rentcars/telegramSummary.js INPUT_JSON START_DATES_CSV DURATIONS_CSV");
  }
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  process.stdout.write(buildMmAvailabilityAlert(payload, {
    expectedStartDates,
    expectedDurations
  }));
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
  buildMmAvailabilityAlert,
  isMmCarsProvider
};
