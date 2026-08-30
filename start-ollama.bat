@echo off
REM ============================================================
REM  RED Justice - Start Ollama + Server (Windows)
REM  Starts Ollama service, then starts RED Justice on port 8008
REM ============================================================
setlocal

set PORT=8008
set MODEL=llama3.2

echo.
echo ============================================================
echo   RED Justice - Starting Ollama + Server
echo ============================================================
echo.

REM ── Check if Ollama is installed ──
echo [1/3] Checking Ollama...
where ollama >nul 2>nul
if errorlevel 1 (
    echo   Ollama not found. Please install from https://ollama.com
    echo   Starting server without AI (fallback mode)...
    goto :start_server
)
echo   OK: Ollama found

REM ── Start Ollama if not running ──
echo.
echo [2/3] Starting Ollama service...
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /i "ollama.exe" >nul
if errorlevel 1 (
    start "" ollama serve
    echo   Waiting for Ollama to start...
    timeout /t 5 /nobreak >nul
    echo   OK: Ollama started
) else (
    echo   OK: Ollama already running
)

REM ── Pull model if not installed ──
echo.
echo [3/3] Checking model: %MODEL%
ollama list 2>nul | find /i "%MODEL%" >nul
if errorlevel 1 (
    echo   Pulling %MODEL% (may take several minutes)...
    ollama pull %MODEL%
) else (
    echo   OK: Model %MODEL% ready
)

:start_server
echo.
echo ============================================================
echo   Starting RED Justice on port %PORT%
echo   URL: http://localhost:%PORT%
echo   AI:  Ollama (%MODEL%) at localhost:11434
echo ============================================================
echo.

set PORT=%PORT%
set LOCAL_AI_BASE_URL=http://localhost:11434/v1
set LOCAL_AI_MODEL=%MODEL%

if exist ".next\standalone\server.js" (
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
