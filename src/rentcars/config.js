const fs = require("fs");
const path = require("path");
const {
  makeTimestampForFile,
  normalizeWhitespace,
  parseDate,
  parseTime,
  uniqueStrings
} = require("./utils");

function parseCliArgs(argv) {
  const args = {
    locations: [],
    durationDays: [],
    pickupWeekdays: [],
    startDates: [],
    sortOrders: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const rawKey = token.slice(2);
    const equalsIndex = rawKey.indexOf("=");
    const key = equalsIndex >= 0 ? rawKey.slice(0, equalsIndex) : rawKey;
    const inlineValue = equalsIndex >= 0 ? rawKey.slice(equalsIndex + 1) : null;

    if (key === "headed") {
      args.headless = false;
      continue;
    }

    if (key === "headless") {
      args.headless = true;
      continue;
    }

    if (key === "help") {
      args.help = true;
      continue;
    }

    const nextValue = inlineValue == null ? argv[index + 1] : inlineValue;
    if (nextValue == null || nextValue === "" || (inlineValue == null && nextValue.startsWith("--"))) {
      throw new Error(`Missing value for argument: ${token}`);
    }

    if (inlineValue == null) {
      index += 1;
    }

    if (key === "location") {
      args.locations.push(nextValue);
      continue;
    }

    if (key === "locations") {
      args.locations.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    if (key === "duration-days") {
      args.durationDays.push(nextValue);
      continue;
    }

    if (key === "durations-days") {
      args.durationDays.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    if (key === "pickup-weekday") {
      args.pickupWeekdays.push(nextValue);
      continue;
    }

    if (key === "pickup-weekdays") {
      args.pickupWeekdays.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    if (key === "start-date" || key === "pickup-date-option") {
      args.startDates.push(nextValue);
      continue;
    }

    if (key === "start-dates" || key === "pickup-dates") {
      args.startDates.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    if (key === "sort-order") {
      args.sortOrders.push(nextValue);
      continue;
    }

    if (key === "sort-orders") {
      args.sortOrders.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    args[key] = nextValue;
  }

  return args;
}

function parseDurationDaysInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }

  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");

  const values = [];
  for (const part of parts) {
    const normalized = normalizeWhitespace(part);
    if (!normalized) {
      continue;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`${fieldName} must contain positive integers. Received: ${part}`);
    }

    values.push(parsed);
  }

  return [...new Set(values)].sort((left, right) => left - right);
}

function parsePositiveIntegerInput(rawValue, fieldName) {
  if (rawValue == null || rawValue === "") {
    return 0;
  }

  const parsed = Number.parseInt(String(rawValue).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer. Received: ${rawValue}`);
  }

  return parsed;
}

function parseSortOrdersInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }

  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");

  const aliases = new Map([
    ["suggested", "suggested"],
    ["sugerowane", "suggested"],
    ["price", "price"],
    ["po cenie", "price"],
    ["cena", "price"],
    ["price_insurance", "price_insurance"],
    ["price-insurance", "price_insurance"],
    ["insurance", "price_insurance"],
    ["ubezpieczenie", "price_insurance"],
    ["po cenie z ubezpieczeniem", "price_insurance"]
  ]);

  const values = [];
  for (const part of parts) {
    const normalized = normalizeWhitespace(part).toLowerCase().replace(/_/g, " ");
    if (!normalized) {
      continue;
    }

    const canonical = aliases.get(normalized) || aliases.get(normalized.replace(/\s+/g, "_"));
    if (!canonical) {
      throw new Error(`${fieldName} contains unsupported sort order: ${part}`);
    }
    values.push(canonical);
  }

  return [...new Set(values)];
}

function normalizeDayToken(rawValue) {
  return String(rawValue ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parsePickupWeekdaysInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }

  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");

  const dayMapping = new Map([
    ["sunday", 0],
    ["sun", 0],
    ["niedziela", 0],
    ["monday", 1],
    ["mon", 1],
    ["poniedzialek", 1],
    ["pon", 1],
    ["tuesday", 2],
    ["tue", 2],
    ["wtorek", 2],
    ["wt", 2],
    ["wednesday", 3],
    ["wed", 3],
    ["sroda", 3],
    ["sr", 3],
    ["thursday", 4],
    ["thu", 4],
    ["thurs", 4],
    ["czwartek", 4],
    ["czw", 4],
    ["friday", 5],
    ["fri", 5],
    ["piatek", 5],
    ["pt", 5],
    ["saturday", 6],
    ["sat", 6],
    ["sobota", 6],
    ["sob", 6]
  ]);

  const weekdays = [];
  for (const part of parts) {
    const normalized = normalizeDayToken(part);
    if (!normalized) {
      continue;
    }

    if (/^[0-6]$/.test(normalized)) {
      weekdays.push(Number.parseInt(normalized, 10));
      continue;
    }

    const dayNumber = dayMapping.get(normalized);
    if (dayNumber == null) {
      throw new Error(`${fieldName} contains unsupported day: ${part}`);
    }
    weekdays.push(dayNumber);
  }

  return [...new Set(weekdays)];
}

function parseDateListInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }

  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");

  const dates = [];
  for (const part of parts) {
    const normalized = normalizeWhitespace(part);
    if (!normalized) {
      continue;
    }
    dates.push(parseDate(normalized, fieldName).raw);
  }

  return [...new Set(dates)].sort();
}

function addDaysToDate(date, daysToAdd) {
  const clone = new Date(date.getTime());
  clone.setDate(clone.getDate() + daysToAdd);
  return clone;
}

function nearestWeekdayDateFromNow(targetWeekday) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (targetWeekday - today.getDay() + 7) % 7;
  return addDaysToDate(today, offset);
}

function toIsoLocalDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rollingDateOptionsFromTomorrow(daysCount) {
  if (!daysCount) {
    return [];
  }

  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Array.from({ length: daysCount }, (_, index) => toIsoLocalDate(addDaysToDate(tomorrow, index)));
}

function loadConfig(argv) {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    return { help: true };
  }

  let fileConfig = {};
  if (cli.config) {
    const configPath = path.resolve(cli.config);
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fileConfig.__configPath = configPath;
  }

  const merged = {
    ...fileConfig,
    ...cli
  };

  const locations = (cli.locations || []).length
    ? uniqueStrings(cli.locations)
    : uniqueStrings(Array.isArray(fileConfig.locations) ? fileConfig.locations : []);

  const pickupDate = merged.pickupDate ?? merged["pickup-date"];
  const pickupTime = merged.pickupTime ?? merged["pickup-time"];
  const dropoffDate = merged.dropoffDate ?? merged["dropoff-date"];
  const dropoffTime = merged.dropoffTime ?? merged["dropoff-time"];

  if (!locations.length) {
    throw new Error("At least one location is required. Use --location or provide locations in the config file.");
  }
  if (!pickupDate || !pickupTime || !dropoffDate || !dropoffTime) {
    throw new Error("pickupDate, pickupTime, dropoffDate, and dropoffTime are required.");
  }

  const parsedPickupDate = parseDate(pickupDate, "pickupDate");
  const parsedDropoffDate = parseDate(dropoffDate, "dropoffDate");
  parseTime(pickupTime, "pickupTime");
  parseTime(dropoffTime, "dropoffTime");

  const pickupStamp = new Date(`${pickupDate}T${pickupTime}:00`);
  const dropoffStamp = new Date(`${dropoffDate}T${dropoffTime}:00`);
  if (!(pickupStamp < dropoffStamp)) {
    throw new Error("Drop-off date/time must be after pick-up date/time.");
  }

  const fileDurations = parseDurationDaysInput(
    fileConfig.durationsDays
    ?? fileConfig["durations-days"]
    ?? fileConfig.durationDays
    ?? fileConfig["duration-days"],
    "durationsDays"
  );
  const cliDurations = parseDurationDaysInput(cli.durationDays, "duration-days");
  const configuredDurations = cliDurations.length ? cliDurations : fileDurations;

  const defaultDurationDays = Math.round((dropoffStamp.getTime() - pickupStamp.getTime()) / (24 * 60 * 60 * 1000));
  const durationDays = configuredDurations.length
    ? configuredDurations
    : [defaultDurationDays];

  const rollingDays = parsePositiveIntegerInput(
    merged.rollingDays
    ?? merged["rolling-days"]
    ?? merged.startRangeDays
    ?? merged["start-range-days"],
    "rollingDays"
  );

  const configuredPickupWeekdays = [...new Set([
    ...parsePickupWeekdaysInput(
      fileConfig.pickupWeekdays
      ?? fileConfig["pickup-weekdays"],
      "pickupWeekdays"
    ),
    ...parsePickupWeekdaysInput(cli.pickupWeekdays, "pickup-weekdays")
  ])];

  const configuredStartDates = (cli.startDates || []).length
    ? parseDateListInput(cli.startDates, "start-dates")
    : parseDateListInput(
      fileConfig.startDates
      ?? fileConfig["start-dates"]
      ?? fileConfig.pickupDates
      ?? fileConfig["pickup-dates"],
      "startDates"
    );

  const pickupDateOptions = configuredStartDates.length
    ? configuredStartDates
    : rollingDays
    ? rollingDateOptionsFromTomorrow(rollingDays)
    : configuredPickupWeekdays.length
      ? configuredPickupWeekdays
      .map((weekday) => toIsoLocalDate(nearestWeekdayDateFromNow(weekday)))
      .sort()
      : [parsedPickupDate.raw];

  const configuredSortOrders = [
    ...parseSortOrdersInput(
      fileConfig.sortOrders
      ?? fileConfig["sort-orders"]
      ?? fileConfig.resultsOrder
      ?? fileConfig["results-order"],
      "sortOrders"
    ),
    ...parseSortOrdersInput(cli.sortOrders, "sort-orders")
  ];
  const sortOrders = configuredSortOrders.length
    ? [...new Set(configuredSortOrders)]
    : ["suggested", "price", "price_insurance"];

  const defaultCsvName = `rentcars-results-${makeTimestampForFile()}.csv`;

  return {
    baseUrl: normalizeWhitespace(merged.baseUrl || "https://rentcars.pl"),
    locations,
    pickupDate: parsedPickupDate.raw,
    pickupDateOptions,
    pickupTime: normalizeWhitespace(pickupTime),
    dropoffDate: parsedDropoffDate.raw,
    dropoffTime: normalizeWhitespace(dropoffTime),
    durationDays,
    rollingDays,
    sortOrders,
    residenceCountry: normalizeWhitespace(merged.residenceCountry || merged["residence-country"] || "Poland"),
    driverAge: Number.parseInt(merged.driverAge || merged["driver-age"] || "30", 10),
    maxProvidersPerLocation: Number.parseInt(
      merged.maxProvidersPerLocation || merged["max-providers-per-location"] || "25",
      10
    ),
    timeoutMs: Number.parseInt(merged.timeoutMs || merged["timeout-ms"] || "45000", 10),
    speedMode: normalizeWhitespace(merged.speedMode || merged["speed-mode"] || "safe"),
    locationConcurrency: parsePositiveIntegerInput(
      merged.locationConcurrency || merged["location-concurrency"],
      "locationConcurrency"
    ) || 1,
    headless: merged.headless !== false,
    browserExecutablePath: normalizeWhitespace(
      merged.browserExecutablePath || merged["browser-executable-path"] || ""
    ) || null,
    outputCsv: path.resolve(merged.outputCsv || merged["output-csv"] || path.join("output", defaultCsvName)),
    artifactsDir: path.resolve(merged.artifactsDir || merged["artifacts-dir"] || path.join("artifacts", "rentcars")),
    configPath: fileConfig.__configPath || null
  };
}

function printHelp() {
  const message = `
RentCars.pl scraper

Usage:
  node .\\src\\rentcars\\cli.js --config .\\rentcars.config.example.json

  node .\\src\\rentcars\\cli.js ^
    --location "Warszawa" ^
    --location "Krakow" ^
    --pickup-date 2026-05-15 ^
    --pickup-time 10:00 ^
    --dropoff-date 2026-05-18 ^
    --dropoff-time 10:00

Options:
  --config PATH
  --location TEXT              Repeatable
  --locations "A,B,C"         Comma-separated shortcut
  --pickup-date YYYY-MM-DD
  --pickup-time HH:MM
  --dropoff-date YYYY-MM-DD
  --dropoff-time HH:MM
  --start-dates "YYYY-MM-DD,YYYY-MM-DD"
  --rolling-days NUMBER       Rolling pickup start dates from tomorrow
  --pickup-weekdays "thursday,friday"
  --pickup-weekday DAY        Repeatable shortcut
  --durations-days "2,3,4"    Multiple rental lengths in days
  --duration-days NUMBER       Repeatable shortcut
  --sort-orders "suggested,price,price_insurance"
  --max-providers-per-location NUMBER
  --location-concurrency NUMBER
  --residence-country TEXT
  --driver-age NUMBER
  --output-csv PATH
  --artifacts-dir PATH
  --browser-executable-path PATH
  --timeout-ms NUMBER
  --headed
  --help
`;

  process.stdout.write(message.trimStart());
}

module.exports = {
  loadConfig,
  printHelp
};
