const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSite, verifySite } = require("../src/rentcars/pagesSite");

const marker = '<meta name="rentcars-report-metadata-version" content="1">';
const candidate = (profile, day, id = day) => ({
  profile,
  metadata: { report_profile: profile, run_id: String(id), run_attempt: 1,
    execution_started_at: `2026-09-${day}T08:00:00Z`, generated_at: `2026-09-${day}T09:00:00Z` },
  html: `${marker}<p>${profile} ${id}</p>`
});
function options(files = {}, overrides = {}) {
  return {
    baseUrl: "https://reports.example/rentcars/", pagesExists: false,
    resolveLegacyProfile: async () => "morning",
    fetchImpl: async (url, init) => {
      assert.equal(init.headers, undefined, "public Pages requests must not contain credentials");
      const name = new URL(url).pathname.replace("/rentcars/", "");
      return { status: Object.hasOwn(files, name) ? 200 : 404, text: async () => files[name] };
    }, ...overrides
  };
}
test("morning -> afternoon -> morning preserves independent report contents and links", async () => {
  const first = await buildSite({ ...options(), ...candidate("morning", "27") });
  const second = await buildSite({ ...options(first.files), ...candidate("afternoon", "28") });
  assert.equal(second.files["morning/report.html"], first.files["morning/report.html"]);
  const third = await buildSite({ ...options(second.files), ...candidate("morning", "29") });
  assert.equal(third.files["afternoon/report.html"], second.files["afternoon/report.html"]);
  assert.match(third.files["index.html"], /morning\/report.html/);
  assert.match(third.files["index.html"], /afternoon\/report.html/);
});
test("freshness is per profile; older afternoon cannot replace afternoon but can coexist with newer morning", async () => {
  const morning = await buildSite({ ...options(), ...candidate("morning", "29") });
  const afternoon = await buildSite({ ...options(morning.files), ...candidate("afternoon", "28") });
  assert.equal(afternoon.publish, true);
  assert.equal(afternoon.files["report.html"], morning.files["report.html"]);
  const stale = await buildSite({ ...options(afternoon.files), ...candidate("afternoon", "27") });
  assert.equal(stale.publish, false);
});
test("existing root report migrates into its own profile without relabeling it", async () => {
  const legacy = candidate("morning", "27");
  delete legacy.metadata.report_profile;
  const migrated = await buildSite({ ...options({ "report.html": legacy.html,
    "report-meta.json": JSON.stringify(legacy.metadata) }), ...candidate("afternoon", "28") });
  assert.equal(migrated.files["morning/report.html"], legacy.html);
  assert.notEqual(migrated.files["afternoon/report.html"], legacy.html);
});
test("missing, corrupted or unavailable preserved reports block deployment", async () => {
  const first = await buildSite({ ...options(), ...candidate("morning", "27") });
  for (const mutation of [
    (files) => { delete files["morning/report.html"]; },
    (files) => { files["morning/report.html"] += "corrupted"; },
    (files) => { files["morning/report-meta.json"] = "{}"; }
  ]) {
    const files = { ...first.files };
    mutation(files);
    await assert.rejects(buildSite({ ...options(files), ...candidate("afternoon", "28") }));
  }
  await assert.rejects(buildSite({ ...options({}, { fetchImpl: async () => ({ status: 503 }) }),
    ...candidate("morning", "28") }), /503/);
  await assert.rejects(buildSite({ ...options({}, { pagesExists: true }), ...candidate("morning", "28") }), /missing/i);
});
test("invalid profile and candidate metadata are rejected before publishing", async () => {
  await assert.rejects(buildSite({ ...options(), ...candidate("other", "28") }), /profile/i);
  const bad = candidate("morning", "28");
  bad.metadata.execution_started_at = "invalid";
  await assert.rejects(buildSite({ ...options(), ...bad }), /timestamp/i);
});

test("older attempt and a changing public manifest cannot overwrite a report", async () => {
  const current = candidate("morning", "28");
  current.metadata.run_attempt = 2;
  const first = await buildSite({ ...options(), ...current });
  assert.equal((await buildSite({ ...options(first.files), ...candidate("morning", "28") })).publish, false);
  const stableFetch = options(first.files).fetchImpl;
  let reads = 0;
  await assert.rejects(buildSite({ ...options(first.files), ...candidate("afternoon", "29"),
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/rentcars/report-meta.json" && ++reads === 2) {
        return { status: 200, text: async () => first.files["report-meta.json"] + " " };
      }
      return stableFetch(url, init);
    }
  }), /changed/);
});

test("post-deployment verification checks both report bodies, not just root metadata", async () => {
  const first = await buildSite({ ...options(), ...candidate("morning", "27") });
  const result = await buildSite({ ...options(first.files), ...candidate("afternoon", "28") });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-pages-"));
  try {
    fs.writeFileSync(path.join(directory, "report-meta.json"), result.files["report-meta.json"]);
    fs.writeFileSync(path.join(directory, "report.html"), result.files["report.html"]);
    const config = { directory, attempts: 1, ...options(result.files) };
    await verifySite(config);
    const incomplete = { ...result.files };
    delete incomplete["morning/report.html"];
    await assert.rejects(verifySite({ ...config, ...options(incomplete) }), /deadline/);
    const missingAlias = { ...result.files };
    delete missingAlias["report.html"];
    await assert.rejects(verifySite({ ...config, ...options(missingAlias) }), /deadline/);
    await assert.rejects(verifySite({ ...config, ...options({ ...result.files, "report.html": "stale" }) }), /deadline/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
