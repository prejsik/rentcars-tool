const fs = require("fs");
const path = require("path");
const { dailyPrice } = require("./utils");

const MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN = 10;
const MM_TOP1_RUNNER_UP_PRICE_PER_DAY_THRESHOLD_PLN = 5;

function normalizeProviderName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isMmCarsProvider(value) {
  return normalizeProviderName(value).includes("mm cars rental");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatProviderRating(rating) {
  const numeric = Number(rating);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function formatProviderName(offer) {
  if (!offer) {
    return "Not available";
  }
  const name = String(offer.provider_name || "Not available").trim() || "Not available";
  const rating = formatProviderRating(offer.provider_rating);
  return rating ? `${name} (${rating})` : name;
}

function isPlnOffer(offer) {
  return String(offer?.currency || "").toUpperCase() === "PLN";
}

function isSameCurrency(left, right) {
  return String(left?.currency || "").toUpperCase() === String(right?.currency || "").toUpperCase();
}

function getRentalDaysForComparison(mmOffer, higherRankedOffer) {
  const candidates = [mmOffer?.rental_days, higherRankedOffer?.rental_days]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return candidates[0] || 1;
}

function isMmCloseToHigherRankedProvider(mmOffer, rankedOffers) {
  if (!mmOffer || !Number.isFinite(Number(mmOffer.total_price)) || !isPlnOffer(mmOffer)) {
    return false;
  }

  const topOffers = Array.isArray(rankedOffers) ? rankedOffers.filter(Boolean) : [];
  const mmRankIndex = topOffers.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  const higherRankedOffers = (mmRankIndex >= 0 ? topOffers.slice(0, mmRankIndex) : topOffers)
    .filter((offer) => offer && !isMmCarsProvider(offer.provider_name));

  for (const higherRankedOffer of higherRankedOffers) {
    if (!Number.isFinite(Number(higherRankedOffer.total_price)) || !isSameCurrency(mmOffer, higherRankedOffer)) {
      continue;
    }

    const priceDifference = Number(mmOffer.total_price) - Number(higherRankedOffer.total_price);
    if (priceDifference <= 0) {
      continue;
    }

    const rentalDays = getRentalDaysForComparison(mmOffer, higherRankedOffer);
    if (priceDifference / rentalDays <= MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN) {
      return true;
    }
  }

  return false;
}

function isMmTopRankedWithPricierRunnerUp(mmOffer, rankedOffers) {
  if (!mmOffer || !Number.isFinite(Number(mmOffer.total_price)) || !isPlnOffer(mmOffer)) {
    return false;
  }

  const topOffers = Array.isArray(rankedOffers) ? rankedOffers.filter(Boolean) : [];
  if (!topOffers.length || !isMmCarsProvider(topOffers[0]?.provider_name) || topOffers[0] !== mmOffer) {
    return false;
  }

  const runnerUp = topOffers.find((offer, index) => index > 0 && offer && !isMmCarsProvider(offer.provider_name));
  if (!runnerUp || !Number.isFinite(Number(runnerUp.total_price)) || !isSameCurrency(mmOffer, runnerUp)) {
    return false;
  }

  const priceDifference = Number(runnerUp.total_price) - Number(mmOffer.total_price);
  if (priceDifference <= 0) {
    return false;
  }

  const rentalDays = getRentalDaysForComparison(mmOffer, runnerUp);
  return priceDifference / rentalDays > MM_TOP1_RUNNER_UP_PRICE_PER_DAY_THRESHOLD_PLN;
}

function mmClassName(offer, rankedOffers) {
  if (!isMmCarsProvider(offer?.provider_name)) {
    return "";
  }
  if (isMmTopRankedWithPricierRunnerUp(offer, rankedOffers)) {
    return "mm mm-top1-gap";
  }
  return isMmCloseToHigherRankedProvider(offer, rankedOffers) ? "mm mm-close" : "mm";
}

function buildProviderCell(offer, rankedOffers) {
  const className = mmClassName(offer, rankedOffers);
  const classAttribute = className ? ` class="${className}"` : "";
  return `<td${classAttribute}>${escapeHtml(formatProviderName(offer))}</td>`;
}

function formatOfferPrice(offer) {
  if (!offer || !Number.isFinite(Number(offer.total_price))) {
    return "Not available";
  }
  const pricePerDay = Number.isFinite(Number(offer.daily_price))
    ? Number(offer.daily_price)
    : dailyPrice(offer.total_price, offer.rental_days);
  if (pricePerDay == null) {
    return "Not available";
  }
  return `${pricePerDay.toFixed(2)} ${offer.currency || ""}/day`.trim();
}

function buildPriceCell(offer, rankedOffers) {
  const className = mmClassName(offer, rankedOffers);
  const classAttribute = className ? ` class="${className}"` : "";
  return `<td${classAttribute}>${escapeHtml(formatOfferPrice(offer))}</td>`;
}

function sortOrderLabel(sortOrder) {
  const labels = {
    suggested: "sugerowane",
    price: "po cenie",
    price_insurance: "po cenie z ubezpieczeniem"
  };
  return labels[sortOrder] || sortOrder;
}

function formatDurationMs(value) {
  const totalMs = Number(value);
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    return "Not available";
  }

  const totalSeconds = Math.round(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes || hours) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return `${parts.join(" ")} (${Math.round(totalMs)} ms)`;
}

function normalizeScenarios(payload) {
  return Array.isArray(payload.scenarios) && payload.scenarios.length ? payload.scenarios : [payload];
}

function scenarioLocations(rootPayload, scenarioPayload) {
  const tableLocations = Object.keys(scenarioPayload.top_3_by_location || {}).sort((a, b) => a.localeCompare(b));
  if (tableLocations.length) {
    return tableLocations;
  }
  return Array.isArray(rootPayload.locations) ? rootPayload.locations : [];
}

function scenarioTitle(scenarioPayload, index, total) {
  const label = scenarioPayload.start_day_label || scenarioPayload.start_date || scenarioPayload.scenario_id || "Scenario";
  return `Scenario ${index + 1}/${total}: ${label} + ${scenarioPayload.rental_days} day(s)`;
}

function buildErrorsHtml(errors) {
  if (!Array.isArray(errors) || !errors.length) {
    return "";
  }

  const items = errors
    .map((error) => `<li><strong>${escapeHtml(error.location || "Unknown")}:</strong> ${escapeHtml(error.error || error.message || error)}</li>`)
    .join("\n");

  return `<details class="errors"><summary>Errors (${errors.length})</summary><ul>${items}</ul></details>`;
}

function buildScenarioRows(rootPayload, scenarioPayload) {
  const locations = scenarioLocations(rootPayload, scenarioPayload);
  const tableData = scenarioPayload.top_3_by_location || {};

  const rows = [];
  for (const location of locations) {
    const locationData = tableData[location] || {};
    const sortOrders = Array.isArray(scenarioPayload.sort_orders) && scenarioPayload.sort_orders.length
      ? scenarioPayload.sort_orders.map((item) => item.order || item)
      : Array.isArray(locationData)
        ? ["price"]
        : Object.keys(locationData);

    for (const sortOrder of sortOrders) {
      const top3 = Array.isArray(locationData)
        ? locationData
        : Array.isArray(locationData[sortOrder]) ? locationData[sortOrder] : [];
      rows.push({ location, sortOrder, top3 });
    }
  }

  return rows
    .map((row, index) => {
      const top3 = row.top3;
      const rowClass = index % 2 === 0 ? "even" : "odd";
      return `<tr class="${rowClass}">
        <td class="index">${index}</td>
        <td class="location">${escapeHtml(row.location)}</td>
        <td>${escapeHtml(sortOrderLabel(row.sortOrder))}</td>
        ${buildProviderCell(top3[0], top3)}
        ${buildPriceCell(top3[0], top3)}
        ${buildProviderCell(top3[1], top3)}
        ${buildPriceCell(top3[1], top3)}
        ${buildProviderCell(top3[2], top3)}
        ${buildPriceCell(top3[2], top3)}
      </tr>`;
    })
    .join("\n");
}

function buildScenarioTable(rootPayload, scenarioPayload, index, total) {
  const pickup = scenarioPayload.pickup_date || "";
  const dropoff = scenarioPayload.dropoff_date || "";
  const rentalDays = scenarioPayload.rental_days || "";

  return `<section class="scenario">
    <h2>${escapeHtml(scenarioTitle(scenarioPayload, index, total))}</h2>
    <div class="period">${escapeHtml(`${pickup} -> ${dropoff} (rental_days=${rentalDays})`)}</div>
    <table>
      <thead>
        <tr>
          <th>(index)</th>
          <th>location</th>
          <th>sort_order</th>
          <th>top1_offer</th>
          <th>top1_daily_price</th>
          <th>top2_offer</th>
          <th>top2_daily_price</th>
          <th>top3_offer</th>
          <th>top3_daily_price</th>
        </tr>
      </thead>
      <tbody>
        ${buildScenarioRows(rootPayload, scenarioPayload)}
      </tbody>
    </table>
    ${buildErrorsHtml(scenarioPayload.errors)}
  </section>`;
}

function buildHtmlReport(payload) {
  const scenarios = normalizeScenarios(payload);
  const generatedAt = payload.generated_at || new Date().toISOString();
  const executionStartedAt = payload.execution_started_at || "";
  const executionDuration = formatDurationMs(payload.execution_duration_ms);
  const progressText = Number.isFinite(Number(payload.expected_scenario_count))
    ? `${Number(payload.completed_scenario_count ?? scenarios.length)} / ${Number(payload.expected_scenario_count)} scenarios`
    : `${scenarios.length} scenarios`;
  const partialNotice = payload.is_partial
    ? `<div class="notice">Partial report: ${escapeHtml(progressText)} completed before the run stopped.</div>`
    : "";

  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RentCars.pl report</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #11151b;
      --line: #d7d7d7;
      --text: #e9edf2;
      --muted: #9aa4b2;
      --green: #22e642;
      --yellow-bg: #caa300;
      --yellow-text: #253040;
      --blue-bg: #1e5bd7;
      --blue-text: #ffffff;
      --red-bg: #d73535;
      --red-text: #ffffff;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
      padding: 24px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 22px;
      font-weight: 700;
    }

    .meta {
      color: var(--muted);
      margin-bottom: 24px;
      font-size: 13px;
    }

    .scenario {
      margin: 0 0 34px;
      padding-top: 8px;
      border-top: 2px solid #2d333b;
    }

    h2 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 700;
    }

    .period {
      color: var(--text);
      margin-bottom: 8px;
      font-size: 14px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #0d0f12;
      border: 2px solid var(--line);
      table-layout: auto;
    }

    th, td {
      border: 2px solid var(--line);
      padding: 8px 11px;
      text-align: left;
      white-space: nowrap;
      vertical-align: middle;
    }

    th {
      color: var(--text);
      font-weight: 700;
      background: #111;
    }

    td {
      color: var(--green);
      font-weight: 700;
    }

    td.index {
      color: var(--text);
      width: 72px;
    }

    .mm {
      background: var(--yellow-bg);
      color: var(--yellow-text);
    }

    .mm-close {
      background: var(--blue-bg);
      color: var(--blue-text);
    }

    .mm-top1-gap {
      background: var(--red-bg);
      color: var(--red-text);
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin: 0 0 18px;
      color: var(--muted);
      font-size: 13px;
    }

    .badge {
      display: inline-block;
      padding: 2px 7px;
      border: 1px solid var(--line);
      color: var(--text);
    }

    .errors {
      margin-top: 10px;
      color: #ffb4a9;
    }

    .footer {
      border-top: 2px solid #2d333b;
      color: var(--muted);
      font-size: 13px;
      margin-top: 26px;
      padding-top: 12px;
    }

    .notice {
      border: 1px solid #d97706;
      background: #fff7ed;
      color: #7c2d12;
      padding: 10px 12px;
      margin: 0 0 18px;
      font-size: 13px;
      font-weight: 700;
    }

    @media (max-width: 980px) {
      body { padding: 14px; }
      .scenario { overflow-x: auto; }
      table { min-width: 900px; }
    }
  </style>
</head>
<body>
  <h1>RentCars.pl report</h1>
  <div class="meta">Generated at: ${escapeHtml(generatedAt)} | Time zone: ${escapeHtml(payload.time_zone || "Europe/Warsaw")} | Source: ${escapeHtml(payload.source_url || "https://rentcars.pl")}</div>
  ${partialNotice}
  <div class="legend">
    <span><span class="badge mm">MM Cars Rental</span> MM Cars Rental in table</span>
    <span><span class="badge mm mm-close">MM close</span> MM Cars Rental max 10 PLN/day more expensive than a higher-ranked competitor</span>
    <span><span class="badge mm mm-top1-gap">MM top1</span> MM Cars Rental top1 and top2 more than 5 PLN/day more expensive</span>
  </div>
  ${scenarios.map((scenario, index) => buildScenarioTable(payload, scenario, index, scenarios.length)).join("\n")}
  <div class="footer">Execution started at: ${escapeHtml(executionStartedAt || "Not available")} | Execution duration: ${escapeHtml(executionDuration)}</div>
</body>
</html>`;
}

function writeHtmlReport(payload, outputPath) {
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildHtmlReport(payload), "utf8");
  return targetPath;
}

function generateReportFromFile(inputPath, outputPath) {
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  return writeHtmlReport(payload, outputPath);
}

if (require.main === module) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: node src/rentcars/reportHtml.js [input-json] [output-html]\n");
    process.exit(0);
  }

  const inputPath = process.argv[2] || "output/rentcars-results-latest.json";
  const outputPath = process.argv[3] || "output/rentcars-report.html";
  const writtenPath = generateReportFromFile(inputPath, outputPath);
  console.log(`RentCars.pl HTML report saved to ${writtenPath}`);
}

module.exports = {
  buildHtmlReport,
  generateReportFromFile,
  writeHtmlReport
};
