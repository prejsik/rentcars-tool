#!/usr/bin/env node

const { isTrustedDailyRun } = require("./watchdog");

const TIME_ZONE = "Europe/Warsaw";
const isScrape = (job) => String(job?.name || "").startsWith("Scrape chunk ");
const finished = (job) => job.status === "completed";
const successful = (job) => finished(job) && job.conclusion === "success";

function warsawDate(time) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
}

function estimateRemaining(jobs, { now, concurrency = 6 }) {
  const chunks = jobs.filter(isScrape);
  if (chunks.some((job) => finished(job) && !successful(job))) return null;
  const samples = chunks.filter(successful).map((job) =>
    (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60000
  ).filter((minutes) => Number.isFinite(minutes) && minutes > 0).sort((a, b) => a - b);
  const active = chunks.filter((job) => job.status === "in_progress");
  if (samples.length < 2 || !active.length || !Number.isInteger(concurrency) || concurrency < 1) return null;
  const lowDuration = samples[Math.floor((samples.length - 1) * 0.25)] * 0.8;
  const highDuration = samples[Math.ceil((samples.length - 1) * 0.75)] * 1.3;
  const elapsed = active.map((job) => (now - Date.parse(job.started_at)) / 60000);
  if (elapsed.some((minutes) => !Number.isFinite(minutes) || minutes < 0 || minutes >= highDuration)) return null;
  const queued = chunks.filter((job) => !finished(job) && job.status !== "in_progress").length;
  // Simulate remaining batches on the same parallel worker limit as the daily workflow.
  const predict = (duration) => {
    const lanes = elapsed.map((minutes) => Math.max(0, duration - minutes));
    while (lanes.length < concurrency) lanes.push(0);
    for (let index = 0; index < queued; index += 1) {
      const firstFree = lanes.indexOf(Math.min(...lanes));
      lanes[firstFree] += duration;
    }
    return Math.max(...lanes);
  };
  return {
    lowMinutes: Math.max(5, Math.floor(predict(lowDuration) / 5) * 5),
    highMinutes: Math.max(5, Math.ceil(predict(highDuration) / 5) * 5)
  };
}

async function collectMorningMessage({ repository, defaultBranch, token, now = Date.now(), concurrency = 6,
  fetchImpl = globalThis.fetch, apiUrl = "https://api.github.com", serverUrl = "https://github.com" }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || !defaultBranch || !token) {
    throw new Error("Missing repository, branch or GitHub read token.");
  }
  const api = async (suffix) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/${suffix}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`GitHub inspection failed: HTTP ${response.status}.`);
    return response.json();
  };
  const date = warsawDate(now);
  const header = `RentCars.pl: status poranny 07:00 | ${date}\nStan na ${new Intl.DateTimeFormat("pl-PL", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(new Date(now))} (${TIME_ZONE}).`;
  const payload = await api(`actions/workflows/rentcars-daily.yml/runs?branch=${encodeURIComponent(defaultBranch)}&per_page=100`);
  const runs = (payload.workflow_runs || []).filter((run) =>
    isTrustedDailyRun(run, { repository, defaultBranch })
    && Number.isFinite(Date.parse(run.created_at)) && Date.parse(run.created_at) <= now
    && warsawDate(Date.parse(run.created_at)) === date
  ).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  let selected;
  let jobs;
  for (const run of runs) {
    const collected = [];
    for (let page = 1; page <= 10; page += 1) {
      const data = await api(`actions/runs/${run.id}/attempts/${run.run_attempt || 1}/jobs?per_page=100&page=${page}`);
      if (!Array.isArray(data.jobs) || !Number.isInteger(data.total_count) || data.total_count < 0) {
        throw new Error("GitHub jobs response is incomplete.");
      }
      collected.push(...data.jobs);
      if (collected.length >= data.total_count) break;
      if (data.jobs.length < 100) throw new Error("GitHub jobs response is incomplete.");
      if (page === 10) throw new Error("GitHub jobs response exceeded inspection limit.");
    }
    const hasWork = collected.some((job) => isScrape(job) && job.conclusion !== "skipped");
    if (!hasWork && run.status === "completed" && run.conclusion === "success") continue;
    selected = run; jobs = collected; break;
  }
  if (!selected) return `${header}\n\nBrak dzisiejszego uruchomienia zbierajacego dane.\nETA: nie mozna oszacowac przed startem.\n\nGitHub Actions:\n${serverUrl}/${repository}/actions/workflows/rentcars-daily.yml`;
  const runUrl = `${serverUrl}/${repository}/actions/runs/${selected.id}`;
  const chunks = jobs.filter(isScrape);
  const successCount = chunks.filter(successful).length;
  const failedCount = chunks.filter((job) => finished(job) && job.conclusion !== "success" && job.conclusion !== "skipped").length;
  const runningCount = chunks.filter((job) => job.status === "in_progress").length;
  const waitingCount = chunks.filter((job) => !finished(job) && job.status !== "in_progress").length;
  const sections = [header, `Proba: ${selected.run_attempt || 1}. Status GitHub: ${selected.status}${selected.conclusion ? ` / ${selected.conclusion}` : ""}.`,
    `Paczki zakonczone poprawnie: ${successCount}/${chunks.length}. W toku: ${runningCount}; oczekuje: ${waitingCount}; bledy: ${failedCount}.\nTo postep paczek, nie dokladny procent sprawdzonych ofert.`];
  let report = null;
  try {
    const site = await api("pages");
    const base = new URL(site.html_url);
    if (base.protocol !== "https:") throw new Error("Invalid Pages URL.");
    const prefix = base.href.replace(/\/$/, "") + "/";
    const query = `?run=${selected.id}&attempt=${selected.run_attempt || 1}&checked=${now}`;
    // Public report requests deliberately have no GitHub credentials.
    const metadataResponse = await fetchImpl(`${prefix}report-meta.json${query}`, { signal: AbortSignal.timeout(10000) });
    if (metadataResponse.ok) {
      const metadata = await metadataResponse.json();
      const matches = String(metadata.run_id) === String(selected.id)
        && Number(metadata.run_attempt) === Number(selected.run_attempt || 1);
      const fields = ["expected_check_count", "successful_check_count", "failed_check_count", "missing_check_count"];
      if (matches && fields.every((field) => Number.isInteger(metadata[field]) && metadata[field] >= 0)) {
        const htmlResponse = await fetchImpl(`${prefix}report.html${query}`, { signal: AbortSignal.timeout(10000) });
        if (htmlResponse.ok && (await htmlResponse.text()).includes('<meta name="rentcars-report-metadata-version" content="1">')) {
          report = { ...metadata, url: `${prefix}report.html` };
        }
      }
    }
  } catch {
    // Progress is still useful when publication is unavailable or has not finished.
  }
  const complete = report?.run_status === "complete" && report.expected_check_count > 0
    && report.successful_check_count === report.expected_check_count
    && report.failed_check_count === 0 && report.missing_check_count === 0;
  if (report) {
    sections.push(`${complete ? "Raport kompletny" : "Raport niekompletny"}. Sprawdzenia poprawne: ${report.successful_check_count}/${report.expected_check_count}; bledy: ${report.failed_check_count}; brakujace: ${report.missing_check_count}.\n\nHTML:\n${report.url}`);
  } else {
    sections.push("Publikacja HTML biezacej proby nie jest jeszcze potwierdzona.");
  }
  if (!complete) {
    if (selected.status === "completed") {
      sections.push("Uruchomienie zakonczone, ale kompletny opublikowany raport nie jest potwierdzony. ETA nie dotyczy zakonczonej proby; sprawdz diagnostyke w GitHub Actions.");
    } else {
      if (chunks.length > 0 && chunks.every(finished)) {
        sections.push("Zbieranie danych zakonczone. Oczekiwanie na scalenie i publikacje; ETA tego etapu niedostepne.");
      } else {
        const eta = estimateRemaining(jobs, { now, concurrency });
        if (eta) sections.push(`Szacowany czas do konca zbierania: ${eta.lowMinutes}-${eta.highMinutes} min.\nPrzy obecnym tempie, bez dodatkowych kolejek i ponowien. Scalenie i publikacja moga wydluzyc ten czas.`);
        else sections.push("ETA: nie mozna jeszcze wiarygodnie oszacowac (kolejka, blad lub zbyt malo zakonczonych paczek).");
      }
      sections.push("Po zakonczeniu pozostaje wlaczona osobna wiadomosc z wynikiem.");
    }
  }
  sections.push(`GitHub Actions:\n${runUrl}`);
  return sections.join("\n\n");
}

if (require.main === module) {
  collectMorningMessage({
    repository: process.env.GITHUB_REPOSITORY, defaultBranch: process.env.DEFAULT_BRANCH,
    token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL, serverUrl: process.env.GITHUB_SERVER_URL,
    concurrency: Number(process.env.LOCATION_CHUNK_CONCURRENCY || 6)
  }).then((message) => process.stdout.write(`${message}\n`)).catch(() => {
    console.error("Morning status inspection failed; the workflow will send a fallback status.");
    process.exitCode = 1;
  });
}

module.exports = { warsawDate, estimateRemaining, collectMorningMessage };
