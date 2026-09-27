const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { yaml } = require("../node_modules/playwright-core/lib/utilsBundle");

const ROOT = path.resolve(__dirname, "..");

function workflow(relativePath) {
  return yaml.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function trustedRun(overrides = {}) {
  return {
    id: 41,
    event: "schedule",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    created_at: "2026-09-25T23:17:00.000Z",
    head_branch: "main",
    head_repository: { full_name: "mmcars/rentcars" },
    repository: { full_name: "mmcars/rentcars" },
    has_scrape_jobs: true,
    ...overrides
  };
}

const trustOptions = {
  repository: "mmcars/rentcars",
  defaultBranch: "main"
};

test("daily notification is independent from Pages and has read-only permissions", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const notify = daily.jobs.notify;

  assert.ok(notify, "daily workflow must define a standalone notify job");
  assert.equal(notify.environment, undefined);
  assert.deepEqual(notify.permissions, { actions: "read", contents: "read", pages: "read" });
  assert.match(String(notify.if), /always\(\)/);
  assert.deepEqual(notify.needs, ["plan", "scrape", "merge"]);
  assert.equal(notify.steps.some((step) => step.uses === "actions/checkout@v4"), false);
  assert.equal(notify.steps.some((step) => step.uses === "actions/download-artifact@v4"), true);

  const notifyShell = notify.steps.map((step) => step.run || "").join("\n");
  const sendStep = notify.steps.find((step) => step.name === "Send Telegram notification");
  assert.match(notifyShell, /report-meta\.json/);
  assert.match(notifyShell, /report\.html/);
  assert.equal(sendStep.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.match(sendStep.run, /Authorization: Bearer \$\{GITHUB_TOKEN\}/);
  assert.equal(daily.jobs.merge.environment, undefined);
  assert.equal(daily.jobs.publish.environment.name, "github-pages");
  assert.equal([].concat(daily.jobs.publish.needs).includes("notify"), false);
  assert.match(String(daily.jobs.publish.if), /always\(\).*needs\.merge\.result == 'success'/);
  assert.match(String(daily.jobs.publish.outputs.published), /pages-deployment\.outcome == 'success'/);
});

test("daily notification sends one verified report link or one bounded link-free fallback", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const sendStep = daily.jobs.notify.steps.find((step) => step.name === "Send Telegram notification");
  const bashPath = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

  assert.ok(sendStep, "daily notification must have a send step");

  function execute({ withBody, pagesSiteAvailable = true, metadataAttempt = "2", htmlStatus = "200", htmlMarker = true }) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-notify-shell-"));
    const inputDir = path.join(tempDir, "notification-input");
    const capturePath = path.join(tempDir, "telegram-message.txt");
    const bashEnvPath = path.join(tempDir, "bash-env.sh");
    fs.mkdirSync(inputDir);
    if (withBody) {
      fs.writeFileSync(path.join(inputDir, "rentcars-notification-body.txt"), "RentCars.pl: run finished (complete).", "utf8");
    }
    fs.writeFileSync(bashEnvPath, [
      "curl() {",
      "  local output_path=''",
      "  local is_pages_api=false",
      "  local is_metadata=false",
      "  local is_html=false",
      "  local previous=''",
      "  local argument",
      "  for argument in \"$@\"; do",
      "    if [[ \"$previous\" == '--output' ]]; then output_path=\"$argument\"; fi",
      "    if [[ \"$argument\" == */repos/*/pages ]]; then is_pages_api=true; fi",
      "    if [[ \"$argument\" == *report-meta.json* ]]; then is_metadata=true; fi",
      "    if [[ \"$argument\" == https://*report.html* ]]; then is_html=true; fi",
      "    previous=\"$argument\"",
      "  done",
      "  if [[ \"$is_pages_api\" == true ]]; then",
      "    if [[ \"$MOCK_PAGES_SITE_AVAILABLE\" == true ]]; then",
      "      printf '{\"html_url\":\"https://reports.example.test/rentcars\"}' > \"$output_path\"",
      "      printf '200'",
      "    else",
      "      printf '404'",
      "    fi",
      "    return 0",
      "  fi",
      "  if [[ \"$is_metadata\" == true ]]; then",
      "    printf '{\"run_id\":\"%s\",\"run_attempt\":%s}' \"$GITHUB_RUN_ID\" \"$MOCK_METADATA_ATTEMPT\" > \"$output_path\"",
      "    printf '200'",
      "    return 0",
      "  fi",
      "  if [[ \"$is_html\" == true ]]; then",
      "    if [[ \"$MOCK_HTML_MARKER\" == true ]]; then",
      "      printf '<meta name=\"rentcars-report-metadata-version\" content=\"1\">' > \"$output_path\"",
      "    else",
      "      printf '<html>Service unavailable</html>' > \"$output_path\"",
      "    fi",
      "    printf '%s' \"$MOCK_HTML_STATUS\"",
      "    return 0",
      "  fi",
      "  while [[ $# -gt 0 ]]; do",
      "    if [[ \"$1\" == text=* ]]; then printf '%s' \"${1#text=}\" > \"$CAPTURE_PATH\"; fi",
      "    shift",
      "  done",
      "}",
      "sleep() { :; }",
      "export -f curl sleep"
    ].join("\n"), "utf8");

    try {
      const result = spawnSync(bashPath, ["--noprofile", "--norc", "-c", sendStep.run], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: bashEnvPath.replaceAll("\\", "/"),
          CAPTURE_PATH: capturePath.replaceAll("\\", "/"),
          RUNNER_TEMP: tempDir.replaceAll("\\", "/"),
          MOCK_PAGES_SITE_AVAILABLE: pagesSiteAvailable ? "true" : "false",
          MOCK_METADATA_ATTEMPT: metadataAttempt,
          MOCK_HTML_STATUS: htmlStatus,
          MOCK_HTML_MARKER: htmlMarker ? "true" : "false",
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_CHAT_ID: "test-chat",
          GITHUB_TOKEN: "test-github-token",
          ARTIFACT_URL: "https://github.test/artifacts/55",
          RUN_URL: "https://github.test/actions/runs/77",
          GITHUB_RUN_ID: "77",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_API_URL: "https://api.github.test",
          GITHUB_REPOSITORY: "mmcars/rentcars",
          GITHUB_REPOSITORY_OWNER: "mmcars",
          PLAN_RESULT: "success",
          SCRAPE_RESULT: "success",
          MERGE_RESULT: "success"
        }
      });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(capturePath, "utf8");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const successMessage = execute({ withBody: true });
  assert.equal((successMessage.match(/RentCars\.pl: run finished/g) || []).length, 1);
  assert.match(successMessage, /Current HTML report:\nhttps:\/\/reports\.example\.test\/rentcars\/report\.html\n\nArtifact backup:/);

  const noJsonMessage = execute({ withBody: false });
  assert.equal((noJsonMessage.match(/RentCars\.pl: run finished/g) || []).length, 1);
  assert.match(noJsonMessage, /details unavailable; plan=success, scrape=success, merge=success/);
  assert.match(noJsonMessage, /Current HTML report:\nhttps:\/\/reports\.example\.test\/rentcars\/report\.html\n\nArtifact backup:/);

  const pagesFailureMessage = execute({ withBody: true, pagesSiteAvailable: false });
  assert.equal((pagesFailureMessage.match(/RentCars\.pl: run finished/g) || []).length, 1);
  assert.doesNotMatch(pagesFailureMessage, /report\.html/);
  assert.match(pagesFailureMessage, /GitHub Pages deployment was not confirmed for this run\.\n\nArtifact backup:/);

  const staleAttemptMessage = execute({ withBody: true, metadataAttempt: "1" });
  assert.equal((staleAttemptMessage.match(/RentCars\.pl: run finished/g) || []).length, 1);
  assert.doesNotMatch(staleAttemptMessage, /report\.html/);
  assert.match(staleAttemptMessage, /GitHub Pages deployment was not confirmed for this run/);

  for (const failure of [{ htmlStatus: "404" }, { htmlMarker: false }]) {
    const invalidHtmlMessage = execute({ withBody: true, ...failure });
    assert.doesNotMatch(invalidHtmlMessage, /report\.html/);
    assert.match(invalidHtmlMessage, /GitHub Pages deployment was not confirmed for this run/);
  }
});

test("daily schedule retains 60 rolling dates and durations 2 through 14", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const inputs = daily.on.workflow_dispatch.inputs;

  assert.equal(daily.env.SCHEDULE_ROLLING_DAYS, "60");
  assert.equal(daily.env.SCHEDULE_DURATIONS, "2,3,4,5,6,7,8,9,10,11,12,13,14");
  assert.equal(inputs.rolling_days.default, "60");
  assert.equal(inputs.durations.default, "2,3,4,5,6,7,8,9,10,11,12,13,14");
});

test("notification formatter preserves blank lines and alerts only when MM is absent for the whole date", () => {
  const { buildDailyNotification } = require("../src/rentcars/dailyNotification");
  const scenario = (startDate, rentalDays, providerName) => ({
    start_date: startDate,
    rental_days: rentalDays,
    expected_check_count: 1,
    successful_check_count: 1,
    failed_check_count: 0,
    results: [{ provider_name: providerName }]
  });
  const payload = {
    run_status: "complete",
    completed_scenario_count: 4,
    expected_scenario_count: 4,
    successful_check_count: 4,
    failed_check_count: 0,
    missing_check_count: 0,
    expected_check_count: 4,
    generated_at: "2026-09-26T05:00:00.000Z",
    scenarios: [
      scenario("2026-10-01", 2, "MM Cars Rental"),
      scenario("2026-10-01", 3, "Another provider"),
      scenario("2026-10-02", 2, "Another provider"),
      scenario("2026-10-02", 3, "Another provider")
    ]
  };

  assert.equal(buildDailyNotification(payload, {
    expectedStartDates: "2026-10-01,2026-10-02",
    expectedDurations: "2,3"
  }), [
    "RentCars.pl: run finished (complete; 4/4 scenarios; 4 successful, 0 failed, 0 missing / 4 checks; generated 2026-09-26T05:00:00.000Z).",
    "",
    "ALERT MM Cars Rental",
    "",
    "Brak MM - pe\u0142ne dane:",
    "2026-10-02"
  ].join("\n"));
});

test("notification formatter CLI rejects malformed source JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-notification-"));
  const inputPath = path.join(tempDir, "invalid.json");
  const helperPath = path.join(ROOT, "src/rentcars/dailyNotification.js");
  fs.writeFileSync(inputPath, "{not-json", "utf8");

  try {
    assert.equal(fs.existsSync(helperPath), true, "notification formatter CLI must exist");
    const result = spawnSync(process.execPath, [
      helperPath,
      inputPath,
      "2026-10-01",
      "2"
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON|Unexpected|property name/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("smoke validation rejects partial, error, malformed, and missing JSON after exit zero", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-smoke-validation-"));
  const helperPath = path.join(ROOT, "src/rentcars/validateSmokeResult.js");
  const cases = [
    {
      name: "partial",
      file: "partial.json",
      contents: JSON.stringify({
        run_status: "partial",
        is_partial: true,
        expected_scenario_count: 1,
        completed_scenario_count: 0,
        expected_check_count: 9,
        successful_check_count: 0,
        failed_check_count: 0,
        missing_check_count: 9
      })
    },
    {
      name: "error",
      file: "error.json",
      contents: JSON.stringify({
        run_status: "complete_with_errors",
        is_partial: false,
        expected_scenario_count: 1,
        completed_scenario_count: 1,
        expected_check_count: 9,
        successful_check_count: 8,
        failed_check_count: 1,
        missing_check_count: 0
      })
    },
    {
      name: "null count",
      file: "null-count.json",
      contents: JSON.stringify({
        run_status: "complete",
        is_partial: false,
        expected_scenario_count: 1,
        completed_scenario_count: 1,
        expected_check_count: 9,
        successful_check_count: 9,
        failed_check_count: null,
        missing_check_count: 0
      })
    },
    { name: "malformed", file: "malformed.json", contents: "{" },
    { name: "missing", file: "missing.json", contents: null }
  ];

  try {
    assert.equal(fs.existsSync(helperPath), true, "smoke validation CLI must exist");
    for (const fixture of cases) {
      const inputPath = path.join(tempDir, fixture.file);
      if (fixture.contents != null) {
        fs.writeFileSync(inputPath, fixture.contents, "utf8");
      }
      const result = spawnSync(process.execPath, [helperPath, "0", inputPath], { encoding: "utf8" });
      assert.notEqual(result.status, 0, `${fixture.name} result must fail validation`);
      assert.match(result.stderr, /smoke|JSON|ENOENT|complete/i);
    }

    const validPath = path.join(tempDir, "blank-status.json");
    fs.writeFileSync(validPath, JSON.stringify({
      run_status: "complete",
      is_partial: false,
      expected_scenario_count: 1,
      completed_scenario_count: 1,
      expected_check_count: 9,
      successful_check_count: 9,
      failed_check_count: 0,
      missing_check_count: 0
    }), "utf8");
    const blankStatus = spawnSync(process.execPath, [helperPath, "", validPath], { encoding: "utf8" });
    assert.notEqual(blankStatus.status, 0, "blank subprocess status must fail validation");
    assert.match(blankStatus.stderr, /subprocess status is invalid/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("smoke validation accepts a complete zero-error result", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-smoke-validation-"));
  const inputPath = path.join(tempDir, "complete.json");
  fs.writeFileSync(inputPath, JSON.stringify({
    run_status: "complete",
    is_partial: false,
    expected_scenario_count: 1,
    completed_scenario_count: 1,
    expected_check_count: 9,
    successful_check_count: 9,
    failed_check_count: 0,
    missing_check_count: 0
  }), "utf8");

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "src/rentcars/validateSmokeResult.js"),
      "0",
      inputPath
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated complete RentCars smoke result: 1\/1 scenarios, 9\/9 checks/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("smoke workflow validates JSON before rendering a report", () => {
  const smoke = workflow(".github/workflows/rentcars-smoke.yml");
  const steps = smoke.jobs.smoke.steps;
  const scrapeIndex = steps.findIndex((step) => step.name === "Run one-day smoke scraper");
  const validateIndex = steps.findIndex((step) => step.name === "Validate smoke JSON");
  const reportIndex = steps.findIndex((step) => step.name === "Generate smoke report");

  assert.ok(scrapeIndex >= 0 && validateIndex > scrapeIndex && reportIndex > validateIndex);
  assert.match(steps[scrapeIndex].run, /scraper_status=.*GITHUB_OUTPUT/s);
  assert.match(steps[validateIndex].run, /validateSmokeResult\.js/);
  assert.match(steps[validateIndex].run, /steps\.scraper\.outputs\.scraper_status/);
});

test("watchdog listens for completed daily runs and serializes recovery", () => {
  const watchdog = workflow(".github/workflows/rentcars-watchdog.yml");

  assert.deepEqual(watchdog.on.workflow_run.workflows, ["RentCars daily run"]);
  assert.deepEqual(watchdog.on.workflow_run.types, ["completed"]);
  assert.equal(watchdog.concurrency.group, "rentcars-watchdog-recovery");
  assert.equal(watchdog.concurrency["cancel-in-progress"], false);
  assert.deepEqual(watchdog.permissions, { actions: "write", contents: "read" });
});

test("completed-run recovery accepts only trusted default-repository default-branch daily runs", () => {
  const { decideCompletedRunRecovery } = require("../src/rentcars/watchdog");
  const source = trustedRun();

  assert.deepEqual(decideCompletedRunRecovery(source, [source], trustOptions), {
    action: "rerun",
    runId: 41,
    runAttempt: 1
  });
  assert.deepEqual(decideCompletedRunRecovery(
    trustedRun({ head_repository: { full_name: "fork/rentcars" } }),
    [],
    trustOptions
  ), { action: "none", runId: null, runAttempt: 0 });
  assert.deepEqual(decideCompletedRunRecovery(
    trustedRun({ head_branch: "feature" }),
    [],
    trustOptions
  ), { action: "none", runId: null, runAttempt: 0 });
  assert.deepEqual(decideCompletedRunRecovery(
    trustedRun({ event: "pull_request" }),
    [],
    trustOptions
  ), { action: "none", runId: null, runAttempt: 0 });
});

test("completed-run recovery stops at attempt three and never races an active trusted run", () => {
  const { decideCompletedRunRecovery } = require("../src/rentcars/watchdog");
  const exhausted = trustedRun({ run_attempt: 3 });
  assert.deepEqual(decideCompletedRunRecovery(exhausted, [exhausted], trustOptions), {
    action: "exhausted",
    runId: 41,
    runAttempt: 3
  });

  const failed = trustedRun();
  const active = trustedRun({
    id: 42,
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
    created_at: "2026-09-26T00:00:00.000Z"
  });
  assert.deepEqual(decideCompletedRunRecovery(failed, [failed, active], trustOptions), {
    action: "monitor",
    runId: 42,
    runAttempt: 2
  });
});

test("completed-run recovery accepts only the watchdog-marked dispatch", () => {
  const { decideCompletedRunRecovery } = require("../src/rentcars/watchdog");
  const recovery = trustedRun({
    event: "workflow_dispatch",
    display_title: "RentCars watchdog recovery"
  });
  const manual = trustedRun({
    event: "workflow_dispatch",
    display_title: "RentCars daily run"
  });

  assert.equal(decideCompletedRunRecovery(recovery, [recovery], trustOptions).action, "rerun");
  assert.deepEqual(decideCompletedRunRecovery(manual, [manual], trustOptions), {
    action: "none",
    runId: null,
    runAttempt: 0
  });
});
