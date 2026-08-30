#!/bin/bash
# ============================================================
#  RED Justice — Start Ollama + Server (Linux/macOS)
#  Starts Ollama service, pulls default model, then starts RED Justice
# ============================================================
set -e

DEFAULT_MODEL="${LOCAL_AI_MODEL:-llama3.2}"
PORT="${PORT:-8008}"

echo ""
echo "============================================================"
echo "  RED Justice — Ollama Auto-Start"
echo "============================================================"
echo ""

# ── Step 1: Check if Ollama is installed ──
echo "[1/4] Checking Ollama..."
if ! command -v ollama &>/dev/null; then
    echo "  ERROR: Ollama not found."
    echo "  Install from: https://ollama.com/download"
    echo "  Then run this script again."
    exit 1
fi
echo "  OK: Ollama found"

# ── Step 2: Start Ollama service (if not running) ──
echo ""
echo "[2/4] Starting Ollama service..."
if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
    ollama serve &
    OLLAMA_PID=$!
    echo "  Waiting for Ollama to start..."
    for i in $(seq 1 10); do
        sleep 1
        if curl -s http://localhost:11434/api/tags &>/dev/null; then
            echo "  OK: Ollama started (PID $OLLAMA_PID)"
            break
        fi
    done
else
    echo "  OK: Ollama already running"
fi

# ── Step 3: Check / pull the default model ──
echo ""
echo "[3/4] Checking model: $DEFAULT_MODEL"
if ! ollama list 2>/dev/null | grep -q "$DEFAULT_MODEL"; then
    echo "  Model not found. Pulling $DEFAULT_MODEL..."
    echo "  (This may take several minutes on first run)"
    ollama pull "$DEFAULT_MODEL" || {
        echo "  WARNING: Could not pull $DEFAULT_MODEL"
        echo "  You can pull manually: ollama pull $DEFAULT_MODEL"
    }
    echo "  OK: Model $DEFAULT_MODEL ready"
else
    echo "  OK: Model $DEFAULT_MODEL already installed"
fi

# ── Step 4: Start RED Justice ──
echo ""
echo "[4/4] Starting RED Justice on port $PORT..."
echo ""
echo "============================================================"
echo "  RED Justice is starting..."
echo "  URL: http://localhost:$PORT"
echo "  AI:  Ollama ($DEFAULT_MODEL) at localhost:11434"
echo "============================================================"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

export PORT=$PORT
export LOCAL_AI_BASE_URL="http://localhost:11434/v1"
export LOCAL_AI_MODEL="$DEFAULT_MODEL"

# Try production build first, fall back to dev
if [ -f ".next/standalone/server.js" ]; then
    export NODE_ENV=production
    node .next/standalone/server.js
else
    echo "Production build not found, running dev mode..."
    bun run dev
fi
