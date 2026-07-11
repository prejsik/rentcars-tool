const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const {
  ensureDir,
  formatMoney,
  normalizeWhitespace,
  parseDate,
  parseMoney,
  safeFilePart,
  toAccessibleDateLabels,
  writeTextFile
} = require("./utils");
const { locationCatalog, normalizeLocationKey } = require("./locations");

const COOKIE_BUTTON_PATTERNS = [
  /akceptuj wszystkie/i,
  /akceptuj/i,
  /zgadzam/i,
  /odrzu[c\u0107] opcjonalne/i,
  /accept all/i,
  /accept/i,
  /allow all/i,
  /agree/i,
  /got it/i,
  /continue/i,
  /understand/i
];

const SEARCH_BUTTON_PATTERNS = [/^szukaj$/i, /sprawd(?:z|\u017a) cen(?:e|\u0119)/i, /search now/i, /^search$/i, /show cars/i, /find cars/i];
const PICKUP_VALIDATION_ERROR_PATTERN = /punkt odbioru|pick-?up location/i;
const LOAD_MORE_RESULTS_PATTERN = /zobacz\s+wi(?:e|\u0119)cej|poka(?:z|\u017c)\s+wi(?:e|\u0119)cej|wi(?:e|\u0119)cej\s+samochod|load more|show more|more cars/i;
const AUTOMATIC_TRANSMISSION_PATTERN = /automatyczna|automatic|automat\b/i;
const MANUAL_TRANSMISSION_PATTERN = /manualna|manual\b|r\u0119czna|reczna/i;
const RENTCARS_SORT_OPTIONS = new Map([
  ["suggested", { order: "suggested", label: "sugerowane", priceMode: "base" }],
  ["price", { order: "price", label: "po cenie", priceMode: "base" }],
  ["price_insurance", { order: "price_insurance", label: "po cenie z ubezpieczeniem", priceMode: "insurance" }]
]);

function clampPositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function normalizeSpeedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fast" || normalized === "turbo") {
    return normalized;
  }
  return "safe";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryLocationOutcome(outcome) {
  return /No offers could be extracted|No valid offers|Could not find|Could not select|was not accepted|timed? out|navigation|Target page|browser has been closed/i
    .test(String(outcome?.error?.message || ""));
}

function isBlockedThirdPartyResource(url) {
  return /(?:popupsmart|smartsupp|googletagmanager|google-analytics|googleadservices|doubleclick|facebook|tiktok)\./i
    .test(String(url || ""));
}

async function closeBrowserWithTimeout(browser, timeoutMs = 5000) {
  await Promise.race([
    browser.close(),
    delay(timeoutMs)
  ]).catch(() => {});
}

class RentCarsScraper {
  constructor(config) {
    this.config = config;
    this.locationCandidateCache = new Map();
  }

  async run() {
    ensureDir(this.config.artifactsDir);
    const browser = await chromium.launch(this.resolveLaunchOptions());

    const results = [];
    const failures = [];
    let searchTargets = [];
    let outcomes = [];

    try {
      const requestedLocations = Array.isArray(this.config.locations) ? [...this.config.locations] : [];
      const locationTargets = await this.resolveLocationSearchTargets(browser, requestedLocations);
      const sortOrders = normalizeSortOrders(this.config.sortOrders);
      searchTargets = [];
      for (const locationTarget of locationTargets) {
        for (const sortOrder of sortOrders) {
          const sortOption = rentCarsSortOption(sortOrder);
          searchTargets.push({
            ...locationTarget,
            sortOrder: sortOption.order,
            sortLabel: sortOption.label,
            priceMode: sortOption.priceMode
          });
        }
      }

      const workerCount = clampPositiveInteger(this.config.locationConcurrency, 1, 1, 6);
      const boundedWorkers = Math.max(1, Math.min(workerCount, searchTargets.length || 1));
      outcomes = new Array(searchTargets.length);
      const runTargetIndexes = async (indexes, concurrency, attemptNumber) => {
        let nextIndex = 0;
        const workers = Array.from({ length: Math.max(1, Math.min(concurrency, indexes.length || 1)) }, async () => {
          while (true) {
            const listIndex = nextIndex;
            nextIndex += 1;
            if (listIndex >= indexes.length) {
              return;
            }

            const targetIndex = indexes[listIndex];
            const target = searchTargets[targetIndex];
            if (attemptNumber > 1) {
              console.log(`RETRY ${attemptNumber - 1}/2 ${formatSearchTarget(target)} -> ${outcomes[targetIndex]?.error?.message || "failed"}`);
              await delay(1000 * attemptNumber + Math.floor(Math.random() * 500));
            }
            outcomes[targetIndex] = {
              ...await this.runSingleLocation(browser, target),
              attemptCount: attemptNumber
            };
          }
        });
        await Promise.all(workers);
      };

      await runTargetIndexes(searchTargets.map((_, index) => index), boundedWorkers, 1);
      for (let attemptNumber = 2; attemptNumber <= 3; attemptNumber += 1) {
        const retryIndexes = outcomes
          .map((outcome, index) => ({ outcome, index }))
          .filter(({ outcome }) => outcome && !outcome.ok && shouldRetryLocationOutcome(outcome))
          .map(({ index }) => index);
        if (!retryIndexes.length) {
          break;
        }
        await runTargetIndexes(retryIndexes, 2, attemptNumber);
      }

      for (let index = 0; index < searchTargets.length; index += 1) {
        const target = searchTargets[index];
        const outcome = outcomes[index];
        const targetLabel = formatSearchTarget(target);
        if (!outcome) {
          failures.push(searchTargetFailure(target, "Unknown scraper failure.", 1));
          console.log(`ERR ${targetLabel} -> Unknown scraper failure.`);
          continue;
        }

        if (outcome.ok) {
          results.push(...outcome.results);
          console.log(
            `OK  ${targetLabel} -> ${outcome.cheapest.provider} -> ${formatMoney(outcome.cheapest.totalPrice, outcome.cheapest.currency)}`
          );
          continue;
        }

        failures.push(searchTargetFailure(target, outcome.error.message, outcome.attemptCount));
        console.log(`ERR ${targetLabel} -> ${outcome.error.message}`);
      }
    } finally {
      await closeBrowserWithTimeout(browser);
    }

    return {
      results,
      failures,
      expectedTargets: searchTargets.map((target) => ({
        requestedLocation: target.requestedLocation,
        location: target.location,
        pickupLocationId: target.value || "",
        sortOrder: target.sortOrder,
        sortLabel: target.sortLabel,
        priceMode: target.priceMode
      })),
      successfulCheckCount: outcomes.filter((outcome) => outcome?.ok).length,
      failedCheckCount: failures.length
    };
  }

  resolveLaunchOptions() {
    const executablePath = firstExistingPath([
      this.config.browserExecutablePath,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ]);

    const options = {
      headless: this.config.headless
    };

    if (executablePath) {
      options.executablePath = executablePath;
    }

    return options;
  }

  async resolveLocationSearchTargets(browser, requestedLocations) {
    const fallbackTargets = makeAirportOnlyFallbackTargets(requestedLocations);
    if (!/rentcars\.pl/i.test(this.config.baseUrl)) {
      return fallbackTargets;
    }

    const staticAirportTargets = makeStaticAirportLocationTargets(requestedLocations);
    if (staticAirportTargets.length) {
      return staticAirportTargets;
    }

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      locale: "pl-PL"
    });
    await this.configureContext(context);

    const page = await context.newPage();
    page.setDefaultTimeout(this.config.timeoutMs);
    page.setDefaultNavigationTimeout(this.config.timeoutMs);

    try {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
      await this.acceptCookies(page);
      await page.waitForSelector("#pickup-location_place", { timeout: this.config.timeoutMs }).catch(() => {});

      const options = await page.evaluate(() => Array.from(
        document.querySelectorAll("#pickup-location_place option")
      ).map((option) => ({
        value: option.value || "",
        label: String(option.textContent || "").replace(/\s+/g, " ").trim(),
        className: option.className || ""
      })).filter((option) => option.value && option.label)).catch(() => []);

      if (!options.length) {
        return fallbackTargets;
      }

      const targets = [];
      for (const requestedLocation of requestedLocations) {
        const matches = findRentCarsLocationMatches(requestedLocation, options);
        if (!matches.length) {
          const airportFallbacks = makeAirportOnlyFallbackTargets([requestedLocation]);
          targets.push(...airportFallbacks);
          continue;
        }

        for (const match of matches) {
          targets.push(makeLocationTarget(requestedLocation, match));
        }

        console.log(`LOC ${requestedLocation} -> ${matches.length} option(s): ${matches.map((item) => item.label).join(" | ")}`);
      }

      return targets.length ? targets : fallbackTargets;
    } finally {
      await context.close().catch(() => {});
    }
  }

  async runSingleLocation(browser, targetInput) {
    const target = makeLocationTarget(targetInput);
    const location = target.location;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      locale: "en-US"
    });

    await this.configureContext(context);

    const page = await context.newPage();
    page.setDefaultTimeout(this.config.timeoutMs);
    page.setDefaultNavigationTimeout(this.config.timeoutMs);

    const responseCollector = this.createResponseCollector();
    page.on("response", async (response) => {
      await this.captureResponseOffers(responseCollector, response, target);
    });

    try {
      let homepagePrepared = false;
      if (!this.isFastMode()) {
        await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
        await this.acceptCookies(page);
        await this.dismissObstructiveOverlays(page);
        homepagePrepared = true;
      }

      let offers = await this.tryDirectSearchFlow(page, target, responseCollector);

      if (!offers.length) {
        if (!homepagePrepared) {
          await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
          await this.acceptCookies(page);
          await this.dismissObstructiveOverlays(page);
          homepagePrepared = true;
        }

        await this.fillSearchForm(page, target);
        await this.submitSearch(page);
        await this.ensureConfiguredSearchPeriod(page);
        await this.waitForResults(page);
        if (this.prefersAutomaticTransmission()) {
          responseCollector.clear();
          if (await this.applyAutomaticTransmissionFilter(page)) {
            console.log(`FLT ${formatSearchTarget(target)} -> automatic transmission`);
          }
        }
        await this.waitForCollectorOffers(responseCollector, this.collectorWaitTimeoutMs());

        const pageOffers = await this.collectOffersFromCurrentPage(page, target);
        await this.loadAdditionalResultPages(page, target, responseCollector, pageOffers);
        offers = dedupeOffers([
          ...responseCollector.getOffers(),
          ...pageOffers
        ]);
      }
      if (!offers.length) {
        throw new Error("No offers could be extracted from the results page.");
      }

      const filteredOffers = this.filterOffersForConfiguredTransmission(offers);
      const locationOffers = normalizeTransmissionPreference(this.config.transmission) === "any"
        ? selectBestOffersForTransmissionViews(
          filteredOffers,
          target,
          this.config.maxProvidersPerLocation,
          this.config.focusProviders || []
        )
        : selectBestOffersByProvider(
          filteredOffers,
          target,
          this.config.maxProvidersPerLocation,
          this.config.focusProviders || []
        );
      if (!locationOffers.length) {
        throw new Error("No valid offers with provider and price were extracted.");
      }

      const cheapest = locationOffers[0];
      return {
        ok: true,
        cheapest,
        results: locationOffers.map((offer) => ({
          ...offer,
          requestedLocation: target.requestedLocation,
          pickupLocation: target.location,
          pickupLocationId: target.value || "",
          sortOrder: target.sortOrder,
          sortLabel: target.sortLabel,
          priceMode: target.priceMode
        }))
      };
    } catch (error) {
      await this.captureFailureArtifacts(page, target);
      return { ok: false, error };
    } finally {
      await context.close().catch(() => {});
    }
  }

  isFastMode() {
    return normalizeSpeedMode(this.config.speedMode) !== "safe";
  }

  collectorWaitTimeoutMs() {
    const speedMode = normalizeSpeedMode(this.config.speedMode);
    if (speedMode === "turbo") {
      return 1000;
    }
    if (speedMode === "fast") {
      return 5000;
    }
    return 8000;
  }

  async configureContext(context) {
    if (this.config.currency) {
      await context
        .addCookies([
          {
            name: "currency",
            value: this.config.currency,
            url: this.config.baseUrl
          }
        ])
        .catch(() => {});
    }

    if (!this.isFastMode()) {
      return;
    }

    await context.route("**/*", async (route) => {
      const resourceType = route.request().resourceType();
      if (isBlockedThirdPartyResource(route.request().url())) {
        await route.abort().catch(() => {});
        return;
      }
      if (resourceType === "image" || resourceType === "font" || resourceType === "media") {
        await route.abort().catch(() => {});
        return;
      }

      await route.continue().catch(() => {});
    });
  }

  async tryDirectSearchFlow(page, location, collector) {
    const target = makeLocationTarget(location);
    if (!/rentcars\.pl/i.test(this.config.baseUrl) || !target.value) {
      return [];
    }

    const origin = new URL(this.config.baseUrl).origin;
    const searchUrl = this.buildDirectSearchUrl(origin, target.value);
    const loaded = await page
      .goto(searchUrl, { waitUntil: "domcontentloaded", timeout: this.config.timeoutMs })
      .then(() => true)
      .catch(() => false);

    if (!loaded || !(await this.looksLikeSearchPage(page))) {
      return [];
    }

    await this.waitForResults(page);
    if (this.prefersAutomaticTransmission()) {
      collector.clear();
      if (await this.applyAutomaticTransmissionFilter(page)) {
        console.log(`FLT ${formatSearchTarget(target)} -> automatic transmission`);
      }
    }
    await this.waitForCollectorOffers(collector, this.collectorWaitTimeoutMs());

    const pageOffers = await this.collectOffersFromCurrentPage(page, target);
    await this.loadAdditionalResultPages(page, target, collector, pageOffers);
    return dedupeOffers([
      ...collector.getOffers(),
      ...pageOffers
    ]);
  }

  async resolveLocationCandidates(page, location) {
    const cacheKey = normalizeWhitespace(location).toLowerCase();
    if (this.locationCandidateCache.has(cacheKey)) {
      return [...this.locationCandidateCache.get(cacheKey)];
    }

    const baseUrl = new URL(this.config.baseUrl);
    const endpoint = `${baseUrl.origin}/api/v2/autocomplete?location=${encodeURIComponent(location)}`;
    const response = await page.request.get(endpoint).catch(() => null);
    if (!response || !response.ok()) {
      return [];
    }

    const payload = await response.json().catch(() => null);
    const rawCandidates = Array.isArray(payload?.result) ? payload.result : [];

    const normalizedLocation = normalizeWhitespace(location).toLowerCase();
    const allLocations = rawCandidates.filter((item) => /all locations/i.test(String(item.place || "")));
    const cityMatches = rawCandidates.filter((item) => normalizeWhitespace(item.city).toLowerCase().includes(normalizedLocation));
    const exactMatches = rawCandidates.filter((item) => normalizeWhitespace(item.place).toLowerCase().includes(normalizedLocation));

    const candidates = [
      ...allLocations,
      ...cityMatches,
      ...exactMatches,
      ...rawCandidates
    ];
    this.locationCandidateCache.set(cacheKey, candidates);
    return [...candidates];
  }

  buildDirectSearchUrl(origin, placeId) {
    const sqPayload = {
      PickupLocationId: placeId,
      DropOffLocationId: placeId,
      PickupDateTime: `${this.config.pickupDate}T${this.config.pickupTime}:00`,
      DropOffDateTime: `${this.config.dropoffDate}T${this.config.dropoffTime}:00`,
      ResidenceCountry: normalizeCountryCode(this.config.residenceCountry) || "PL",
      DriverAge: Number.isFinite(this.config.driverAge) ? this.config.driverAge : 30,
      Hash: ""
    };

    const sq = encodeSqPayload(sqPayload);
    const guid = crypto.randomUUID();
    return `${origin}/search/${guid}?sq=${sq}`;
  }

  createResponseCollector() {
    const offers = [];
    const seenKeys = new Set();

    return {
      add: (entries) => {
        for (const entry of this.filterOffersForConfiguredTransmission(entries)) {
          const key = `${entry.provider}|${entry.totalPrice}|${entry.location}|${entry.sortOrder || ""}|${entry.priceMode || ""}`;
          if (seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);
          offers.push(entry);
        }
      },
      clear: () => {
        offers.length = 0;
        seenKeys.clear();
      },
      getOffers: () => [...offers]
    };
  }

  async captureResponseOffers(collector, response, fallbackLocation) {
    const url = response.url();
    const headers = response.headers();
    const contentType = String(headers["content-type"] || "");

    if (!/rentcars/i.test(url)) {
      return;
    }
    if (!/json|javascript/i.test(contentType)) {
      return;
    }

    try {
      const payload = await response.json();
      const offers = this.extractOffersFromUnknownPayload(payload, fallbackLocation, "network");
      if (offers.length) {
        collector.add(offers);
      }
    } catch {
      return;
    }
  }

  async acceptCookies(page) {
    const selectors = [
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "#onetrust-accept-btn-handler",
      "button#onetrust-accept-btn-handler",
      "[data-testid='cookie-accept-all']"
    ];

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ timeout: 3000, force: true }).catch(() => {});
          await page.evaluate((cssSelector) => {
            const element = document.querySelector(cssSelector);
            if (element instanceof HTMLElement) {
              element.click();
            }
          }, selector).catch(() => {});
          await page.waitForTimeout(800);
          if (!(await this.cookieBannerLooksVisible(page))) {
            return;
          }
        }
      }

      for (const pattern of [
        /accept all cookies/i,
        ...COOKIE_BUTTON_PATTERNS
      ]) {
        const button = page.getByRole("button", { name: pattern }).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3000, force: true }).catch(() => {});
          await page.evaluate(() => {
            const buttonElement = Array.from(document.querySelectorAll("button"))
              .find((element) => /accept all cookies|accept all|accept/i.test((element.textContent || "").trim()));
            if (buttonElement instanceof HTMLElement) {
              buttonElement.click();
            }
          }).catch(() => {});
          await page.waitForTimeout(800);
          if (!(await this.cookieBannerLooksVisible(page))) {
            return;
          }
        }
      }

      if (!(await this.cookieBannerLooksVisible(page))) {
        return;
      }

      await page.waitForTimeout(500);
    }
  }

  async cookieBannerLooksVisible(page) {
    const signals = [
      page.locator("#onetrust-banner-sdk").first(),
      page.getByText(/consent to cookies/i).first(),
      page.getByRole("button", { name: /accept all cookies/i }).first()
    ];

    for (const signal of signals) {
      if (await signal.isVisible().catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  async fillSearchForm(page, locationInput) {
    await this.dismissObstructiveOverlays(page);
    const target = makeLocationTarget(locationInput);
    if (await this.fillRentCarsForm(page, target)) {
      return;
    }

    await this.setPickupLocation(page, target.location);
    await this.tryFillDateAndTimeInForm(page);
    await this.setResidenceCountry(page, this.config.residenceCountry);
    await this.setDriverAge(page, this.config.driverAge);
  }

  async fillRentCarsForm(page, locationInput) {
    if (!/rentcars\.pl/i.test(this.config.baseUrl)) {
      return false;
    }

    const hasForm = await page.locator("#form-cars-search").first().isVisible().catch(() => false);
    if (!hasForm) {
      return false;
    }

    const target = makeLocationTarget(locationInput);
    const selected = await page.evaluate(
      ({ locationText, locationValue, pickupDate, dropoffDate, pickupTime, dropoffTime, sortOrder }) => {
        const normalize = (value) => String(value || "")
          .normalize("NFD")
          .replace(/[\u0141\u0142]/g, "l")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

        const dispatch = (element) => {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };

        const chooseLocation = (selectId, hiddenId, preselectionId, displayId) => {
          const select = document.querySelector(selectId);
          if (!(select instanceof HTMLSelectElement)) {
            return null;
          }

          const wanted = normalize(locationText);
          const wantedValue = String(locationValue || "");
          const options = Array.from(select.options).filter((option) => option.value);
          const exactValue = wantedValue
            ? options.find((option) => option.value === wantedValue)
            : null;
          const exactLabel = options.find((option) => normalize(option.textContent) === wanted);
          const exactCity = options.find((option) => normalize(option.textContent) === `${wanted}, centrum`);
          const startsWithCity = options.find((option) =>
            normalize(option.textContent).startsWith(`${wanted},`) && !/lotnisko/i.test(option.textContent || "")
          );
          const anyCity = options.find((option) => normalize(option.textContent).startsWith(`${wanted},`));
          const containsCity = options.find((option) => normalize(option.textContent).includes(wanted));
          const option = exactValue || exactLabel || exactCity || startsWithCity || anyCity || containsCity;

          if (!option) {
            return null;
          }

          select.value = option.value;
          dispatch(select);

          for (const selector of [hiddenId, preselectionId]) {
            const hidden = document.querySelector(selector);
            if (hidden instanceof HTMLInputElement) {
              hidden.value = option.value;
              dispatch(hidden);
            }
          }

          const display = document.querySelector(displayId);
          if (display) {
            display.textContent = option.textContent || "";
            display.setAttribute("title", option.textContent || "");
          }

          return {
            value: option.value,
            label: option.textContent || ""
          };
        };

        const setInputValue = (selector, value) => {
          const input = document.querySelector(selector);
          if (!(input instanceof HTMLInputElement)) {
            return false;
          }
          input.value = value;
          dispatch(input);
          return true;
        };

        const setSelectValue = (selector, value, displayId) => {
          const select = document.querySelector(selector);
          if (!(select instanceof HTMLSelectElement)) {
            return false;
          }
          select.value = value;
          dispatch(select);
          const display = document.querySelector(displayId);
          if (display) {
            display.textContent = value;
            display.setAttribute("title", value);
          }
          return true;
        };

        const setHiddenValue = (selector, value) => {
          const input = document.querySelector(selector);
          if (!(input instanceof HTMLInputElement)) {
            return false;
          }
          input.value = value;
          dispatch(input);
          return true;
        };

        const pickup = chooseLocation(
          "#pickup-location_place",
          "#pickup-location",
          "#pickup-location_place_preselection",
          "#select2-pickup-location_place-container"
        );
        const dropoff = chooseLocation(
          "#return-location_place",
          "#return-location",
          "#return-location_place_preselection",
          "#select2-return-location_place-container"
        );

        const pickupDateSet = setInputValue("#pickup-date", pickupDate);
        const dropoffDateSet = setInputValue("#return-date", dropoffDate);
        const pickupTimeSet = setSelectValue("#time_range-time_start", pickupTime, "#select2-time_range-time_start-container");
        const dropoffTimeSet = setSelectValue("#time_range-time_end", dropoffTime, "#select2-time_range-time_end-container");
        const sortOrderSet = setHiddenValue("#results_order", sortOrder);

        return {
          ok: Boolean(pickup && dropoff && pickupDateSet && dropoffDateSet && pickupTimeSet && dropoffTimeSet),
          pickup,
          dropoff,
          pickupDateSet,
          dropoffDateSet,
          pickupTimeSet,
          dropoffTimeSet,
          sortOrderSet
        };
      },
      {
        locationText: target.location,
        locationValue: target.value || "",
        pickupDate: this.config.pickupDate,
        dropoffDate: this.config.dropoffDate,
        pickupTime: this.config.pickupTime,
        dropoffTime: this.config.dropoffTime,
        sortOrder: target.sortOrder || "suggested"
      }
    ).catch(() => ({ ok: false }));

    if (!selected?.ok) {
      return false;
    }

    await page.waitForTimeout(300);
    return true;
  }

  async tryFillDateAndTimeInForm(page) {
    const steps = [
      () => this.setDateRange(page, this.config.pickupDate, this.config.dropoffDate),
      () => this.setTime(page, this.config.pickupTime, 0),
      () => this.setTime(page, this.config.dropoffTime, 1)
    ];

    for (const step of steps) {
      await step().catch(() => {});
    }
  }

  async setPickupLocation(page, location) {
    await this.acceptCookies(page);

    const inputCandidates = [
      page.getByPlaceholder(/enter airport or city/i).first(),
      page.getByPlaceholder(/punkt odbioru/i).first(),
      page.getByPlaceholder(/miejsce odbioru/i).first(),
      page.getByPlaceholder(/pick-up location/i).first(),
      page.getByLabel(/punkt odbioru/i).first(),
      page.getByLabel(/miejsce odbioru/i).first(),
      page.getByLabel(/pick-up location/i).first(),
      page.locator("input[placeholder*='Punkt']").first(),
      page.locator("input[placeholder*='Pick-up']").first(),
      page.locator("input:not([readonly])[name*='pickup' i]:not([name*='date' i]), input:not([readonly])[name*='odbior' i], input:not([readonly])[name*='from' i]").first(),
      page.locator("input:not([readonly])[name*='pick' i]:not([name*='date' i])").first(),
      page.locator("input:not([readonly]):not([type='hidden']):not([type='submit']):not([type='button']):not([id*='date' i]):not([name*='date' i])").first()
    ];

    let input = null;
    for (const candidate of inputCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        input = candidate;
        break;
      }
    }

    if (!input) {
      const trigger = page.getByText(/punkt odbioru|miejsce odbioru|pick-up location/i).first();
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: 3000 });
      }

      for (const candidate of inputCandidates) {
        if (await candidate.isVisible().catch(() => false)) {
          input = candidate;
          break;
        }
      }
    }

    if (!input) {
      throw new Error("Could not find the pick-up location input.");
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await input.click({ timeout: 5000, force: true }).catch(() => {});
      await input.focus().catch(() => {});
      await input.press("Control+A").catch(() => {});
      await input.fill("");
      await input.type(location, { delay: 80 });
      await page.waitForTimeout(1000);

      const selected = await this.chooseAutocompleteOption(page, location, input);
      if (!selected) {
        continue;
      }

      const looksValid = await this.locationSelectionLooksValid(page, input, location);
      if (looksValid) {
        return;
      }
    }

    throw new Error(`Could not select pick-up location "${location}" from autocomplete.`);
  }

  async chooseAutocompleteOption(page, location, input) {
    const escapedLocation = escapeRegExp(location);
    const exactishPattern = new RegExp(escapedLocation, "i");
    const allLocationsPattern = new RegExp(`${escapedLocation}.*all locations`, "i");
    const autocompleteItemSelector = ".Autocomplete-AutocompleteItem, [class*='AutocompleteItem'], .select2-results__option, .ui-menu-item, [class*='autocomplete' i], [class*='suggest' i], [role='option']";
    const optionCandidates = [
      page.locator(autocompleteItemSelector).filter({ hasText: allLocationsPattern }).first(),
      page.locator(autocompleteItemSelector).filter({ hasText: exactishPattern }).first(),
      page.locator(autocompleteItemSelector).first(),
      page.getByRole("option", { name: exactishPattern }).first(),
      page.locator("[role='option']").filter({ hasText: exactishPattern }).first(),
      page.locator("li").filter({ hasText: exactishPattern }).first(),
      page.locator("[class*='option']").filter({ hasText: exactishPattern }).first(),
      page.locator("[class*='suggest']").filter({ hasText: exactishPattern }).first()
    ];

    for (const option of optionCandidates) {
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(500);
        const pickerStillVisible = await page.locator(autocompleteItemSelector).first().isVisible().catch(() => false);
        if (!pickerStillVisible) {
          return true;
        }
      }
    }

    await input.press("ArrowDown").catch(() => {});
    await page.waitForTimeout(200);
    await input.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
    return await this.locationSelectionLooksValid(page, input, location);
  }

  async locationSelectionLooksValid(page, input, expectedLocation) {
    const value = normalizeWhitespace(await input.inputValue().catch(() => ""));
    const hasErrorClass = await input.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      return element.classList.contains("Autocomplete-EnterLocation_hasError") || element.getAttribute("aria-invalid") === "true";
    }).catch(() => false);

    const hasValidationError = await this.hasPickupLocationValidationError(page);
    const hasAnyValue = Boolean(value);
    const valueLooksReasonable = hasAnyValue && new RegExp(escapeRegExp(expectedLocation), "i").test(value);

    return !hasErrorClass && !hasValidationError && (valueLooksReasonable || hasAnyValue);
  }

  async hasPickupLocationValidationError(page) {
    const inlineError = page
      .locator(".SearchModifier-Errors_isVisible .SearchModifier-Error")
      .filter({ hasText: PICKUP_VALIDATION_ERROR_PATTERN })
      .first();
    return await inlineError.isVisible().catch(() => false);
  }

  async setDateRange(page, pickupDate, dropoffDate) {
    if (await this.fillNativeDateInputs(page, pickupDate, dropoffDate)) {
      return;
    }

    await this.openCalendarFor(page, "pickup", 0);
    await page.waitForFunction(() => {
      const wrapper = document.querySelector(".DatePicker-CalendarWrapper_isVisible");
      return Boolean(wrapper);
    }, null, {
      timeout: 10000
    });
    await this.selectDateFromRangePicker(page, pickupDate);
    await page.waitForTimeout(250);
    await this.selectDateFromRangePicker(page, dropoffDate);
    await page.waitForTimeout(500);
  }

  async fillNativeDateInputs(page, pickupDate, dropoffDate) {
    const values = [pickupDate, dropoffDate];
    const selectors = [
      "input[type='date']",
      "input[name*='date' i]",
      "input[name*='data' i]",
      "input[id*='date' i]",
      "input[id*='data' i]"
    ];
    const inputs = page.locator(selectors.join(","));
    const count = await inputs.count().catch(() => 0);
    if (count < 2) {
      return false;
    }

    let filled = 0;
    for (let index = 0; index < Math.min(count, 2); index += 1) {
      const input = inputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) {
        continue;
      }
      const value = values[index];
      const typed = await input.fill(value, { timeout: 3000 }).then(() => true).catch(() => false);
      if (!typed) {
        continue;
      }
      await input.evaluate((element) => {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(() => {});
      filled += 1;
    }

    return filled >= 2;
  }

  async openCalendarFor(page, kind, locationIndex) {
    await this.acceptCookies(page);

    const patterns = kind === "pickup"
      ? [/data odbioru/i, /pick-up date/i, /pickup date/i]
      : [/data zwrotu/i, /drop-off date/i, /dropoff date/i];

    const candidates = [
      page.locator(".DatePicker-CalendarField").nth(locationIndex),
      page.locator("input[type='text'], input[type='date']").nth(locationIndex + 1),
      ...patterns.map((pattern) => page.getByText(pattern).nth(0)),
      ...patterns.map((pattern) => page.getByLabel(pattern).first()),
      page.locator("[data-testid*='date']").nth(locationIndex),
      page.locator("button, div").filter({ hasText: patterns[0] }).nth(0)
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ timeout: 4000, force: true }).catch(() => {});
        await page.waitForTimeout(600);
        return;
      }
    }

    throw new Error(`Could not open the ${kind} date picker.`);
  }

  async selectDateFromRangePicker(page, dateValue) {
    const dateParts = parseDate(dateValue, "date");
    const monthLabel = `${monthName(dateParts)} ${dateParts.year}`;

    for (let step = 0; step < 18; step += 1) {
      const monthVisible = await page
        .locator(".rdrMonth, .Calendar-NavigationMonth")
        .filter({ hasText: new RegExp(escapeRegExp(monthLabel), "i") })
        .first()
        .isVisible()
        .catch(() => false);
      if (monthVisible) {
        break;
      }
      const moved = await this.clickNextMonth(page);
      if (!moved) {
        break;
      }
      await page.waitForTimeout(250);
    }

    const clicked = await page.evaluate(
      ({ targetMonthLabel, targetDay }) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const months = Array.from(document.querySelectorAll(".rdrMonth"));
        const month = months.find((item) => normalize(item.textContent).includes(targetMonthLabel));
        if (!month) {
          return false;
        }

        const dayButtons = Array.from(
          month.querySelectorAll("button.rdrDay:not(.rdrDayPassive):not(.rdrDayDisabled)")
        );
        const dayButton = dayButtons.find(
          (button) => normalize(button.textContent) === String(targetDay)
        );
        if (!dayButton) {
          return false;
        }

        dayButton.click();
        return true;
      },
      { targetMonthLabel: monthLabel, targetDay: dateParts.day }
    );

    if (clicked) {
      await page.waitForTimeout(400);
      return;
    }

    const labels = toAccessibleDateLabels(dateParts);
    for (const label of labels) {
      const exactButton = page.getByRole("button", { name: new RegExp(escapeRegExp(label), "i") }).first();
      if (await exactButton.isVisible().catch(() => false)) {
        await exactButton.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    }

    throw new Error(`Could not select calendar date ${dateValue}.`);
  }

  async clickNextMonth(page) {
    const candidates = [
      page.getByRole("button", { name: /nast(?:e|\u0119)pny|next month/i }).first(),
      page.getByRole("button", { name: /next/i }).first(),
      page.locator("[aria-label*='Next']").first(),
      page.locator("button").filter({ hasText: /^>$/ }).first()
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }

    return false;
  }

  async setTime(page, time, locationIndex) {
    await this.acceptCookies(page);

    const exactPattern = new RegExp(`^${escapeRegExp(time)}$`);

    const comboboxes = [
      page.getByRole("combobox", { name: /time/i }).nth(locationIndex),
      page.getByRole("combobox", { name: /godzina/i }).nth(locationIndex),
      page.locator("select").nth(locationIndex),
      page.locator("[role='combobox']").nth(locationIndex)
    ];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) {
        continue;
      }

      const selected = await combobox.selectOption({ label: time }).then(() => true).catch(() => false);
      if (selected) {
        await page.waitForTimeout(200);
        return;
      }

      const clicked = await combobox.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (clicked) {
        const option = page.getByRole("option", { name: exactPattern }).first();
        if (await option.isVisible().catch(() => false)) {
          await option.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
          return;
        }
      }
    }

    const timeText = page.getByText(exactPattern).nth(locationIndex);
    if (await timeText.isVisible().catch(() => false)) {
      await timeText.click({ timeout: 3000 }).catch(() => {});
    }
  }

  async setResidenceCountry(page, residenceCountry) {
    await this.acceptCookies(page);

    const comboboxes = [
      page.getByRole("combobox", { name: /country of residence/i }).first(),
      page.getByLabel(/country of residence/i).first(),
      page.locator("select").filter({ hasText: /poland|united kingdom|united states/i }).nth(0)
    ];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) {
        continue;
      }

      const selected = await combobox.selectOption({ label: residenceCountry }).then(() => true).catch(() => false);
      if (selected) {
        await page.waitForTimeout(200);
        return;
      }

      const clicked = await combobox.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) {
        continue;
      }

      const option = page.getByRole("option", { name: new RegExp(escapeRegExp(residenceCountry), "i") }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  async setDriverAge(page, driverAge) {
    await this.acceptCookies(page);

    const ageText = driverAge >= 30 && driverAge <= 65 ? "30-65" : String(driverAge);
    const comboboxes = [
      page.getByRole("combobox", { name: /age/i }).first(),
      page.getByLabel(/age/i).first(),
      page.locator("select").nth(1)
    ];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) {
        continue;
      }

      const selected = await combobox.selectOption({ label: ageText }).then(() => true).catch(() => false);
      if (selected) {
        await page.waitForTimeout(200);
        return;
      }

      const clicked = await combobox.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) {
        continue;
      }

      const option = page.getByRole("option", { name: new RegExp(`^${escapeRegExp(ageText)}$`) }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  async submitSearch(page) {
    await this.acceptCookies(page);
    await this.dismissObstructiveOverlays(page);

    const directButtons = [
      page.locator("#elementsubmit").first(),
      page.locator("button[name='elementsubmit']").first(),
      page.locator("#form-cars-search button").filter({ hasText: /szukaj/i }).first()
    ];

    for (const button of directButtons) {
      if (await button.isVisible().catch(() => false)) {
        await Promise.allSettled([
          page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }),
          button.click({ timeout: 4000, force: true })
        ]);
        await page.waitForTimeout(1200);
        if (await this.looksLikeSearchPage(page)) {
          return;
        }
        if (await this.hasPickupLocationValidationError(page)) {
          throw new Error("Pick-up location was not accepted by RentCars.pl.");
        }
      }
    }

    for (const pattern of SEARCH_BUTTON_PATTERNS) {
      const button = page.getByRole("button", { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) {
        await Promise.allSettled([
          page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }),
          button.click({ timeout: 4000 })
        ]);
        await page.waitForTimeout(800);
        if (!(await this.looksLikeSearchPage(page)) && (await this.hasPickupLocationValidationError(page))) {
          throw new Error("Pick-up location was not accepted by RentCars.pl.");
        }
        return;
      }
    }

    const fallback = page.locator("button, a").filter({ hasText: /search/i }).first();
    if (await fallback.isVisible().catch(() => false)) {
      await Promise.allSettled([
        page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }),
        fallback.click({ timeout: 4000 })
      ]);
      await page.waitForTimeout(800);
      if (!(await this.looksLikeSearchPage(page)) && (await this.hasPickupLocationValidationError(page))) {
        throw new Error("Pick-up location was not accepted by RentCars.pl.");
      }
      return;
    }

    throw new Error("Could not find the RentCars.pl search button.");
  }

  async waitForResults(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }).catch(() => {});
    const speedMode = normalizeSpeedMode(this.config.speedMode);
    const networkIdleTimeoutMs = speedMode === "turbo" ? 2_500 : speedMode === "fast" ? 5_000 : 15_000;
    const maxAttempts = speedMode === "turbo" ? 10 : speedMode === "fast" ? 20 : 30;
    const visibleSettleMs = speedMode === "turbo" ? 250 : speedMode === "fast" ? 600 : 1500;
    const pollMs = speedMode === "turbo" ? 250 : speedMode === "fast" ? 400 : 750;
    const finalSettleMs = speedMode === "turbo" ? 500 : speedMode === "fast" ? 1000 : 3000;

    await page.waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs }).catch(() => {});
    await this.waitForLoadingScreenToFinish(page);

    const realResult = page.locator(".car-search-result-item").first();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await realResult.isVisible().catch(() => false)) {
        await page.waitForTimeout(visibleSettleMs);
        return;
      }
      await page.waitForTimeout(pollMs);
    }

    const signals = [
      page.getByText(/sort by|sortuj/i).first(),
      page.getByText(/free cancellation|bezp(?:l|\u0142)atne anulowanie/i).first(),
      page.getByText(/very good|bardzo dobry|sprawd(?:z|\u017a) cen(?:e|\u0119)/i).first(),
      page.locator("article").first()
    ];

    for (const signal of signals) {
      if (await signal.isVisible().catch(() => false)) {
        await page.waitForTimeout(finalSettleMs);
        return;
      }
    }

    await page.waitForTimeout(finalSettleMs);
  }

  async waitForCollectorOffers(collector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (collector.getOffers().length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async collectOffersFromCurrentPage(page, targetInput) {
    const target = makeLocationTarget(targetInput);
    const domOffers = this.filterOffersForConfiguredTransmission(
      await this.extractOffersFromDom(page, target).catch(() => [])
    );
    if (countUniqueOfferProviders(domOffers) >= 3) {
      return dedupeOffers(domOffers);
    }

    const scriptOffers = this.filterOffersForConfiguredTransmission(
      await this.extractOffersFromPageScripts(page, target).catch(() => [])
    );
    return this.filterOffersForConfiguredTransmission(dedupeOffers([
      ...domOffers,
      ...scriptOffers
    ]));
  }

  async loadAdditionalResultPages(page, targetInput, collector, accumulatedOffers) {
    const maxAdditionalPages = clampPositiveInteger(this.config.maxAdditionalResultPages, 1, 0, 3);
    if (maxAdditionalPages < 1) {
      return;
    }

    const target = makeLocationTarget(targetInput);
    const desiredProviders = Math.min(
      3,
      clampPositiveInteger(this.config.maxProvidersPerLocation, 3, 1, 25)
    );
    const seenUrls = new Set([page.url()]);

    for (let pageIndex = 0; pageIndex < maxAdditionalPages; pageIndex += 1) {
      const combinedOffers = dedupeOffers([
        ...collector.getOffers(),
        ...accumulatedOffers
      ]);
      const configuredOffers = this.filterOffersForConfiguredTransmission(combinedOffers);
      const configuredReady = countUniqueOfferProviders(configuredOffers) >= desiredProviders;
      const automaticReady = normalizeTransmissionPreference(this.config.transmission) !== "any"
        || countUniqueOfferProviders(filterOffersByTransmissionPreference(combinedOffers, "automatic")) >= desiredProviders;
      if (configuredReady && automaticReady) {
        return;
      }

      const control = await this.findLoadMoreControl(page);
      if (!control) {
        return;
      }

      const beforeUrl = page.url();
      let loaded = false;
      const href = normalizeWhitespace(control.href);

      if (control.locator) {
        const loadStatePromise = page
          .waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs })
          .catch(() => {});
        const clicked = await control.locator
          .click({ timeout: 5000, force: true })
          .then(() => true)
          .catch(() => false);
        await loadStatePromise;
        loaded = clicked || page.url() !== beforeUrl;
      }

      if (!loaded && href) {
        const nextUrl = resolveUrl(href, beforeUrl);
        if (!nextUrl || seenUrls.has(nextUrl)) {
          return;
        }

        seenUrls.add(nextUrl);
        loaded = await page
          .goto(nextUrl, { waitUntil: "domcontentloaded", timeout: this.config.timeoutMs })
          .then(() => true)
          .catch(() => page.url() !== beforeUrl);
      }

      if (!loaded) {
        return;
      }

      await this.waitForResults(page);
      await this.waitForCollectorOffers(collector, Math.min(this.collectorWaitTimeoutMs(), 5000));
      accumulatedOffers.push(...await this.collectOffersFromCurrentPage(page, target));
    }
  }

  async findLoadMoreControl(page) {
    const locators = [
      page.locator(".load-more a[href], .load-more button").first(),
      page.getByRole("link", { name: LOAD_MORE_RESULTS_PATTERN }).first(),
      page.getByRole("button", { name: LOAD_MORE_RESULTS_PATTERN }).first(),
      page.locator("a, button, [role='button']").filter({ hasText: LOAD_MORE_RESULTS_PATTERN }).first()
    ];

    for (const locator of locators) {
      if (!(await locator.count().catch(() => 0))) {
        continue;
      }
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }

      const disabled = await locator
        .evaluate((element) => {
          const className = String(element.className || "");
          return Boolean(element.disabled)
            || element.getAttribute("aria-disabled") === "true"
            || /\bdisabled\b/i.test(className);
        })
        .catch(() => false);
      if (disabled) {
        continue;
      }

      const rawHref = normalizeWhitespace(await locator.getAttribute("href").catch(() => ""));
      const href = /^(?:javascript:|#)/i.test(rawHref) ? "" : rawHref;
      return { locator, href };
    }

    return null;
  }

  prefersAutomaticTransmission() {
    return normalizeTransmissionPreference(this.config.transmission) === "automatic";
  }

  filterOffersForConfiguredTransmission(offers) {
    return filterOffersByTransmissionPreference(offers, this.config.transmission);
  }

  async applyAutomaticTransmissionFilter(page) {
    const clicked = await page.evaluate(() => {
      const normalize = (value) => String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const isAutomatic = (value) => /automatyczna|automatic|automat\b/i.test(value);
      const isManual = (value) => /manualna|manual\b|reczna|r\u0119czna/i.test(value);
      const isTransmissionGroup = (value) => /skrzyn|transmission|gearbox|gear/.test(normalize(value));
      const isFilterContext = (element) => {
        const wrapper = element.closest("[class*='filter' i], [id*='filter' i], .SearchFiltersGroup, .SearchFiltersGroup-FilterWrapper");
        if (!wrapper) {
          return false;
        }
        const text = normalize(wrapper.textContent || "");
        return isTransmissionGroup(text) || isAutomatic(text);
      };
      const escapeCssIdentifier = (value) => {
        if (window.CSS?.escape) {
          return window.CSS.escape(value);
        }
        return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      };
      const labelTextForInput = (input) => {
        const id = input.getAttribute("id");
        const label = id ? document.querySelector(`label[for="${escapeCssIdentifier(id)}"]`) : null;
        const closestLabel = input.closest("label");
        const wrapper = input.closest("[class*='filter' i], [id*='filter' i], .SearchFiltersGroup-FilterWrapper");
        return [
          label?.textContent,
          closestLabel?.textContent,
          wrapper?.textContent,
          input.getAttribute("aria-label"),
          input.getAttribute("name"),
          input.value
        ].filter(Boolean).join(" ");
      };

      const clickElement = (element) => {
        if (!element) {
          return false;
        }
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        element.click();
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };

      const inputs = Array.from(document.querySelectorAll("input[type='checkbox'], input[type='radio']"));
      for (const input of inputs) {
        const text = labelTextForInput(input);
        if (!isAutomatic(text) || isManual(text) || !isFilterContext(input)) {
          continue;
        }
        if (input.checked) {
          return true;
        }
        return clickElement(input);
      }

      const controls = Array.from(document.querySelectorAll(
        ".SearchFiltersGroup-FilterWrapper, [class*='filter' i] label, [class*='filter' i] button, [class*='filter' i] [role='checkbox'], [class*='filter' i] [role='radio']"
      ));
      for (const control of controls) {
        const text = control.textContent || control.getAttribute("aria-label") || "";
        if (!isAutomatic(text) || isManual(text) || !isFilterContext(control)) {
          continue;
        }
        const selected = control.getAttribute("aria-checked") === "true"
          || /\b(active|selected|checked)\b/i.test(String(control.className || ""));
        if (selected) {
          return true;
        }
        const input = control.querySelector?.("input[type='checkbox'], input[type='radio']");
        return clickElement(input || control);
      }

      return false;
    }).catch(() => false);

    if (!clicked) {
      return false;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(this.config.timeoutMs, 10000) }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: this.collectorWaitTimeoutMs() + 3000 }).catch(() => {});
    await this.waitForLoadingScreenToFinish(page);
    await page.waitForTimeout(this.isFastMode() ? 800 : 1500);
    return true;
  }

  async ensureConfiguredSearchPeriod(page) {
    return;
  }

  async findSearchUrl(page) {
    const current = page.url();
    if (/\/search\/[0-9a-f-]{36}/i.test(current) && /[?&]sq=/i.test(current)) {
      return current;
    }

    return "";
  }

  async looksLikeSearchPage(page) {
    const url = page.url();
    if (/\/search\/[0-9a-f-]{36}/i.test(url) && /[?&]sq=/i.test(url)) {
      return true;
    }
    if (/\/(?:pl\/)?szukaj\/[a-z0-9]+\.html/i.test(url)) {
      return true;
    }

    const resultItem = page.locator(".car-search-result-item").first();
    if (await resultItem.isVisible().catch(() => false)) {
      return true;
    }

    const loadingSignal = page.getByText(/searching 1,000\+ car rental brands|wyszukiwanie|szukamy/i).first();
    if (await loadingSignal.isVisible().catch(() => false)) {
      return true;
    }

    const sortBySignal = page.getByText(/sort by|sortuj|sortowanie|sprawd(?:z|\u017a) cen(?:e|\u0119)/i).first();
    return await sortBySignal.isVisible().catch(() => false);
  }

  async waitForLoadingScreenToFinish(page) {
    const loadingText = page.getByText(/Searching 1,000\+ car rental brands|wyszukiwanie|szukamy/i).first();
    if (!(await loadingText.isVisible().catch(() => false))) {
      return;
    }

    const speedMode = normalizeSpeedMode(this.config.speedMode);
    const maxWaitMs = speedMode === "turbo" ? 12_000 : speedMode === "fast" ? 20_000 : 60_000;
    const networkIdleTimeoutMs = speedMode === "turbo" ? 1_500 : speedMode === "fast" ? 2_500 : 5_000;
    const pollMs = speedMode === "turbo" ? 300 : speedMode === "fast" ? 500 : 1000;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const stillVisible = await loadingText.isVisible().catch(() => false);
      if (!stillVisible) {
        return;
      }
      await page.waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs }).catch(() => {});
      await page.waitForTimeout(pollMs);
    }
  }

  async extractOffersFromPageScripts(page, targetInput) {
    const target = makeLocationTarget(targetInput);
    const html = await page.content();
    const scriptContents = [];
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) != null) {
      scriptContents.push(match[1]);
    }

    const offers = [];
    for (const content of scriptContents) {
      const possibleJsonBlocks = content.match(/\{[\s\S]{50,}\}/g) || [];
      for (const block of possibleJsonBlocks) {
        try {
          const parsed = JSON.parse(block);
          offers.push(...this.extractOffersFromUnknownPayload(parsed, target, "script"));
        } catch {
          continue;
        }
      }
    }

    return dedupeOffers(offers);
  }

  extractOffersFromUnknownPayload(payload, targetInput, source) {
    const target = makeLocationTarget(targetInput);
    const offers = [];
    const visited = new Set();

    const walk = (value) => {
      if (!value || typeof value !== "object") {
        return;
      }
      if (visited.has(value)) {
        return;
      }
      visited.add(value);

      if (Array.isArray(value)) {
        const normalized = value
          .map((item) => this.normalizeOfferCandidate(item, target, source))
          .filter(Boolean);
        if (normalized.length) {
          offers.push(...normalized);
        }
        for (const item of value) {
          walk(item);
        }
        return;
      }

      for (const nested of Object.values(value)) {
        walk(nested);
      }
    };

    walk(payload);
    return dedupeOffers(offers);
  }

  normalizeOfferCandidate(candidate, targetInput, source) {
    const target = makeLocationTarget(targetInput);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }

    const provider = normalizeWhitespace(
      firstDefinedString([
        candidate.providerName,
        candidate.supplierName,
        candidate.vendorName,
        candidate.supplier_name,
        candidate.companyName,
        candidate.provider?.name,
        candidate.supplier?.name,
        candidate.vendor?.name,
        candidate.company?.name,
        candidate.rentalCompany?.name,
        candidate.partner?.name,
        candidate.carName,
        candidate.vehicleName,
        candidate.modelName,
        candidate.car?.name,
        candidate.vehicle?.name,
        candidate.model?.name
      ])
    );
    const providerRating = firstRating([
      candidate.providerRating,
      candidate.supplierRating,
      candidate.vendorRating,
      candidate.companyRating,
      candidate.partnerRating,
      candidate.rating,
      candidate.score,
      candidate.reviewScore,
      candidate.review_score,
      candidate.provider?.rating,
      candidate.provider?.score,
      candidate.supplier?.rating,
      candidate.supplier?.score,
      candidate.supplier?.reviewScore,
      candidate.vendor?.rating,
      candidate.company?.rating,
      candidate.partner?.rating,
      candidate.rentalCompany?.rating,
      candidate.reviews?.rating,
      candidate.reviews?.score,
      candidate.reviews?.average,
      candidate.review?.rating,
      candidate.review?.score,
      candidate.rating?.value,
      candidate.rating?.score,
      candidate.rating?.average
    ]);

    const basePriceMoney = firstMoney([
      candidate.totalPrice,
      candidate.price,
      candidate.price?.formatted,
      candidate.price?.amount,
      candidate.price?.total,
      candidate.prices?.total,
      candidate.prices?.default,
      candidate.pricing?.total,
      candidate.pricing?.amount,
      candidate.payment?.total,
      candidate.payment?.amount,
      candidate.payment?.payNow,
      candidate.payment?.payOnArrival,
      candidate.amount,
      candidate.formattedPrice,
      candidate.total,
      candidate.prices,
      candidate.total_price,
      candidate.amount_total
    ]);
    const protectedPriceMoney = firstMoney([
      candidate.protectedPrice,
      candidate.protectionPrice,
      candidate.insuredPrice,
      candidate.priceWithProtection,
      candidate.priceWithInsurance,
      candidate.totalPriceWithProtection,
      candidate.totalPriceWithInsurance,
      candidate.prices?.protected,
      candidate.prices?.withProtection,
      candidate.prices?.withInsurance,
      candidate.prices?.insurance,
      candidate.pricing?.protected,
      candidate.pricing?.withProtection,
      candidate.pricing?.withInsurance,
      candidate.protection?.total,
      candidate.insurance?.total
    ]);
    const parsedMoney = target.priceMode === "insurance"
      ? protectedPriceMoney
      : basePriceMoney || protectedPriceMoney;

    if (!provider || !parsedMoney) {
      return null;
    }

    const location = normalizeWhitespace(
      firstDefinedString([
        candidate.locationName,
        candidate.location?.name,
        candidate.location?.title,
        candidate.pickUpLocation?.name,
        candidate.pickupLocation?.name,
        candidate.pickupLocName,
        candidate.dropoffLocName,
        candidate.branch?.name,
        candidate.station?.name,
        target.location
      ])
    );
    const transmission = firstTransmission([
      candidate.transmission,
      candidate.transmissionType,
      candidate.gearbox,
      candidate.gearboxType,
      candidate.gearBox,
      candidate.carTransmission,
      candidate.vehicleTransmission,
      candidate.car?.transmission,
      candidate.car?.gearbox,
      candidate.vehicle?.transmission,
      candidate.vehicle?.gearbox,
      candidate.model?.transmission,
      candidate.features,
      candidate.car?.features,
      candidate.vehicle?.features
    ]);

    return {
      provider,
      providerRating,
      totalPrice: parsedMoney.value,
      currency: normalizeCurrency(parsedMoney.currency),
      basePrice: basePriceMoney?.value ?? null,
      protectedPrice: protectedPriceMoney?.value ?? null,
      priceVerified: target.priceMode !== "insurance" || protectedPriceMoney != null,
      location,
      requestedLocation: target.requestedLocation,
      pickupLocation: target.location,
      pickupLocationId: target.value || "",
      sortOrder: target.sortOrder,
      sortLabel: target.sortLabel,
      priceMode: target.priceMode,
      transmission,
      source
    };
  }

  async extractOffersFromDom(page, targetInput) {
    const target = makeLocationTarget(targetInput);
    const rawCandidates = await page.evaluate((targetData) => {
      const defaultLocation = targetData.location;
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const results = [];
      const parseRating = (value) => {
        const text = normalize(value).replace(",", ".");
        const matches = text.match(/\d+(?:\.\d+)?/g) || [];
        for (const match of matches) {
          const rating = Number.parseFloat(match);
          if (Number.isFinite(rating) && rating > 0 && rating <= 10) {
            return Number(rating.toFixed(1));
          }
        }
        return null;
      };

      const findRatingText = (root) => {
        const ratingSelectors = [
          "[data-testid*='rating']",
          "[data-testid*='score']",
          "[class*='rating']",
          "[class*='score']",
          "[aria-label*='rating' i]",
          "[aria-label*='score' i]"
        ];

        for (const selector of ratingSelectors) {
          const element = root.querySelector(selector);
          const text = normalize(element?.textContent || element?.getAttribute?.("aria-label") || "");
          if (parseRating(text) != null) {
            return text;
          }
        }

        const lines = normalize(root.textContent).split(/\n+/).map(normalize).filter(Boolean);
        return lines.find((line) => /(rating|score|excellent|very good|good)/i.test(line) && parseRating(line) != null) || "";
      };

      const findTransmissionText = (root) => {
        const text = normalize(root?.innerText || root?.textContent || "");
        const lines = text.split(/\n+/).map(normalize).filter(Boolean);
        return lines.find((line) => /automatyczna|automatic|automat\b|manualna|manual\b|r(?:e|\u0119)czna/i.test(line)) || "";
      };

      const addCandidate = (providerText, priceText, ratingText = "", transmissionText = "") => {
        const provider = normalize(providerText);
        const price = normalize(priceText);
        const providerRating = parseRating(ratingText);
        if (!provider || !price || !/\d/.test(price)) {
          return;
        }

        results.push({
          provider,
          providerRating,
          priceText: price,
          location: defaultLocation,
          requestedLocation: targetData.requestedLocation,
          sortOrder: targetData.sortOrder,
          sortLabel: targetData.sortLabel,
          priceMode: targetData.priceMode,
          transmissionText: normalize(transmissionText)
        });
      };

      const addRentCarsCandidate = (item, index) => {
        const basePriceText =
          item.querySelector(".without-protection .total-price")?.textContent ||
          item.querySelector(".car-prices .total-price")?.textContent ||
          "";
        const protectedPriceText =
          item.querySelector(".with-protection .total-price")?.textContent ||
          "";
        const priceText = targetData.priceMode === "insurance"
          ? protectedPriceText
          : basePriceText || protectedPriceText;

        let companyName = "";
        const locationJson = item.querySelector("script[data-var='location']")?.textContent || "";
        if (locationJson) {
          try {
            companyName = JSON.parse(locationJson).companyName || "";
          } catch {
            companyName = "";
          }
        }

        const logoText =
          item.querySelector(".company-logo img")?.getAttribute("title") ||
          item.querySelector(".company-logo img")?.getAttribute("alt") ||
          "";
        const provider = normalize(companyName || logoText)
          .replace(/^wypozyczalnia\s+/i, "")
          .replace(/^wypożyczalnia\s+/i, "");
        const ratingText = item.querySelector(".rating-details")?.textContent || "";
        const transmissionText = findTransmissionText(item);

        if (!provider || !priceText) {
          return;
        }

        results.push({
          provider,
          providerRating: parseRating(ratingText),
          priceText: normalize(priceText),
          basePriceText: normalize(basePriceText),
          protectedPriceText: normalize(protectedPriceText),
          location: defaultLocation,
          requestedLocation: targetData.requestedLocation,
          sortOrder: targetData.sortOrder,
          sortLabel: targetData.sortLabel,
          priceMode: targetData.priceMode,
          transmissionText,
          offerRank: index
        });
      };

      Array.from(document.querySelectorAll(".car-search-result-item")).forEach((item, index) => {
        addRentCarsCandidate(item, index);
      }
      );

      const supplierFilterRows = Array.from(document.querySelectorAll(".SearchFiltersGroup-FilterWrapper"));
      for (const row of supplierFilterRows) {
        const provider = row.querySelector(".SearchFiltersGroup-FilterLabel")?.textContent || "";
        const price = row.querySelector(".SearchFiltersGroup-FilterMinPrice")?.textContent || "";
        addCandidate(provider, price, findRatingText(row), findTransmissionText(row));
      }

      if (results.length < 3) {
        const selectors = [
          "article",
          "[data-testid*='offer']",
          "[data-testid*='result']",
          "[class*='offer']",
          "[class*='result']",
          "[class*='vehicle']",
          "[class*='car']"
        ];

        const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
        for (const node of nodes) {
        const text = normalize(node.innerText);
        if (!text || !/\d/.test(text)) {
          continue;
        }

        const lines = text.split(/\n+/).map(normalize).filter(Boolean);
        const priceLine = lines.find((line) => /(EUR|USD|GBP|PLN|\u20ac|\$|\u00a3|z(?:l|\u0142))/i.test(line) && /\d/.test(line)) || "";
        const providerLine = lines.find((line) => {
          if (line.length < 3 || line.length > 50) {
            return false;
          }
          if (/(bezp(?:l|\u0142)atne anulowanie|sprawd(?:z|\u017a) cen(?:e|\u0119)|rezerwuj|free cancellation|book|total|price|rating|excellent|very good|from|pay now)/i.test(line)) {
            return false;
          }
          return /[a-z]/i.test(line);
        }) || "";

        if (!priceLine || !providerLine) {
          continue;
        }

          addCandidate(providerLine, priceLine, findRatingText(node), findTransmissionText(node));
        }
      }

      return results;
    }, {
      location: target.location,
      requestedLocation: target.requestedLocation,
      sortOrder: target.sortOrder,
      sortLabel: target.sortLabel,
      priceMode: target.priceMode
    });

    const offers = [];
    for (const candidate of rawCandidates) {
      const money = parseMoney(candidate.priceText);
      if (!money) {
        continue;
      }
      offers.push({
        provider: normalizeWhitespace(candidate.provider),
        providerRating: Number.isFinite(candidate.providerRating) ? Number(candidate.providerRating) : null,
        totalPrice: money.value,
        currency: normalizeCurrency(money.currency),
        basePrice: parseMoney(candidate.basePriceText)?.value ?? null,
        protectedPrice: parseMoney(candidate.protectedPriceText)?.value ?? null,
        priceVerified: candidate.priceMode !== "insurance" || Boolean(candidate.protectedPriceText),
        location: normalizeWhitespace(candidate.location) || target.location,
        requestedLocation: normalizeWhitespace(candidate.requestedLocation) || target.requestedLocation,
        pickupLocation: target.location,
        pickupLocationId: target.value || "",
        sortOrder: candidate.sortOrder || target.sortOrder,
        sortLabel: candidate.sortLabel || target.sortLabel,
        priceMode: candidate.priceMode || target.priceMode,
        transmission: normalizeTransmission(candidate.transmissionText),
        offerRank: Number.isFinite(candidate.offerRank) ? candidate.offerRank : null,
        source: "dom"
      });
    }

    return dedupeOffers(offers);
  }

  async captureFailureArtifacts(page, targetInput) {
    const target = makeLocationTarget(targetInput);
    const baseName = safeFilePart(`${target.location}-${target.sortOrder}`) || "location";
    const screenshotPath = path.join(this.config.artifactsDir, `${baseName}.png`);
    const htmlPath = path.join(this.config.artifactsDir, `${baseName}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (html) {
      writeTextFile(htmlPath, html);
    }
  }

  async dismissObstructiveOverlays(page) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      const clickSelectors = [
        ".rc-simple-react-modal__close",
        "[aria-label*='close' i]",
        "[aria-label*='zamknij' i]",
        "button.close",
        ".close"
      ];

      for (const selector of clickSelectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          if (element instanceof HTMLElement && element.offsetParent !== null) {
            element.click();
          }
        }
      }

      const removeSelectors = [
        "[id^='popupsmart-container']",
        "[class*='popupsmart' i]",
        ".rc-simple-react-modal__backdrop"
      ];

      for (const selector of removeSelectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          element.remove();
        }
      }

      const promoPattern = /odbierz.*zni(?:z|ż)k|newsletter|promocj/i;
      for (const element of Array.from(document.body.querySelectorAll("div, section"))) {
        const style = window.getComputedStyle(element);
        const zIndex = Number.parseInt(style.zIndex || "0", 10);
        if ((style.position === "fixed" || style.position === "absolute") && zIndex >= 1000 && promoPattern.test(element.textContent || "")) {
          element.remove();
        }
      }

      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    }).catch(() => {});
    await page.waitForTimeout(200);
  }
}

function firstDefinedString(values) {
  for (const value of values) {
    if (typeof value === "string" && normalizeWhitespace(value)) {
      return value;
    }
  }
  return "";
}

function normalizeTransmissionPreference(value) {
  const normalized = normalizeWhitespace(value || "automatic").toLowerCase().replace(/[_-]+/g, " ");
  if (["any", "all", "dowolna"].includes(normalized)) {
    return "any";
  }
  if (["manual", "manualna"].includes(normalized)) {
    return "manual";
  }
  return "automatic";
}

function normalizeTransmission(value) {
  if (value == null) {
    return "";
  }
  const values = Array.isArray(value)
    ? value
    : typeof value === "object"
      ? Object.values(value)
      : [value];
  const text = normalizeWhitespace(values.map((item) => {
    if (item == null) {
      return "";
    }
    return typeof item === "object" ? JSON.stringify(item) : String(item);
  }).join(" "));
  if (!text) {
    return "";
  }
  if (AUTOMATIC_TRANSMISSION_PATTERN.test(text)) {
    return "automatic";
  }
  if (MANUAL_TRANSMISSION_PATTERN.test(text)) {
    return "manual";
  }
  return "";
}

function firstTransmission(values) {
  for (const value of values) {
    const transmission = normalizeTransmission(value);
    if (transmission) {
      return transmission;
    }
  }
  return "";
}

function filterOffersByTransmissionPreference(offers, rawPreference) {
  const preference = normalizeTransmissionPreference(rawPreference);
  if (preference === "any") {
    return Array.isArray(offers) ? offers : [];
  }

  const rows = Array.isArray(offers) ? offers : [];
  const withoutOpposite = rows.filter((offer) => {
    const transmission = normalizeTransmission(offer?.transmission);
    return transmission !== (preference === "automatic" ? "manual" : "automatic");
  });
  const exactMatches = withoutOpposite.filter((offer) => normalizeTransmission(offer?.transmission) === preference);
  return exactMatches.length ? exactMatches : withoutOpposite;
}

function normalizeRatingValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
    return null;
  }

  return Number(parsed.toFixed(1));
}

function parseRatingValue(rawValue) {
  if (rawValue == null) {
    return null;
  }

  if (typeof rawValue === "number") {
    return normalizeRatingValue(rawValue);
  }

  if (typeof rawValue === "string") {
    const matches = normalizeWhitespace(rawValue).replace(",", ".").match(/\d+(?:\.\d+)?/g) || [];
    for (const match of matches) {
      const rating = normalizeRatingValue(match);
      if (rating != null) {
        return rating;
      }
    }
    return null;
  }

  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    const preferredKeys = [
      "rating",
      "score",
      "value",
      "average",
      "averageScore",
      "reviewScore",
      "supplierRating",
      "providerRating"
    ];

    for (const key of preferredKeys) {
      const rating = parseRatingValue(rawValue[key]);
      if (rating != null) {
        return rating;
      }
    }

    for (const [key, value] of Object.entries(rawValue)) {
      if (!/rating|score|review/i.test(key)) {
        continue;
      }
      const rating = parseRatingValue(value);
      if (rating != null) {
        return rating;
      }
    }
  }

  return null;
}

function firstRating(values) {
  for (const value of values) {
    const rating = parseRatingValue(value);
    if (rating != null) {
      return rating;
    }
  }
  return null;
}

function firstMoney(values) {
  for (const value of values) {
    let parsed = null;
    if (typeof value === "number" && Number.isFinite(value)) {
      parsed = parseMoney(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const formattedCandidate = firstDefinedString([
        value.formatted,
        value.display,
        value.price
      ]);
      if (formattedCandidate) {
        parsed = parseMoney(formattedCandidate, normalizeCurrency(firstDefinedString([value.currency, value.curr])));
      }
      if (parsed) {
        return parsed;
      }

      const numericCandidate = [value.raw, value.amount, value.total, value.value]
        .find((item) => typeof item === "number" && Number.isFinite(item));

      if (numericCandidate != null) {
        parsed = parseMoney(numericCandidate, normalizeCurrency(firstDefinedString([value.currency, value.curr])));
      } else {
        parsed = parseMoney(firstDefinedString([
          value.amount,
          value.total,
          value.value,
          value.formatted,
          value.display,
          value.price
        ]));
      }
    } else {
      parsed = parseMoney(value);
    }

    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function monthName(dateParts) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)));
}

function dedupeOffers(offers) {
  const seen = new Set();
  const unique = [];

  for (const offer of offers) {
    const provider = normalizeRentCarsProviderName(offer.provider);
    if (!isUsableRentCarsOffer({ ...offer, provider })) {
      continue;
    }

    const key = [
      provider.toLowerCase(),
      offer.totalPrice,
      normalizeWhitespace(offer.location).toLowerCase(),
      normalizeWhitespace(offer.sortOrder).toLowerCase(),
      normalizeWhitespace(offer.priceMode).toLowerCase(),
      normalizeTransmission(offer.transmission)
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      ...offer,
      provider,
      providerRating: Number.isFinite(offer.providerRating) ? Number(offer.providerRating) : null,
      location: normalizeWhitespace(offer.location),
      requestedLocation: normalizeWhitespace(offer.requestedLocation),
      pickupLocation: normalizeWhitespace(offer.pickupLocation || offer.location),
      pickupLocationId: normalizeWhitespace(offer.pickupLocationId),
      sortOrder: normalizeWhitespace(offer.sortOrder),
      sortLabel: normalizeWhitespace(offer.sortLabel),
      priceMode: normalizeWhitespace(offer.priceMode),
      transmission: normalizeTransmission(offer.transmission),
      priceVerified: offer.priceVerified === true,
      offerRank: Number.isFinite(offer.offerRank) ? Number(offer.offerRank) : null
    });
  }

  return unique;
}

function isUsableRentCarsOffer(offer) {
  const provider = normalizeRentCarsProviderName(offer?.provider);
  const totalPrice = Number(offer?.totalPrice);
  if (!provider || !Number.isFinite(totalPrice) || totalPrice <= 0) {
    return false;
  }
  if (normalizeWhitespace(offer?.priceMode).toLowerCase() === "insurance" && offer?.priceVerified !== true) {
    return false;
  }

  const normalizedProvider = normalizeWhitespace(provider).toLowerCase();
  const promoDailyPricePattern = /\bod\s+\d+(?:[,.]\d{1,2})?\s*z(?:\u0142|l)\s+za\s+dzie(?:\u0144|n)/i;
  if (promoDailyPricePattern.test(normalizedProvider)) {
    return false;
  }

  return totalPrice >= 40;
}

function countUniqueOfferProviders(offers) {
  const providers = new Set();
  for (const offer of offers) {
    const provider = normalizeRentCarsProviderName(offer.provider).toLowerCase();
    if (provider && isUsableRentCarsOffer({ ...offer, provider })) {
      providers.add(provider);
    }
  }
  return providers.size;
}

function selectBestOffersByProvider(offers, targetInput, maxProviders, forcedProviderNames) {
  const target = makeLocationTarget(targetInput);
  const byProvider = new Map();

  for (const offer of offers) {
    const provider = normalizeRentCarsProviderName(offer.provider);
    if (!isUsableRentCarsOffer({ ...offer, provider })) {
      continue;
    }

    const normalizedOffer = {
      provider,
      providerRating: Number.isFinite(offer.providerRating) ? Number(offer.providerRating) : null,
      totalPrice: offer.totalPrice,
      currency: normalizeCurrency(offer.currency),
      basePrice: Number.isFinite(offer.basePrice) ? Number(offer.basePrice) : null,
      protectedPrice: Number.isFinite(offer.protectedPrice) ? Number(offer.protectedPrice) : null,
      priceVerified: offer.priceVerified === true,
      location: normalizeWhitespace(offer.location || target.location),
      requestedLocation: normalizeWhitespace(offer.requestedLocation || target.requestedLocation),
      pickupLocation: normalizeWhitespace(offer.pickupLocation || target.location),
      pickupLocationId: normalizeWhitespace(offer.pickupLocationId || target.value),
      sortOrder: normalizeWhitespace(offer.sortOrder || target.sortOrder),
      sortLabel: normalizeWhitespace(offer.sortLabel || target.sortLabel),
      priceMode: normalizeWhitespace(offer.priceMode || target.priceMode),
      transmission: normalizeTransmission(offer.transmission),
      offerRank: Number.isFinite(offer.offerRank) ? Number(offer.offerRank) : null,
      source: normalizeWhitespace(offer.source)
    };

    const providerKey = provider.toLowerCase();
    const existing = byProvider.get(providerKey);
    if (!existing || normalizedOffer.totalPrice < existing.totalPrice) {
      byProvider.set(providerKey, normalizedOffer);
    }
  }

  const sorted = [...byProvider.values()].sort(compareOffersForTarget);
  const limit = Number.isFinite(maxProviders) && maxProviders > 0 ? maxProviders : sorted.length;
  const selected = sorted.slice(0, limit);

  const forcedProviders = Array.isArray(forcedProviderNames) ? forcedProviderNames : [];
  for (const forcedProvider of forcedProviders) {
    const forcedKey = normalizeWhitespace(forcedProvider).toLowerCase();
    if (!forcedKey) {
      continue;
    }

    const alreadyIncluded = selected.some(
      (item) => normalizeWhitespace(item.provider).toLowerCase() === forcedKey
    );
    if (alreadyIncluded) {
      continue;
    }

    const forcedOffer = byProvider.get(forcedKey);
    if (forcedOffer) {
      selected.push(forcedOffer);
    }
  }

  return selected.sort(compareOffersForTarget);
}

function selectBestOffersForTransmissionViews(offers, targetInput, maxProviders, forcedProviderNames) {
  const allOffers = selectBestOffersByProvider(
    offers,
    targetInput,
    maxProviders,
    forcedProviderNames
  );
  const automaticOffers = selectBestOffersByProvider(
    offers.filter((offer) => normalizeTransmission(offer.transmission) === "automatic"),
    targetInput,
    maxProviders,
    forcedProviderNames
  );
  const selected = new Map();
  for (const offer of [...allOffers, ...automaticOffers]) {
    const providerKey = normalizeWhitespace(offer.provider).toLowerCase();
    const transmission = normalizeTransmission(offer.transmission) || "unknown";
    selected.set(`${providerKey}\u0000${transmission}`, offer);
  }

  return [...selected.values()].sort(compareOffersForTarget);
}

function compareOffersForTarget(left, right) {
  const leftRank = Number.isFinite(left.offerRank) ? left.offerRank : Number.MAX_SAFE_INTEGER;
  const rightRank = Number.isFinite(right.offerRank) ? right.offerRank : Number.MAX_SAFE_INTEGER;
  if (left.sortOrder === "suggested" && right.sortOrder === "suggested" && leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (left.totalPrice !== right.totalPrice) {
    return left.totalPrice - right.totalPrice;
  }
  return String(left.provider).localeCompare(String(right.provider));
}

function rentCarsSortOption(value) {
  return RENTCARS_SORT_OPTIONS.get(value) || RENTCARS_SORT_OPTIONS.get("suggested");
}

function normalizeSortOrders(values) {
  const rawValues = Array.isArray(values) && values.length
    ? values
    : ["price_insurance"];
  const normalized = [];
  for (const value of rawValues) {
    const key = normalizeWhitespace(value).toLowerCase();
    const option = rentCarsSortOption(key);
    if (!normalized.includes(option.order)) {
      normalized.push(option.order);
    }
  }
  return normalized;
}

function makeLocationTarget(input, option = null) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const sortOption = rentCarsSortOption(input.sortOrder || "price_insurance");
    const requestedLocation = normalizeWhitespace(input.requestedLocation || input.location || input.label);
    const location = normalizeWhitespace(input.location || input.label || requestedLocation);
    return {
      requestedLocation,
      location,
      label: location,
      value: normalizeWhitespace(input.value || input.placeId),
      sortOrder: sortOption.order,
      sortLabel: normalizeWhitespace(input.sortLabel) || sortOption.label,
      priceMode: normalizeWhitespace(input.priceMode) || sortOption.priceMode
    };
  }

  const requestedLocation = normalizeWhitespace(input);
  const location = normalizeWhitespace(option?.label || requestedLocation);
  return {
    requestedLocation,
    location,
    label: location,
    value: normalizeWhitespace(option?.value),
    sortOrder: "price_insurance",
    sortLabel: "po cenie z ubezpieczeniem",
    priceMode: "insurance"
  };
}

function searchTargetFailure(targetInput, error, attemptCount = 1) {
  const target = makeLocationTarget(targetInput);
  return {
    location: target.location,
    requestedLocation: target.requestedLocation,
    pickupLocation: target.location,
    pickupLocationId: target.value || "",
    sortOrder: target.sortOrder,
    sortLabel: target.sortLabel,
    priceMode: target.priceMode,
    attemptCount,
    error
  };
}

function formatSearchTarget(targetInput) {
  const target = makeLocationTarget(targetInput);
  const cityPrefix = target.requestedLocation && target.requestedLocation !== target.location
    ? `${target.requestedLocation} / `
    : "";
  return `${cityPrefix}${target.location} / ${target.sortLabel}`;
}

function findRentCarsLocationMatches(requestedLocation, options) {
  const requested = normalizeForMatch(requestedLocation);
  const requestedHasBranch = requested.includes(",");

  const matches = options.filter((option) => {
    const label = normalizeForMatch(option.label);
    if (requestedHasBranch) {
      return label === requested;
    }
    return label.startsWith(`${requested},`);
  });

  if (requestedHasBranch) {
    return uniqueLocationOptions(matches);
  }

  const airportMatches = matches.filter(isRentCarsAirportOption);
  if (airportMatches.length) {
    return uniqueLocationOptions(airportMatches);
  }

  return uniqueLocationOptions(options
    .filter((option) => normalizeForMatch(option.label).includes(requested))
    .filter(isRentCarsAirportOption));
}

function makeAirportOnlyFallbackTargets(requestedLocations) {
  return requestedLocations.flatMap((location) => {
    const requested = normalizeForMatch(location);
    const fallbackLabels = AIRPORT_LOCATION_FALLBACKS[requested];
    if (!fallbackLabels || requested.includes(",")) {
      return [makeLocationTarget(location)];
    }
    return fallbackLabels.map((label) => makeLocationTarget(location, { label, value: "" }));
  });
}

function makeStaticAirportLocationTargets(requestedLocations) {
  const targets = [];
  for (const location of requestedLocations) {
    const requested = normalizeForMatch(location);
    const staticOptions = STATIC_AIRPORT_LOCATION_TARGETS[requested];
    if (!staticOptions || requested.includes(",")) {
      return [];
    }
    targets.push(...staticOptions.map((option) => makeLocationTarget(location, option)));
  }
  return targets;
}

const AIRPORT_LOCATION_FALLBACKS = Object.fromEntries(locationCatalog.map((entry) => [
  normalizeLocationKey(entry.city),
  entry.airports.map((airport) => airport.label)
]));

const STATIC_AIRPORT_LOCATION_TARGETS = Object.fromEntries(locationCatalog.map((entry) => [
  normalizeLocationKey(entry.city),
  entry.airports.map((airport) => ({ label: airport.label, value: airport.id }))
]));

function isRentCarsAirportOption(option) {
  const label = normalizeForMatch(option?.label || option);
  return [
    "lotnisko",
    "airport",
    "aeroport",
    "balice",
    "rebiechowo",
    "pyrzowice",
    "strachowice",
    "lawica",
    "szwederowo",
    "lublinek",
    "okecie",
    "modlin"
  ].some((token) => label.includes(token));
}

function uniqueLocationOptions(options) {
  const seen = new Set();
  const output = [];
  for (const option of options) {
    const key = `${option.value}|${option.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(option);
  }
  return output;
}

function normalizeForMatch(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0141\u0142]/g, "l")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeRentCarsProviderName(value) {
  const name = normalizeWhitespace(value);
  const comparable = name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/sp\.?\s*z\s*o\.?\s*o\.?/g, "sp z o o");
  if (comparable.includes("mm service lease polska")) {
    return "MM Cars Rental";
  }
  return name;
}

function normalizeCurrencyLegacy(value) {
  if (!value) {
    return "";
  }
  if (value === "Z\u0141") {
    return "PLN";
  }
  if (value === "$") {
    return "USD";
  }
  if (value === "\u20ac") {
    return "EUR";
  }
  if (value === "\u00a3") {
    return "GBP";
  }
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function dedupeLocationCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const placeId = Number.parseInt(candidate?.placeID, 10);
    if (!Number.isFinite(placeId)) {
      continue;
    }
    if (seen.has(placeId)) {
      continue;
    }
    seen.add(placeId);
    unique.push({ ...candidate, placeID: placeId });
  }

  return unique;
}

function normalizeCurrency(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).toUpperCase();
  if (normalized === "Z\u0141" || normalized === "Z\u00c5\u0081" || normalized === "ZL") {
    return "PLN";
  }
  if (value === "$") {
    return "USD";
  }
  if (value === "\u20ac" || value === "\u00e2\u201a\u00ac") {
    return "EUR";
  }
  if (value === "\u00a3" || value === "\u00c2\u0141") {
    return "GBP";
  }
  return normalized;
}

function decodeSqPayload(rawSq) {
  try {
    const decoded = decodeURIComponent(String(rawSq));
    const json = Buffer.from(decoded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function encodeSqPayload(payload) {
  const json = JSON.stringify(payload);
  return encodeURIComponent(Buffer.from(json, "utf8").toString("base64"));
}

function normalizeCountryCode(value) {
  const normalized = normalizeWhitespace(value).toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) {
    return normalized;
  }

  const mapping = {
    POLAND: "PL",
    GERMANY: "DE",
    FRANCE: "FR",
    ITALY: "IT",
    SPAIN: "ES",
    PORTUGAL: "PT",
    CZECHIA: "CZ",
    "CZECH REPUBLIC": "CZ",
    SLOVAKIA: "SK",
    HUNGARY: "HU",
    ROMANIA: "RO",
    LITHUANIA: "LT",
    LATVIA: "LV",
    ESTONIA: "EE",
    SWEDEN: "SE",
    NORWAY: "NO",
    DENMARK: "DK",
    FINLAND: "FI",
    IRELAND: "IE",
    "UNITED KINGDOM": "GB",
    UK: "GB",
    "GREAT BRITAIN": "GB",
    "UNITED STATES": "US",
    USA: "US",
    CANADA: "CA",
    AUSTRALIA: "AU",
    "NEW ZEALAND": "NZ",
    NEWZEALAND: "NZ"
  };

  return mapping[normalized] || "";
}

module.exports = {
  RentCarsScraper,
  filterOffersByTransmissionPreference,
  findRentCarsLocationMatches,
  selectBestOffersForTransmissionViews,
  shouldRetryLocationOutcome
};
