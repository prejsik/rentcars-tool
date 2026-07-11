const fs = require("fs");
const path = require("path");
const { dailyPrice } = require("./utils");

const MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN = 10;
const MM_TOP1_RUNNER_UP_PRICE_PER_DAY_THRESHOLD_PLN = 10;
const MM_TOP1_GAP_20_PRICE_PER_DAY_THRESHOLD_PLN = 20;
const MM_TOP1_GAP_30_PRICE_PER_DAY_THRESHOLD_PLN = 30;
const TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN = 150;

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

function getMmTop1GapPerDay(mmOffer, rankedOffers) {
  if (!mmOffer || !Number.isFinite(Number(mmOffer.total_price)) || !isPlnOffer(mmOffer)) {
    return null;
  }

  const topOffers = Array.isArray(rankedOffers) ? rankedOffers.filter(Boolean) : [];
  if (!topOffers.length || !isMmCarsProvider(topOffers[0]?.provider_name) || topOffers[0] !== mmOffer) {
    return null;
  }

  const runnerUp = topOffers.find((offer, index) => index > 0 && offer && !isMmCarsProvider(offer.provider_name));
  if (!runnerUp || !Number.isFinite(Number(runnerUp.total_price)) || !isSameCurrency(mmOffer, runnerUp)) {
    return null;
  }

  const priceDifference = Number(runnerUp.total_price) - Number(mmOffer.total_price);
  if (priceDifference <= 0) {
    return null;
  }

  const rentalDays = getRentalDaysForComparison(mmOffer, runnerUp);
  return priceDifference / rentalDays;
}

function getMmTop1GapState(mmOffer, rankedOffers) {
  const gapPerDay = getMmTop1GapPerDay(mmOffer, rankedOffers);
  if (!Number.isFinite(gapPerDay) || gapPerDay <= MM_TOP1_RUNNER_UP_PRICE_PER_DAY_THRESHOLD_PLN) {
    return null;
  }
  if (gapPerDay >= MM_TOP1_GAP_30_PRICE_PER_DAY_THRESHOLD_PLN) {
    return "top1-gap-30";
  }
  if (gapPerDay >= MM_TOP1_GAP_20_PRICE_PER_DAY_THRESHOLD_PLN) {
    return "top1-gap-20";
  }
  return "top1-gap";
}

function mmClassName(offer, rankedOffers) {
  if (!isMmCarsProvider(offer?.provider_name)) {
    return "";
  }
  const top1GapState = getMmTop1GapState(offer, rankedOffers);
  if (top1GapState) {
    return `mm mm-${top1GapState}`;
  }
  return isMmCloseToHigherRankedProvider(offer, rankedOffers) ? "mm mm-close" : "mm";
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

function offerViewSpan(mode, content, className = "") {
  const classes = ["offer-view", `offer-view-${mode}`, className].filter(Boolean).join(" ");
  return `<span class="${classes}">${content}</span>`;
}

function buildDualCell(automaticContent, allContent, automaticClass = "", allClass = "") {
  return `<td class="view-cell">${offerViewSpan("automatic", automaticContent, automaticClass)}${offerViewSpan("all", allContent, allClass)}</td>`;
}

function rankOffersByProvider(offers) {
  const byProvider = new Map();
  for (const offer of offers) {
    const providerKey = normalizeProviderName(offer?.provider_name);
    if (!providerKey || !Number.isFinite(Number(offer?.total_price))) {
      continue;
    }
    const existing = byProvider.get(providerKey);
    if (!existing || Number(offer.total_price) < Number(existing.total_price)) {
      byProvider.set(providerKey, offer);
    }
  }
  return [...byProvider.values()].sort(
    (left, right) => Number(left.total_price) - Number(right.total_price)
  );
}

function rankedOffersForView(scenarioPayload, location, sortOrder, legacyTop3, mode) {
  const matchingResults = (Array.isArray(scenarioPayload.results) ? scenarioPayload.results : [])
    .filter((offer) => {
      const offerLocation = String(offer.pickup_location || offer.location || "").toLowerCase();
      const offerSortOrder = offer.sort_order || "suggested";
      return offerLocation === String(location).toLowerCase() && offerSortOrder === sortOrder;
    });
  const sourceOffers = matchingResults.length ? matchingResults : legacyTop3;
  const hasTransmissionMetadata = sourceOffers.some((offer) =>
    ["automatic", "manual"].includes(String(offer?.transmission || "").toLowerCase())
  );
  const viewOffers = mode === "automatic" && hasTransmissionMetadata
    ? sourceOffers.filter((offer) => String(offer?.transmission || "").toLowerCase() === "automatic")
    : sourceOffers;
  return rankOffersByProvider(viewOffers);
}

function getMmState(rankedOffers) {
  const mmOffer = rankedOffers.find((offer) => isMmCarsProvider(offer?.provider_name));
  if (!mmOffer) {
    return "missing";
  }
  const top1GapState = getMmTop1GapState(mmOffer, rankedOffers);
  if (top1GapState) {
    return top1GapState;
  }
  return isMmCloseToHigherRankedProvider(mmOffer, rankedOffers) ? "close" : "normal";
}

function isTop1High(rankedOffers) {
  const topOffer = rankedOffers[0];
  const pricePerDay = Number.isFinite(Number(topOffer?.daily_price))
    ? Number(topOffer.daily_price)
    : dailyPrice(topOffer?.total_price, topOffer?.rental_days);
  return Number.isFinite(pricePerDay) && pricePerDay > TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN;
}

function mmRankLabel(rankedOffers) {
  const rank = rankedOffers.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  return rank >= 0 ? `Top ${rank + 1}` : "Brak MM";
}

function cheaperOffersLabel(rankedOffers) {
  const rank = rankedOffers.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  return rank >= 0 ? String(rank) : "Brak danych";
}

function isAirportLocation(location) {
  return /airport|lotnisko/i.test(String(location || ""));
}

function scenarioDate(scenarioPayload) {
  const value = scenarioPayload.start_date
    || scenarioPayload.start_day_label
    || scenarioPayload.pickup_date
    || "";
  return String(value).slice(0, 10);
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
  const locations = new Set([
    ...(Array.isArray(scenarioPayload.expected_locations) ? scenarioPayload.expected_locations : []),
    ...Object.keys(scenarioPayload.top_3_by_location || {}),
    ...(Array.isArray(scenarioPayload.errors) ? scenarioPayload.errors.map((error) => error.location) : [])
  ].filter(Boolean));
  if (locations.size) {
    return [...locations].sort((a, b) => a.localeCompare(b));
  }
  return Array.isArray(rootPayload.locations) ? [...rootPayload.locations].sort((a, b) => a.localeCompare(b)) : [];
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
    .map((error) => {
      const attemptText = error.attempt_count ? ` after ${error.attempt_count} attempt(s)` : "";
      return `<li><strong>${escapeHtml(error.location || "Unknown")}:</strong> Error${escapeHtml(attemptText)}: ${escapeHtml(error.error || error.message || error)}</li>`;
    })
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
      const legacyTop3 = Array.isArray(locationData)
        ? locationData
        : Array.isArray(locationData[sortOrder]) ? locationData[sortOrder] : [];
      const allRanked = rankedOffersForView(scenarioPayload, location, sortOrder, legacyTop3, "all");
      const automaticRanked = rankedOffersForView(scenarioPayload, location, sortOrder, legacyTop3, "automatic");
      rows.push({ location, sortOrder, allRanked, automaticRanked });
    }
  }

  return rows
    .map((row, index) => {
      const allRanked = row.allRanked;
      const automaticRanked = row.automaticRanked;
      const allTop3 = allRanked.slice(0, 3);
      const automaticTop3 = automaticRanked.slice(0, 3);
      const allMm = allRanked.find((offer) => isMmCarsProvider(offer?.provider_name));
      const automaticMm = automaticRanked.find((offer) => isMmCarsProvider(offer?.provider_name));
      const rowClass = index % 2 === 0 ? "even" : "odd";
      const allHigh = isTop1High(allRanked);
      const automaticHigh = isTop1High(automaticRanked);
      return `<tr class="${rowClass}" data-location="${escapeHtml(row.location)}" data-location-type="${isAirportLocation(row.location) ? "airport" : "branch"}" data-mm-state-automatic="${getMmState(automaticRanked)}" data-mm-state-all="${getMmState(allRanked)}" data-top1-high-automatic="${automaticHigh}" data-top1-high-all="${allHigh}">
        <td class="index">${index}</td>
        <td class="location">${escapeHtml(row.location)}</td>
        ${buildDualCell(escapeHtml(formatProviderName(automaticTop3[0])), escapeHtml(formatProviderName(allTop3[0])), mmClassName(automaticTop3[0], automaticTop3), mmClassName(allTop3[0], allTop3))}
        ${buildDualCell(escapeHtml(formatOfferPrice(automaticTop3[0])), escapeHtml(formatOfferPrice(allTop3[0])), automaticHigh ? "top1-high" : "", allHigh ? "top1-high" : "")}
        ${buildDualCell(escapeHtml(formatProviderName(automaticTop3[1])), escapeHtml(formatProviderName(allTop3[1])), mmClassName(automaticTop3[1], automaticTop3), mmClassName(allTop3[1], allTop3))}
        ${buildDualCell(escapeHtml(formatOfferPrice(automaticTop3[1])), escapeHtml(formatOfferPrice(allTop3[1])))}
        ${buildDualCell(escapeHtml(formatProviderName(automaticTop3[2])), escapeHtml(formatProviderName(allTop3[2])), mmClassName(automaticTop3[2], automaticTop3), mmClassName(allTop3[2], allTop3))}
        ${buildDualCell(escapeHtml(formatOfferPrice(automaticTop3[2])), escapeHtml(formatOfferPrice(allTop3[2])))}
        ${buildDualCell(escapeHtml(formatOfferPrice(automaticMm)), escapeHtml(formatOfferPrice(allMm)), automaticMm ? mmClassName(automaticMm, automaticRanked) : "muted", allMm ? mmClassName(allMm, allRanked) : "muted")}
        ${buildDualCell(escapeHtml(mmRankLabel(automaticRanked)), escapeHtml(mmRankLabel(allRanked)), "rank-cell", "rank-cell")}
        ${buildDualCell(escapeHtml(cheaperOffersLabel(automaticRanked)), escapeHtml(cheaperOffersLabel(allRanked)), "count-cell", "count-cell")}
      </tr>`;
    })
    .join("\n");
}

function buildScenarioTable(rootPayload, scenarioPayload, index, total) {
  const pickup = scenarioPayload.pickup_date || "";
  const dropoff = scenarioPayload.dropoff_date || "";
  const rentalDays = scenarioPayload.rental_days || "";

  return `<section class="scenario" data-date="${escapeHtml(scenarioDate(scenarioPayload))}" data-duration="${escapeHtml(rentalDays)}">
    <h2>${escapeHtml(scenarioTitle(scenarioPayload, index, total))}</h2>
    <div class="period">${escapeHtml(`${pickup} -> ${dropoff} (rental_days=${rentalDays})`)}</div>
    <table>
      <colgroup>
        <col class="col-index">
        <col class="col-location">
        <col class="col-company">
        <col class="col-rate">
        <col class="col-company">
        <col class="col-rate">
        <col class="col-company">
        <col class="col-rate">
        <col class="col-mm-rate">
        <col class="col-rank">
        <col class="col-count">
      </colgroup>
      <thead>
        <tr>
          <th>#</th>
          <th>Lokalizacja</th>
          <th>Top 1 firma</th>
          <th>Top 1 PLN/d</th>
          <th>Top 2 firma</th>
          <th>Top 2 PLN/d</th>
          <th>Top 3 firma</th>
          <th>Top 3 PLN/d</th>
          <th>MM PLN/d</th>
          <th>Pozycja MM</th>
          <th>Tańsze oferty</th>
        </tr>
      </thead>
      <tbody>
        ${buildScenarioRows(rootPayload, scenarioPayload)}
      </tbody>
    </table>
    ${buildErrorsHtml(scenarioPayload.errors)}
  </section>`;
}

function primaryRankingForLocation(scenarioPayload, location, mode) {
  const locationData = scenarioPayload?.top_3_by_location?.[location] || {};
  const configuredSortOrder = scenarioPayload?.sort_orders?.[0];
  const sortOrder = configuredSortOrder?.order
    || configuredSortOrder
    || (Array.isArray(locationData) ? "price" : Object.keys(locationData)[0])
    || "price_insurance";
  const legacyTop3 = Array.isArray(locationData)
    ? locationData
    : Array.isArray(locationData[sortOrder]) ? locationData[sortOrder] : [];
  return rankedOffersForView(scenarioPayload, location, sortOrder, legacyTop3, mode);
}

function buildMultiFilter(id, label, options, allLabel = "Wszystkie") {
  const optionHtml = options
    .map((option) => `<label class="multi-option"><input type="checkbox" value="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span></label>`)
    .join("");
  return `<div class="filter-field"><span class="filter-label">${escapeHtml(label)}</span><details class="multi-filter" id="${escapeHtml(id)}" data-all-label="${escapeHtml(allLabel)}"><summary>${escapeHtml(allLabel)}</summary><div class="multi-options">${optionHtml}</div></details></div>`;
}

function buildHtmlReport(payload) {
  const scenarios = normalizeScenarios(payload);
  const generatedAt = payload.generated_at || new Date().toISOString();
  const executionStartedAt = payload.execution_started_at || "";
  const executionDuration = formatDurationMs(payload.execution_duration_ms);
  const locations = [...new Set(scenarios.flatMap((scenario) => scenarioLocations(payload, scenario)))].sort();
  const durations = [...new Set(scenarios
    .map((scenario) => Number(scenario.rental_days))
    .filter(Number.isFinite))].sort((left, right) => left - right);
  const locationChecks = scenarios.reduce(
    (sum, scenario) => sum + scenarioLocations(payload, scenario).length,
    0
  );
  const missingMm = scenarios.reduce((sum, scenario) => sum + scenarioLocations(payload, scenario)
    .filter((location) => !primaryRankingForLocation(scenario, location, "all")
      .some((offer) => isMmCarsProvider(offer?.provider_name))).length, 0);
  const errorCount = scenarios.reduce(
    (sum, scenario) => sum + (Array.isArray(scenario.errors) ? scenario.errors.length : 0),
    0
  );
  const highTop1Count = scenarios.reduce((sum, scenario) => sum + scenarioLocations(payload, scenario)
    .filter((location) => isTop1High(primaryRankingForLocation(scenario, location, "all"))).length, 0);
  const locationOptions = locations.map((location) => ({ value: location, label: location }));
  const durationOptions = durations.map((duration) => ({ value: String(duration), label: `${duration} dni` }));
  const mmStateOptions = [
    { value: "missing", label: "Brak MM" },
    { value: "top1-gap", label: "Top1: różnica 10–19,99 PLN/d" },
    { value: "top1-gap-20", label: "Top1: różnica 20–29,99 PLN/d" },
    { value: "top1-gap-30", label: "Top1: różnica min. 30 PLN/d" },
    { value: "close", label: "Blisko wyższej pozycji" },
    { value: "normal", label: "Pozostałe" }
  ];
  const top1Options = [
    { value: "high", label: `Powyżej ${TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN} PLN/d` },
    { value: "normal", label: `Do ${TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN} PLN/d` }
  ];
  const progressText = Number.isFinite(Number(payload.expected_scenario_count))
    ? `${Number(payload.completed_scenario_count ?? scenarios.length)} / ${Number(payload.expected_scenario_count)} scenarios`
    : `${scenarios.length} scenarios`;
  const checkProgressText = Number.isFinite(Number(payload.expected_check_count))
    ? `${Number(payload.successful_check_count || 0)} successful, ${Number(payload.failed_check_count || 0)} failed, ${Number(payload.missing_check_count || 0)} missing / ${Number(payload.expected_check_count)} checks`
    : "";
  const runStatus = payload.run_status || (payload.is_partial ? "partial" : "complete");
  const statusNotice = runStatus === "partial"
    ? `<div class="notice">Partial report: ${escapeHtml(progressText)}. ${escapeHtml(checkProgressText)}</div>`
    : runStatus === "complete_with_errors"
      ? `<div class="notice warning">Complete with errors: ${escapeHtml(progressText)}. ${escapeHtml(checkProgressText)}</div>`
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
      --orange-bg: #d96b00;
      --orange-text: #ffffff;
      --magenta-bg: #a61e74;
      --magenta-text: #ffffff;
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

    .summary {
      color: var(--muted);
      margin-bottom: 14px;
      font-size: 13px;
    }

    .scenario {
      margin: 0 0 34px;
      padding-top: 8px;
      border-top: 2px solid #2d333b;
      overflow-x: visible;
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
      table-layout: fixed;
    }

    col.col-index { width: 3%; }
    col.col-location { width: 16%; }
    col.col-company { width: 11%; }
    col.col-rate { width: 7%; }
    col.col-mm-rate { width: 8%; }
    col.col-rank { width: 8%; }
    col.col-count { width: 11%; }

    th, td {
      border: 2px solid var(--line);
      padding: 6px 7px;
      text-align: left;
      white-space: normal;
      vertical-align: middle;
      overflow-wrap: anywhere;
      line-height: 1.25;
    }

    th {
      color: var(--text);
      font-weight: 700;
      background: #111;
      font-size: 11px;
    }

    td {
      color: var(--green);
      font-weight: 700;
      font-size: 12px;
    }

    th:nth-child(4), th:nth-child(6), th:nth-child(8), th:nth-child(9), th:nth-child(10), th:nth-child(11),
    td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(9), td:nth-child(10), td:nth-child(11) {
      text-align: right;
      white-space: nowrap;
    }

    td.index {
      color: var(--text);
      text-align: center;
    }

    .mm {
      background: var(--yellow-bg);
      color: var(--yellow-text);
    }

    .mm-close {
      background: var(--red-bg);
      color: var(--red-text);
    }

    .mm-top1-gap {
      background: var(--blue-bg);
      color: var(--blue-text);
    }

    .mm-top1-gap-20 {
      background: var(--orange-bg);
      color: var(--orange-text);
    }

    .mm-top1-gap-30 {
      background: var(--magenta-bg);
      color: var(--magenta-text);
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 24px;
      color: var(--muted);
      font-size: 13px;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 10px;
      margin: 0 0 18px;
      padding: 12px 0;
      border-top: 1px solid #2d333b;
      border-bottom: 1px solid #2d333b;
    }

    .toolbar > label, .filter-label { color: var(--muted); font-size: 12px; }

    .toolbar select, .toolbar input[type="date"], .multi-filter > summary {
      display: block;
      margin-top: 4px;
      min-height: 34px;
      border: 1px solid #596273;
      border-radius: 4px;
      background: #11151b;
      color: var(--text);
      padding: 5px 8px;
    }

    .filter-field { min-width: 150px; }
    .filter-label { display: block; }
    .multi-filter { position: relative; margin-top: 4px; }
    .multi-filter > summary {
      min-width: 150px;
      cursor: pointer;
      list-style: none;
      line-height: 22px;
    }
    .multi-filter > summary::-webkit-details-marker { display: none; }
    .multi-filter > summary::after { content: "▾"; float: right; margin-left: 12px; }
    .multi-filter[open] > summary::after { content: "▴"; }
    .multi-options {
      position: absolute;
      z-index: 20;
      top: calc(100% + 4px);
      left: 0;
      min-width: 220px;
      max-width: 340px;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid #596273;
      border-radius: 4px;
      background: #11151b;
      box-shadow: 0 8px 20px #00000066;
      padding: 6px;
    }
    .multi-option {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 6px;
      color: var(--text);
      font-size: 12px;
      cursor: pointer;
    }
    .multi-option:hover { background: #242b35; }
    .multi-option input { flex: 0 0 auto; margin: 1px 0 0; }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: 700;
    }

    .errors {
      margin-top: 10px;
      color: #ffb4a9;
    }

    .view-cell { padding: 0; }
    .offer-view { display: block; padding: 6px 7px; min-height: 100%; }
    .offer-view-automatic { display: none; }
    body[data-offer-view="automatic"] .offer-view-all { display: none; }
    body[data-offer-view="automatic"] .offer-view-automatic { display: block; }
    .rank-cell, .count-cell { color: var(--text); }

    .top1-high {
      background: #7a1d1d;
      color: #ffffff;
    }

    .muted {
      color: var(--muted);
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

    .notice.warning {
      border-color: #dc2626;
      background: #2a1111;
      color: #ffd0cc;
    }

    @media (max-width: 1100px) {
      body { padding: 14px; }
      th, td { padding: 5px; }
      td { font-size: 11px; }
    }

    @media (max-width: 720px) {
      body { padding: 10px; }
      .scenario { margin-bottom: 26px; }
      table, tbody, tr, td { display: block; width: 100%; }
      table { border: 0; background: transparent; }
      colgroup, thead { display: none; }
      tbody { display: grid; gap: 10px; }
      tr { border: 1px solid var(--line); background: #0d0f12; }
      td, td.index,
      td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(9), td:nth-child(10), td:nth-child(11) {
        display: grid;
        grid-template-columns: minmax(92px, 38%) 1fr;
        gap: 8px;
        border: 0;
        border-bottom: 1px solid #3d434b;
        padding: 7px 9px;
        text-align: left;
        white-space: normal;
      }
      td:last-child { border-bottom: 0; }
      td::before { color: var(--muted); font-weight: 400; }
      td:nth-child(1)::before { content: "#"; }
      td:nth-child(2)::before { content: "Lokalizacja"; }
      td:nth-child(3)::before { content: "Top 1 firma"; }
      td:nth-child(4)::before { content: "Top 1 PLN/d"; }
      td:nth-child(5)::before { content: "Top 2 firma"; }
      td:nth-child(6)::before { content: "Top 2 PLN/d"; }
      td:nth-child(7)::before { content: "Top 3 firma"; }
      td:nth-child(8)::before { content: "Top 3 PLN/d"; }
      td:nth-child(9)::before { content: "MM PLN/d"; }
      td:nth-child(10)::before { content: "Pozycja MM"; }
      td:nth-child(11)::before { content: "Tańsze oferty"; }
    }
  </style>
</head>
<body data-offer-view="all">
  <h1>RentCars.pl report</h1>
  <div class="meta">Generated at: ${escapeHtml(generatedAt)} | Time zone: ${escapeHtml(payload.time_zone || "Europe/Warsaw")} | Source: ${escapeHtml(payload.source_url || "https://rentcars.pl")}</div>
  ${statusNotice}
  <div class="summary">Scenariusze: ${scenarios.length} | sprawdzenia lokalizacji: ${locationChecks} | brak MM Cars Rental: ${missingMm} | błędy: ${errorCount} | Top1 &gt; ${TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN} PLN/d: ${highTop1Count}</div>
  <div class="legend">
    <span><span class="badge mm">MM Cars Rental</span> MM Cars Rental in table</span>
    <span><span class="badge mm mm-close">MM close</span> MM Cars Rental max 10 PLN/day more expensive than a higher-ranked competitor</span>
    <span><span class="badge mm mm-top1-gap">Top1: +10 PLN/d</span> Top 2 jest droższy od MM o ponad 10 PLN/dzień</span>
    <span><span class="badge mm mm-top1-gap-20">Top1: +20 PLN/d</span> Top 2 jest droższy od MM o min. 20 PLN/dzień</span>
    <span><span class="badge mm mm-top1-gap-30">Top1: +30 PLN/d</span> Top 2 jest droższy od MM o min. 30 PLN/dzień</span>
    <span><span class="badge top1-high">Top1 &gt; ${TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN}</span> stawka Top1 przekracza ${TOP1_HIGH_PRICE_PER_DAY_THRESHOLD_PLN} PLN/dzień</span>
  </div>
  <div class="toolbar">
    <label>Skrzynia<select id="filter-transmission"><option value="all">Wszystkie auta</option><option value="automatic">Tylko automaty</option></select></label>
    <label>Oddziały<select id="filter-location-type"><option value="airport">Lotniska</option><option value="all">Wszystkie oddziały</option></select></label>
    <label>Data<input id="filter-date" type="date"></label>
    ${buildMultiFilter("filter-location", "Lokalizacja", locationOptions)}
    ${buildMultiFilter("filter-duration", "Duration", durationOptions)}
    ${buildMultiFilter("filter-state", "Stan MM", mmStateOptions)}
    ${buildMultiFilter("filter-top1", "Kontrola Top1", top1Options)}
  </div>
  ${scenarios.map((scenario, index) => buildScenarioTable(payload, scenario, index, scenarios.length)).join("\n")}
  <div class="footer">Execution started at: ${escapeHtml(executionStartedAt || "Not available")} | Execution duration: ${escapeHtml(executionDuration)}</div>
  <script>
    const transmissionControl = document.getElementById("filter-transmission");
    const locationTypeControl = document.getElementById("filter-location-type");
    const dateControl = document.getElementById("filter-date");
    const multiControls = ["filter-location", "filter-duration", "filter-state", "filter-top1"].map((id) => document.getElementById(id));
    function selectedValues(control) {
      return new Set(Array.from(control.querySelectorAll("input:checked")).map((input) => input.value));
    }
    function updateMultiSummary(control) {
      const checked = Array.from(control.querySelectorAll("input:checked"));
      const summary = control.querySelector("summary");
      if (!checked.length) {
        summary.textContent = control.dataset.allLabel;
      } else if (checked.length === 1) {
        summary.textContent = checked[0].closest("label").querySelector("span").textContent;
      } else {
        summary.textContent = checked.length + " wybrane";
      }
    }
    function applyFilters() {
      const offerView = transmissionControl.value;
      const locationType = locationTypeControl.value;
      document.body.dataset.offerView = offerView;
      const date = dateControl.value;
      const selectedLocations = selectedValues(multiControls[0]);
      const selectedDurations = selectedValues(multiControls[1]);
      const selectedStates = selectedValues(multiControls[2]);
      const selectedTop1States = selectedValues(multiControls[3]);
      multiControls.forEach(updateMultiSummary);
      for (const section of document.querySelectorAll(".scenario")) {
        const scenarioMatch = (!date || section.dataset.date === date)
          && (!selectedDurations.size || selectedDurations.has(section.dataset.duration));
        let visibleRows = 0;
        for (const row of section.querySelectorAll("tbody tr")) {
          const mmState = offerView === "all" ? row.dataset.mmStateAll : row.dataset.mmStateAutomatic;
          const top1High = offerView === "all" ? row.dataset.top1HighAll : row.dataset.top1HighAutomatic;
          const top1State = top1High === "true" ? "high" : "normal";
          const top1Match = !selectedTop1States.size || selectedTop1States.has(top1State);
          const locationTypeMatch = locationType === "all" || row.dataset.locationType === locationType;
          const locationMatch = !selectedLocations.size || selectedLocations.has(row.dataset.location);
          const stateMatch = !selectedStates.size || selectedStates.has(mmState);
          const visible = scenarioMatch && locationTypeMatch && locationMatch && stateMatch && top1Match;
          row.hidden = !visible;
          if (visible) visibleRows += 1;
        }
        section.hidden = visibleRows === 0;
      }
    }
    transmissionControl.addEventListener("input", applyFilters);
    locationTypeControl.addEventListener("input", applyFilters);
    dateControl.addEventListener("input", applyFilters);
    multiControls.forEach((control) => control.addEventListener("change", applyFilters));
    applyFilters();
  </script>
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
