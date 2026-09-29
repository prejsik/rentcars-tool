#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const PROFILES = ["morning", "afternoon"];
const MARKER = '<meta name="rentcars-report-metadata-version" content="1">';
const digest = (text) => createHash("sha256").update(text).digest("hex");
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function validate(metadata, html) {
  if (!metadata || !Number.isFinite(Date.parse(metadata.execution_started_at))) {
    throw new Error("Invalid report execution timestamp.");
  }
  if (!metadata.run_id || !Number.isInteger(metadata.run_attempt) || metadata.run_attempt < 1 || !html?.includes(MARKER)) {
    throw new Error("Invalid report identity or HTML marker.");
  }
}

function newer(a, b) {
  const difference = Date.parse(a.execution_started_at) - Date.parse(b.execution_started_at);
  if (difference) return difference > 0;
  if (String(a.run_id) === String(b.run_id)) return a.run_attempt > b.run_attempt;
  return Date.parse(a.generated_at || 0) > Date.parse(b.generated_at || 0);
}

async function buildSite({ profile, metadata, html, baseUrl, pagesExists = true,
  resolveLegacyProfile, fetchImpl = globalThis.fetch }) {
  if (!PROFILES.includes(profile) || metadata.report_profile !== profile) throw new Error("Invalid report profile.");
  validate(metadata, html);
  const prefix = baseUrl.replace(/\/$/, "") + "/";
  if (new URL(prefix).protocol !== "https:") throw new Error("Pages URL must use HTTPS.");
  const read = async (name) => {
    const response = await fetchImpl(`${prefix}${name}?publication=${metadata.run_id}-${metadata.run_attempt}-${Date.now()}`, {
      signal: AbortSignal.timeout(20000), cache: "no-store"
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Cannot preserve ${name}: HTTP ${response.status}.`);
    return response.text();
  };
  const rootText = await read("report-meta.json");
  const rootHtml = await read("report.html");
  const reports = {};
  if (rootText === null || rootHtml === null) {
    if (pagesExists || rootText !== null || rootHtml !== null) throw new Error("Existing Pages report is missing; publication blocked.");
  } else {
    const root = JSON.parse(rootText);
    validate(root, rootHtml);
    if (root.publication_profiles) {
      if (Object.keys(root.publication_profiles).some((key) => !PROFILES.includes(key))
        || Object.keys(root.publication_profiles).length === 0) throw new Error("Invalid publication manifest.");
      for (const [name, hashes] of Object.entries(root.publication_profiles)) {
        const savedMeta = await read(`${name}/report-meta.json`);
        const savedHtml = await read(`${name}/report.html`);
        if (savedMeta === null || savedHtml === null
          || digest(savedMeta) !== hashes.metadata_sha256 || digest(savedHtml) !== hashes.html_sha256) {
          throw new Error(`Cannot preserve ${name}: missing or inconsistent report files.`);
        }
        const parsed = JSON.parse(savedMeta);
        validate(parsed, savedHtml);
        if (parsed.report_profile !== name) throw new Error(`Invalid ${name} profile metadata.`);
        reports[name] = { metadata: parsed, metaText: savedMeta, html: savedHtml };
      }
    } else {
      // One-time migration of the existing report; never relabel morning data as afternoon.
      const legacyProfile = root.report_profile || await resolveLegacyProfile(root);
      if (!PROFILES.includes(legacyProfile)) throw new Error("Cannot identify legacy report profile.");
      root.report_profile = legacyProfile;
      reports[legacyProfile] = { metadata: root, metaText: serialize(root), html: rootHtml };
    }
    if (await read("report-meta.json") !== rootText) throw new Error("Pages changed while preparing the site; publication blocked.");
  }
  if (reports[profile] && newer(reports[profile].metadata, metadata)) return { publish: false, files: {} };
  reports[profile] = { metadata, metaText: serialize(metadata), html };
  const files = {};
  const manifest = {};
  let latest;
  for (const [name, report] of Object.entries(reports)) {
    files[`${name}/report.html`] = report.html;
    files[`${name}/report-meta.json`] = report.metaText;
    manifest[name] = { metadata_sha256: digest(report.metaText), html_sha256: digest(report.html) };
    if (!latest || newer(report.metadata, latest.metadata)) latest = report;
  }
  // Keep historical /report.html links useful without merging the two report slots.
  files["report.html"] = latest.html;
  files["report-meta.json"] = serialize({ ...latest.metadata, publication_profiles: manifest });
  files["index.html"] = '<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RentCars - raporty</title><h1>RentCars - raporty</h1><ul>'
    + PROFILES.map((name) => `<li>${reports[name] ? `<a href="${name}/report.html">` : ""}${name === "morning" ? "Poranny" : "Popoludniowy"}${reports[name] ? "</a>" : " - oczekuje na pierwsza publikacje"}</li>`).join("") + "</ul></html>\n";
  return { publish: true, files };
}

async function main() {
  const output = process.env.GITHUB_OUTPUT;
  const verifying = process.argv.includes("--verify");
  if (!verifying) fs.appendFileSync(output, "publish=false\n");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("Invalid GitHub repository.");
  const api = async (suffix) => fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}/${suffix}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20000)
  });
  const site = await api("pages");
  if (![200, 404].includes(site.status)) throw new Error(`Cannot inspect Pages: HTTP ${site.status}.`);
  const [owner, repo] = repository.split("/");
  const baseUrl = site.status === 200 ? (await site.json()).html_url : `https://${owner}.github.io/${repo}/`;
  if (verifying) {
    await verifySite({ baseUrl, directory: "pages" });
    console.log("Both published report slots verified.");
    return;
  }
  const result = await buildSite({
    profile: process.env.REPORT_PROFILE,
    metadata: JSON.parse(fs.readFileSync("output/rentcars-report-meta.json", "utf8")),
    html: fs.readFileSync("output/rentcars-report.html", "utf8"),
    baseUrl, pagesExists: site.status === 200,
    resolveLegacyProfile: async (metadata) => {
      if (!/^\d+$/.test(String(metadata.run_id))) throw new Error("Invalid legacy run ID.");
      const response = await api(`actions/runs/${metadata.run_id}`);
      if (!response.ok) throw new Error(`Cannot identify legacy run: HTTP ${response.status}.`);
      const run = await response.json();
      return run.display_title === "RentCars daytime run" ? "afternoon" : "morning";
    }
  });
  if (!result.publish) { console.log("A newer report exists for this profile; keeping artifact only."); return; }
  for (const [name, content] of Object.entries(result.files)) {
    const destination = path.join("pages", name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  fs.appendFileSync(output, "publish=true\n");
}

async function verifySite({ baseUrl, directory, fetchImpl = globalThis.fetch,
  attempts = 12, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const rootText = fs.readFileSync(path.join(directory, "report-meta.json"), "utf8");
  const manifest = JSON.parse(rootText).publication_profiles;
  const expected = {
    "report-meta.json": digest(rootText),
    "report.html": digest(fs.readFileSync(path.join(directory, "report.html"), "utf8"))
  };
  for (const [profile, hashes] of Object.entries(manifest)) {
    expected[`${profile}/report-meta.json`] = hashes.metadata_sha256;
    expected[`${profile}/report.html`] = hashes.html_sha256;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let matches = true;
    for (const [name, hash] of Object.entries(expected)) {
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/${name}?verify=${Date.now()}-${attempt}`, {
          signal: AbortSignal.timeout(10000), cache: "no-store"
        });
        if (response.status !== 200 || digest(await response.text()) !== hash) matches = false;
      } catch { matches = false; }
      if (!matches) break;
    }
    if (matches) return;
    if (attempt + 1 < attempts) await sleep(10000);
  }
  throw new Error("Published report slots did not become visible before the verification deadline.");
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildSite, verifySite };
