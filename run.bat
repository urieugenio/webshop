@echo off
rem Builds the site. Double-click, or run "run.bat --serve" / "run.bat --clean"
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
node build.mjs %*
pause
