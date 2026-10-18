@echo off
rem Builds the site and publishes the changed files to Cloudflare (https://uri.fashion).
rem The first time, sign in once with:  npx wrangler login
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules\wrangler (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
node build.mjs --publish %*
pause
