@echo off
REM ============================================================
REM  RED JUSTICE - Master Setup Script (Windows)
REM  Builds a production-ready local server on port 8008
REM ============================================================
setlocal

set PORT=3000
cd /d "%~dp0"

echo.
echo ============================================================
echo   RED JUSTICE - Master Setup
echo   Production-ready local server on port %PORT%
echo ============================================================
echo.

REM ── Step 1: Check Node.js ──
echo [1/6] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo   ERROR: Node.js not found.
    echo   Please install Node.js v18+ from: https://nodejs.org
    echo   Then run setup.bat again.
    pause
    exit /b 1
)
echo   OK: Node.js found

REM ── Step 2: Install dependencies ──
echo.
echo [2/6] Installing dependencies...
where bun >nul 2>nul
if errorlevel 1 (
    echo   Bun not found, using npm...
    call npm install
) else (
    call bun install
)
if errorlevel 1 (
    echo   ERROR: Dependency installation failed.
    pause
    exit /b 1
)
echo   OK: Dependencies installed

REM ── Step 3: Create .env file ──
echo.
echo [3/6] Setting up environment...
if not exist ".env" (
    echo   Creating .env file...
    echo # RED Justice Environment > .env
    echo DATABASE_URL="file:./db/custom.db" >> .env
    echo PORT=%PORT% >> .env
    echo LOCAL_AI_BASE_URL=http://localhost:11434/v1 >> .env
    echo LOCAL_AI_MODEL=llama3.2 >> .env
    echo LOCAL_AI_TIMEOUT_MS=120000 >> .env
    echo   OK: Created .env
) else (
    echo   OK: .env already exists
)

REM ── Step 4: Set up database ──
echo.
echo [4/6] Setting up database...
where bun >nul 2>nul
if errorlevel 1 (
    call npx prisma db push --accept-data-loss
    call npx prisma generate
) else (
    call bun run db:push
    call bun run db:generate
)
if errorlevel 1 (
    echo   ERROR: Database setup failed.
    pause
    exit /b 1
)
echo   OK: Database ready

REM ── Step 5: Build production bundle ──
echo.
echo [5/6] Building production bundle...
where bun >nul 2>nul
if errorlevel 1 (
    call npm run build
) else (
    call bun run build
)
if errorlevel 1 (
    echo   WARN: Production build failed. You can still run in dev mode.
) else (
    echo   OK: Production build complete
)

REM ── Step 6: Done ──
echo.
echo [6/6] Setup complete!
echo.
echo ============================================================
echo   RED JUSTICE IS READY
echo ============================================================
echo.
echo   Port:           %PORT%
echo   Database:       SQLite at db\custom.db
echo   AI:             Ollama (install separately from ollama.com)
echo.
echo   TO START:
echo     Use:  start-red-justice.bat (starts the server)
echo     Use:  start-ollama.bat     (starts Ollama + server)
echo.
echo   The server will be at: http://localhost:%PORT%
echo.
echo   AI NOTE: Install Ollama from https://ollama.com
echo   Then run: ollama pull llama3.2
echo   In Settings, you can select which Ollama model to use.
echo.
echo   DOCKER: docker compose up --build
echo.
echo ============================================================
echo.
pause
