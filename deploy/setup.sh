#!/usr/bin/env bash
# HaxBall bot — one-shot setup for Ubuntu 22.04 / 24.04
#
# Usage:
#   sudo bash deploy/setup.sh [REPO_URL] [HAXBALL_TOKEN]
#
# Example:
#   sudo bash deploy/setup.sh https://github.com/hhhhhh75/haxbot.git thr1.xxxxx.xxxxx
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
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

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
npm install --omit=dev

echo "==> Writing ${ENV_FILE}"
if [ -z "$TOKEN" ]; then
  echo "WARNING: no token passed. Edit ${ENV_FILE} and set HAXBALL_TOKEN." >&2
fi
cat > "$ENV_FILE" <<EOF
HAXBALL_TOKEN=${TOKEN}
# Room geolocation (remove these lines to leave it unset)
GEO_CODE=MA
GEO_LAT=33.5731
GEO_LON=-7.5898
EOF
chmod 600 "$ENV_FILE"

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
ExecStart=/usr/bin/node run.js
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
