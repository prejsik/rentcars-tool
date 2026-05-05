@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo Setup completed.
) else (
  echo Setup failed with error code %CODE%.
)
echo Press Q to close this window.
choice /c Q /n /m ""
exit /b %CODE%
