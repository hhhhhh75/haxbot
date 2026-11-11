#!/usr/bin/env bash
# HaxBall bot — optional remote desktop (RDP) for the VPS
#
# Usage:
#   sudo bash deploy/setup-rdp.sh [USERNAME] [PASSWORD]
#
# Example:
#   sudo bash deploy/setup-rdp.sh hax 'MotDePasseSolide123'
#
# What it does:
#   - installs XFCE (light desktop) + xrdp
#   - creates the user if it does not exist, with the given password
#   - makes XFCE the default session of that user
#   - opens port 3389 (if ufw is active) and starts xrdp at boot
#
# After that, from Windows: Win+R -> mstsc -> <SERVER_IP>:3389
# Login with the username / password you passed above.
#
# Note: RDP needs a desktop, so it costs ~400-600 MB of RAM. The bot itself
# stays headless (no desktop needed to run it).

set -euo pipefail

USER_NAME="${1:-hax}"
USER_PASS="${2:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root (sudo bash deploy/setup-rdp.sh ...)" >&2
  exit 1
fi

echo "==> Installing XFCE and xrdp"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  xfce4 xfce4-terminal dbus-x11 x11-xserver-utils \
  xrdp xorgxrdp net-tools

echo "==> Preparing user '${USER_NAME}'"
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  if [ -z "$USER_PASS" ]; then
    echo "ERROR: user '${USER_NAME}' does not exist, pass a password as 2nd argument." >&2
    exit 1
  fi
  adduser --gecos "" --disabled-password "$USER_NAME"
  echo "${USER_NAME}:${USER_PASS}" | chpasswd
  echo "    user created"
else
  if [ -n "$USER_PASS" ]; then
    echo "${USER_NAME}:${USER_PASS}" | chpasswd
    echo "    password updated"
  fi
fi

HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"

echo "==> Setting XFCE as the default session"
echo "xfce4-session" > "${HOME_DIR}/.xsession"
chown "${USER_NAME}:${USER_NAME}" "${HOME_DIR}/.xsession"
chmod 644 "${HOME_DIR}/.xsession"

# xrdp reads its own key/cert; the user needs ssl-cert group for clean access.
usermod -aG ssl-cert "$USER_NAME" || true

echo "==> Tuning xrdp for XFCE"
if ! grep -q "^allow_channels" /etc/xrdp/xrdp.ini 2>/dev/null; then
  cat >> /etc/xrdp/xrdp.ini <<'EOF'

[Globals]
; --- added by setup-rdp.sh ---
bitmap_cache=true
bitmap_compression=true
EOF
fi

# Avoid the "black screen" bug on Ubuntu 22.04/24.04
if [ -f /etc/xrdp/startwm.sh ]; then
  if ! grep -q "unset DBUS_SESSION_BUS_ADDRESS" /etc/xrdp/startwm.sh; then
    sed -i '/^test -x \/etc\/X11\/Xsession/i unset DBUS_SESSION_BUS_ADDRESS\nunset XDG_RUNTIME_DIR' /etc/xrdp/startwm.sh || true
  fi
fi

echo "==> Enabling the service"
systemctl enable xrdp
systemctl restart xrdp

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Opening port 3389 in ufw"
  ufw allow 3389/tcp
fi

IP="$(hostname -I | awk '{print $1}')"

echo
echo "RDP is ready."
echo "  Address  : ${IP}:3389"
echo "  Username : ${USER_NAME}"
echo "  Password : (the one you passed)"
echo
echo "From Windows: Win+R -> mstsc -> ${IP}:3389"
echo "Useful commands:"
echo "  systemctl status xrdp     # service state"
echo "  tail -f /var/log/xrdp.log  # connection log"
