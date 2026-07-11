Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Show-MessageBox {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [string]$Title = "RentCars.pl launcher",
    [ValidateSet("Info", "Error", "Warning")]
    [string]$Type = "Info"
  )

  Add-Type -AssemblyName System.Windows.Forms

  $icon = [System.Windows.Forms.MessageBoxIcon]::Information
  if ($Type -eq "Error") {
    $icon = [System.Windows.Forms.MessageBoxIcon]::Error
  } elseif ($Type -eq "Warning") {
    $icon = [System.Windows.Forms.MessageBoxIcon]::Warning
  }

  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    $icon
  )
}

function Get-DefaultLocations {
  $catalogPath = Join-Path $root "src\rentcars\locations.json"
  if (-not (Test-Path $catalogPath)) {
    throw "Missing shared location catalog: $catalogPath"
  }

  return @(
    Get-Content -Raw -LiteralPath $catalogPath |
      ConvertFrom-Json |
      ForEach-Object { [string]$_.city } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
}

function Ensure-Requirements {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    Show-MessageBox -Message "Node.js was not found. Install Node.js 18+ and run start-rentcars.bat again." -Type Error
    throw "Node.js is required."
  }

  $entryPath = Join-Path $root "src\rentcars\run.js"
  if (-not (Test-Path $entryPath)) {
    Show-MessageBox -Message "File src\rentcars\run.js was not found. Check project files." -Type Error
    throw "Missing src\rentcars\run.js."
  }

  [void](Get-DefaultLocations)

  $playwrightPackagePath = Join-Path $root "node_modules\playwright\package.json"
  if (-not (Test-Path $playwrightPackagePath)) {
    Show-MessageBox -Message "Dependencies were not found. Run setup.bat first, then start-rentcars.bat again." -Type Error
    throw "Missing dependencies."
  }
}

function Show-RunPicker {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $catalogCities = @(Get-DefaultLocations)

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "RentCars.pl - Options"
  $form.StartPosition = "CenterScreen"
  $form.Width = 560
  $form.Height = 1010
  $form.TopMost = $true

  $durationsLabel = New-Object System.Windows.Forms.Label
  $durationsLabel.Left = 20
  $durationsLabel.Top = 18
  $durationsLabel.Width = 500
  $durationsLabel.Height = 48
  $durationsLabel.Text = "Select rental durations. You can select multiple options.`nOptions '2-20 (all)' and '2-10 (all)' select common ranges."
  $form.Controls.Add($durationsLabel)

  $checkedList = New-Object System.Windows.Forms.CheckedListBox
  $checkedList.Left = 20
  $checkedList.Top = 80
  $checkedList.Width = 500
  $checkedList.Height = 250
  $checkedList.CheckOnClick = $true
  [void]$checkedList.Items.Add("2-20 (all)")
  [void]$checkedList.Items.Add("2-10 (all)")
  foreach ($day in 2..20) {
    [void]$checkedList.Items.Add("$day")
  }
  $checkedList.SetItemChecked(1, $true)
  $checkedList.Tag = $false

  $checkedList.Add_ItemCheck({
    param($sender, $eventArgs)

    if ($sender.Tag -eq $true) {
      return
    }

    if ($eventArgs.NewValue -ne [System.Windows.Forms.CheckState]::Checked) {
      return
    }

    try {
      $sender.Tag = $true

      if ($eventArgs.Index -eq 0) {
        for ($i = 1; $i -lt $sender.Items.Count; $i++) {
          $sender.SetItemChecked($i, $false)
        }
        return
      }

      if ($eventArgs.Index -eq 1) {
        $sender.SetItemChecked(0, $false)
        for ($i = 2; $i -lt $sender.Items.Count; $i++) {
          $sender.SetItemChecked($i, $false)
        }
        return
      }

      $sender.SetItemChecked(0, $false)
      $sender.SetItemChecked(1, $false)
    } finally {
      $sender.Tag = $false
    }
  })
  $form.Controls.Add($checkedList)

  $locationsLabel = New-Object System.Windows.Forms.Label
  $locationsLabel.Left = 20
  $locationsLabel.Top = 340
  $locationsLabel.Width = 500
  $locationsLabel.Height = 34
  $locationsLabel.Text = "Cities checked by default match the shared RentCars catalog:`n$($catalogCities -join ', ')."
  $form.Controls.Add($locationsLabel)

  $startDatesLabel = New-Object System.Windows.Forms.Label
  $startDatesLabel.Left = 20
  $startDatesLabel.Top = 385
  $startDatesLabel.Width = 500
  $startDatesLabel.Height = 44
  $startDatesLabel.Text = "Choose pickup start dates. Use a date range, or paste specific dates at once.`nNo Add date button needed."
  $form.Controls.Add($startDatesLabel)

  $rangeRadio = New-Object System.Windows.Forms.RadioButton
  $rangeRadio.Left = 20
  $rangeRadio.Top = 438
  $rangeRadio.Width = 220
  $rangeRadio.Height = 24
  $rangeRadio.Text = "Date range (from - to)"
  $rangeRadio.Checked = $true
  $form.Controls.Add($rangeRadio)

  $specificRadio = New-Object System.Windows.Forms.RadioButton
  $specificRadio.Left = 280
  $specificRadio.Top = 438
  $specificRadio.Width = 220
  $specificRadio.Height = 24
  $specificRadio.Text = "Specific dates"
  $form.Controls.Add($specificRadio)

  $fromLabel = New-Object System.Windows.Forms.Label
  $fromLabel.Left = 20
  $fromLabel.Top = 478
  $fromLabel.Width = 80
  $fromLabel.Height = 22
  $fromLabel.Text = "From:"
  $form.Controls.Add($fromLabel)

  $fromDatePicker = New-Object System.Windows.Forms.DateTimePicker
  $fromDatePicker.Left = 95
  $fromDatePicker.Top = 472
  $fromDatePicker.Width = 150
  $fromDatePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
  $fromDatePicker.CustomFormat = "yyyy-MM-dd"
  $fromDatePicker.Value = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($fromDatePicker)

  $toLabel = New-Object System.Windows.Forms.Label
  $toLabel.Left = 280
  $toLabel.Top = 478
  $toLabel.Width = 50
  $toLabel.Height = 22
  $toLabel.Text = "To:"
  $form.Controls.Add($toLabel)

  $toDatePicker = New-Object System.Windows.Forms.DateTimePicker
  $toDatePicker.Left = 330
  $toDatePicker.Top = 472
  $toDatePicker.Width = 150
  $toDatePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
  $toDatePicker.CustomFormat = "yyyy-MM-dd"
  $toDatePicker.Value = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($toDatePicker)

  $specificDatesLabel = New-Object System.Windows.Forms.Label
  $specificDatesLabel.Left = 20
  $specificDatesLabel.Top = 525
  $specificDatesLabel.Width = 500
  $specificDatesLabel.Height = 32
  $specificDatesLabel.Text = "Specific dates: click dates in the calendar to add/remove them, or paste dates manually."
  $form.Controls.Add($specificDatesLabel)

  $specificCalendar = New-Object System.Windows.Forms.MonthCalendar
  $specificCalendar.Left = 20
  $specificCalendar.Top = 560
  $specificCalendar.MaxSelectionCount = 1
  $specificCalendar.SelectionStart = (Get-Date).Date.AddDays(1)
  $specificCalendar.SelectionEnd = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($specificCalendar)

  $specificDatesTextBox = New-Object System.Windows.Forms.TextBox
  $specificDatesTextBox.Left = 285
  $specificDatesTextBox.Top = 560
  $specificDatesTextBox.Width = 235
  $specificDatesTextBox.Height = 92
  $specificDatesTextBox.Multiline = $true
  $specificDatesTextBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $specificDatesTextBox.Text = (Get-Date).Date.AddDays(1).ToString("yyyy-MM-dd")
  $form.Controls.Add($specificDatesTextBox)

  $clearSpecificDatesButton = New-Object System.Windows.Forms.Button
  $clearSpecificDatesButton.Left = 285
  $clearSpecificDatesButton.Top = 665
  $clearSpecificDatesButton.Width = 170
  $clearSpecificDatesButton.Height = 28
  $clearSpecificDatesButton.Text = "Clear selected dates"
  $form.Controls.Add($clearSpecificDatesButton)

  $dateModeHint = New-Object System.Windows.Forms.Label
  $dateModeHint.Left = 20
  $dateModeHint.Top = 725
  $dateModeHint.Width = 500
  $dateModeHint.Height = 22
  $dateModeHint.Text = "Range mode creates every date from From to To, inclusive."
  $form.Controls.Add($dateModeHint)

  $speedLabel = New-Object System.Windows.Forms.Label
  $speedLabel.Left = 20
  $speedLabel.Top = 755
  $speedLabel.Width = 500
  $speedLabel.Height = 32
  $speedLabel.Text = "Speed mode. Use safe to return to the previous stable behavior."
  $form.Controls.Add($speedLabel)

  $speedCombo = New-Object System.Windows.Forms.ComboBox
  $speedCombo.Left = 20
  $speedCombo.Top = 790
  $speedCombo.Width = 250
  $speedCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$speedCombo.Items.Add("fast")
  [void]$speedCombo.Items.Add("safe")
  [void]$speedCombo.Items.Add("turbo")
  $speedCombo.SelectedIndex = 0
  $form.Controls.Add($speedCombo)

  $transmissionLabel = New-Object System.Windows.Forms.Label
  $transmissionLabel.Left = 20
  $transmissionLabel.Top = 825
  $transmissionLabel.Width = 500
  $transmissionLabel.Height = 22
  $transmissionLabel.Text = "Transmission"
  $form.Controls.Add($transmissionLabel)

  $transmissionCombo = New-Object System.Windows.Forms.ComboBox
  $transmissionCombo.Left = 20
  $transmissionCombo.Top = 850
  $transmissionCombo.Width = 250
  $transmissionCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$transmissionCombo.Items.Add("all cars")
  [void]$transmissionCombo.Items.Add("automatic only")
  $transmissionCombo.SelectedIndex = 0
  $form.Controls.Add($transmissionCombo)

  function Format-IsoDate([datetime]$value) {
    return $value.Date.ToString("yyyy-MM-dd")
  }

  function Get-DateRangeIso {
    param(
      [Parameter(Mandatory = $true)]
      [datetime]$Start,
      [Parameter(Mandatory = $true)]
      [datetime]$End
    )

    $dates = @()
    $cursor = $Start.Date
    $last = $End.Date
    while ($cursor -le $last) {
      $dates += (Format-IsoDate -value $cursor)
      $cursor = $cursor.AddDays(1)
    }

    return $dates
  }

  function Set-SpecificDateText {
    param([string[]]$Dates)
    $specificDatesTextBox.Text = (@($Dates) | Sort-Object -Unique) -join ", "
  }

  function Parse-SpecificStartDates {
    param([Parameter(Mandatory = $true)][string]$Text)

    $tokens = @(
      $Text -split "[,\s;|]+" |
        ForEach-Object { [string]$_ } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )

    $dates = New-Object System.Collections.Generic.List[string]
    $invalid = New-Object System.Collections.Generic.List[string]
    foreach ($token in $tokens) {
      if ($token -notmatch "^\d{4}-\d{2}-\d{2}$") {
        [void]$invalid.Add($token)
        continue
      }

      $parsedDate = [datetime]::MinValue
      $ok = [datetime]::TryParseExact(
        $token,
        "yyyy-MM-dd",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None,
        [ref]$parsedDate
      )

      if (-not $ok) {
        [void]$invalid.Add($token)
        continue
      }

      [void]$dates.Add((Format-IsoDate -value $parsedDate))
    }

    return [PSCustomObject]@{
      dates = @($dates | Sort-Object -Unique)
      invalid = @($invalid)
    }
  }

  function Update-DateModeControls {
    $rangeMode = $rangeRadio.Checked
    $fromLabel.Enabled = $rangeMode
    $fromDatePicker.Enabled = $rangeMode
    $toLabel.Enabled = $rangeMode
    $toDatePicker.Enabled = $rangeMode
    $specificDatesLabel.Enabled = -not $rangeMode
    $specificCalendar.Enabled = -not $rangeMode
    $specificDatesTextBox.Enabled = -not $rangeMode
    $clearSpecificDatesButton.Enabled = -not $rangeMode

    if ($rangeMode) {
      $dateModeHint.Text = "Range mode creates every date from From to To, inclusive."
    } else {
      $dateModeHint.Text = "Specific mode: click a date to add it, click it again to remove it."
    }
  }

  $rangeRadio.Add_CheckedChanged({ Update-DateModeControls })
  $specificRadio.Add_CheckedChanged({ Update-DateModeControls })
  $specificCalendar.Add_MouseDown({
    param($sender, $eventArgs)

    if (-not $specificRadio.Checked) {
      $specificRadio.Checked = $true
    }

    $hit = $sender.HitTest($eventArgs.X, $eventArgs.Y)
    if ([string]$hit.HitArea -ne "Date") {
      return
    }

    $selectedIsoDate = Format-IsoDate -value $hit.Time
    $parsedSpecificDates = Parse-SpecificStartDates -Text $specificDatesTextBox.Text
    $dateSet = New-Object System.Collections.Generic.HashSet[string]
    foreach ($date in @($parsedSpecificDates.dates)) {
      [void]$dateSet.Add([string]$date)
    }

    if ($dateSet.Contains($selectedIsoDate)) {
      [void]$dateSet.Remove($selectedIsoDate)
    } else {
      [void]$dateSet.Add($selectedIsoDate)
    }

    Set-SpecificDateText -Dates @($dateSet)
  })
  $clearSpecificDatesButton.Add_Click({
    $specificRadio.Checked = $true
    $specificDatesTextBox.Clear()
  })
  Update-DateModeControls

  $runButton = New-Object System.Windows.Forms.Button
  $runButton.Left = 20
  $runButton.Top = 920
  $runButton.Width = 170
  $runButton.Height = 30
  $runButton.Text = "Run"
  $form.Controls.Add($runButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Left = 210
  $cancelButton.Top = 920
  $cancelButton.Width = 170
  $cancelButton.Height = 30
  $cancelButton.Text = "Cancel"
  $form.Controls.Add($cancelButton)

  $runButton.Add_Click({
    $picked = @()
    foreach ($item in $checkedList.CheckedItems) {
      $picked += [string]$item
    }

    if ($picked.Count -eq 0) {
      [void][System.Windows.Forms.MessageBox]::Show(
        "Select at least one duration option.",
        "Validation",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      return
    }

    if ($rangeRadio.Checked) {
      if ($fromDatePicker.Value.Date -gt $toDatePicker.Value.Date) {
        [void][System.Windows.Forms.MessageBox]::Show(
          "Start date range is invalid. 'From' must be before or equal to 'To'.",
          "Validation",
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return
      }

      $pickedStartDates = @(Get-DateRangeIso -Start $fromDatePicker.Value -End $toDatePicker.Value)
    } else {
      $parsedSpecificDates = Parse-SpecificStartDates -Text $specificDatesTextBox.Text
      if (@($parsedSpecificDates.invalid).Count -gt 0) {
        [void][System.Windows.Forms.MessageBox]::Show(
          "Invalid start date(s): $(@($parsedSpecificDates.invalid) -join ', '). Use YYYY-MM-DD format.",
          "Validation",
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return
      }

      $pickedStartDates = @($parsedSpecificDates.dates)
    }

    if ($pickedStartDates.Count -eq 0) {
      [void][System.Windows.Forms.MessageBox]::Show(
        "Choose at least one start date.",
        "Validation",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      return
    }

    $selectedTransmission = if ($transmissionCombo.SelectedIndex -eq 1) { "automatic" } else { "any" }
    $form.Tag = [PSCustomObject]@{
      selected_durations = @($picked)
      start_dates = $pickedStartDates
      speed_mode = [string]$speedCombo.SelectedItem
      transmission = $selectedTransmission
    }
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  })

  $cancelButton.Add_Click({
    $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Close()
  })

  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }

  return $form.Tag
}

function Resolve-Durations {
  param([Parameter(Mandatory = $true)][object[]]$SelectedItems)

  $selectedTokens = @(
    $SelectedItems |
      ForEach-Object { [string]$_ } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )

  if ($selectedTokens -contains "2-20 (all)") {
    return @(2..20)
  }

  if ($selectedTokens -contains "2-10 (all)") {
    return @(2..10)
  }

  $unique = New-Object System.Collections.Generic.HashSet[int]
  foreach ($item in $selectedTokens) {
    $raw = [string]$item
    if ($raw -match "^\s*(\d+)\s*$") {
      $value = [int]$matches[1]
      if ($value -ge 2 -and $value -le 20) {
        [void]$unique.Add($value)
      }
    }
  }

  if ($unique.Count -eq 0) {
    return @(2)
  }

  return @($unique | Sort-Object)
}

function Invoke-ProcessWithProgress {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$StatusText,
    [Parameter(Mandatory = $true)]
    [string]$StdOutPath,
    [Parameter(Mandatory = $true)]
    [string]$StdErrPath,
    [int]$ExpectedSteps = 0
  )

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $progressForm = New-Object System.Windows.Forms.Form
  $progressForm.Text = "RentCars.pl - Running"
  $progressForm.StartPosition = "CenterScreen"
  $progressForm.Width = 440
  $progressForm.Height = 155
  $progressForm.TopMost = $true
  $progressForm.ControlBox = $false

  $label = New-Object System.Windows.Forms.Label
  $label.Left = 18
  $label.Top = 18
  $label.Width = 390
  $label.Height = 52
  $label.Text = $StatusText
  $progressForm.Controls.Add($label)

  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Left = 18
  $bar.Top = 82
  $bar.Width = 390
  $bar.Height = 22
  if ($ExpectedSteps -gt 0) {
    $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
    $bar.Minimum = 0
    $bar.Maximum = 100
    $bar.Value = 0
  } else {
    $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
    $bar.MarqueeAnimationSpeed = 35
  }
  $progressForm.Controls.Add($bar)

  $progressForm.Show()
  [System.Windows.Forms.Application]::DoEvents()

  try {
    $process = Start-Process `
      -FilePath $FilePath `
      -ArgumentList $Arguments `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdOutPath `
      -RedirectStandardError $StdErrPath `
      -PassThru

    $lastProgressRead = [datetime]::MinValue
    while (-not $process.WaitForExit(250)) {
      if ($ExpectedSteps -gt 0 -and ((Get-Date) - $lastProgressRead).TotalMilliseconds -ge 750) {
        $lastProgressRead = Get-Date
        $progressLine = @(
          Get-Content -LiteralPath $StdOutPath -Tail 30 -ErrorAction SilentlyContinue |
            Select-String -Pattern "^PROGRESS\s+\d+/\d+\s+\(\d+%\)\s+\|\s+elapsed\s+.+\s+\|\s+ETA\s+.+$"
        ) | Select-Object -Last 1
        if ($progressLine) {
          $progressText = [string]$progressLine.Line
          $label.Text = $progressText
          if ($progressText -match "\((\d+)%\)") {
            $bar.Value = [Math]::Max(0, [Math]::Min(100, [int]$matches[1]))
          }
        }
      }
      [System.Windows.Forms.Application]::DoEvents()
    }

    $process.WaitForExit()
    $process.Refresh()

    if ($null -eq $process.ExitCode -or [string]::IsNullOrWhiteSpace([string]$process.ExitCode)) {
      return 0
    }

    return [int]$process.ExitCode
  } finally {
    $progressForm.Close()
    $progressForm.Dispose()
  }
}

try {
  Ensure-Requirements

  $pickedOptions = Show-RunPicker
  if (-not $pickedOptions) {
    exit 0
  }

  $selected = @(
    @($pickedOptions.selected_durations) |
      ForEach-Object { [string]$_ } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  $startDates = @(
    @($pickedOptions.start_dates) |
      ForEach-Object { [string]$_ } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Sort-Object -Unique
  )

  $durations = Resolve-Durations -SelectedItems $selected
  $durationsCsv = ($durations | ForEach-Object { $_.ToString() }) -join ","
  $startDatesCsv = ($startDates -join ",")
  $speedMode = [string]$pickedOptions.speed_mode
  if ([string]::IsNullOrWhiteSpace($speedMode)) {
    $speedMode = "fast"
  }
  $transmission = [string]$pickedOptions.transmission
  if ([string]::IsNullOrWhiteSpace($transmission)) {
    $transmission = "any"
  }

  $outputDir = Join-Path $root "output"
  if (-not (Test-Path $outputDir)) {
    [void](New-Item -ItemType Directory -Path $outputDir -Force)
  }

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $jsonPath = Join-Path $outputDir "rentcars-results-$timestamp.json"
  $jsonLatestPath = Join-Path $outputDir "rentcars-results-latest.json"
  $htmlPath = Join-Path $outputDir "rentcars-report.html"
  $stdoutLog = Join-Path $outputDir "rentcars-run-log.txt"
  $stderrLog = Join-Path $outputDir "rentcars-run-error.txt"

  $locationsCsv = (@(Get-DefaultLocations) -join ",")
  $configPath = Join-Path $root "rentcars.config.example.json"

  $nodeArgs = @(
    "src\rentcars\run.js",
    "--config", $configPath,
    "--locations=$locationsCsv",
    "--start-dates=$startDatesCsv",
    "--durations-days=$durationsCsv",
    "--speed-mode=$speedMode",
    "--transmission=$transmission",
    "--timeout-ms=30000",
    "--output-json=$jsonPath"
  )

  $runExitCode = Invoke-ProcessWithProgress `
    -FilePath "node" `
    -Arguments $nodeArgs `
    -StatusText "Running RentCars.pl scraper. This can take a while." `
    -StdOutPath $stdoutLog `
    -StdErrPath $stderrLog `
    -ExpectedSteps ($startDates.Count * $durations.Count)

  if ($runExitCode -ne 0) {
    Show-MessageBox -Message "RentCars.pl scraper finished with error code $runExitCode.`nLogs:`n$stdoutLog`n$stderrLog" -Type Error
    exit $runExitCode
  }

  if (Test-Path $jsonPath) {
    Copy-Item -Path $jsonPath -Destination $jsonLatestPath -Force
  }

  $reportStdOut = Join-Path $outputDir "rentcars-report-log.txt"
  $reportStdErr = Join-Path $outputDir "rentcars-report-error.txt"
  $reportArgs = @(
    "src\rentcars\reportHtml.js",
    $jsonLatestPath,
    $htmlPath
  )

  $reportExitCode = Invoke-ProcessWithProgress `
    -FilePath "node" `
    -Arguments $reportArgs `
    -StatusText "Generating RentCars.pl HTML report." `
    -StdOutPath $reportStdOut `
    -StdErrPath $reportStdErr

  if ($reportExitCode -ne 0) {
    Show-MessageBox -Message "RentCars.pl report finished with error code $reportExitCode.`nLogs:`n$reportStdOut`n$reportStdErr" -Type Error
    exit $reportExitCode
  }

  Show-MessageBox -Message "Finished.`n`nJSON:`n$jsonLatestPath`n`nHTML:`n$htmlPath" -Type Info
  exit 0
} catch {
  Show-MessageBox -Message ($_.Exception.Message) -Type Error
  exit 1
}
