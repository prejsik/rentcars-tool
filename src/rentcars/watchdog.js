#!/usr/bin/env node

const fs = require("node:fs");

const ACTIVE_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting"
]);

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWatchdogRecovery(run) {
  return run?.event === "workflow_dispatch"
    && String(run?.display_title || "").includes("RentCars watchdog recovery");
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
        has_scrape_jobs: jobs.some((job) => (
          String(job?.name || "").startsWith("Scrape chunk ")
          && job?.conclusion !== "skipped"
        ))
      };
    } catch (error) {
      return {
        ...run,
        has_scrape_jobs: null,
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
  if (primaryRun.status === "completed" && primaryRun.conclusion === "success") {
    return { action: "none", runId, runAttempt };
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
  process.stdout.write(JSON.stringify(classifyDailyRuns(enrichedRuns, {
    now: process.env.WATCHDOG_NOW || undefined
  })));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  classifyDailyRuns,
  enrichRunJobEvidence,
  selectNewestPrimaryRun
};
