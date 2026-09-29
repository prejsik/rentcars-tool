const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { yaml } = require("../node_modules/playwright-core/lib/utilsBundle");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_RUN_ID = "36573506556";

function writeArtifact(directory, mutate = () => {}) {
  const executionStartedAt = "2026-09-28T23:17:00.000Z";
  const generatedAt = "2026-09-29T02:30:00.000Z";
  const results = {
    execution_started_at: executionStartedAt,
    generated_at: generatedAt,
    run_status: "complete",
    is_partial: false,
    completed_scenario_count: 2,
    expected_scenario_count: 2,
    successful_check_count: 18,
    failed_check_count: 0,
    missing_check_count: 0,
    expected_check_count: 18,
    scenarios: [
      { start_date: "2026-09-30", rental_days: 2, run_status: "complete", expected_check_count: 9, successful_check_count: 9, failed_check_count: 0 },
      { start_date: "2026-09-30", rental_days: 3, run_status: "complete", expected_check_count: 9, successful_check_count: 9, failed_check_count: 0 }
    ]
  };
  const metadata = {
    run_id: SOURCE_RUN_ID,
    run_attempt: 1,
    report_profile: "morning",
    execution_started_at: executionStartedAt,
    generated_at: generatedAt,
    run_status: "complete",
    completed_scenario_count: 2,
    expected_scenario_count: 2,
    successful_check_count: 18,
    failed_check_count: 0,
    missing_check_count: 0,
    expected_check_count: 18
  };
  mutate({ metadata, results });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "rentcars-results-latest.json"), `${JSON.stringify(results)}\n`);
  fs.writeFileSync(path.join(directory, "rentcars-report-meta.json"), `${JSON.stringify(metadata)}\n`);
  fs.writeFileSync(path.join(directory, "rentcars-report.html"), '<meta name="rentcars-report-metadata-version" content="1"><h1>Report</h1>');
}

test("artifact validation preserves source timestamps and requires complete internally consistent scope", () => {
  const { validateRecoveredReport } = require("../src/rentcars/recoverReport");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-recovery-"));
  try {
    writeArtifact(directory);
    const metadataPath = path.join(directory, "rentcars-report-meta.json");
    const before = fs.readFileSync(metadataPath, "utf8");
    const result = validateRecoveredReport({ directory, runId: SOURCE_RUN_ID, attempt: "1" });
    assert.deepEqual(result, {
      reportProfile: "morning",
      sourceTimestamp: "2026-09-28T23:17:00.000Z"
    });
    assert.equal(fs.readFileSync(metadataPath, "utf8"), before);

    writeArtifact(directory, ({ results }) => {
      results.scenarios[1].expected_check_count = 8;
      results.scenarios[1].successful_check_count = 8;
    });
    assert.throws(
      () => validateRecoveredReport({ directory, runId: SOURCE_RUN_ID, attempt: "1" }),
      /scenario scope/i
    );
    for (const mutate of [
      ({ metadata }) => { metadata.run_id = "different-run"; },
      ({ metadata }) => { metadata.run_attempt = 2; },
      ({ metadata }) => { metadata.report_profile = "other"; },
      ({ metadata, results }) => { metadata.failed_check_count = results.failed_check_count = 1; },
      ({ results }) => { results.execution_started_at = "2026-09-29T10:00:00Z"; }
    ]) {
      writeArtifact(directory, mutate);
      assert.throws(() => validateRecoveredReport({ directory, runId: SOURCE_RUN_ID, attempt: "1" }));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery workflow downloads one existing merged artifact and only publishes validated files", () => {
  const workflowPath = path.join(ROOT, ".github/workflows/rentcars-report-recovery.yml");
  const recovery = yaml.parse(fs.readFileSync(workflowPath, "utf8"));
  const publish = recovery.jobs.publish;
  const steps = publish.steps;
  const source = steps.find((step) => step.id === "source");
  const download = steps.find((step) => step.uses === "actions/download-artifact@v4");
  const freshness = steps.find((step) => step.id === "freshness");
  const deploy = steps.find((step) => step.id === "pages-deployment");
  const verify = steps.find((step) => step.name === "Verify published report slots");

  assert.deepEqual(recovery.permissions, { actions: "read", contents: "read", pages: "write", "id-token": "write" });
  assert.deepEqual(Object.keys(recovery.on.workflow_dispatch.inputs), ["source_run_id", "source_attempt", "replace_run_id"]);
  assert.equal(recovery.on.workflow_dispatch.inputs.replace_run_id.default, "");
  assert.equal(publish.concurrency.group, "rentcars-pages-publication");
  assert.equal(publish.concurrency["cancel-in-progress"], false);
  assert.equal(publish.environment.name, "github-pages");
  assert.match(source.run, /actions\/runs\/\$\{sourceRunId\}\/attempts\/\$\{sourceAttempt\}/);
  assert.match(source.run, /actions\/workflows\/rentcars-daily\.yml/);
  assert.match(source.run, /Cache-Control[^\n]+no-cache/);
  assert.match(source.run, /inspection=/);
  assert.match(source.run, /head_branch[^\n]+main/);
  assert.ok(download);
  assert.equal(download.with.name, "${{ steps.source.outputs.artifact_name }}");
  assert.equal(download.with["github-token"], "${{ github.token }}");
  assert.equal(download.with["run-id"], "${{ inputs.source_run_id }}");
  assert.equal(freshness.env.REPORT_PROFILE, "${{ steps.validation.outputs.report_profile }}");
  assert.equal(freshness.env.REPLACE_REPORT_RUN_ID, "${{ inputs.replace_run_id }}");
  assert.equal(deploy.if, "steps.freshness.outputs.publish == 'true'");
  assert.equal(verify.if, "steps.pages-deployment.outcome == 'success'");
  assert.equal(verify.run.trim(), "node src/rentcars/pagesSite.js --verify");
  assert.equal(Object.hasOwn(recovery.jobs, "scrape"), false);
  assert.equal(Object.hasOwn(recovery.jobs, "notify"), false);
  assert.doesNotMatch(JSON.stringify(recovery), /telegram/i);
});
