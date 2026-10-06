const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { yaml } = require("../node_modules/playwright-core/lib/utilsBundle");

const { mergePayloads } = require("../src/rentcars/mergeResults");
const { buildMmAvailabilityAlert } = require("../src/rentcars/telegramSummary");

const startDate = "2026-09-10";
const location = "Warszawa, Lotnisko-Okecie";
const sortOrder = "price_insurance";
const ROOT = path.resolve(__dirname, "..");

function expectedTarget(mmCoverageComplete) {
  const target = {
    location,
    sort_order: sortOrder
  };
  if (typeof mmCoverageComplete === "boolean") {
    target.mm_coverage_complete = mmCoverageComplete;
  }
  return target;
}

function scenario({ provider, price, mmCoverageComplete, rankingCoverageComplete, failed = false }) {
  const target = expectedTarget(mmCoverageComplete);
  if (typeof rankingCoverageComplete === "boolean") target.ranking_coverage_complete = rankingCoverageComplete;
  return {
    scenario_id: `${startDate}-2`,
    start_date: startDate,
    rental_days: 2,
    expected_targets: [target],
    expected_check_count: 1,
    successful_check_count: failed ? 0 : 1,
    failed_check_count: failed ? 1 : 0,
    results: failed ? [] : [{
      provider_name: provider,
      pickup_location: location,
      sort_order: sortOrder,
      total_price: price,
      rental_days: 2,
      transmission: "automatic"
    }],
    errors: failed ? [{
      location,
      sort_order: sortOrder,
      error: "temporary failure"
    }] : []
  };
}

function mergeAttempts(...attempts) {
  return mergePayloads(attempts.map((attempt, index) => ({
    file: `attempt-${index + 1}.json`,
    payload: { scenarios: [attempt] }
  })), {
    expectedScenarioCount: 1,
    expectedCheckCount: 1,
    startedAt: "2026-09-10T06:00:00.000Z",
    generatedAt: "2026-09-10T06:05:00.000Z"
  });
}

function alertFor(payload) {
  return buildMmAvailabilityAlert(payload, {
    expectedStartDates: [startDate],
    expectedDurations: [2]
  });
}

const confirmedMissingAlert = [
  "ALERT MM Cars Rental",
  "",
  "Brak MM - pełne dane:",
  startDate
].join("\n");

const incompleteAlert = [
  "ALERT MM Cars Rental",
  "",
  "Nie można potwierdzić - niepełne dane:",
  startDate
].join("\n");

test("new incomplete success replaces old complete MM result and coverage together", () => {
  const payload = mergeAttempts(
    scenario({ provider: "MM Cars Rental", price: 200, mmCoverageComplete: true }),
    scenario({ provider: "INTER FLEET", price: 220, mmCoverageComplete: false })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["INTER FLEET"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, false);
  assert.equal(alertFor(payload), incompleteAlert);
});

test("new complete success replaces old incomplete result and confirms MM absence", () => {
  const payload = mergeAttempts(
    scenario({ provider: "INTER FLEET", price: 200, mmCoverageComplete: false }),
    scenario({ provider: "Kaizen Rent", price: 220, mmCoverageComplete: true })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["Kaizen Rent"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, true);
  assert.equal(alertFor(payload), confirmedMissingAlert);
});

test("new complete success with MM fully recovers from an incomplete absence", () => {
  const payload = mergeAttempts(
    scenario({ provider: "INTER FLEET", price: 200, mmCoverageComplete: false }),
    scenario({ provider: "MM Cars Rental", price: 220, mmCoverageComplete: true })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["MM Cars Rental"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, true);
  assert.equal(alertFor(payload), "");
});

test("failed retry preserves the previous successful result and its coverage", () => {
  const payload = mergeAttempts(
    scenario({ provider: "INTER FLEET", price: 200, mmCoverageComplete: false }),
    scenario({ mmCoverageComplete: true, failed: true })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["INTER FLEET"]);
  assert.equal(merged.expected_targets[0].mm_coverage_complete, false);
  assert.deepEqual(merged.errors, []);
  assert.equal(alertFor(payload), incompleteAlert);
});

test("unknown coverage remains unknown when its successful attempt is accepted", () => {
  const payload = mergeAttempts(
    scenario({ provider: "MM Cars Rental", price: 200, mmCoverageComplete: true }),
    scenario({ provider: "INTER FLEET", price: 220 })
  );
  const merged = payload.scenarios[0];

  assert.deepEqual(merged.results.map((offer) => offer.provider_name), ["INTER FLEET"]);
  assert.equal(Object.hasOwn(merged.expected_targets[0], "mm_coverage_complete"), false);
  assert.equal(alertFor(payload), confirmedMissingAlert);
});

test("latest accepted offers keep their ranking coverage without turning a ranking limit into a failed check", () => {
  const payload = mergeAttempts(
    scenario({ provider: "MM Cars Rental", price: 200, mmCoverageComplete: true, rankingCoverageComplete: true }),
    scenario({ provider: "INTER FLEET", price: 220, mmCoverageComplete: false, rankingCoverageComplete: false })
  );
  assert.deepEqual(payload.scenarios[0].results.map(offer => offer.provider_name), ["INTER FLEET"]);
  assert.equal(payload.scenarios[0].expected_targets[0].ranking_coverage_complete, false);
  assert.equal(payload.scenarios[0].expected_targets[0].mm_coverage_complete, false);
  assert.equal(payload.run_status, "complete");
  assert.equal(payload.failed_check_count, 0);
});

const mergeCases = [
  { name: "missing scenarios", expectedScenarios: 2, expectedChecks: 2, status: "partial", missing: 1, exit: 1 },
  { name: "missing checks", expectedScenarios: 1, expectedChecks: 2, status: "partial", missing: 1, exit: 1 },
  { name: "complete_with_errors", expectedScenarios: 1, expectedChecks: 1, failed: true,
    status: "complete_with_errors", missing: 0, exit: 1 },
  { name: "complete", expectedScenarios: 1, expectedChecks: 1, status: "complete", missing: 0, exit: 0 }
];

for (const item of mergeCases) {
  test(`merge saves ${item.name} report before the workflow completeness gate returns ${item.exit}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-merge-gate-"));
    const daily = yaml.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/rentcars-daily.yml"), "utf8"));
    const steps = daily.jobs.merge.steps;
    const gate = steps.find(step => step.name === "Fail incomplete merged report for workflow retry");
    const output = path.join(dir, "output", "rentcars-results-latest.json");
    try {
      fs.mkdirSync(path.join(dir, "parts"));
      fs.writeFileSync(path.join(dir, "parts", "chunk.json"), JSON.stringify({ scenarios: [scenario({
        provider: "MM Cars Rental", price: 200, mmCoverageComplete: true, failed: item.failed
      })] }));
      const merge = spawnSync(process.execPath, [path.join(ROOT, "src/rentcars/mergeResults.js"),
        "--input-dir", path.join(dir, "parts"), "--output-json", output,
        `--expected-scenario-count=${item.expectedScenarios}`, `--expected-check-count=${item.expectedChecks}`],
      { encoding: "utf8" });
      assert.equal(merge.status, 0, merge.stderr);
      const payload = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(payload.run_status, item.status);
      assert.equal(payload.completed_scenario_count, 1);
      assert.equal(payload.missing_check_count, item.missing);
      const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
      const stepOutput = path.join(dir, "step-output.txt");
      for (const step of steps.filter(step => step.id === "report" || step.id === "metadata"
        || step.name === "Prepare notification body")) {
        const script = step.run.replace("node src/rentcars/reportHtml.js",
          `node "${path.join(ROOT, "src/rentcars/reportHtml.js").replaceAll("\\", "/")}"`)
          .replace("node src/rentcars/dailyNotification.js",
            `node "${path.join(ROOT, "src/rentcars/dailyNotification.js").replaceAll("\\", "/")}"`);
        const rendered = spawnSync(bash, ["-eo", "pipefail", "-c", script], { cwd: dir, encoding: "utf8", env: {
          ...process.env, RUN_ID: "77", RUN_ATTEMPT: "2", RUN_EVENT: "schedule", REPORT_PROFILE: "afternoon",
          GITHUB_OUTPUT: stepOutput.replaceAll("\\", "/"), EXPECTED_START_DATES: startDate, EXPECTED_DURATIONS: "2"
        } });
        assert.equal(rendered.status, 0, rendered.stderr);
      }
      const htmlPath = path.join(dir, "output", "rentcars-report.html");
      const metadataPath = path.join(dir, "output", "rentcars-report-meta.json");
      const bodyPath = path.join(dir, "output", "rentcars-notification-body.txt");
      const html = fs.readFileSync(htmlPath, "utf8");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      assert.equal(metadata.run_status, item.status);
      assert.equal(metadata.run_id, "77");
      assert.equal(metadata.run_attempt, 2);
      assert.ok(fs.readFileSync(bodyPath, "utf8").startsWith(`RentCars.pl: run finished (${item.status};`));
      assert.match(fs.readFileSync(stepOutput, "utf8"), /report_exists=true/);
      assert.match(fs.readFileSync(stepOutput, "utf8"), /metadata_exists=true/);
      const run = (gate?.run || ":").replaceAll("output/rentcars-results-latest.json", `"${output.replaceAll("\\", "/")}"`);
      const result = spawnSync(bash, ["-eo", "pipefail", "-c", run], { cwd: ROOT, encoding: "utf8" });
      assert.equal(result.status, item.exit, `${item.name}: ${result.stderr || "incomplete merge must not leave Actions green"}`);
      assert.equal(fs.existsSync(output), true, "gate must preserve the saved result");
      assert.equal(fs.readFileSync(htmlPath, "utf8"), html, "gate must preserve the report for publication and backup");
      assert.equal(JSON.parse(fs.readFileSync(metadataPath, "utf8")).run_status, item.status);
      assert.equal(fs.existsSync(bodyPath), true);
      const site = await require("../src/rentcars/pagesSite").buildSite({
        profile: "afternoon", metadata, html, baseUrl: "https://reports.example.test/rentcars/", pagesExists: false,
        fetchImpl: async () => ({ status: 404 })
      });
      assert.equal(site.publish, true, "saved partial/error reports remain publishable without changing status");
      assert.equal(site.files["afternoon/report.html"], html);
      assert.equal(JSON.parse(site.files["afternoon/report-meta.json"]).run_status, item.status);
      const uploadIndex = steps.findIndex(step => step.id === "upload");
      assert.ok(steps.indexOf(gate) > uploadIndex, "completeness failure must happen after artifact upload");
      assert.equal(gate.if, "always()");
      assert.notEqual(gate["continue-on-error"], true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("workflow completeness gate rejects missing and malformed JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-merge-invalid-"));
  try {
    const daily = yaml.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/rentcars-daily.yml"), "utf8"));
    const gate = daily.jobs.merge.steps.find(step => step.name === "Fail incomplete merged report for workflow retry");
    const input = path.join(dir, "result.json");
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    for (const contents of [null, "{not-json"]) {
      if (contents !== null) fs.writeFileSync(input, contents);
      const run = (gate?.run || ":").replaceAll("output/rentcars-results-latest.json", `"${input.replaceAll("\\", "/")}"`);
      const result = spawnSync(bash, ["-eo", "pipefail", "-c", run], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(result.status, 0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
