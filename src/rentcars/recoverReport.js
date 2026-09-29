#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function validateRecoveredReport({ directory = "output", runId, attempt }) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "rentcars-report-meta.json"), "utf8"));
  const results = JSON.parse(fs.readFileSync(path.join(directory, "rentcars-results-latest.json"), "utf8"));
  const html = fs.readFileSync(path.join(directory, "rentcars-report.html"), "utf8");
  if (String(metadata.run_id) !== String(runId) || metadata.run_attempt !== Number(attempt)
    || !["morning", "afternoon"].includes(metadata.report_profile)
    || !html.includes('<meta name="rentcars-report-metadata-version" content="1">')) {
    throw new Error("The report does not match the selected source run, attempt or profile.");
  }
  const fields = ["completed_scenario_count", "expected_scenario_count", "successful_check_count",
    "failed_check_count", "missing_check_count", "expected_check_count"];
  if (fields.some((field) => !Number.isInteger(results[field]) || results[field] < 0 || results[field] !== metadata[field])
    || results.run_status !== "complete" || metadata.run_status !== "complete" || results.is_partial
    || results.expected_check_count < 1 || results.expected_scenario_count < 1
    || results.failed_check_count !== 0 || results.missing_check_count !== 0
    || results.successful_check_count !== results.expected_check_count
    || results.completed_scenario_count !== results.expected_scenario_count) {
    throw new Error("Recovery requires a complete report with no failed or missing checks.");
  }
  if (!Array.isArray(results.scenarios) || results.scenarios.length !== results.expected_scenario_count
    || new Set(results.scenarios.map((scenario) => `${scenario.start_date}-${scenario.rental_days}`)).size !== results.scenarios.length
    || results.scenarios.some((scenario) => scenario.run_status !== "complete" || scenario.failed_check_count !== 0
      || !Number.isInteger(scenario.expected_check_count) || scenario.expected_check_count < 1
      || scenario.successful_check_count !== scenario.expected_check_count)
    || results.scenarios.reduce((sum, scenario) => sum + scenario.expected_check_count, 0) !== results.expected_check_count) {
    throw new Error("Recovery scenario scope is incomplete or inconsistent.");
  }
  for (const field of ["execution_started_at", "generated_at"]) {
    if (!Number.isFinite(Date.parse(metadata[field])) || metadata[field] !== results[field]) {
      throw new Error("Recovery source timestamps are inconsistent.");
    }
  }
  return { reportProfile: metadata.report_profile, sourceTimestamp: metadata.execution_started_at };
}

if (require.main === module) {
  try {
    const result = validateRecoveredReport({ runId: process.env.SOURCE_RUN_ID, attempt: process.env.SOURCE_ATTEMPT });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `report_profile=${result.reportProfile}\n`);
    console.log(`Validated complete ${result.reportProfile} report from ${result.sourceTimestamp}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateRecoveredReport };
