const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDetailRows, buildWorkbook } = require("../src/rentcars/reportXlsx");
const { buildHtmlReport } = require("../src/rentcars/reportHtml");

const location = "Gdansk Lotnisko";
const sortOrder = "price_insurance";

function scenario(prices, coverage = true, overrides = {}) {
  return {
    start_date: "2026-09-27",
    rental_days: 2,
    expected_locations: [location],
    sort_orders: [{ order: sortOrder }],
    expected_targets: [{ location, sort_order: sortOrder, mm_coverage_complete: coverage }],
    results: prices.map(([provider_name, daily_price]) => ({
      provider_name, daily_price, total_price: daily_price * 2,
      pickup_location: location, sort_order: sortOrder, rental_days: 2,
      currency: "PLN", transmission: "automatic", price_verified: true
    })),
    errors: [],
    ...overrides
  };
}

function payload(scenarios) {
  return { run_status: "complete", sort_orders: [sortOrder], scenarios };
}

function sheetRow(workbook, name, row = 5) {
  const sheet = workbook.getWorksheet(name);
  const values = {};
  sheet.getRow(4).eachCell((cell, column) => {
    values[String(cell.value)] = sheet.getCell(row, column).value;
  });
  return values;
}

test("Excel excludes inapplicable gaps from medians and pricing recommendations", () => {
  const data = payload([
    ...Array.from({ length: 4 }, () => scenario([["MM Cars Rental", 100], ["Other", 120]])),
    ...Array.from({ length: 4 }, () => scenario([["Other", 100], ["MM Cars Rental", 110]])),
    ...Array.from({ length: 2 }, () => scenario([["Other", 100]]))
  ]);
  const rows = buildDetailRows(data);
  assert.equal(rows[0].gap_to_top1_daily, null);
  assert.equal(rows[8].gap_to_top1_daily, null);
  assert.equal(rows[4].room_if_top1_daily, null);
  const workbook = buildWorkbook(data);
  const airport = sheetRow(workbook, "By airport");
  assert.equal(airport["Median Gap To Top1 Daily"], 10);
  assert.equal(airport["Avg Gap To Top1 Daily"], 10);
  assert.equal(airport["Median Room If Top1 Daily"], 20);
  const recommendation = sheetRow(workbook, "Recommendations");
  assert.equal(recommendation["Proposed Reduction Pln Daily"], 10);
});

test("Excel falls back to rental total when daily price is null or blank", () => {
  for (const missing of [null, "", " "]) {
    const input = scenario([["MM Cars Rental", 110], ["Other", 100]]);
    input.results[0].daily_price = missing;
    const [row] = buildDetailRows(payload([input]));
    assert.equal(row.mm_daily, 110);
    assert.equal(row.mm_rank, 2);
  }
});

test("Excel separates incomplete MM searches from confirmed absence in statistics", () => {
  const data = payload([
    scenario([["Other", 100]], false),
    scenario([["Other", 100]], true),
    scenario([["MM Cars Rental", 100], ["Other", 120]], true)
  ]);
  const details = buildDetailRows(data);
  assert.equal(details[0].check_status, "incomplete");
  assert.equal(details[0].mm_status, "unknown");
  assert.equal(details[1].mm_status, "missing");
  assert.equal(details[2].mm_status, "present");
  const workbook = buildWorkbook(data);
  const airport = sheetRow(workbook, "By airport");
  assert.equal(airport["Valid Checks"], 2);
  assert.equal(airport["Mm Missing"], 1);
  assert.equal(airport["Mm Unknown"], 1);
  assert.equal(airport["Mm Top1 Pct"], 0.5);
  const quality = sheetRow(workbook, "Data quality");
  assert.equal(quality.Status, "incomplete");
  assert.match(quality.Error, /incomplete/i);
});

test("Excel does not suggest pricing changes when all MM searches are unknown", () => {
  const workbook = buildWorkbook(payload([scenario([["Other", 100]], false)]));
  const recommendation = sheetRow(workbook, "Recommendations");
  assert.equal(recommendation["Mm Missing Pct"], null);
  assert.equal(recommendation["Proposed Reduction Pln Daily"], 0);
  assert.equal(recommendation["Proposed City Fee Pln Daily"], 0);
  assert.match(recommendation.Action, /incomplete|insufficient/i);
});

test("HTML distinguishes unknown MM from confirmed absence and filters them separately", () => {
  const html = buildHtmlReport(payload([
    scenario([["Other", 100]], false),
    scenario([["Other", 100]], true)
  ]));
  const rows = html.match(/<tr class="(?:even|odd)"[^>]*>[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /data-mm-state-all="unknown"/);
  assert.match(rows[0], /data-mm-state-automatic="unknown"/);
  assert.doesNotMatch(rows[0], /Brak MM/);
  assert.match(rows[1], /data-mm-state-all="missing"/);
  assert.match(html, /value="unknown"/);
  assert.match(html, /brak MM Cars Rental: 1/);
  assert.match(html, /niepotwierdzona obecno\u015b\u0107 MM: 1/);
});

test("observed MM stays present in HTML even when the automatic search is incomplete", () => {
  const input = scenario([["MM Cars Rental", 100], ["Other", 120]], false);
  input.results[0].transmission = "manual";
  const html = buildHtmlReport(payload([input]));
  assert.match(html, /data-mm-state-automatic="unknown"/);
  assert.doesNotMatch(html, /data-mm-state-all="(?:missing|unknown)"/);
  assert.equal(buildDetailRows(payload([input]))[0].mm_status, "present");
});

test("HTML distinguishes unread competitors from exhausted results without hiding known MM", () => {
  const unfinished = scenario([["MM Cars Rental", 100]]);
  unfinished.expected_targets[0].ranking_coverage_complete = false;
  const exhausted = scenario([["MM Cars Rental", 100]]);
  exhausted.expected_targets[0].ranking_coverage_complete = true;
  const html = buildHtmlReport(payload([unfinished, exhausted]));
  const rows = html.match(/<tr class="(?:even|odd)"[^>]*>[\s\S]*?<\/tr>/g);
  assert.match(rows[0], /Niepe\u0142ne dane/);
  assert.doesNotMatch(rows[0], /Not available/);
  assert.match(rows[0], /Top 1/);
  assert.match(rows[0], /100\.00 PLN\/day/);
  assert.doesNotMatch(rows[1], /Niepe\u0142ne dane/);
  assert.match(rows[1], /Not available/);
});

test("failed checks and checks without offers are not confirmed MM absence", () => {
  const data = payload([
    scenario([["Other", 100]], true, { errors: [{ location, sort_order: sortOrder, error: "timeout" }] }),
    scenario([], true)
  ]);
  const html = buildHtmlReport(data);
  assert.doesNotMatch(html, /data-mm-state-all="missing"/);
  assert.match(html, /brak MM Cars Rental: 0/);
  assert.equal(sheetRow(buildWorkbook(data), "By airport")["Mm Missing"], 0);
});

test("Top1 competitors uses the same eligible checks as airport statistics", () => {
  const workbook = buildWorkbook(payload([
    scenario([["Other", 100]], false),
    scenario([["Other", 100]], true),
    scenario([["Other", 100]], true, { errors: [{ location, error: "timeout" }] })
  ]));
  assert.equal(sheetRow(workbook, "Top1 competitors")["Top1 Count"], 1);
});

test("legacy reports without coverage flags retain their absence interpretation", () => {
  for (const targets of [undefined, [{ location, sort_order: sortOrder }]]) {
    const data = payload([scenario([["Other", 100]], true, { expected_targets: targets })]);
    const [detail] = buildDetailRows(data);
    assert.equal(detail.mm_status, "missing");
    assert.equal(detail.check_status, "ok");
    assert.match(buildHtmlReport(data), /data-mm-state-all="missing"/);
  }
});

test("Excel and HTML preserve the same source order for equal-price providers", () => {
  for (const prices of [
    [["Z Rental", 100], ["MM Cars Rental", 100]],
    [["MM Cars Rental", 100], ["A Rental", 100]]
  ]) {
    const data = payload([scenario(prices)]);
    const expectedRank = prices[0][0] === "MM Cars Rental" ? 1 : 2;
    const [detail] = buildDetailRows(data);
    assert.equal(detail.mm_rank, expectedRank);
    assert.equal(detail.top1_provider, prices[0][0]);
    const html = buildHtmlReport(data);
    assert.match(html, new RegExp(`offer-view-all rank-cell">Top ${expectedRank}<`));
    assert.equal(sheetRow(buildWorkbook(data), "Details")["Mm Rank"], expectedRank);
  }
});

test("empty partial report exports a readable workbook with its error status", async () => {
  const workbook = buildWorkbook({
    ...payload([]), run_status: "partial", completed_scenario_count: 0,
    expected_scenario_count: 780, expected_check_count: 7020
  });
  assert.equal(workbook.getWorksheet("Overview").getCell("B5").value, "partial");
  assert.equal(sheetRow(workbook, "Details").Status, "No data");
  assert.equal(sheetRow(workbook, "Data quality").Status, "partial");
  const ExcelJS = require("exceljs");
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(reopened.worksheets.length, 8);
  assert.equal(reopened.getWorksheet("Details").getTables().length, 1);
});
