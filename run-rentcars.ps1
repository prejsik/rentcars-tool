$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$DefaultLocations = "Warszawa,Krakow,Gdansk,Katowice,Wroclaw,Poznan"
$DefaultDurations = "2"
$ConfigPath = Join-Path $Root "rentcars.config.example.json"
$OutputJson = Join-Path $Root "output\rentcars-results-latest.json"
$OutputHtml = Join-Path $Root "output\rentcars-report.html"

Write-Host "RentCars.pl local runner"
Write-Host ""
Write-Host "Default cities match DiscoverCars: $DefaultLocations"
Write-Host ""

$Locations = Read-Host "Cities/locations comma-separated (Enter = all default cities)"
if ([string]::IsNullOrWhiteSpace($Locations)) {
  $Locations = $DefaultLocations
}

$StartDates = Read-Host "Pickup start date(s) YYYY-MM-DD comma-separated (Enter = tomorrow rolling)"
$Durations = Read-Host "Duration day(s) comma-separated (Enter = 2)"
if ([string]::IsNullOrWhiteSpace($Durations)) {
  $Durations = $DefaultDurations
}

$NodeArgs = @(
  "src\rentcars\run.js",
  "--config", $ConfigPath,
  "--locations=$Locations",
  "--durations-days=$Durations",
  "--timeout-ms=30000",
  "--output-json=$OutputJson"
)

if ([string]::IsNullOrWhiteSpace($StartDates)) {
  $NodeArgs += "--rolling-days=1"
} else {
  $NodeArgs += "--start-dates=$StartDates"
}

Write-Host ""
Write-Host "Running RentCars.pl scraper..."
& node @NodeArgs
$RunCode = $LASTEXITCODE
if ($RunCode -ne 0) {
  exit $RunCode
}

Write-Host ""
Write-Host "Generating HTML report..."
& node "src\rentcars\reportHtml.js" $OutputJson $OutputHtml
$ReportCode = $LASTEXITCODE
if ($ReportCode -ne 0) {
  exit $ReportCode
}

Write-Host ""
Write-Host "JSON: $OutputJson"
Write-Host "HTML: $OutputHtml"
exit 0
