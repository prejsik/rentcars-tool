#!/usr/bin/env node

const fs = require("node:fs");

function requiredCount(payload, field) {
  const value = payload?.[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`RentCars smoke JSON has invalid ${field}.`);
  }
  return value;
}

function validateSmokeResult({ subprocessStatus, payload }) {
  if (subprocessStatus == null || (typeof subprocessStatus === "string" && !subprocessStatus.trim())) {
    throw new Error("RentCars smoke subprocess status is invalid.");
  }
  const exitCode = Number(subprocessStatus);
  if (!Number.isInteger(exitCode)) {
    throw new Error("RentCars smoke subprocess status is invalid.");
  }
  if (exitCode !== 0) {
    throw new Error(`RentCars smoke subprocess exited with status ${exitCode}.`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("RentCars smoke JSON must be an object.");
  }
  if (payload.run_status !== "complete" || payload.is_partial !== false) {
    throw new Error(`RentCars smoke JSON is not complete: ${payload.run_status || "missing status"}.`);
  }

  const expectedScenarios = requiredCount(payload, "expected_scenario_count");
  const completedScenarios = requiredCount(payload, "completed_scenario_count");
  const expectedChecks = requiredCount(payload, "expected_check_count");
  const successfulChecks = requiredCount(payload, "successful_check_count");
  const failedChecks = requiredCount(payload, "failed_check_count");
  const missingChecks = requiredCount(payload, "missing_check_count");

  if (expectedScenarios < 1 || completedScenarios !== expectedScenarios) {
    throw new Error(`RentCars smoke JSON has incomplete scenarios: ${completedScenarios}/${expectedScenarios}.`);
  }
  if (expectedChecks < 1 || successfulChecks !== expectedChecks || failedChecks !== 0 || missingChecks !== 0) {
    throw new Error(`RentCars smoke JSON has incomplete checks: ${successfulChecks} successful, ${failedChecks} failed, ${missingChecks} missing / ${expectedChecks}.`);
  }

  return {
    completedScenarios,
    expectedScenarios,
    successfulChecks,
    expectedChecks
  };
}

function main() {
  const [subprocessStatus, inputPath] = process.argv.slice(2);
  if (subprocessStatus == null || !inputPath) {
    throw new Error("Usage: node src/rentcars/validateSmokeResult.js SUBPROCESS_STATUS INPUT_JSON");
  }
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = validateSmokeResult({ subprocessStatus, payload });
  console.log(`Validated complete RentCars smoke result: ${result.completedScenarios}/${result.expectedScenarios} scenarios, ${result.successfulChecks}/${result.expectedChecks} checks.`);
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
  validateSmokeResult
};
