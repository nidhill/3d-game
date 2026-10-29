@echo off
cd /d "%~dp0"
echo.
echo   HACA Office Explorer (multiplayer + voice)
echo   Close this window to stop the server.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules\selfsigned (
  echo Installing server packages...
  call npm install
)
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080/index.html"
node server.js
