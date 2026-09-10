const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { RentCarsScraper } = require("../src/rentcars/scraper");

const config = {
  baseUrl: "https://rentcars.pl", headless: true, timeoutMs: 3000,
  pickupDate: "2026-09-07", dropoffDate: "2026-09-09",
  pickupTime: "10:00", dropoffTime: "10:00"
};
const target = { location: "Warszawa, Lotnisko-Okecie", value: "1", sortOrder: "price_insurance" };
const fixture = `<form id="form-cars-search" method="post" action="/pl/szukaj/abc123.html">
  ${["pickup", "return"].map((prefix) => `
    <select id="${prefix}-location_place" name="${prefix}-place">
      <option value="">Select</option><option value="1">Warszawa, Lotnisko-Okecie</option>
      <option value="47">Warszawa, Lotnisko-Modlin</option>
    </select>
    <input id="${prefix}-location" name="${prefix}-location" type="hidden">
    <input id="${prefix}-location_place_preselection" type="hidden">
    <input id="${prefix}-date" name="${prefix}-date">
  `).join("")}
  <select id="time_range-time_start" name="pickup-time"><option>10:00</option></select>
  <select id="time_range-time_end" name="return-time"><option>10:00</option></select>
  <input id="results_order" name="sort" type="hidden">
  <button id="elementsubmit" type="button">Szukaj</button>
</form>`;

async function main() {
  const scraper = new RentCarsScraper(config);
  const browser = await chromium.launch(scraper.resolveLaunchOptions());
  try {
    const page = await browser.newPage();
    let submitted;
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST") {
        submitted = Object.fromEntries(new URLSearchParams(route.request().postData()));
        await route.fulfill({ contentType: "text/html", body: "Results" });
      } else {
        await route.fulfill({ contentType: "text/html", body: fixture });
      }
    });
    await page.goto(config.baseUrl);
    await scraper.fillSearchForm(page, target);
    await scraper.submitSearch(page);
    assert.deepEqual(submitted, {
      "pickup-place": "1", "pickup-location": "1", "pickup-date": config.pickupDate,
      "return-place": "1", "return-location": "1", "return-date": config.dropoffDate,
      "pickup-time": "10:00", "return-time": "10:00", sort: "price_insurance"
    });
    console.log("PASS native search submits exact fields without a button click handler");

    await page.goto(config.baseUrl);
    await assert.rejects(scraper.fillSearchForm(page, { ...target, value: "47" }), /Could not fill/);
    await assert.rejects(scraper.fillSearchForm(page, { ...target, location: "Unknown airport" }), /Could not fill/);
    scraper.config = { ...config, pickupTime: "25:00" };
    await assert.rejects(scraper.fillSearchForm(page, target), /Could not fill/);
    scraper.config = config;
    await page.locator("#results_order").evaluate((input) => input.remove());
    await assert.rejects(scraper.fillSearchForm(page, target), /Could not fill/);
    console.log("PASS invalid airport, time, and missing sort field are rejected");

    await page.setContent(`
      <input type="checkbox" id="filters-car_category_5" name="filters[car_category][]" value="5"><label for="filters-car_category_5">premium</label>
      <input type="checkbox" id="filters-car_category_9" name="filters[car_category][]" value="9"><label for="filters-car_category_9">van</label>
      <input type="checkbox" id="filters-car_category_11" name="filters[car_category][]" value="11"><label for="filters-car_category_11">minivan</label>
    `);
    scraper.config = { ...config, vehicleCategories: ["premium", "van", "minivan"] };
    assert.equal(await scraper.applyVehicleCategoryFilter(page), true);
    assert.deepEqual(
      await page.locator("input:checked").evaluateAll((inputs) => inputs.map((input) => input.value)),
      ["5", "9", "11"]
    );
    console.log("PASS premium, van, and minivan filters are applied together");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
