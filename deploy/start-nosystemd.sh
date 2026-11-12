#!/usr/bin/env bash
# Start the HaxBall bot without systemd (containers, sandboxes, WSL).
#
# Usage:
#   sudo bash deploy/start-nosystemd.sh         # start or restart
#   sudo bash deploy/start-nosystemd.sh stop    # stop
#
# It runs a tiny supervisor loop: if node exits, it restarts after 15 seconds.
# Logs: /var/log/haxbot.log (or $LOG)
#
# Note: nothing restarts this after a reboot of the machine — for a real VPS
# use the systemd path in deploy/setup.sh instead.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/haxbot}"
ENV_FILE="${ENV_FILE:-/etc/haxbot.env}"
LOG="${LOG:-/var/log/haxbot.log}"
PID_FILE="${PID_FILE:-/tmp/haxbot-supervisor.pid}"

stop_bot() {
  pkill -f "haxbot-supervisor" 2>/dev/null || true
  pkill -f "node run.js" 2>/dev/null || true
  rm -f "$PID_FILE"
}

if [ "${1:-start}" = "stop" ]; then
  stop_bot
  echo "Bot stopped."
  exit 0
fi

if [ ! -f "$APP_DIR/run.js" ]; then
  echo "ERROR: ${APP_DIR}/run.js not found." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found (token file)." >&2
  exit 1
fi

NODE_BIN=/usr/bin/node
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || echo /usr/bin/node)"
if [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH." >&2
  exit 1
fi

stop_bot
sleep 1

# Load HAXBALL_TOKEN / GEO_* / CHROME_PATH.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

mkdir -p "$(dirname "$LOG")"
cd "$APP_DIR"

echo "==> Starting the bot in the background (log: ${LOG})"
export PATH="$(dirname "$NODE_BIN"):$PATH"
nohup bash -c 'while true; do node run.js; echo "[supervisor] node exited, restarting in 15s"; sleep 15; done' haxbot-supervisor >> "$LOG" 2>&1 &
echo $! > "$PID_FILE"

sleep 2
echo "==> Running (pid $(cat "$PID_FILE")). First lines of the log:"
tail -n 15 "$LOG" || true
