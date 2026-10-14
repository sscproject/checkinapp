#!/usr/bin/env bash
# One-command setup for an AWS Lightsail (or EC2) Ubuntu 24.04 server.
# Installs Node.js + Caddy (automatic HTTPS), runs the app as a locked-down service.
# Safe to re-run: it also updates the app to the latest code from GitHub.
#
# Usage (as the default 'ubuntu' user):
#   curl -fsSL https://raw.githubusercontent.com/sscproject/checkinapp/main/deploy/lightsail-setup.sh -o setup.sh
#   sudo ADMIN_PIN='your-long-secret' bash setup.sh
# Optional: DOMAIN=checkin.example.org (a DNS name already pointing at this server's static IP)
set -euo pipefail

REPO="https://github.com/sscproject/checkinapp.git"
APP_DIR=/opt/checkinapp
DATA_DIR=/var/lib/checkinapp
ENV_FILE=/etc/checkinapp.env

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo"; exit 1; }

# Re-runs can reuse the PIN already saved on the server
if [ -z "${ADMIN_PIN:-}" ] && [ -f "$ENV_FILE" ]; then ADMIN_PIN=$(grep '^ADMIN_PIN=' "$ENV_FILE" | cut -d= -f2-); fi
[ -n "${ADMIN_PIN:-}" ] || { echo "Set ADMIN_PIN, e.g.: sudo ADMIN_PIN='long-secret' bash setup.sh"; exit 1; }
[ ${#ADMIN_PIN} -ge 8 ] || { echo "ADMIN_PIN must be at least 8 characters"; exit 1; }

IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
HOSTNAME_PUBLIC="${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
echo ">> Public address will be: https://$HOSTNAME_PUBLIC/"

echo ">> Installing packages (Node.js, Caddy, git)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -q
apt-get install -y -q nodejs caddy git unattended-upgrades
node --version

echo ">> Fetching app code…"
id checkin >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin checkin
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" fetch -q origin && git -C "$APP_DIR" reset -q --hard origin/main
else rm -rf "$APP_DIR"; git clone -q "$REPO" "$APP_DIR"; fi
mkdir -p "$DATA_DIR"
chown -R checkin:checkin "$DATA_DIR"
chmod 700 "$DATA_DIR"

echo ">> Writing config…"
umask 077
cat > "$ENV_FILE" <<CONF
ADMIN_PIN=$ADMIN_PIN
PUBLIC_URL=https://$HOSTNAME_PUBLIC/
TRUST_PROXY=1
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA_DIR
CONF
umask 022

cat > /etc/systemd/system/checkinapp.service <<UNIT
[Unit]
Description=Event check-in app
After=network.target

[Service]
User=checkin
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$HOSTNAME_PUBLIC {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:3000
}
CADDY

systemctl daemon-reload
systemctl enable --now checkinapp
systemctl restart checkinapp
systemctl enable caddy
systemctl restart caddy

echo ">> Checking…"
sleep 3
curl -fsS http://127.0.0.1:3000/health && echo "  app OK"
echo
echo "=============================================================="
echo " Done!  Check-in page:  https://$HOSTNAME_PUBLIC/"
echo "        Admin page:     https://$HOSTNAME_PUBLIC/admin"
echo " (HTTPS certificate can take up to a minute on first visit)"
echo "=============================================================="
