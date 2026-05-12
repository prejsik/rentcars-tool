# RentCars.pl Cheapest Offers Scraper

This is a separate RentCars.pl scraper module based on the DiscoverCars scraper structure.

## Features

- opens RentCars.pl and fills the rental search form with Playwright
- accepts multiple cities in one run and expands each city to matching RentCars.pl airport pickup points
- supports rolling pickup start dates, specific start dates, pickup weekdays, and duration scenarios
- checks RentCars.pl only with the `price_insurance` sort mode
- extracts offers from JSON responses, embedded page data, or rendered DOM
- continues processing when one location fails
- prints sorted prices with provider name and rating, without car model names
- saves the results to CSV
- generates a compact HTML report with the execution duration at the end

## Run

Using a config file:

```powershell
node .\src\rentcars\cli.js --config .\rentcars.config.example.json
```

Interactive local launcher:

```powershell
.\start-rentcars.bat
```

It opens a Windows options window similar to the DiscoverCars launcher. The default city set matches DiscoverCars:
`Warszawa,Krakow,Gdansk,Katowice,Wroclaw,Poznan`.

Save the GitHub-style JSON payload:

```powershell
node .\src\rentcars\run.js --config .\rentcars.config.example.json --save=.\output\rentcars-results-latest.json
```

Default local profile in the example config:

- `rollingDays: 30`
- `durationsDays: [2]`
- `sortOrders: ["price_insurance"]`
- starts from tomorrow and checks 30 rolling pickup start dates

Generate the RentCars.pl HTML report from that JSON:

```powershell
node .\src\rentcars\reportHtml.js .\output\rentcars-results-latest.json .\output\rentcars-report.html
```

## GitHub Actions

The RentCars.pl GitHub workflow lives in a separate file:

```text
.github/workflows/rentcars-daily.yml
```

It uploads a separate artifact named `rentcars-results-<run number>` with:

- `output/rentcars-results-latest.json`
- `output/rentcars-report.html`
- `output/rentcars-run-log.txt`
- `output/rentcars-run-error.txt`
- `artifacts/rentcars/**`

The scheduled GitHub profile is:

- around `03:17 Europe/Warsaw`, matching the DiscoverCars daily workflow
- all DiscoverCars cities mapped to RentCars.pl airport pickup points: `Warszawa,Krakow,Gdansk,Katowice,Wroclaw,Poznan`
- `rolling_days: 30`
- `durations: 2,3,4,5,6,7,8,9,10`
- `sort_orders: price_insurance`
- `speed_mode: fast`

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
  --output-csv .\output\rentcars-results.csv
```

Run with a visible browser:

```powershell
node .\src\rentcars\cli.js --config .\rentcars.config.example.json --headed
```

## Notes

- RentCars.pl uses a different Polish UI and search flow than DiscoverCars, so this module is intentionally separate under `src/rentcars`.
- A city such as `Warszawa` is expanded only to airport pickup options, for example `Warszawa, Lotnisko-Modlin` and `Warszawa, Lotnisko-Okecie`.
- The scheduled GitHub Actions workflow is separate too: `.github/workflows/rentcars-daily.yml`.
- GitHub runs that workflow in the cloud, so the local laptop does not need to be turned on.
- The RentCars.pl workflow uploads `rentcars-results-latest.json`, `rentcars-report.html`, `rentcars-run-log.txt`, `rentcars-run-error.txt`, and failure artifacts.
- If RentCars.pl changes the form, the main places to adjust are:
  - `setPickupLocation`
  - `chooseAutocompleteOption`
  - `setDateRange`
  - `extractOffersFromDom`
