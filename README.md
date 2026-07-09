# RentCars.pl Cheapest Offers Scraper

This is a separate RentCars.pl scraper module based on the DiscoverCars scraper structure.

## Features

- opens RentCars.pl and fills the rental search form with Playwright
- accepts multiple cities in one run and expands each city to matching RentCars.pl airport pickup points
- keeps cities, airport labels, and RentCars.pl IDs in `src/rentcars/locations.json`
- supports rolling pickup start dates, specific start dates, pickup weekdays, and duration scenarios
- checks RentCars.pl only with the `price_insurance` sort mode
- searches RentCars.pl with automatic transmission filtering when that filter is available
- requires a verified protected price in `price_insurance` mode and records base and insured prices separately
- loads the next "show more cars" result page when fewer than 3 providers are visible
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
- `transmission: "automatic"`
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

## GitHub Actions

The RentCars.pl GitHub workflow lives in a separate file:

```text
.github/workflows/rentcars-daily.yml
```

The daily workflow groups start dates into bounded chunks, merges all chunk JSON files, deploys one final report, and sends one Telegram message. A separate `rentcars-smoke.yml` workflow runs after pushes but uploads only a smoke artifact; it cannot overwrite GitHub Pages or send Telegram notifications.

It uploads a separate merged artifact named `rentcars-results-<run number>` with:

- `output/rentcars-results-latest.json`
- `output/rentcars-report.html`
- `output/rentcars-summary.xlsx`

Per-chunk JSON, logs, and failure artifacts remain in separate short-lived chunk artifacts instead of being duplicated in the final artifact.

During long scheduled runs, every date chunk writes JSON snapshots after each completed duration. If one chunk stops early, the merge job can still publish a partial HTML report from the chunks that uploaded data.

The scheduled GitHub profile is:

- around `01:17 Europe/Warsaw`
- all locations from `src/rentcars/locations.json`
- `rolling_days: 30`
- `durations: 2,3,4,5,6,7,8,9,10`
- `sort_orders: price_insurance`
- `speed_mode: fast`
- `location_concurrency: 6`
- `max-parallel: 6` chunks at once
- 5 start dates per chunk for durations 2-10, or 3 dates per chunk for wider duration sets
- controlled chunk timeout: `135m`, with a `150m` job timeout

Manual GitHub runs can override locations, rolling days, durations, and speed mode from the `workflow_dispatch` form.
Telegram notifications use the repository `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets.

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
