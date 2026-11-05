#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-9222}"
WAIT_SECONDS="${WAIT_SECONDS:-45}"
PID_FILE="${PID_FILE:-$ROOT_DIR/.tmp/electron-launcher.pid}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/.tmp/electron-launcher.log}"
FORCE=0

usage() {
  cat <<'EOF'
Usage:
  scripts/electron-launcher.sh start [--port N] [--wait SEC] [--pid-file PATH] [--log-file PATH] [--force]
  scripts/electron-launcher.sh stop [--pid-file PATH]
  scripts/electron-launcher.sh status [--pid-file PATH] [--port N]

Behavior:
  - start: launches Electron in background and waits for CDP endpoint readiness
  - stop: stops the background Electron process tracked by pid file
  - status: prints whether launcher process and CDP endpoint are up

Examples:
  scripts/electron-launcher.sh start --port 9222
  scripts/electron-launcher.sh status
  scripts/electron-launcher.sh stop
EOF
}

endpoint() {
  echo "http://127.0.0.1:${PORT}/json/list"
}

read_env_value() {
  local key="$1"
  local env_file="$ROOT_DIR/.env"

  if [[ ! -f "$env_file" ]]; then
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" != *=* ]] && continue

    local current_key="${line%%=*}"
    local current_value="${line#*=}"
    current_key="$(printf '%s' "$current_key" | sed 's/[[:space:]]*$//')"
    current_value="$(printf '%s' "$current_value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    current_value="${current_value%\"}"
    current_value="${current_value#\"}"
    current_value="${current_value%\'}"
    current_value="${current_value#\'}"

    if [[ "$current_key" == "$key" ]]; then
      printf '%s\n' "$current_value"
      return 0
    fi
  done < "$env_file"

  return 1
}

print_ai_backend_summary() {
  local llm_backend codex_model claude_model openrouter_model
  llm_backend="$(read_env_value "LLM" || true)"
  llm_backend="$(printf '%s' "$llm_backend" | tr '[:upper:]' '[:lower:]')"

  case "$llm_backend" in
    codex)
      codex_model="$(read_env_value "CODEX_MODEL" || true)"
      if [[ -n "$codex_model" ]]; then
        echo "[start] AI backend: codex-cli ($codex_model)"
      else
        echo "[start] AI backend: codex-cli"
      fi
      ;;
    claude)
      claude_model="$(read_env_value "CLAUDE_MODEL" || true)"
      if [[ -n "$claude_model" ]]; then
        echo "[start] AI backend: claude-cli ($claude_model)"
      else
        echo "[start] AI backend: claude-cli"
      fi
      ;;
    claude-haiku)
      claude_model="$(read_env_value "CLAUDE_HAIKU_MODEL" || true)"
      echo "[start] AI backend: claude-haiku-cli (${claude_model:-claude-haiku-5-5})"
      ;;
    openrouter|"")
      openrouter_model="$(read_env_value "OPENROUTER_MODEL" || true)"
      if [[ -n "$openrouter_model" ]]; then
        echo "[start] AI backend: openrouter ($openrouter_model)"
      else
        echo "[start] AI backend: openrouter"
      fi
      ;;
    *)
      echo "[start] AI backend: ${llm_backend}"
      ;;
  esac
}

find_pid_by_port_arg() {
  pgrep -af "(Electron|Orbit).*--remote-debugging-port=${PORT}" | awk '{print $1}' | head -n1
}

is_cdp_ready() {
  curl -fsS --max-time 2 "$(endpoint)" >/dev/null 2>&1
}

parse_common_flags() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        PORT="$2"
        shift 2
        ;;
      --wait)
        WAIT_SECONDS="$2"
        shift 2
        ;;
      --pid-file)
        PID_FILE="$2"
        shift 2
        ;;
      --log-file)
        LOG_FILE="$2"
        shift 2
        ;;
      --force)
        FORCE=1
        shift
        ;;
      *)
        echo "Unknown flag: $1" >&2
        usage
        exit 2
        ;;
    esac
  done
}

ensure_gui_context_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi

  if pgrep -x -U "$UID" Dock >/dev/null 2>&1; then
    return 0
  fi

  echo "No Dock process found for uid ${UID}. This usually means no active GUI login session." >&2
  echo "Electron may abort at startup in this context (HIServices / NSApplication init)." >&2

  if [[ "$FORCE" -eq 1 ]]; then
    echo "Continuing due to --force." >&2
    return 0
  fi

  echo "Refusing to start. Re-run in an interactive macOS user session or pass --force." >&2
  exit 3
}

running_pid_from_file() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "$pid"
    return 0
  fi

  # Fallback: when launched through macOS "open", pid tracking may drift.
  local discovered
  discovered="$(find_pid_by_port_arg || true)"
  if [[ -n "${discovered}" ]] && kill -0 "$discovered" >/dev/null 2>&1; then
    echo "$discovered" >"$PID_FILE"
    echo "$discovered"
    return 0
  fi

  return 1
}

start_cmd() {
  parse_common_flags "$@"
  print_ai_backend_summary
  ensure_gui_context_macos

  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

  if [[ ! -x "$ROOT_DIR/node_modules/.bin/electron" ]]; then
    echo "Electron binary not found at node_modules/.bin/electron" >&2
    echo "Run: npm install" >&2
    exit 4
  fi

  local existing_pid
  if existing_pid="$(running_pid_from_file)"; then
    if is_cdp_ready; then
      echo "Launcher already running (pid=${existing_pid}), CDP ready at $(endpoint)"
      echo "[start] Assistant runtime log: $ROOT_DIR/.tmp/assistant-runtime.log"
      exit 0
    fi
    echo "Found stale running pid ${existing_pid} without CDP readiness. Stopping it first." >&2
    kill "$existing_pid" >/dev/null 2>&1 || true
    sleep 1
  fi

  : >"$LOG_FILE"
  local pid=""

  if [[ "$(uname -s)" == "Darwin" ]]; then
    local app_path="$ROOT_DIR/node_modules/electron/dist/Electron.app"
    if [[ ! -d "$app_path" ]]; then
      echo "Electron app bundle not found at $app_path" >&2
      exit 4
    fi

    # A packaged app can be reopened from the Dock without a project argument.
    if [[ -d "/Applications/Orbit.app" ]]; then
      app_path="/Applications/Orbit.app"
      open -na "$app_path" --args "--remote-debugging-port=${PORT}" >>"$LOG_FILE" 2>&1
    elif [[ -d "$ROOT_DIR/dist/Orbit-darwin-$(uname -m)/Orbit.app" ]]; then
      app_path="$ROOT_DIR/dist/Orbit-darwin-$(uname -m)/Orbit.app"
      open -na "$app_path" --args "--remote-debugging-port=${PORT}" >>"$LOG_FILE" 2>&1
    else
      # Development fallback; the standalone Orbit.app is the normal launcher.
      open -na "$app_path" --args "$ROOT_DIR" "--remote-debugging-port=${PORT}" >>"$LOG_FILE" 2>&1
    fi

    # Discover the spawned Electron pid by remote-debugging arg.
    local j
    for ((j = 1; j <= 10; j++)); do
      pid="$(find_pid_by_port_arg || true)"
      if [[ -n "$pid" ]]; then
        break
      fi
      sleep 1
    done
  else
    nohup "$ROOT_DIR/node_modules/.bin/electron" "$ROOT_DIR" "--remote-debugging-port=${PORT}" >>"$LOG_FILE" 2>&1 &
    pid=$!
  fi

  if [[ -n "$pid" ]]; then
    echo "$pid" >"$PID_FILE"
    echo "Started Electron (pid=${pid}), waiting for CDP at $(endpoint)"
  else
    rm -f "$PID_FILE"
    echo "Started Electron, waiting for CDP at $(endpoint)"
  fi
  echo "[start] Assistant runtime log: $ROOT_DIR/.tmp/assistant-runtime.log"

  local i
  for ((i = 1; i <= WAIT_SECONDS; i++)); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "Electron exited before CDP became ready. Last log lines:" >&2
      tail -n 80 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      exit 5
    fi

    if is_cdp_ready; then
      echo "CDP ready at $(endpoint)"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for CDP readiness after ${WAIT_SECONDS}s. Last log lines:" >&2
  tail -n 80 "$LOG_FILE" >&2 || true
  exit 6
}

stop_cmd() {
  parse_common_flags "$@"

  local pid
  if ! pid="$(running_pid_from_file)"; then
    echo "No running launcher process found."
    rm -f "$PID_FILE"
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  echo "Stopped Electron launcher process (pid=${pid})."
}

status_cmd() {
  parse_common_flags "$@"

  local pid
  if pid="$(running_pid_from_file)"; then
    echo "Process: running (pid=${pid})"
  else
    echo "Process: not running"
  fi

  if is_cdp_ready; then
    echo "CDP: ready ($(endpoint))"
  else
    echo "CDP: not ready ($(endpoint))"
  fi
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 2
  fi

  local cmd="$1"
  shift || true

  case "$cmd" in
    start)
      start_cmd "$@"
      ;;
    stop)
      stop_cmd "$@"
      ;;
    status)
      status_cmd "$@"
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 2
      ;;
  esac
}

main "$@"
