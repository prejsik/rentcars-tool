# RentCars.pl Cheapest Offers Scraper

This is a separate RentCars.pl scraper module based on the DiscoverCars scraper structure.

## Features

- opens RentCars.pl and fills the rental search form with Playwright
- accepts multiple cities in one run and expands each city to matching RentCars.pl airport pickup points
- keeps cities, airport labels, and RentCars.pl IDs in `src/rentcars/locations.json`
- supports rolling pickup start dates, specific start dates, pickup weekdays, and duration scenarios
- checks RentCars.pl only with the `price_insurance` sort mode
- collects all cars by default and lets the HTML report switch between all cars and automatic transmission only
- requires a verified protected price in `price_insurance` mode and records base and insured prices separately
- follows further result pages within the configured limit until MM and the top three providers are covered for the required transmission views
- in fast mode, prefers visible DOM offers and avoids long waits for optional network JSON payloads
- retries transient location failures twice in a lower-concurrency queue
- reports successful, failed, and missing airport checks separately from scenario progress
- prints sorted daily prices with provider name and rating, without car model names
- saves the results to CSV
- generates an HTML report with visible missing-airport rows and the execution duration at the end
- generates an Excel summary with overview, recommendations, airport, duration, opportunity, competitor, detail, and data-quality sheets
- splits GitHub scheduled runs into parallel multi-date chunks and merges them into one final HTML report

## Run

Using a config file:

```powershell
node .\src\rentcars\cli.js --config .\rentcars.config.example.json
```

Interactive local launcher:

```powershell
.\start-rentcars.bat
```

It opens a Windows options window similar to the DiscoverCars launcher. The default city set comes from `src/rentcars/locations.json` and includes DiscoverCars cities plus Bydgoszcz and Lodz.

Save the GitHub-style JSON payload:

```powershell
node .\src\rentcars\run.js --config .\rentcars.config.example.json --save=.\output\rentcars-results-latest.json
```

Default local profile in the example config:

- `rollingDays: 30`
- `durationsDays: [2]`
- `sortOrders: ["price_insurance"]`
- `transmission: "any"`
- `maxAdditionalResultPages: 1`
- starts from tomorrow and checks 30 rolling pickup start dates

Generate the RentCars.pl HTML report from that JSON:

```powershell
node .\src\rentcars\reportHtml.js .\output\rentcars-results-latest.json .\output\rentcars-report.html
```

Generate the Excel pricing summary:

```powershell
node .\src\rentcars\reportXlsx.js .\output\rentcars-results-latest.json .\output\rentcars-summary.xlsx
```

Report interpretation:

- `Niepelne dane MM` in the HTML filter and `unknown` / `incomplete` in Excel mean MM absence could not be confirmed. These checks are excluded from confirmed absence counts and pricing aggregates. Legacy JSON files without coverage flags retain their previous interpretation.
- Gaps to TOP1 are calculated only where MM is present and ranks below first. Room for a price increase is calculated only where MM ranks first and another provider is available. Missing values remain blank, not zero.
- Equal-price providers retain their order in the source results in both HTML and Excel.
- An empty partial run can still generate an Excel workbook showing its status and lack of data.

Run the offline regression suite (no scraping, GitHub mutations, or Telegram messages):

```powershell
npm.cmd test
```

## GitHub Actions

The RentCars.pl GitHub workflow lives in a separate file:

```text
.github/workflows/rentcars-daily.yml
```

The daily workflow groups start dates into bounded chunks and merges all chunk JSON files into one final report. A separate `rentcars-watchdog.yml` checks the run around 06:30 and 08:30 Europe/Warsaw and also reacts when a trusted daily run finishes unsuccessfully, including after the morning checks. Recovery is limited to three total attempts and does not start another retry while a trusted daily run is active. It retries the complete workflow so every chunk artifact is rebuilt, starts a replacement production run when the primary run is missing, and sends a Telegram status message.

If collection and merging succeeded and only publication or notification failed, the watchdog reports that failure without repeating the scrape. Inconclusive job evidence blocks recovery instead of risking a duplicate run.

If GitHub's recent-runs list omits the run from a completion event, the watchdog reads that exact run directly before inspecting its jobs. It checks the latest status so an already active retry is not restarted. Search-form submission also waits for the button and result state within the configured timeout, clicks once, and preserves click/navigation errors instead of mislabeling them as a missing button.

Report generation, Pages publication, and Telegram notification are separate jobs. The notification does not need a repository checkout or approval of the Pages environment. It waits for publication only for a bounded period and includes an HTML link only when the public metadata matches the current run and attempt and the HTML endpoint returns a recognizable report. Otherwise it sends the available artifact link and workflow link without presenting an older HTML report as current. A later Pages publication does not send a second completion message.

The separate `rentcars-morning.yml` workflow schedules a morning Telegram status at **07:00 Europe/Warsaw**, with daylight-saving time handled by the schedule timezone. GitHub may delay the trigger; the message includes the actual inspection time. It inspects only today's trusted daily/recovery run and its current attempt, without starting collection or publishing anything. Existing completion notifications remain enabled.

Morning progress counts completed, running, queued, and failed chunks, not individual offers or scenarios inside running chunks. ETA is a range for the remaining collection work, based on at least two successful chunks in the current attempt and the six-worker limit. It excludes unpredictable runner delays, retries, and final publication. Failed, overdue, queued-only, or insufficiently sampled work gets an explicit unknown ETA. Current verified complete or partial reports include their HTML link and check counts; older reports are not passed off as today's results. API/checkout failures produce a diagnostic message instead. Manual runs preview the message by default; sending requires selecting `send_notification`.

A separate `rentcars-smoke.yml` workflow runs tests and a bounded scraper after pushes, but it cannot overwrite GitHub Pages or send Telegram notifications. The smoke check requires both a successful process exit and complete JSON with no failed or missing checks; partial output cannot produce a green result.

Each attempt uploads a separate merged artifact named `rentcars-results-<run number>-attempt-<attempt>` with:

- `output/rentcars-results-latest.json`
- `output/rentcars-report.html`
- `output/rentcars-summary.xlsx`

Per-chunk JSON, logs, and failure artifacts remain in separate short-lived chunk artifacts instead of being duplicated in the final artifact.

During long scheduled runs, every date chunk writes JSON snapshots after each completed duration. Failed workflows are retried as complete attempts because GitHub does not reliably retain successful chunk artifacts across a failed-jobs-only rerun. Complementary scenario results are still merged within the available attempt data before publication.

The scheduled GitHub profiles share all settings except the pickup-date horizon:

- `01:17 Europe/Warsaw`: 60 rolling pickup dates from tomorrow (unchanged)
- `10:00 Europe/Warsaw`: 20 rolling pickup dates from tomorrow, using a timezone-aware schedule
- all locations from `src/rentcars/locations.json`
- `durations: 2,3,4,5,6,7,8,9,10,11,12,13,14`
- `sort_orders: price_insurance`
- `speed_mode: fast`
- `location_concurrency: 6`
- `max-parallel: 6` chunks at once
- 5 start dates per chunk for durations 2-10, or 3 dates per chunk for wider duration sets
- controlled chunk timeout: `135m`, with a `150m` job timeout

Manual GitHub runs can override locations, rolling days, durations, and speed mode from the `workflow_dispatch` form.
Telegram notifications use the repository `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets.
Both scheduled runs use these same secrets and publish to the same Pages HTML URL; the newer report replaces the older one. The 10:00 profile has 260 date/duration scenarios, 2340 airport checks, and seven chunks. GitHub may delay scheduled starts. Rerunning a scheduled attempt retains its original schedule profile; manual runs keep the 60-day default unless overridden.
The 10:00 run is named `RentCars daytime run`. Completion-triggered recovery treats the daytime and night profiles separately, so a shorter report cannot replace recovery of the 60-day collection. Existing morning watchdog checkpoints check only the night profile; they do not detect a missing daytime trigger.

Using CLI arguments:

```powershell
node .\src\rentcars\cli.js `
  --location "Warszawa" `
  --location "Krakow" `
  --pickup-date 2026-05-15 `
  --pickup-time 10:00 `
  --dropoff-date 2026-05-17 `
  --dropoff-time 10:00 `
  --start-dates "2026-05-15" `
  --rolling-days 1 `
  --durations-days 2 `
  --sort-orders "price_insurance" `
  --transmission "automatic" `
  --output-csv .\output\rentcars-results.csv
```

Run with a visible browser:

```powershell
node .\src\rentcars\cli.js --config .\rentcars.config.example.json --headed
```

## Notes

- RentCars.pl uses a different Polish UI and search flow than DiscoverCars, so this module is intentionally separate under `src/rentcars`.
- A city such as `Warszawa` is expanded only to airport pickup options, for example `Warszawa, Lotnisko-Modlin` and `Warszawa, Lotnisko-Okecie`.
- Added airport-only cities include `Bydgoszcz, Lotnisko-Szwederowo` and `Lodz` mapped to `Łódź, Lotnisko-Lublinek` in the shared catalog.
- The scheduled GitHub Actions workflow is separate too: `.github/workflows/rentcars-daily.yml`.
- GitHub runs that workflow in the cloud, so the local laptop does not need to be turned on.
- The RentCars.pl workflow uploads `rentcars-results-latest.json`, `rentcars-report.html`, `rentcars-run-log.txt`, `rentcars-run-error.txt`, and failure artifacts.
- If RentCars.pl changes the form, the main places to adjust are:
  - `setPickupLocation`
  - `chooseAutocompleteOption`
  - `setDateRange`
  - `extractOffersFromDom`
