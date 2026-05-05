const path = require("path");
const {
  compareByPriceAscending,
  formatMoney,
  toCsv,
  writeTextFile
} = require("./utils");

function buildSortedRows(results) {
  return [...results].sort(compareByPriceAscending);
}

function printResultsTable(results) {
  const rows = buildScenarioLocationCheapestRows(results).map((item) => ({
    pickup_date: item.pickupDate || "",
    pickup_day: toWeekdayName(item.pickupDate),
    duration_days: item.durationDays ?? "",
    location: item.location,
    sort_order: item.sortLabel || item.sortOrder || "",
    provider: formatProviderForDisplay(item.provider, item.providerRating),
    total_price: formatMoney(item.totalPrice, item.currency)
  }));

  if (!rows.length) {
    console.log("No successful results to display.");
    return;
  }

  console.table(rows);
}

function printSummary(results, failures) {
  const sorted = buildSortedRows(results);

  if (sorted.length) {
    printScenarioRankings(sorted, 3);
  } else {
    console.log("No location returned a valid offer.");
  }

  if (failures.length) {
    console.log("");
    console.log("Failed locations:");
    for (const failure of failures) {
      const durationLabel = failure.durationDays ? ` (${failure.durationDays} days)` : "";
      console.log(`- ${failure.location}${durationLabel}: ${failure.error}`);
    }
  }
}

function buildCheapestByKey(sortedRows, keySelector) {
  const map = new Map();
  for (const row of sortedRows) {
    const key = keySelector(row);
    if (!map.has(key)) {
      map.set(key, row);
    }
  }
  return [...map.values()];
}

function buildScenarioGroups(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.pickupDate || ""}|${row.durationDays ?? ""}`;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(row);
  }

  return [...map.entries()]
    .map(([key, scenarioRows]) => {
      const [pickupDate, durationDaysRaw] = key.split("|");
      const parsedDuration = Number.parseInt(durationDaysRaw, 10);
      return {
        pickupDate,
        durationDays: Number.isFinite(parsedDuration) ? parsedDuration : null,
        rows: buildSortedRows(scenarioRows)
      };
    })
    .sort((left, right) => {
      if (left.pickupDate !== right.pickupDate) {
        return left.pickupDate.localeCompare(right.pickupDate);
      }

      const leftDuration = left.durationDays ?? Number.MAX_SAFE_INTEGER;
      const rightDuration = right.durationDays ?? Number.MAX_SAFE_INTEGER;
      return leftDuration - rightDuration;
    });
}

function buildScenarioLocationCheapestRows(results) {
  const rows = [];
  const groups = buildScenarioGroups(results);

  for (const group of groups) {
    const cheapestByLocation = buildCheapestByKey(
      group.rows,
      (item) => `${item.location}|${item.sortOrder || ""}|${item.pickupDate || ""}|${item.durationDays ?? ""}`
    );

    const sortedByLocation = [...cheapestByLocation].sort((left, right) => left.location.localeCompare(right.location));
    rows.push(...sortedByLocation);
  }

  return rows;
}

function buildTopProvidersPerLocation(sortedRows, topLimit) {
  const locationProviderBestMap = new Map();

  for (const row of sortedRows) {
    const requestedLocation = row.requestedLocation || row.location;
    const sortLabel = row.sortLabel || row.sortOrder || "";
    const locationKey = `${requestedLocation}|${sortLabel}`;
    const providerKey = String(row.provider || "").trim().toLowerCase();

    if (!locationProviderBestMap.has(locationKey)) {
      locationProviderBestMap.set(locationKey, new Map());
    }

    const providerMap = locationProviderBestMap.get(locationKey);
    if (!providerMap.has(providerKey) || row.totalPrice < providerMap.get(providerKey).totalPrice) {
      providerMap.set(providerKey, row);
    }
  }

  const output = [];
  for (const [locationKey, providerMap] of [...locationProviderBestMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [location, sortLabel] = locationKey.split("|");
    const ranked = [...providerMap.values()].sort(compareByPriceAscending).slice(0, topLimit);
    ranked.forEach((row, index) => {
      output.push({
        ...row,
        location,
        sortLabel,
        rank: index + 1
      });
    });
  }

  return output;
}

function printScenarioRankings(sortedRows, topLimit) {
  const groups = buildScenarioGroups(sortedRows);
  if (!groups.length) {
    return;
  }

  console.log("Rankings per pickup date and duration (Top 3 per city):");
  for (const group of groups) {
    const topRows = buildTopProvidersPerLocation(group.rows, topLimit);
    if (!topRows.length) {
      continue;
    }

    const weekday = toWeekdayName(group.pickupDate);
    const weekdayLabel = weekday ? ` (${weekday})` : "";
    const durationLabel = group.durationDays != null ? `${group.durationDays} days` : "duration unknown";
    console.log(`- Pickup ${group.pickupDate}${weekdayLabel} | ${durationLabel}`);
    console.table(
      topRows.map((row) => ({
        location: row.location,
        sort_order: row.sortLabel || row.sortOrder || "",
        rank: row.rank,
        provider: formatProviderForDisplay(row.provider, row.providerRating),
        total_price: formatMoney(row.totalPrice, row.currency),
        source: row.source || ""
      }))
    );
  }
}

function formatProviderRating(rating) {
  const numeric = Number(rating);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function formatProviderForDisplay(provider, rating = null) {
  const ratingText = formatProviderRating(rating);
  const suffix = ratingText ? ` (${ratingText})` : "";
  return `${provider}${suffix}`;
}

function toWeekdayName(isoDateString) {
  if (!isoDateString) {
    return "";
  }

  const date = new Date(`${isoDateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC"
  }).format(date);
}

function writeCsvReport(outputCsvPath, results) {
  const rows = buildSortedRows(results);
  const csv = toCsv(rows);
  writeTextFile(outputCsvPath, csv);
  return path.resolve(outputCsvPath);
}

module.exports = {
  printResultsTable,
  printSummary,
  writeCsvReport
};
