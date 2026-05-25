const fs = require("fs");
const path = require("path");

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values ?? []) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function parseDate(value, fieldName) {
  const raw = normalizeWhitespace(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format. Received: ${value}`);
  }

  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} is not a valid date: ${value}`);
  }

  return { year, month, day, raw };
}

function parseTime(value, fieldName) {
  const raw = normalizeWhitespace(value);
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} must use HH:MM format. Received: ${value}`);
  }

  const [hours, minutes] = raw.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`${fieldName} is not a valid time: ${value}`);
  }

  return { hours, minutes, raw };
}

function makeTimestampForFile(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function toMonthName(dateParts) {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day))
  );
}

function toWeekdayShort(dateParts) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day))
  );
}

function toAccessibleDateLabels(dateParts) {
  const monthName = toMonthName(dateParts);
  const weekdayShort = toWeekdayShort(dateParts);
  const day = String(dateParts.day);
  const paddedDay = String(dateParts.day).padStart(2, "0");
  const year = String(dateParts.year);
  const shortMonth = monthName.slice(0, 3);

  return uniqueStrings([
    `${monthName} ${day}, ${year}`,
    `${monthName} ${paddedDay}, ${year}`,
    `${day} ${monthName} ${year}`,
    `${paddedDay} ${monthName} ${year}`,
    `${weekdayShort}, ${monthName} ${day}, ${year}`,
    `${weekdayShort}, ${shortMonth} ${day}, ${year}`,
    `${year}-${String(dateParts.month).padStart(2, "0")}-${paddedDay}`
  ]);
}

function parseMoney(rawValue, fallbackCurrency = "") {
  if (rawValue == null) {
    return null;
  }

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return {
      value: rawValue,
      currency: fallbackCurrency || "",
      raw: String(rawValue)
    };
  }

  const raw = normalizeWhitespace(String(rawValue));
  if (!raw) {
    return null;
  }

  const currencyMatch =
    raw.match(/\b(EUR|USD|GBP|PLN|CHF|CAD|AUD|NZD|SEK|NOK|DKK|CZK|HUF|RON)\b/i) ||
    raw.match(/z\u0142|zl|\u20ac|\$|\u00a3/i);
  const currency = currencyMatch ? String(currencyMatch[0]).toUpperCase() : fallbackCurrency || "";

  const numericMatch = raw.match(/(\d{1,3}(?:[\s.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})|\d+)/);
  if (!numericMatch) {
    return null;
  }

  let numeric = numericMatch[1].replace(/\s+/g, "");
  const hasComma = numeric.includes(",");
  const hasDot = numeric.includes(".");

  if (hasComma && hasDot) {
    if (numeric.lastIndexOf(",") > numeric.lastIndexOf(".")) {
      numeric = numeric.replace(/\./g, "").replace(",", ".");
    } else {
      numeric = numeric.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = numeric.split(",");
    numeric = parts.length === 2 && parts[1].length <= 2
      ? `${parts[0].replace(/\./g, "")}.${parts[1]}`
      : numeric.replace(/,/g, "");
  } else if (hasDot) {
    const parts = numeric.split(".");
    numeric = parts.length === 2 && parts[1].length <= 2
      ? numeric
      : numeric.replace(/\./g, "");
  }

  const value = Number.parseFloat(numeric);
  if (!Number.isFinite(value)) {
    return null;
  }

  return { value, currency, raw };
}

function formatMoney(value, currency = "") {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  }

  return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

function dailyPrice(totalPrice, rentalDays) {
  const total = Number(totalPrice);
  const days = Number(rentalDays);
  if (!Number.isFinite(total) || !Number.isFinite(days) || days <= 0) {
    return null;
  }
  return total / days;
}

function compareByPriceAscending(left, right) {
  return left.totalPrice - right.totalPrice;
}

function toCsv(rows) {
  const header = [
    "requested_location",
    "location",
    "pickup_location_id",
    "sort_order",
    "price_mode",
    "duration_days",
    "pickup_date",
    "dropoff_date",
    "provider",
    "provider_rating",
    "daily_price",
    "currency",
    "source"
  ];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.requestedLocation ?? row.requested_location ?? "",
        row.location,
        row.pickupLocationId ?? row.pickup_location_id ?? "",
        row.sortOrder ?? row.sort_order ?? "",
        row.priceMode ?? row.price_mode ?? "",
        row.durationDays ?? "",
        row.pickupDate ?? "",
        row.dropoffDate ?? "",
        row.provider,
        Number.isFinite(row.providerRating) ? row.providerRating : "",
        formatDailyPriceForCsv(row),
        row.currency || "",
        row.source || ""
      ]
        .map(escapeCsv)
        .join(",")
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatDailyPriceForCsv(row) {
  const calculated = dailyPrice(row.totalPrice ?? row.total_price, row.durationDays ?? row.rental_days);
  if (calculated != null) {
    return calculated.toFixed(2);
  }
  const fallback = Number(row.dailyPrice ?? row.daily_price);
  return Number.isFinite(fallback) ? fallback.toFixed(2) : "";
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, "\"\"")}"`;
}

function writeTextFile(targetPath, content) {
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content, "utf8");
}

function safeFilePart(value) {
  return normalizeWhitespace(value).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

module.exports = {
  compareByPriceAscending,
  dailyPrice,
  ensureDir,
  formatMoney,
  makeTimestampForFile,
  normalizeWhitespace,
  parseDate,
  parseMoney,
  parseTime,
  safeFilePart,
  toAccessibleDateLabels,
  toCsv,
  uniqueStrings,
  writeTextFile
};
