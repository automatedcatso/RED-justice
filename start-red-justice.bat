@echo off
REM ============================================================
REM  RED Justice - Quick Start (Windows)
REM  Starts the RED Justice server on port 8008
REM ============================================================
setlocal

set PORT=3000
cd /d "%~dp0"

echo.
echo ============================================================
echo   RED Justice - Starting Server
echo   Port: %PORT%
echo ============================================================
echo.

set PORT=%PORT%

if exist ".next\standalone\server.js" (
    echo Starting production server...
    set NODE_ENV=production
    node .next\standalone\server.js
) else (
    echo Production build not found. Running dev mode...
    where bun >nul 2>nul
    if errorlevel 1 (
        npx next dev -p %PORT%
    ) else (
        bun run dev
    )
)

pause
