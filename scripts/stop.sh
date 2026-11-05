#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CDP_PORT:-9222}"
PID_FILE="${ROOT_DIR}/.tmp/electron-launcher.pid"

# 1. Try the launcher's own stop (uses pid file)
if [[ -f "$PID_FILE" ]]; then
    "$ROOT_DIR/scripts/electron-launcher.sh" stop "$@" 2>/dev/null && exit 0
fi

# 2. Find Electron by CDP port arg
pid=$(pgrep -af "Electron.*--remote-debugging-port=${PORT}" 2>/dev/null | awk '{print $1}' | head -n1)

# 3. Fallback: find any Electron running from this project
if [[ -z "${pid:-}" ]]; then
    pid=$(pgrep -af "Electron.*${ROOT_DIR}" 2>/dev/null | grep -v "Helper" | awk '{print $1}' | head -n1)
fi

if [[ -z "${pid:-}" ]]; then
    echo "[stop] No running browser process found."
    exit 0
fi

echo "[stop] Killing Electron process (pid=${pid})..."
kill "$pid" 2>/dev/null || true
sleep 1

# Force kill if still alive
if kill -0 "$pid" 2>/dev/null; then
    echo "[stop] Force killing (pid=${pid})..."
    kill -9 "$pid" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "[stop] Browser stopped."
