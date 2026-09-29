const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
      json: async () => ({ jobs })
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
    if (!url.endsWith("/jobs?per_page=100")) {
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
      ] })
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

  assert.deepEqual(requestedUrls, [
    "https://api.github.com/repos/mmcars/rentcars/actions/runs/801",
    "https://api.github.com/repos/mmcars/rentcars/actions/runs/801/jobs?per_page=100"
  ]);
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
      json: async () => url.endsWith("/jobs?per_page=100") ? { jobs } : trustedRun()
    });
    const runs = await includeTriggeredRun([], { env: workflowRunEnv, token: "test-token", fetchImpl });
    const enriched = await enrichRunJobEvidence(runs, { token: "test-token", fetchImpl });
    assert.deepEqual(decideCompletedRunRecovery(trustedRun(), enriched, trustOptions), {
      action, runId: 801, runAttempt: 1
    });
  }
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
