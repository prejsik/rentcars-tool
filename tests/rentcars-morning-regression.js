const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { yaml } = require("../node_modules/playwright-core/lib/utilsBundle");
const helperPath = path.resolve(__dirname, "../src/rentcars/morningNotification.js");
const helper = () => { assert.ok(fs.existsSync(helperPath), "morning notification helper must exist"); return require(helperPath); };
const now = Date.parse("2026-09-27T05:00:00Z");
const job = (index, status, minutes = 10) => ({
  name: `Scrape chunk ${String(index).padStart(3, "0")}`,
  status, conclusion: status === "completed" ? "success" : null,
  started_at: new Date(now - minutes * 60000).toISOString(),
  completed_at: status === "completed" ? new Date(now).toISOString() : null
});
const run = (id = 77, overrides = {}) => ({
  id, run_attempt: 2, event: "schedule", head_branch: "main",
  head_repository: { full_name: "owner/rentcars" },
  created_at: "2026-09-26T23:20:00Z", status: "in_progress", ...overrides
});
const options = { repository: "owner/rentcars", defaultBranch: "main", token: "test-token", now };

test("morning schedule uses 07:00 Warsaw and cannot trigger scraping or publishing", () => {
  const file = path.resolve(__dirname, "../.github/workflows/rentcars-morning.yml");
  assert.ok(fs.existsSync(file), "morning workflow must exist");
  const source = fs.readFileSync(file, "utf8");
  const workflow = yaml.parse(source);
  assert.deepEqual(workflow.on.schedule, [{ cron: "0 7 * * *", timezone: "Europe/Warsaw" }]);
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read", pages: "read" });
  assert.equal(workflow.jobs.notify.environment, undefined);
  assert.doesNotMatch(source, /deploy-pages|\/dispatches|\/rerun|node src\/rentcars\/run\.js/);
  assert.match(source, /if: always\(\)/);
});

test("ETA models parallel batches and remains a range", () => {
  const jobs = [job(1, "completed"), job(2, "completed"), job(3, "in_progress", 5), job(4, "in_progress", 5), job(5, "queued")];
  const eta = helper().estimateRemaining(jobs, { now, concurrency: 2 });
  assert.ok(eta.lowMinutes > 0);
  assert.ok(eta.highMinutes >= eta.lowMinutes);
  assert.ok(eta.highMinutes < 40);
});

test("ETA is unknown for insufficient samples, runner queue, failures or overdue jobs", () => {
  for (const jobs of [
    [job(1, "completed"), job(2, "in_progress", 2)],
    [job(1, "completed"), job(2, "completed"), job(3, "queued")],
    [job(1, "completed"), job(2, "completed"), { ...job(3, "completed"), conclusion: "failure" }, job(4, "in_progress")],
    [job(1, "completed"), job(2, "completed"), job(3, "in_progress", 40)]
  ]) assert.equal(helper().estimateRemaining(jobs, { now, concurrency: 6 }), null);
});

function mockApi({ runs = [run()], jobs, metadata = null, html = '<meta name="rentcars-report-metadata-version" content="1">' } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); calls.push({ url: url.toString(), init });
    let data;
    if (url.pathname.endsWith("/rentcars-daily.yml/runs")) data = { workflow_runs: runs };
    else if (url.pathname.endsWith("/jobs")) data = { total_count: (jobs || []).length, jobs: jobs || [] };
    else if (url.pathname.endsWith("/pages")) data = { html_url: "https://reports.example/rentcars/" };
    else if (url.pathname.endsWith("/report-meta.json")) data = metadata;
    else if (url.pathname.endsWith("/report.html")) return { ok: html != null, status: html == null ? 404 : 200, text: async () => html };
    else throw new Error(`Unexpected URL ${url}`);
    return { ok: data != null, status: data == null ? 404 : 200, json: async () => data };
  };
  return { fetchImpl, calls };
}

test("morning status reports incomplete work with ETA, never today's old report", async () => {
  const api = mockApi({ jobs: [job(1, "completed"), job(2, "completed"), job(3, "in_progress", 5)], metadata: { run_id: "77", run_attempt: 1 } });
  const message = await helper().collectMorningMessage({ ...options, ...api });
  assert.match(message, /2\/3/);
  assert.match(message, /Szacowany czas/);
  assert.doesNotMatch(message, /report\.html/);
  assert.ok(api.calls.every(call => !call.init.method || call.init.method === "GET"));
  assert.ok(api.calls.filter(call => call.url.startsWith("https://reports.example")).every(call => !call.init.headers?.Authorization));
});

test("verified current report is linked with completeness counts and no ETA", async () => {
  const api = mockApi({ jobs: [job(1, "completed")], metadata: {
    run_id: "77", run_attempt: 2, run_status: "complete", expected_check_count: 9,
    successful_check_count: 9, failed_check_count: 0, missing_check_count: 0
  } });
  const message = await helper().collectMorningMessage({ ...options, ...api });
  assert.match(message, /Raport kompletny/);
  assert.match(message, /9\/9/);
  assert.match(message, /https:\/\/reports.example\/rentcars\/morning\/report.html/);
  assert.ok(api.calls.some(({ url }) => new URL(url).pathname.endsWith("/morning/report-meta.json")));
  assert.ok(api.calls.some(({ url }) => new URL(url).pathname.endsWith("/morning/report.html")));
  assert.doesNotMatch(message, /Szacowany czas/);
});

test("failed partial report does not invent a completion time", async () => {
  const api = mockApi({ runs: [run(77, { status: "completed", conclusion: "failure" })], jobs: [{ ...job(1, "completed"), conclusion: "failure" }], metadata: {
    run_id: "77", run_attempt: 2, run_status: "partial", expected_check_count: 9,
    successful_check_count: 4, failed_check_count: 1, missing_check_count: 4
  } });
  const message = await helper().collectMorningMessage({ ...options, ...api });
  assert.match(message, /Raport niekompletny/);
  assert.match(message, /4\/9/);
  assert.match(message, /Uruchomienie zakonczone/);
  assert.doesNotMatch(message, /Po zakonczeniu|Szacowany czas/);
});

test("no morning run today never reports a daytime, old or manual run as today's result", async () => {
  const api = mockApi({ runs: [
    run(79, { display_title: "RentCars daytime run" }),
    run(78, { event: "workflow_dispatch" }),
    run(77, { created_at: "2026-09-25T23:20:00Z" })
  ] });
  assert.match(await helper().collectMorningMessage({ ...options, ...api }), /Brak dzisiejszego/);
  assert.equal(api.calls.length, 1);
});

test("successful skipped schedule companion does not hide primary work", async () => {
  const api = mockApi({ jobs: [job(1, "in_progress", 3)] });
  const original = api.fetchImpl;
  api.fetchImpl = async (input, init) => {
    if (String(input).includes("rentcars-daily.yml/runs")) return { ok: true, json: async () => ({ workflow_runs: [run(78, { status: "completed", conclusion: "success", created_at: "2026-09-27T00:20:00Z" }), run()] }) };
    if (String(input).includes("/runs/78/")) return { ok: true, json: async () => ({ total_count: 1, jobs: [{ ...job(1, "completed"), conclusion: "skipped" }] }) };
    return original(input, init);
  };
  assert.match(await helper().collectMorningMessage({ ...options, ...api }), /runs\/77/);
});

test("Warsaw dates follow summer and winter time", () => {
  assert.equal(helper().warsawDate(Date.parse("2026-09-26T22:30:00Z")), "2026-09-27");
  assert.equal(helper().warsawDate(Date.parse("2026-12-26T23:30:00Z")), "2026-12-27");
});

test("queued workflow can have active jobs and a credible ETA", async () => {
  const api = mockApi({ runs: [run(77, { status: "queued" })], jobs: [job(1, "completed"), job(2, "completed"), job(3, "in_progress", 5)] });
  assert.match(await helper().collectMorningMessage({ ...options, ...api }), /Szacowany czas/);
});

test("jobs pagination includes every page and rejects truncated evidence", async () => {
  for (const truncated of [false, true]) {
    const api = mockApi();
    const original = api.fetchImpl;
    api.fetchImpl = async (input, init) => {
      if (!String(input).includes("/jobs?")) return original(input, init);
      const page = Number(new URL(input).searchParams.get("page"));
      const jobs = page === 1 ? Array.from({ length: truncated ? 10 : 100 }, (_, i) => job(i, "completed"))
        : truncated ? [] : [job(100, "in_progress", 5)];
      return { ok: true, json: async () => ({ total_count: 101, jobs }) };
    };
    if (truncated) await assert.rejects(helper().collectMorningMessage({ ...options, ...api }), /incomplete/);
    else assert.match(await helper().collectMorningMessage({ ...options, ...api }), /100\/101/);
  }
});

test("unavailable or non-report HTML is never linked", async () => {
  for (const html of [null, "<html>Not a report</html>"]) {
    const api = mockApi({ jobs: [job(1, "completed")], html, metadata: {
      run_id: "77", run_attempt: 2, run_status: "complete", expected_check_count: 9,
      successful_check_count: 9, failed_check_count: 0, missing_check_count: 0
    } });
    assert.doesNotMatch(await helper().collectMorningMessage({ ...options, ...api }), /report\.html/);
  }
});

test("send step previews without sending and sends fallback after inspection failure", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const workflow = yaml.parse(fs.readFileSync(path.resolve(__dirname, "../.github/workflows/rentcars-morning.yml"), "utf8"));
  const step = workflow.jobs.notify.steps.find(step => step.name === "Send or preview morning message");
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const [send, outcome] of [[false, "success"], [true, "success"], [true, "failure"], [true, "skipped"]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-morning-test-"));
    try {
      fs.writeFileSync(path.join(dir, "rentcars-morning.txt"), "Verified test status");
      const script = 'curl() { printf "%s\\n" "$@" > "$RUNNER_TEMP/captured.txt"; };\n' + step.run;
      const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
        encoding: "utf8", env: { ...process.env, RUNNER_TEMP: dir.replace(/\\/g, "/"),
          GITHUB_STEP_SUMMARY: path.join(dir, "summary.txt").replace(/\\/g, "/"),
          SEND_NOTIFICATION: String(send), STATUS_OUTCOME: outcome,
          TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_CHAT_ID: "fake", RUN_URL: "https://github.com/test/run" }
      });
      assert.equal(result.status, 0, result.stderr);
      const captured = path.join(dir, "captured.txt");
      assert.equal(fs.existsSync(captured), send);
      if (send) {
        const args = fs.readFileSync(captured, "utf8");
        assert.match(args, outcome === "success" ? /Verified test status/ : /Nie udalo sie odczytac/);
        assert.match(args, /--output\n\/dev\/null/);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("finished collection awaiting publication does not pretend to be scraping", async () => {
  const api = mockApi({ jobs: [job(1, "completed"), job(2, "completed")] });
  const message = await helper().collectMorningMessage({ ...options, ...api });
  assert.match(message, /Zbieranie danych zakonczone/);
  assert.match(message, /scalenie i publikacje/);
  assert.doesNotMatch(message, /Szacowany czas do konca zbierania/);
});
