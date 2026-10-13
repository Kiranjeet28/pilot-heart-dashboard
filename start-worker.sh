#!/usr/bin/env bash
# start-worker.sh — start the DesktopPilot desktop helper with one command.
# Usage: bash start-worker.sh        (from the project root)
# Works on Linux/macOS, and on Windows inside Git Bash or WSL.

set -euo pipefail
cd "$(dirname "$0")/worker/visual-agent"

# 1. Config file
[ -f config.json ] || cp config.example.json config.json

# 2. Python virtual environment (Windows-style venv also supported via Git Bash)
if [ -x ".venv/bin/python" ]; then
    PY=".venv/bin/python"
elif [ -f ".venv/Scripts/python.exe" ]; then
    PY=".venv/Scripts/python.exe"
else
    echo "Creating the Python environment (first run)..."
    python3 -m venv .venv
    PY=".venv/bin/python"
    "$PY" -m pip install --upgrade pip
fi

# 3. Dependencies (first run only)
if [ ! -f ".venv/.deps-installed" ]; then
    echo "Installing dependencies (first run only)..."
    "$PY" -m pip install -r requirements.txt
    touch ".venv/.deps-installed"
fi

# 4. Free the port from a previous helper instance (python only, best effort)
PORT=$(python3 -c "import json;print(json.load(open('config.json'))['port'])" 2>/dev/null || echo 8765)
if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
    for p in $PIDS; do
        if ps -p "$p" -o comm= | grep -qi python; then
            echo "Stopping the previous helper (PID $p) so the port is free..."
            kill "$p"
        else
            echo "Port $PORT is used by another program (PID $p). Close it or change 'port' in worker/visual-agent/config.json." >&2
            exit 1
        fi
    done
fi

# 5. One-time signing key (safe to re-run; does nothing if it already exists)
"$PY" -m desktoppilot_worker setup || true

# 6. Run the helper (Ctrl+C to stop)
exec "$PY" -m desktoppilot_worker run --config config.json
