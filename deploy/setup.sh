#!/usr/bin/env bash
# HaxBall bot — one-shot setup for Ubuntu 22.04 / 24.04
#
# Usage:
#   sudo bash deploy/setup.sh [REPO_URL] [HAXBALL_TOKEN] [GEO_CODE]
#
# Example:
#   sudo bash deploy/setup.sh https://github.com/hhhhhh75/haxbot.git thr1.xxxxx.xxxxx ES
#
# GEO_CODE is the country the room is advertised in: MA (Casablanca, default)
# or ES (Madrid). Pass "none" to leave it unset.
#
# What it does:
#   - installs Node.js 20 + Chromium runtime libraries
#   - clones (or updates) the repository in /opt/haxbot
#   - installs npm dependencies (downloads Chromium for Puppeteer)
#   - writes /etc/haxbot.env (token + geo) with 600 permissions
#   - installs and starts a systemd service that restarts on crash/reboot

set -euo pipefail

REPO_URL="${1:-https://github.com/hhhhhh75/haxbot.git}"
TOKEN="${2:-}"
GEO_CODE_ARG="$(echo "${3:-MA}" | tr '[:lower:]' '[:upper:]')"

# Room geolocation: the country the room is listed in, with that region's
# approximate coordinates.
case "$GEO_CODE_ARG" in
  MA) GEO_CODE=MA; GEO_LAT=33.5731;  GEO_LON=-7.5898 ;;
  ES) GEO_CODE=ES; GEO_LAT=40.4168;  GEO_LON=-3.7038 ;;
  NONE|"") GEO_CODE=""; GEO_LAT=""; GEO_LON="" ;;
  *) GEO_CODE="$GEO_CODE_ARG"; GEO_LAT=""; GEO_LON="" ;;
esac

APP_DIR="${APP_DIR:-/opt/haxbot}"
ENV_FILE="/etc/haxbot.env"
SERVICE="haxbot"
NODE_MAJOR="${NODE_MAJOR:-20}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root (sudo bash deploy/setup.sh ...)" >&2
  exit 1
fi

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git gnupg

echo "==> Installing Node.js ${NODE_MAJOR}"
# Puppeteer 21 and its dependencies break on much newer Node majors
# ("require is not defined in ES module scope" with Node 26), so pin the exact
# major instead of only checking a minimum.
NEED_NODE=1
if [ -x /usr/bin/node ]; then
  CUR_MAJOR="$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$CUR_MAJOR" = "$NODE_MAJOR" ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  if [ -x /usr/bin/node ]; then
    echo "    found Node $(/usr/bin/node --version 2>/dev/null || echo unknown) -> replacing with ${NODE_MAJOR}.x"
  fi
  apt-get remove -y nodejs npm >/dev/null 2>&1 || true
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

NODE_BIN=/usr/bin/node
NPM_BIN=/usr/bin/npm
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
"$NODE_BIN" --version

# Run npm through the pinned node binary: /usr/bin/npm has a
# "#!/usr/bin/env node" shebang and would otherwise pick up another Node
# (for example an nvm install) from PATH.
if [ -f /usr/lib/node_modules/npm/bin/npm-cli.js ]; then
  NPM_CMD=("$NODE_BIN" /usr/lib/node_modules/npm/bin/npm-cli.js)
else
  NPM_CMD=("$NPM_BIN")
fi
"${NPM_CMD[@]}" --version

echo "==> Installing Chromium runtime libraries"
# Package names differ between Ubuntu 22.04 and 24.04 (t64 transition),
# so install what exists on this release.
PKGS="libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0
libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0
libcairo2 libx11-6 libxcb1 libxext6 libxi6 libxrender1 libxtst6 libglib2.0-0
libdbus-1-3 libexpat1 libfontconfig1 fonts-liberation"
INSTALL_PKGS=""
for p in $PKGS; do
  if apt-cache show "${p}t64" >/dev/null 2>&1; then
    INSTALL_PKGS="$INSTALL_PKGS ${p}t64"
  else
    INSTALL_PKGS="$INSTALL_PKGS $p"
  fi
done
apt-get install -y $INSTALL_PKGS

echo "==> Fetching the bot code in ${APP_DIR}"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard origin/main
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Installing npm dependencies (this downloads Chromium, be patient)"
cd "$APP_DIR"
CHROME_PATH_LINE="# CHROME_PATH=/usr/bin/chromium"
case "$(uname -m)" in
  aarch64|arm64)
    # Chrome for Testing has no linux-arm64 build, so Puppeteer cannot download
    # a browser here: use the distribution Chromium (snap) instead.
    echo "    ARM detected -> using the system Chromium"
    apt-get install -y snapd || true
    snap install chromium || true
    export PUPPETEER_SKIP_DOWNLOAD=1
    CHROME_PATH_LINE="CHROME_PATH=/snap/bin/chromium"
    ;;
esac
"${NPM_CMD[@]}" install --omit=dev

# Newer npm versions can refuse to run package install scripts, in which case
# Puppeteer never downloads its browser. Detect that and fetch it explicitly.
BROWSER_FOUND=""
for c in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "$c" >/dev/null 2>&1; then
    BROWSER_FOUND="$(command -v "$c")"
    break
  fi
done
if [ -n "$BROWSER_FOUND" ]; then
  echo "==> Using the system browser: ${BROWSER_FOUND}"
  CHROME_PATH_LINE="CHROME_PATH=${BROWSER_FOUND}"
else
  echo "==> Downloading the Puppeteer browser (npm may have skipped it)"
  if [ -f node_modules/puppeteer/install.mjs ]; then
    "$NODE_BIN" node_modules/puppeteer/install.mjs || true
  else
    echo "    WARNING: install.mjs missing, install a browser manually:" >&2
    echo "    cd ${APP_DIR} && ${NODE_BIN} -e \"require('puppeteer/install.mjs')\"" >&2
  fi
  ls -1 "${HOME}/.cache/puppeteer" 2>/dev/null || true
  CHROME_PATH_LINE="# CHROME_PATH=/usr/bin/chromium"
fi

echo "==> Writing ${ENV_FILE}"
if [ -z "$TOKEN" ]; then
  echo "WARNING: no token passed. Edit ${ENV_FILE} and set HAXBALL_TOKEN." >&2
fi
cat > "$ENV_FILE" <<EOF
HAXBALL_TOKEN=${TOKEN}
${CHROME_PATH_LINE}
# Room geolocation (${GEO_CODE_ARG}). Delete these lines to leave it unset.
GEO_CODE=${GEO_CODE}
GEO_LAT=${GEO_LAT}
GEO_LON=${GEO_LON}
EOF
chmod 600 "$ENV_FILE"

if [ "$(ps -p 1 -o comm= 2>/dev/null || echo unknown)" != "systemd" ]; then
  echo "==> No systemd here (container / sandbox). Using the plain supervisor instead."
  bash "${APP_DIR}/deploy/start-nosystemd.sh"
  echo
  echo "Done."
  echo "  tail -f /var/log/haxbot.log      # live logs"
  echo "  bash ${APP_DIR}/deploy/start-nosystemd.sh        # restart"
  echo "  bash ${APP_DIR}/deploy/start-nosystemd.sh stop   # stop"
  exit 0
fi

echo "==> Installing systemd service ${SERVICE}"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=HaxBall headless bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} run.js
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE}"
systemctl restart "${SERVICE}"

echo "==> Waiting 8s, then showing the first logs"
sleep 8
journalctl -u "${SERVICE}" -n 40 --no-pager || true

echo
echo "Done. Useful commands:"
echo "  journalctl -u ${SERVICE} -f          # live logs"
echo "  systemctl restart ${SERVICE}          # restart the bot"
echo "  nano ${ENV_FILE}                      # change token / geo"
