#!/usr/bin/env node

const fs = require("node:fs");

const ACTIVE_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting"
]);
const NON_FAILURE_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const MERGE_JOB_NAMES = new Set([
  "Merge RentCars.pl report",
  "Merge and publish RentCars.pl report"
]);

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWatchdogRecovery(run) {
  return run?.event === "workflow_dispatch"
    && String(run?.display_title || "") === "RentCars watchdog recovery";
}

function isTrustedDailyRun(run, options = {}) {
  const repository = String(options.repository || "");
  const defaultBranch = String(options.defaultBranch || "");
  if (!repository || !defaultBranch) {
    return false;
  }

  const sourceRepository = String(run?.head_repository?.full_name || "");
  const eventRepository = String(run?.repository?.full_name || repository);
  const trustedEvent = run?.event === "schedule" || isWatchdogRecovery(run);
  return trustedEvent
    && sourceRepository === repository
    && eventRepository === repository
    && run?.head_branch === defaultBranch;
}

function emptyDecision() {
  return { action: "none", runId: null, runAttempt: 0 };
}

function decisionForRun(action, run) {
  return {
    action,
    runId: Number(run?.id),
    runAttempt: Number(run?.run_attempt) || 1
  };
}

function isScrapeJob(job) {
  return String(job?.name || "").startsWith("Scrape chunk ");
}

function isMergeJob(job) {
  return MERGE_JOB_NAMES.has(String(job?.name || ""));
}

function isReportingJob(job) {
  const name = String(job?.name || "");
  return name === "Publish RentCars.pl report" || name.startsWith("Notify Telegram");
}

function isFailedJob(job) {
  const conclusion = String(job?.conclusion || "");
  return Boolean(conclusion) && !NON_FAILURE_CONCLUSIONS.has(conclusion);
}

function summarizeJobEvidence(jobs) {
  const availableJobs = Array.isArray(jobs) ? jobs : [];
  const scrapeJobs = availableJobs.filter(isScrapeJob);
  const mergeJobs = availableJobs.filter(isMergeJob);
  const failedJobs = availableJobs.filter(isFailedJob);
  const reportingFailures = failedJobs.filter(isReportingJob);
  const coreJobsSucceeded = scrapeJobs.length > 0
    && mergeJobs.length > 0
    && [...scrapeJobs, ...mergeJobs].every((job) => job.conclusion === "success");

  return {
    has_scrape_jobs: scrapeJobs.some((job) => job.conclusion !== "skipped"),
    core_jobs_succeeded: coreJobsSucceeded,
    reporting_jobs_failed: reportingFailures.length > 0,
    reporting_only_failure: coreJobsSucceeded
      && reportingFailures.length > 0
      && failedJobs.length === reportingFailures.length
  };
}

function relevantInspectionFailure(runs, referenceRun) {
  const referenceId = Number(referenceRun?.id);
  const referenceTime = timestamp(referenceRun?.created_at);
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => {
      if (!run?.job_evidence_error) {
        return false;
      }
      if (Number(run?.id) === referenceId) {
        return true;
      }
      const runTime = timestamp(run?.created_at);
      return referenceTime != null && runTime != null && runTime >= referenceTime;
    })
    .sort((left, right) => (timestamp(right.created_at) || 0) - (timestamp(left.created_at) || 0))[0];
}

function decideCompletedRunRecovery(triggeredRun, runs, options = {}) {
  if (!isTrustedDailyRun(triggeredRun, options) || triggeredRun?.status !== "completed") {
    return emptyDecision();
  }

  const trustedRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => isTrustedDailyRun(run, options));
  const currentRun = trustedRuns
    .filter((run) => Number(run?.id) === Number(triggeredRun.id))
    .sort((left, right) => (Number(right?.run_attempt) || 1) - (Number(left?.run_attempt) || 1))[0]
    || triggeredRun;
  const activeRun = trustedRuns
    .filter((run) => ACTIVE_STATUSES.has(run?.status))
    .sort((left, right) => (timestamp(right.created_at) || 0) - (timestamp(left.created_at) || 0))[0];

  if (activeRun) {
    return decisionForRun("monitor", activeRun);
  }

  const runId = Number(currentRun.id);
  const runAttempt = Number(currentRun.run_attempt) || 1;
  if (currentRun.status !== "completed" || currentRun.conclusion === "success") {
    return emptyDecision();
  }

  const inspectionFailure = relevantInspectionFailure([...trustedRuns, currentRun], currentRun);
  if (inspectionFailure) {
    return decisionForRun("inspection_failed", inspectionFailure);
  }

  const newerSupersedingRun = trustedRuns
    .filter((run) => (
      Number(run?.id) !== runId
      && run?.status === "completed"
      && (timestamp(run.created_at) || 0) > (timestamp(currentRun.created_at) || 0)
      && (
        (run?.conclusion === "success" && run?.has_scrape_jobs === true)
        || run?.reporting_only_failure === true
      )
    ))
    .sort((left, right) => (timestamp(right.created_at) || 0) - (timestamp(left.created_at) || 0))[0];
  if (newerSupersedingRun) {
    return newerSupersedingRun.reporting_only_failure === true
      ? decisionForRun("reporting_failed", newerSupersedingRun)
      : emptyDecision();
  }
  if (currentRun.reporting_only_failure === true) {
    return decisionForRun("reporting_failed", currentRun);
  }
  if (runAttempt >= 3) {
    return { action: "exhausted", runId, runAttempt };
  }
  return { action: "rerun", runId, runAttempt };
}

async function enrichRunJobEvidence(runs, options = {}) {
  const token = options.token || process.env.GITHUB_TOKEN;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return Promise.all((Array.isArray(runs) ? runs : []).map(async (run) => {
    if (typeof run?.has_scrape_jobs === "boolean") {
      return run;
    }
    try {
      if (!run?.jobs_url) {
        throw new Error(`Run ${run?.id || "unknown"} does not provide jobs_url.`);
      }
      if (!token || typeof fetchImpl !== "function") {
        throw new Error("GITHUB_TOKEN and fetch are required to inspect watchdog job evidence.");
      }

      const separator = String(run.jobs_url).includes("?") ? "&" : "?";
      const response = await fetchImpl(`${run.jobs_url}${separator}per_page=100`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!response.ok) {
        throw new Error(`Could not inspect jobs for run ${run.id}: HTTP ${response.status || "unknown"}.`);
      }
      const payload = await response.json();
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      return {
        ...run,
        ...summarizeJobEvidence(jobs)
      };
    } catch (error) {
      return {
        ...run,
        has_scrape_jobs: null,
        core_jobs_succeeded: null,
        reporting_jobs_failed: null,
        reporting_only_failure: null,
        job_evidence_error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}

function selectNewestPrimaryRun(runs) {
  const orderedRuns = (Array.isArray(runs) ? [...runs] : [])
    .filter((run) => run?.event === "schedule" || isWatchdogRecovery(run))
    .sort((left, right) => (timestamp(right.created_at) || 0) - (timestamp(left.created_at) || 0));

  for (const run of orderedRuns) {
    if (run?.job_evidence_error) {
      return null;
    }
    if (run?.has_scrape_jobs === true || (
      ACTIVE_STATUSES.has(run?.status) && isWatchdogRecovery(run)
    )) {
      return run;
    }
  }
  return null;
}

function classifyDailyRuns(runs, options = {}) {
  const now = timestamp(options.now) ?? Date.now();
  const maxAgeMs = Number(options.maxAgeMs) || 12 * 60 * 60 * 1000;
  const recentRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => run?.event === "schedule" || isWatchdogRecovery(run))
    .filter((run) => !options.repository || isTrustedDailyRun(run, options))
    .filter((run) => {
      const createdAt = timestamp(run?.created_at);
      return createdAt != null && now >= createdAt && now - createdAt <= maxAgeMs;
    });
  const candidates = recentRuns
    .filter((run) => {
      if (run?.has_scrape_jobs === true) {
        return true;
      }
      if (run?.status === "completed" && run?.conclusion && run.conclusion !== "success") {
        return true;
      }
      return ACTIVE_STATUSES.has(run?.status) && isWatchdogRecovery(run);
    })
    .sort((left, right) => {
      const recoveryDifference = Number(ACTIVE_STATUSES.has(right?.status) && isWatchdogRecovery(right))
        - Number(ACTIVE_STATUSES.has(left?.status) && isWatchdogRecovery(left));
      const evidenceDifference = Number(right?.has_scrape_jobs === true) - Number(left?.has_scrape_jobs === true);
      return recoveryDifference
        || evidenceDifference
        || (timestamp(right.created_at) || 0) - (timestamp(left.created_at) || 0);
    });

  const primaryRun = candidates[0];
  if (!primaryRun) {
    const inspectionFailure = recentRuns
      .filter((run) => Boolean(run?.job_evidence_error))
      .sort((left, right) => (timestamp(right.created_at) || 0) - (timestamp(left.created_at) || 0))[0];
    if (inspectionFailure) {
      return {
        action: "inspection_failed",
        runId: Number(inspectionFailure.id),
        runAttempt: Number(inspectionFailure.run_attempt) || 1
      };
    }
    return { action: "dispatch", runId: null, runAttempt: 0 };
  }

  const runId = Number(primaryRun.id);
  const runAttempt = Number(primaryRun.run_attempt) || 1;
  if (ACTIVE_STATUSES.has(primaryRun.status)) {
    return { action: "monitor", runId, runAttempt };
  }
  const inspectionFailure = relevantInspectionFailure(recentRuns, primaryRun);
  if (inspectionFailure) {
    return decisionForRun("inspection_failed", inspectionFailure);
  }
  if (primaryRun.status === "completed" && primaryRun.conclusion === "success") {
    return { action: "none", runId, runAttempt };
  }
  if (primaryRun.reporting_only_failure === true) {
    return { action: "reporting_failed", runId, runAttempt };
  }
  if (runAttempt >= 3) {
    return { action: "exhausted", runId, runAttempt };
  }
  return { action: "rerun", runId, runAttempt };
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const runs = Array.isArray(input) ? input : input.workflow_runs;
  const enrichedRuns = await enrichRunJobEvidence(runs);
  for (const run of enrichedRuns.filter((entry) => entry?.job_evidence_error)) {
    console.error(`Watchdog warning for run ${run.id}: ${run.job_evidence_error}`);
  }
  if (process.env.WATCHDOG_OUTPUT === "latest_primary_run_id") {
    const latestPrimaryRun = selectNewestPrimaryRun(enrichedRuns);
    if (!latestPrimaryRun) {
      throw new Error("No primary RentCars run with scrape job evidence was found.");
    }
    process.stdout.write(String(latestPrimaryRun.id));
    return;
  }
  const options = {
    now: process.env.WATCHDOG_NOW || undefined,
    repository: process.env.WATCHDOG_REPOSITORY || undefined,
    defaultBranch: process.env.WATCHDOG_DEFAULT_BRANCH || undefined
  };
  if (process.env.WATCHDOG_MODE === "workflow_run") {
    const triggeredRunId = Number(process.env.WATCHDOG_TRIGGER_RUN_ID);
    const apiRun = enrichedRuns.find((run) => Number(run?.id) === triggeredRunId);
    const triggeredRun = {
      ...(apiRun || {
        has_scrape_jobs: null,
        core_jobs_succeeded: null,
        reporting_jobs_failed: null,
        reporting_only_failure: null,
        job_evidence_error: `Triggered run ${triggeredRunId || "unknown"} was not returned by the runs API.`
      }),
      id: triggeredRunId,
      event: process.env.WATCHDOG_TRIGGER_EVENT,
      status: process.env.WATCHDOG_TRIGGER_STATUS,
      conclusion: process.env.WATCHDOG_TRIGGER_CONCLUSION,
      run_attempt: Number(process.env.WATCHDOG_TRIGGER_ATTEMPT) || 1,
      created_at: process.env.WATCHDOG_TRIGGER_CREATED_AT,
      display_title: process.env.WATCHDOG_TRIGGER_TITLE,
      head_branch: process.env.WATCHDOG_TRIGGER_BRANCH,
      head_repository: { full_name: process.env.WATCHDOG_TRIGGER_REPOSITORY },
      repository: { full_name: process.env.WATCHDOG_REPOSITORY }
    };
    process.stdout.write(JSON.stringify(decideCompletedRunRecovery(
      triggeredRun,
      enrichedRuns,
      options
    )));
    return;
  }
  process.stdout.write(JSON.stringify(classifyDailyRuns(enrichedRuns, options)));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  classifyDailyRuns,
  decideCompletedRunRecovery,
  enrichRunJobEvidence,
  isTrustedDailyRun,
  selectNewestPrimaryRun
};
