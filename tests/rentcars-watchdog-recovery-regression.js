const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { yaml } = require("../node_modules/playwright-core/lib/utilsBundle");

const {
  classifyDailyRuns,
  decideCompletedRunRecovery,
  enrichRunJobEvidence,
  includeTriggeredRun
} = require("../src/rentcars/watchdog");

const ROOT = path.resolve(__dirname, "..");
const trustOptions = {
  repository: "mmcars/rentcars",
  defaultBranch: "main"
};

function trustedRun(overrides = {}) {
  return {
    id: 801,
    event: "schedule",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    created_at: "2026-09-27T00:00:00.000Z",
    display_title: "RentCars daily run",
    head_branch: "main",
    head_repository: { full_name: "mmcars/rentcars" },
    repository: { full_name: "mmcars/rentcars" },
    jobs_url: "https://api.github.test/runs/801/jobs",
    ...overrides
  };
}

function dailyJobs(overrides = {}) {
  return [
    { name: "Plan RentCars.pl matrix", conclusion: "success" },
    { name: "Scrape chunk 001", conclusion: overrides.scrape || "success" },
    { name: "Merge RentCars.pl report", conclusion: overrides.merge || "success" },
    { name: "Publish RentCars.pl report", conclusion: overrides.publish || "success" },
    { name: "Notify Telegram about RentCars.pl run", conclusion: overrides.notify || "success" }
  ];
}

async function enrich(run, jobs) {
  const [result] = await enrichRunJobEvidence([run], {
    token: "test-token",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ jobs, total_count: jobs.length })
    })
  });
  return result;
}

function scheduledDecision(runs) {
  return classifyDailyRuns(runs, {
    ...trustOptions,
    now: "2026-09-27T04:30:00.000Z"
  });
}

test("reporting-only failure is reported without rerunning completed core work", async () => {
  const notificationFailure = await enrich(trustedRun(), dailyJobs({ notify: "failure" }));

  assert.equal(notificationFailure.core_jobs_succeeded, true);
  assert.equal(notificationFailure.reporting_only_failure, true);
  assert.deepEqual(
    decideCompletedRunRecovery(notificationFailure, [notificationFailure], trustOptions),
    { action: "reporting_failed", runId: 801, runAttempt: 1 }
  );
  assert.deepEqual(
    scheduledDecision([notificationFailure]),
    { action: "reporting_failed", runId: 801, runAttempt: 1 }
  );

  const publicationFailure = await enrich(
    trustedRun({ id: 802, jobs_url: "https://api.github.test/runs/802/jobs" }),
    dailyJobs({ publish: "failure" })
  );
  assert.equal(publicationFailure.reporting_only_failure, true);
  assert.equal(decideCompletedRunRecovery(publicationFailure, [publicationFailure], trustOptions).action, "reporting_failed");

  const historicalJobs = dailyJobs({ notify: "failure" });
  historicalJobs[2].name = "Merge and publish RentCars.pl report";
  const historicalMerge = await enrich(
    trustedRun({ id: 805, jobs_url: "https://api.github.test/runs/805/jobs" }),
    historicalJobs
  );
  assert.equal(historicalMerge.core_jobs_succeeded, true);
  assert.equal(historicalMerge.reporting_only_failure, true);
});

test("core failures retain rerun limit and active-run guard", async () => {
  const coreFailure = await enrich(trustedRun(), dailyJobs({ scrape: "failure", merge: "skipped" }));
  assert.equal(coreFailure.core_jobs_succeeded, false);
  assert.equal(coreFailure.reporting_only_failure, false);
  assert.deepEqual(decideCompletedRunRecovery(coreFailure, [coreFailure], trustOptions), {
    action: "rerun", runId: 801, runAttempt: 1
  });
  assert.deepEqual(scheduledDecision([coreFailure]), {
    action: "rerun", runId: 801, runAttempt: 1
  });

  const exhausted = { ...coreFailure, run_attempt: 3 };
  assert.deepEqual(decideCompletedRunRecovery(exhausted, [exhausted], trustOptions), {
    action: "exhausted", runId: 801, runAttempt: 3
  });

  const active = trustedRun({
    id: 803,
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
    created_at: "2026-09-27T01:00:00.000Z",
    jobs_url: "https://api.github.test/runs/803/jobs"
  });
  assert.deepEqual(decideCompletedRunRecovery(coreFailure, [coreFailure, active], trustOptions), {
    action: "monitor", runId: 803, runAttempt: 2
  });

  const newerReportingFailure = await enrich(
    trustedRun({
      id: 806,
      created_at: "2026-09-27T02:00:00.000Z",
      jobs_url: "https://api.github.test/runs/806/jobs"
    }),
    dailyJobs({ notify: "failure" })
  );
  assert.deepEqual(
    decideCompletedRunRecovery(coreFailure, [coreFailure, newerReportingFailure], trustOptions),
    { action: "reporting_failed", runId: 806, runAttempt: 1 }
  );
});

test("daytime runs do not block recovery of a failed night profile", async () => {
  const nightFailure = await enrich(trustedRun(), dailyJobs({ scrape: "failure", merge: "skipped" }));
  const daytimeActive = trustedRun({
    id: 807,
    display_title: "RentCars daytime run",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-09-27T08:00:00.000Z",
    has_scrape_jobs: true
  });
  const daytimeSuccess = trustedRun({
    id: 808,
    display_title: "RentCars daytime run",
    conclusion: "success",
    created_at: "2026-09-27T08:30:00.000Z",
    has_scrape_jobs: true
  });

  assert.deepEqual(
    decideCompletedRunRecovery(nightFailure, [nightFailure, daytimeActive], trustOptions),
    { action: "rerun", runId: 801, runAttempt: 1 }
  );
  assert.deepEqual(
    decideCompletedRunRecovery(nightFailure, [nightFailure, daytimeSuccess], trustOptions),
    { action: "rerun", runId: 801, runAttempt: 1 }
  );
});

test("an active night run does not block recovery of a failed daytime profile", async () => {
  const daytimeFailure = await enrich(
    trustedRun({ display_title: "RentCars daytime run" }),
    dailyJobs({ scrape: "failure", merge: "skipped" })
  );
  const nightActive = trustedRun({
    id: 809,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-09-27T08:30:00.000Z",
    has_scrape_jobs: true
  });

  assert.deepEqual(
    decideCompletedRunRecovery(daytimeFailure, [daytimeFailure, nightActive], trustOptions),
    { action: "rerun", runId: 801, runAttempt: 1 }
  );
});

test("morning classification ignores the daytime profile", async () => {
  const nightFailure = await enrich(trustedRun(), dailyJobs({ scrape: "failure", merge: "skipped" }));
  const daytimeActive = trustedRun({
    id: 810,
    display_title: "RentCars daytime run",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-09-27T04:00:00.000Z",
    has_scrape_jobs: true
  });

  assert.deepEqual(scheduledDecision([nightFailure, daytimeActive]), {
    action: "rerun", runId: 801, runAttempt: 1
  });
});

test("current or newer relevant job-evidence errors fail closed", async () => {
  const coreFailure = await enrich(trustedRun(), dailyJobs({ scrape: "failure", merge: "skipped" }));
  const currentInspectionFailure = {
    ...coreFailure,
    has_scrape_jobs: null,
    job_evidence_error: "HTTP 503"
  };
  assert.deepEqual(
    decideCompletedRunRecovery(currentInspectionFailure, [currentInspectionFailure], trustOptions),
    { action: "inspection_failed", runId: 801, runAttempt: 1 }
  );
  assert.deepEqual(
    decideCompletedRunRecovery(currentInspectionFailure, [], trustOptions),
    { action: "inspection_failed", runId: 801, runAttempt: 1 }
  );
  assert.deepEqual(
    scheduledDecision([currentInspectionFailure]),
    { action: "inspection_failed", runId: 801, runAttempt: 1 }
  );

  const newerInspectionFailure = trustedRun({
    id: 804,
    conclusion: "success",
    created_at: "2026-09-27T01:00:00.000Z",
    has_scrape_jobs: null,
    job_evidence_error: "HTTP 503",
    jobs_url: "https://api.github.test/runs/804/jobs"
  });
  assert.deepEqual(
    decideCompletedRunRecovery(coreFailure, [coreFailure, newerInspectionFailure], trustOptions),
    { action: "inspection_failed", runId: 804, runAttempt: 1 }
  );
  assert.deepEqual(
    scheduledDecision([coreFailure, newerInspectionFailure]),
    { action: "inspection_failed", runId: 804, runAttempt: 1 }
  );
});

const workflowRunEnv = {
  WATCHDOG_MODE: "workflow_run",
  WATCHDOG_REPOSITORY: "mmcars/rentcars",
  WATCHDOG_DEFAULT_BRANCH: "main",
  WATCHDOG_TRIGGER_RUN_ID: "801",
  WATCHDOG_TRIGGER_EVENT: "schedule",
  WATCHDOG_TRIGGER_STATUS: "completed",
  WATCHDOG_TRIGGER_CONCLUSION: "failure",
  WATCHDOG_TRIGGER_ATTEMPT: "1",
  WATCHDOG_TRIGGER_CREATED_AT: "2026-09-27T00:00:00.000Z",
  WATCHDOG_TRIGGER_TITLE: "RentCars daily run",
  WATCHDOG_TRIGGER_BRANCH: "main",
  WATCHDOG_TRIGGER_REPOSITORY: "mmcars/rentcars"
};

test("missing workflow_run metadata is read exactly before inspecting active attempt jobs", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (!new URL(url).pathname.endsWith("/jobs")) {
      return {
        ok: true,
        json: async () => trustedRun({
          status: "in_progress",
          conclusion: null,
          run_attempt: 2,
          jobs_url: "https://untrusted.example/jobs"
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ jobs: [
        { name: "Plan RentCars.pl matrix", conclusion: "success" },
        { name: "Scrape chunk 001", conclusion: null }
      ], total_count: 2 })
    };
  };
  const runs = await includeTriggeredRun([], {
    env: workflowRunEnv,
    token: "test-token",
    fetchImpl
  });
  assert.equal(runs[0].jobs_url, "https://api.github.com/repos/mmcars/rentcars/actions/runs/801/jobs");

  const enrichedRuns = await enrichRunJobEvidence(runs, {
    token: "test-token",
    fetchImpl
  });

  assert.deepEqual(requestedUrls.map((url) => new URL(url).origin + new URL(url).pathname), [
    "https://api.github.com/repos/mmcars/rentcars/actions/runs/801",
    "https://api.github.com/repos/mmcars/rentcars/actions/runs/801/jobs"
  ]);
  assert.equal(new URL(requestedUrls[1]).searchParams.get("per_page"), "100");
  assert.ok(requestedUrls.every((url) => new URL(url).searchParams.has("inspection")));
  assert.deepEqual(
    decideCompletedRunRecovery(trustedRun(), enrichedRuns, trustOptions),
    { action: "monitor", runId: 801, runAttempt: 2 }
  );
});

test("missing workflow_run fails closed when exact metadata cannot be read", async () => {
  let fetchCount = 0;
  const runs = await includeTriggeredRun([], {
    env: workflowRunEnv,
    token: "test-token",
    fetchImpl: async () => {
      fetchCount++;
      return { ok: false, status: 503 };
    }
  });
  const enrichedRuns = await enrichRunJobEvidence(runs, {
    token: "test-token",
    fetchImpl: async () => {
      throw new Error("jobs must not be requested after metadata failure");
    }
  });

  assert.equal(fetchCount, 1);
  assert.match(enrichedRuns[0].job_evidence_error, /exact run metadata.*HTTP 503/i);
  assert.deepEqual(
    decideCompletedRunRecovery(enrichedRuns[0], enrichedRuns, trustOptions),
    { action: "inspection_failed", runId: 801, runAttempt: 1 }
  );
});

test("missing completed run recovers failed collection but does not rerun reporting-only failures", async () => {
  for (const [jobs, action] of [
    [dailyJobs({ scrape: "failure" }), "rerun"],
    [dailyJobs({ publish: "failure" }), "reporting_failed"]
  ]) {
    const fetchImpl = async (url) => ({
      ok: true,
      json: async () => new URL(url).pathname.endsWith("/jobs") ? { jobs, total_count: jobs.length } : trustedRun()
    });
    const runs = await includeTriggeredRun([], { env: workflowRunEnv, token: "test-token", fetchImpl });
    const enriched = await enrichRunJobEvidence(runs, { token: "test-token", fetchImpl });
    assert.deepEqual(decideCompletedRunRecovery(trustedRun(), enriched, trustOptions), {
      action, runId: 801, runAttempt: 1
    });
  }
});

test("a newer successful replacement suppresses late alerts and retries for an exhausted old run", async () => {
  const old = await enrich(trustedRun({ run_attempt: 3 }), dailyJobs({ scrape: "failure" }));
  const replacement = await enrich(trustedRun({ id: 900, event: "workflow_dispatch",
    display_title: "RentCars watchdog recovery", conclusion: "success",
    created_at: "2026-09-27T13:13:10Z" }), dailyJobs());
  assert.deepEqual(decideCompletedRunRecovery(old, [old, replacement], trustOptions), {
    action: "none", runId: null, runAttempt: 0
  });
});

test("an empty or stale run list reports missing evidence without starting a replacement", () => {
  const options = { ...trustOptions, now: "2026-09-30T12:53:47Z" };
  const stale = trustedRun({ created_at: "2026-09-22T05:03:57Z", has_scrape_jobs: true });
  for (const runs of [[], [stale]]) {
    assert.deepEqual(classifyDailyRuns(runs, options), {
      action: "missing", runId: null, runAttempt: 0
    });
  }
});

test("cancellation is respected by both completion events and scheduled checks", () => {
  const cancelled = trustedRun({ conclusion: "cancelled", has_scrape_jobs: true });
  assert.equal(decideCompletedRunRecovery(cancelled, [cancelled], trustOptions).action, "none");
  assert.equal(scheduledDecision([cancelled]).action, "none");
});

test("a cancelled replacement prevents restarting an older failed run", () => {
  const failed = trustedRun({ has_scrape_jobs: true });
  const cancelled = trustedRun({ id: 902, event: "workflow_dispatch",
    display_title: "RentCars watchdog recovery", conclusion: "cancelled",
    created_at: "2026-09-27T01:00:00Z", has_scrape_jobs: false });
  assert.equal(scheduledDecision([failed, cancelled]).action, "none");
  assert.equal(decideCompletedRunRecovery(failed, [failed, cancelled], trustOptions).action, "none");
});

test("a delayed checkpoint recognizes today's complete report even after twelve hours", () => {
  const completed = trustedRun({ id: 36658415572, conclusion: "success",
    created_at: "2026-09-30T02:08:06Z", has_scrape_jobs: true });
  assert.deepEqual(classifyDailyRuns([completed], {
    ...trustOptions, now: "2026-09-30T15:00:00Z"
  }), { action: "none", runId: 36658415572, runAttempt: 1 });
});

test("incomplete job payloads cannot be used to decide on a retry", async () => {
  for (const payload of [{}, { jobs: [], total_count: 5 }, { jobs: [], total_count: 0 }]) {
    const [run] = await enrichRunJobEvidence([trustedRun()], {
      token: "test-token", fetchImpl: async () => ({ ok: true, json: async () => payload })
    });
    assert.ok(run.job_evidence_error);
    assert.equal(scheduledDecision([run]).action, "inspection_failed");
  }
});

test("completion events re-read exact current state even when a stale attempt is listed", async () => {
  const stale = trustedRun({ has_scrape_jobs: true });
  let requests = 0;
  const runs = await includeTriggeredRun([stale], {
    env: workflowRunEnv, token: "test-token",
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => trustedRun({ run_attempt: 2, conclusion: "cancelled" }) };
    }
  });
  assert.equal(requests, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, "cancelled");
  assert.equal(decideCompletedRunRecovery(stale, runs, trustOptions).action, "none");
});

test("CLI rejects stale, malformed or truncated list evidence instead of deciding on recovery", () => {
  for (const payload of [
    {}, { workflow_runs: [], total_count: 101 },
    { workflow_runs: [trustedRun()], total_count: 1 }
  ]) {
    const result = spawnSync(process.execPath, ["src/rentcars/watchdog.js"], {
      cwd: ROOT, encoding: "utf8", input: JSON.stringify(payload),
      env: { ...process.env, WATCHDOG_SINCE: "2026-09-30", WATCHDOG_MODE: "schedule" }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /automatic recovery is blocked/);
  }
});

test("workflow inspection uses a supported date filter instead of relying on an ignored nonce", () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/rentcars-watchdog.yml"), "utf8"));
  const step = workflow.jobs.watchdog.steps.find((item) => item.name === "Inspect recent RentCars daily runs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-watchdog-cache-"));
  const old = trustedRun({ run_attempt: 3, has_scrape_jobs: true });
  const replacement = trustedRun({ id: 900, event: "workflow_dispatch", display_title: "RentCars watchdog recovery",
    conclusion: "success", has_scrape_jobs: true, created_at: "2026-09-27T13:13:10Z" });
  const fixturePath = path.join(directory, "bash-env.sh");
  const outputPath = path.join(directory, "outputs.txt");
  fs.writeFileSync(fixturePath, [
    "date() { if [[ \"$*\" == *%Y-%m-%d* ]]; then printf '%s' '2026-09-25'; else command date \"$@\"; fi; }",
    "export -f date",
    "curl() {",
    "  local argument",
    "  for argument in \"$@\"; do",
    "    if [[ \"$argument\" == https://*created=%3E%3D* ]]; then printf '%s' \"$FRESH_RUNS\"; return 0; fi",
    "  done",
    "  printf '%s' \"$CACHED_RUNS\"",
    "}", "export -f curl"
  ].join("\n"));
  try {
    for (const [payload, expectedAction] of [
      [{ workflow_runs: [replacement, old], total_count: 2 }, "none"],
      [{ workflow_runs: [], total_count: 101 }, "inspection_failed"]
    ]) {
      const result = spawnSync(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, ...workflowRunEnv,
          BASH_ENV: fixturePath.replaceAll("\\", "/"), GITHUB_OUTPUT: outputPath.replaceAll("\\", "/"),
          GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "mmcars/rentcars", GITHUB_RUN_ID: "901", GITHUB_RUN_ATTEMPT: "1",
          DEFAULT_BRANCH: "main", WATCHDOG_MODE: "schedule", WATCHDOG_NOW: "2026-09-27T18:00:00Z",
          CACHED_RUNS: JSON.stringify({ workflow_runs: [old], total_count: 1 }),
          FRESH_RUNS: JSON.stringify(payload) }
      });
      assert.equal(result.status, 0, result.stderr);
      const output = fs.readFileSync(outputPath, "utf8");
      assert.ok(output.includes(`action=${expectedAction}`), output);
      assert.doesNotMatch(output, /exhausted|rerun|dispatch/);
      fs.unlinkSync(outputPath);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("watchdog reports reporting-only failure without dispatching or rerunning", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/rentcars-watchdog.yml"), "utf8");
  const start = workflow.indexOf("            reporting_failed)");
  const end = workflow.indexOf("              ;;", start);

  assert.ok(start >= 0 && end > start, "watchdog must handle reporting_failed");
  const branch = workflow.slice(start, end);
  assert.match(branch, /No collection rerun was started/i);
  assert.doesNotMatch(branch, /\/rerun|\/dispatches/);
});

test("retry rechecks current status and attempt immediately before the POST", () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(ROOT, ".github/workflows/rentcars-watchdog.yml"), "utf8"));
  const step = workflow.jobs.watchdog.steps.find((item) => item.name === "Recover or report RentCars daily status");
  for (const [changes, expectedPosts] of [
    [{ conclusion: "cancelled" }, 0], [{ conclusion: "success" }, 0],
    [{ run_attempt: 2 }, 0], [{ status: "in_progress", conclusion: null }, 0], [{}, 1]
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-watchdog-retry-"));
    const fixturePath = path.join(directory, "bash-env.sh");
    const capturePath = path.join(directory, "requests.txt");
    fs.writeFileSync(fixturePath, [
      "curl() {",
      "  if [[ \"$*\" == *'--request POST'* ]]; then printf 'POST\\n' >> \"$CAPTURE\"; else printf '%s' \"$CURRENT_RUN\"; fi",
      "}", "export -f curl"
    ].join("\n"));
    try {
      const result = spawnSync(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
          cwd: ROOT, encoding: "utf8", env: { ...process.env,
            BASH_ENV: fixturePath.replaceAll("\\", "/"), CAPTURE: capturePath.replaceAll("\\", "/"),
            ACTION: "rerun", TARGET_RUN_ID: "801", TARGET_RUN_ATTEMPT: "1",
            DEFAULT_BRANCH: "main", GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "mmcars/rentcars",
            GITHUB_SERVER_URL: "https://github.test", GITHUB_RUN_ID: "901",
            TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
            CURRENT_RUN: JSON.stringify(trustedRun(changes)) }
        });
      assert.equal(result.status, 0, result.stderr);
      const posts = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8").trim().split("\n").length : 0;
      assert.equal(posts, expectedPosts, JSON.stringify(changes));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});
