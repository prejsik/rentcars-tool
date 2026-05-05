$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Installing Node dependencies..."
npm install

Write-Host "Installing Playwright Chromium..."
npx playwright install chromium

Write-Host "Done."
