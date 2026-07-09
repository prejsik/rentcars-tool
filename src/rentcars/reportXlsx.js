#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const MM_PROVIDER = "mm cars rental";
const NEAR_NEXT_THRESHOLD_PLN = 10;
const COLORS = {
  title: "FF17212B",
  header: "FF1F4E78",
  headerText: "FFFFFFFF",
  lightBlue: "FFDDEBF7",
  lightGreen: "FFE2F0D9",
  lightYellow: "FFFFF2CC",
  lightRed: "FFFCE4D6",
  lightGray: "FFF2F2F2",
  text: "FF1F2937",
  border: "FFD1D5DB"
};

function normalizeProvider(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isMmProvider(value) {
  return normalizeProvider(value).includes(MM_PROVIDER);
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 2) {
  const numeric = finiteNumber(value);
  return numeric == null ? null : Number(numeric.toFixed(digits));
}

function average(values) {
  const numbers = values.map(finiteNumber).filter((value) => value != null);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function median(values) {
  const numbers = values.map(finiteNumber).filter((value) => value != null).sort((a, b) => a - b);
  if (!numbers.length) {
    return null;
  }
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function dailyPrice(offer, rentalDays) {
  const explicit = finiteNumber(offer?.daily_price);
  if (explicit != null) {
    return explicit;
  }
  const total = finiteNumber(offer?.total_price);
  const days = finiteNumber(offer?.rental_days) || finiteNumber(rentalDays);
  return total != null && days > 0 ? total / days : null;
}

function dateCell(value) {
  const raw = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : raw;
}

function scenarioLocations(scenario) {
  return [...new Set([
    ...(Array.isArray(scenario?.expected_locations) ? scenario.expected_locations : []),
    ...Object.keys(scenario?.top_3_by_location || {}),
    ...(Array.isArray(scenario?.errors) ? scenario.errors.map((error) => error.location) : [])
  ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function scenarioSortOrders(rootPayload, scenario) {
  const values = Array.isArray(scenario?.sort_orders) && scenario.sort_orders.length
    ? scenario.sort_orders.map((entry) => entry.order || entry)
    : rootPayload.sort_orders || ["price_insurance"];
  return [...new Set(values.filter(Boolean))];
}

function rankedOffersForTarget(scenario, location, sortOrder) {
  const byProvider = new Map();
  for (const offer of Array.isArray(scenario?.results) ? scenario.results : []) {
    const offerLocation = String(offer.pickup_location || offer.location || "").trim();
    const offerSortOrder = offer.sort_order || "suggested";
    const price = dailyPrice(offer, scenario.rental_days);
    if (offerLocation !== location || offerSortOrder !== sortOrder || price == null) {
      continue;
    }

    const provider = String(offer.provider_name || "").trim();
    const providerKey = normalizeProvider(provider);
    if (!providerKey) {
      continue;
    }
    const existing = byProvider.get(providerKey);
    if (!existing || price < existing.daily_price) {
      byProvider.set(providerKey, { ...offer, provider_name: provider, daily_price: price });
    }
  }

  return [...byProvider.values()].sort((left, right) => {
    if (left.daily_price !== right.daily_price) {
      return left.daily_price - right.daily_price;
    }
    return left.provider_name.localeCompare(right.provider_name);
  });
}

function buildDetailRows(payload) {
  const rows = [];
  for (const scenario of Array.isArray(payload?.scenarios) ? payload.scenarios : []) {
    for (const location of scenarioLocations(scenario)) {
      for (const sortOrder of scenarioSortOrders(payload, scenario)) {
        const offers = rankedOffersForTarget(scenario, location, sortOrder);
        const error = (scenario.errors || []).find((item) => {
          const sameLocation = String(item.location || "") === location;
          return sameLocation && (!item.sort_order || item.sort_order === sortOrder);
        });
        const mmIndex = offers.findIndex((offer) => isMmProvider(offer.provider_name));
        const mmOffer = mmIndex >= 0 ? offers[mmIndex] : null;
        const mmRank = mmIndex >= 0 ? mmIndex + 1 : null;
        const top1 = offers[0] || null;
        const top2 = offers[1] || null;
        const top3 = offers[2] || null;
        const higherOffer = mmIndex > 0 ? offers[mmIndex - 1] : null;
        const gapToTop1 = mmIndex > 0 ? mmOffer.daily_price - top1.daily_price : null;
        const gapToNext = mmIndex > 0 ? mmOffer.daily_price - higherOffer.daily_price : null;
        const roomIfTop1 = mmIndex === 0 && top2 ? top2.daily_price - mmOffer.daily_price : null;

        rows.push({
          start_date: dateCell(scenario.start_date || scenario.start_day_label || scenario.pickup_date),
          rental_days: Number(scenario.rental_days) || null,
          location,
          sort_order: sortOrder,
          check_status: error ? "error" : offers.length ? "ok" : "no_verified_offers",
          error: error?.error || "",
          attempt_count: Number(error?.attempt_count) || null,
          top1_provider: top1?.provider_name || "",
          top1_daily: round(top1?.daily_price),
          top2_provider: top2?.provider_name || "",
          top2_daily: round(top2?.daily_price),
          top3_provider: top3?.provider_name || "",
          top3_daily: round(top3?.daily_price),
          mm_rank: mmRank,
          mm_daily: round(mmOffer?.daily_price),
          gap_to_top1_daily: round(gapToTop1),
          gap_to_next_daily: round(gapToNext),
          room_if_top1_daily: round(roomIfTop1),
          near_next_under_10_daily: gapToNext != null && gapToNext > 0 && gapToNext < NEAR_NEXT_THRESHOLD_PLN,
          currency: mmOffer?.currency || top1?.currency || "",
          source_url: mmOffer?.source_url || top1?.source_url || payload.source_url || ""
        });
      }
    }
  }
  return rows;
}

function aggregateRows(rows, groupKey) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[groupKey];
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  return [...groups.entries()].map(([key, groupRows]) => {
    const validRows = groupRows.filter((row) => row.top1_provider);
    const mmTop1 = validRows.filter((row) => row.mm_rank === 1).length;
    const mmTop2 = validRows.filter((row) => row.mm_rank === 2).length;
    const mmTop3 = validRows.filter((row) => row.mm_rank != null && row.mm_rank <= 3).length;
    const mmMissing = validRows.filter((row) => row.mm_rank == null).length;
    return {
      [groupKey]: key,
      checks: groupRows.length,
      valid_checks: validRows.length,
      failed_checks: groupRows.filter((row) => row.check_status === "error").length,
      mm_top1: mmTop1,
      mm_top2: mmTop2,
      mm_top3: mmTop3,
      mm_missing: mmMissing,
      mm_top1_pct: validRows.length ? round(mmTop1 / validRows.length, 4) : null,
      near_next_under_10: validRows.filter((row) => row.near_next_under_10_daily).length,
      avg_gap_to_top1_daily: round(average(validRows.map((row) => row.gap_to_top1_daily))),
      median_gap_to_top1_daily: round(median(validRows.map((row) => row.gap_to_top1_daily))),
      avg_gap_to_next_daily: round(average(validRows.map((row) => row.gap_to_next_daily))),
      median_gap_to_next_daily: round(median(validRows.map((row) => row.gap_to_next_daily))),
      avg_room_if_top1_daily: round(average(validRows.map((row) => row.room_if_top1_daily))),
      median_room_if_top1_daily: round(median(validRows.map((row) => row.room_if_top1_daily)))
    };
  }).sort((left, right) => String(left[groupKey]).localeCompare(String(right[groupKey]), undefined, { numeric: true }));
}

function buildRecommendations(byAirport) {
  return byAirport.map((row) => {
    const top1Rate = finiteNumber(row.mm_top1_pct) || 0;
    const missingRate = row.valid_checks ? row.mm_missing / row.valid_checks : 0;
    const medianRoom = finiteNumber(row.median_room_if_top1_daily) || 0;
    const medianGap = finiteNumber(row.median_gap_to_top1_daily) || 0;
    let proposedFee = 0;
    let proposedReduction = 0;
    let action = "Monitor; no broad price change";

    if (missingRate >= 0.3) {
      action = "Fix MM availability/visibility before changing price";
    } else if (top1Rate >= 0.9 && medianRoom >= 10) {
      proposedFee = Math.max(5, Math.min(15, Math.floor(medianRoom / 2)));
      action = "Increase city service fee and protect margin";
    } else if (top1Rate >= 0.8 && medianRoom >= 6) {
      proposedFee = Math.max(3, Math.min(8, Math.floor(medianRoom / 2)));
      action = "Test a moderate city service fee";
    } else if (top1Rate < 0.6 && medianGap > 0) {
      proposedReduction = Math.min(10, Math.ceil(medianGap));
      action = "Reduce effective daily price and recheck";
    }

    return {
      location: row.location,
      mm_top1_pct: row.mm_top1_pct,
      mm_missing_pct: row.valid_checks ? round(missingRate, 4) : null,
      median_room_if_top1_daily: row.median_room_if_top1_daily,
      median_gap_to_top1_daily: row.median_gap_to_top1_daily,
      proposed_city_fee_pln_daily: proposedFee,
      proposed_reduction_pln_daily: proposedReduction,
      action
    };
  });
}

function buildCompetitorRows(detailRows) {
  const counts = new Map();
  for (const row of detailRows) {
    if (!row.top1_provider || isMmProvider(row.top1_provider)) {
      continue;
    }
    const key = `${row.location}|${row.top1_provider}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, top1Count]) => {
    const separator = key.indexOf("|");
    return {
      location: key.slice(0, separator),
      provider: key.slice(separator + 1),
      top1_count: top1Count
    };
  }).sort((left, right) => left.location.localeCompare(right.location) || right.top1_count - left.top1_count);
}

function buildQualityRows(payload, detailRows) {
  const rows = detailRows
    .filter((row) => row.check_status !== "ok")
    .map((row) => ({
      start_date: row.start_date,
      rental_days: row.rental_days,
      location: row.location,
      sort_order: row.sort_order,
      status: row.check_status,
      attempt_count: row.attempt_count,
      error: row.error || "No verified offers"
    }));
  if (!rows.length && payload.run_status !== "complete") {
    rows.push({ status: payload.run_status, error: "Root report status is not complete." });
  }
  return rows;
}

function buildOverviewRows(payload, detailRows) {
  const validRows = detailRows.filter((row) => row.top1_provider);
  const mmTop1 = validRows.filter((row) => row.mm_rank === 1).length;
  const gaps = validRows.map((row) => row.gap_to_top1_daily);
  const nextGaps = validRows.map((row) => row.gap_to_next_daily);
  const rooms = validRows.map((row) => row.room_if_top1_daily);
  return [
    ["Run status", payload.run_status || (payload.is_partial ? "partial" : "complete")],
    ["Generated at", payload.generated_at || ""],
    ["Source", payload.source_url || "https://rentcars.pl"],
    ["Scenarios", `${payload.completed_scenario_count ?? detailRows.length} / ${payload.expected_scenario_count ?? detailRows.length}`],
    ["Expected airport checks", Number(payload.expected_check_count ?? detailRows.length)],
    ["Successful checks", Number(payload.successful_check_count ?? validRows.length)],
    ["Failed checks", Number(payload.failed_check_count ?? detailRows.filter((row) => row.check_status === "error").length)],
    ["Missing checks", Number(payload.missing_check_count || 0)],
    ["Valid ranked rows", validRows.length],
    ["MM top1 count", mmTop1],
    ["MM top1 rate", validRows.length ? mmTop1 / validRows.length : null],
    ["MM top2 count", validRows.filter((row) => row.mm_rank === 2).length],
    ["MM top3 count", validRows.filter((row) => row.mm_rank != null && row.mm_rank <= 3).length],
    ["MM missing count", validRows.filter((row) => row.mm_rank == null).length],
    ["Near next position under 10 PLN/day", validRows.filter((row) => row.near_next_under_10_daily).length],
    ["Average decrease to top1 PLN/day", round(average(gaps))],
    ["Median decrease to top1 PLN/day", round(median(gaps))],
    ["Average decrease to next position PLN/day", round(average(nextGaps))],
    ["Median decrease to next position PLN/day", round(median(nextGaps))],
    ["Average room when MM is top1 PLN/day", round(average(rooms))],
    ["Median room when MM is top1 PLN/day", round(median(rooms))]
  ];
}

function applyTitle(sheet, title, subtitle, width) {
  sheet.mergeCells(1, 1, 1, width);
  sheet.getCell(1, 1).value = title;
  sheet.getCell(1, 1).font = { name: "Aptos Display", size: 18, bold: true, color: { argb: COLORS.headerText } };
  sheet.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.title } };
  sheet.getCell(1, 1).alignment = { vertical: "middle" };
  sheet.getRow(1).height = 30;
  sheet.mergeCells(2, 1, 2, width);
  sheet.getCell(2, 1).value = subtitle;
  sheet.getCell(2, 1).font = { name: "Aptos", size: 10, color: { argb: COLORS.text } };
  sheet.getCell(2, 1).alignment = { wrapText: true, vertical: "middle" };
  sheet.getRow(2).height = 30;
  sheet.views = [{ state: "frozen", ySplit: 4 }];
  sheet.properties.showGridLines = false;
}

function humanizeHeader(value) {
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function styleDataSheet(sheet, headers, rowCount) {
  const headerRow = sheet.getRow(4);
  headerRow.height = 32;
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.header } };
    cell.font = { name: "Aptos", bold: true, color: { argb: COLORS.headerText } };
    cell.alignment = { wrapText: true, vertical: "middle" };
  });

  headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    const lower = header.toLowerCase();
    let width = Math.max(11, humanizeHeader(header).length + 2);
    for (let rowIndex = 5; rowIndex <= Math.min(rowCount + 4, 150); rowIndex += 1) {
      width = Math.max(width, Math.min(42, String(sheet.getCell(rowIndex, index + 1).value ?? "").length + 2));
    }
    column.width = Math.min(42, width);
    if (lower.includes("date")) column.numFmt = "yyyy-mm-dd";
    if (lower.includes("pct")) column.numFmt = "0.0%";
    if (!lower.includes("near_next_under_10") && /daily|price|gap|room|fee|reduction/.test(lower)) {
      column.numFmt = '#,##0.00 "PLN"';
    }
    if (/checks|count|rank|days|attempt/.test(lower)) column.numFmt = "#,##0";
  });

  for (let rowIndex = 5; rowIndex <= rowCount + 4; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    row.font = { name: "Aptos", size: 10, color: { argb: COLORS.text } };
    row.alignment = { vertical: "top" };
    row.eachCell((cell) => {
      cell.border = { bottom: { style: "hair", color: { argb: COLORS.border } } };
    });
  }
}

function addDataSheet(workbook, name, title, subtitle, rows, preferredHeaders = null) {
  const sheet = workbook.addWorksheet(name);
  const headers = preferredHeaders || [...rows.reduce((set, row) => {
    Object.keys(row || {}).forEach((key) => set.add(key));
    return set;
  }, new Set())];
  const safeHeaders = headers.length ? headers : ["status"];
  applyTitle(sheet, title, subtitle, safeHeaders.length);

  sheet.addTable({
    name: `${name.replace(/[^A-Za-z0-9]/g, "")}Table`,
    ref: "A4",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: safeHeaders.map((header) => ({ name: humanizeHeader(header) })),
    rows: rows.length
      ? rows.map((row) => safeHeaders.map((header) => row?.[header] === "" ? null : row?.[header] ?? null))
      : [safeHeaders.map((header, index) => index === 0 ? "No data" : null)]
  });
  styleDataSheet(sheet, safeHeaders, Math.max(1, rows.length));
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + Math.max(1, rows.length), column: safeHeaders.length } };
  return sheet;
}

function addOverviewSheet(workbook, payload, rows) {
  const sheet = workbook.addWorksheet("Overview");
  applyTitle(sheet, "RentCars.pl pricing overview", "Snapshot generated from the merged scraper JSON. All price differences are daily PLN values.", 4);
  sheet.getCell("A4").value = "Metric";
  sheet.getCell("B4").value = "Value";
  rows.forEach(([metric, value], index) => {
    sheet.getCell(index + 5, 1).value = metric;
    sheet.getCell(index + 5, 2).value = value;
  });
  styleDataSheet(sheet, ["metric", "value"], rows.length);
  sheet.getColumn(1).width = 44;
  sheet.getColumn(2).width = 30;
  sheet.getCell("B15").numFmt = "0.0%";

  const status = String(payload.run_status || "");
  sheet.getCell("B5").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: status === "complete" ? COLORS.lightGreen : status === "complete_with_errors" ? COLORS.lightYellow : COLORS.lightRed }
  };
  return sheet;
}

function applySemanticHighlights(workbook) {
  const details = workbook.getWorksheet("Details");
  if (details) {
    const headerMap = new Map();
    details.getRow(4).eachCell((cell, columnNumber) => {
      headerMap.set(String(cell.value || "").toLowerCase(), columnNumber);
    });
    const rankColumn = headerMap.get("mm rank");
    const statusColumn = headerMap.get("check status");
    for (let rowIndex = 5; rowIndex <= details.rowCount; rowIndex += 1) {
      const rank = Number(details.getCell(rowIndex, rankColumn).value);
      const status = details.getCell(rowIndex, statusColumn).value;
      const fill = status === "error"
        ? COLORS.lightRed
        : rank === 1
          ? COLORS.lightGreen
          : rank === 2 || rank === 3
            ? COLORS.lightYellow
            : null;
      if (fill) {
        details.getCell(rowIndex, rankColumn).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      }
    }
  }
}

function buildWorkbook(payload) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RentCars tool";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const details = buildDetailRows(payload);
  const byAirport = aggregateRows(details, "location");
  const byDuration = aggregateRows(details, "rental_days");
  const recommendations = buildRecommendations(byAirport);
  const opportunities = details
    .filter((row) => row.mm_rank > 1 && row.near_next_under_10_daily)
    .sort((left, right) => left.gap_to_next_daily - right.gap_to_next_daily);
  const competitors = buildCompetitorRows(details);
  const qualityRows = buildQualityRows(payload, details);

  addOverviewSheet(workbook, payload, buildOverviewRows(payload, details));
  addDataSheet(workbook, "Recommendations", "Pricing recommendations", "Suggested city-level service fees or effective daily reductions. Revalidate changes with the next scraper run.", recommendations);
  addDataSheet(workbook, "By airport", "Performance by airport", "MM Cars Rental rank and daily price gaps aggregated across dates and durations.", byAirport);
  addDataSheet(workbook, "By duration", "Performance by rental duration", "Use this view to identify duration bands that need separate pricing corrections.", byDuration);
  addDataSheet(workbook, "Opportunities", "Near-position opportunities", "Rows where MM Cars Rental can move one position higher with a reduction below 10 PLN/day.", opportunities);
  addDataSheet(workbook, "Top1 competitors", "Top1 competitors", "How often each non-MM provider ranked first at each airport.", competitors);
  addDataSheet(workbook, "Details", "Scenario details", "One row per pickup date, duration, airport, and sort mode.", details);
  addDataSheet(workbook, "Data quality", "Data quality and scraper errors", "Failed checks and scenarios without verified offers. Review these before making price decisions.", qualityRows);
  applySemanticHighlights(workbook);
  return workbook;
}

async function generateWorkbookFromFile(inputPath, outputPath) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  const workbook = buildWorkbook(payload);
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await workbook.xlsx.writeFile(targetPath);
  return targetPath;
}

async function main() {
  const inputPath = process.argv[2] || path.join("output", "rentcars-results-latest.json");
  const outputPath = process.argv[3] || path.join("output", "rentcars-summary.xlsx");
  const targetPath = await generateWorkbookFromFile(inputPath, outputPath);
  console.log(`RentCars.pl Excel summary saved to ${targetPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildDetailRows,
  buildWorkbook,
  generateWorkbookFromFile
};
