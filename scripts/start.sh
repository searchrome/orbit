#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CDP_PORT:-9222}"

echo "[start] Launching browser with CDP on port $PORT..."
exec "$ROOT_DIR/scripts/electron-launcher.sh" start --port "$PORT" "$@"
