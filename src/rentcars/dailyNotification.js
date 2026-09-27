#!/usr/bin/env node

const fs = require("node:fs");
const { buildMmAvailabilityAlert } = require("./telegramSummary");

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildDailyNotification(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("RentCars notification source must be a JSON object.");
  }
  if (!payload.run_status) {
    throw new Error("RentCars notification source is missing run_status.");
  }

  const progress = [
    String(payload.run_status),
    `${count(payload.completed_scenario_count)}/${count(payload.expected_scenario_count)} scenarios`,
    `${count(payload.successful_check_count)} successful, ${count(payload.failed_check_count)} failed, ${count(payload.missing_check_count)} missing / ${count(payload.expected_check_count)} checks`,
    `generated ${payload.generated_at || "unknown"}`
  ].join("; ");
  const sections = [`RentCars.pl: run finished (${progress}).`];
  const mmAlert = buildMmAvailabilityAlert(payload, options);
  if (mmAlert) {
    sections.push(mmAlert);
  }
  return sections.join("\n\n");
}

function main() {
  const [inputPath, expectedStartDates, expectedDurations] = process.argv.slice(2);
  if (!inputPath) {
    throw new Error("Usage: node src/rentcars/dailyNotification.js INPUT_JSON START_DATES_CSV DURATIONS_CSV");
  }
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  process.stdout.write(buildDailyNotification(payload, {
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
  buildDailyNotification
};
