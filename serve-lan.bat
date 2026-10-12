@echo off
rem Builds the site and serves it on the local network, so it can be opened on a phone on the same wifi.
rem The addresses to open are printed below. Close this window to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules\sharp (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
node build.mjs --serve --lan %*
pause
