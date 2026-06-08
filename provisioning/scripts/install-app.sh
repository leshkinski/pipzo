#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/pipzo/app"
VENV_DIR="/opt/pipzo/venv"
SERVICE_USER=""
KIOSK_USER="${SUDO_USER:-${USER}}"
ENV_DIR="/etc/pipzo"
STATE_DIR="/var/lib/pipzo"
ENABLE_SERVICES="yes"

usage() {
  cat <<'USAGE'
Usage: provisioning/scripts/install-app.sh [options]

Options:
  --app-dir PATH        Installed app checkout path. Default: /opt/pipzo/app
  --venv-dir PATH       Python virtualenv path. Default: /opt/pipzo/venv
  --service-user USER   Backend service user. Default: kiosk user
  --kiosk-user USER     Desktop user that runs Chromium. Default: invoking sudo user
  --no-enable           Install artifacts without enabling/restarting services
  -h, --help            Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --venv-dir) VENV_DIR="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --kiosk-user) KIOSK_USER="$2"; shift 2 ;;
    --no-enable) ENABLE_SERVICES="no"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install-app.sh installs systemd artifacts and is intended for Raspberry Pi OS or another Linux host." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run install-app.sh with sudo so it can write /opt, /etc, /usr/local/bin, and systemd unit paths." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found; this installer expects systemd." >&2
  exit 1
fi

if ! id "$KIOSK_USER" >/dev/null 2>&1; then
  echo "Kiosk user '$KIOSK_USER' does not exist." >&2
  exit 1
fi

if [[ -z "$SERVICE_USER" ]]; then
  SERVICE_USER="$KIOSK_USER"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COPIED_APP="no"
BUILD_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

if getent group bluetooth >/dev/null 2>&1; then
  usermod -a -G bluetooth "$SERVICE_USER"
fi

install -d -m 0755 "$(dirname "$APP_DIR")"
if [[ "$REPO_ROOT" != "$APP_DIR" ]]; then
  install -d -m 0755 "$APP_DIR"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude '.venv/' \
    --exclude 'data/' \
    --exclude 'frontend/node_modules/' \
    --exclude 'frontend/dist/' \
    "$REPO_ROOT/" "$APP_DIR/"
  COPIED_APP="yes"
fi

install -d -m 0755 "$ENV_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 0755 "$VENV_DIR"

if [[ ! -f "$ENV_DIR/pipzo.env" ]]; then
  sed \
    -e "s|PIPZO_FRONTEND_DIST=/opt/pipzo/app/frontend/dist|PIPZO_FRONTEND_DIST=$APP_DIR/frontend/dist|" \
    -e "s|PIPZO_AUDIO_USER=|PIPZO_AUDIO_USER=$KIOSK_USER|" \
    "$APP_DIR/provisioning/env/pipzo.env.example" > /tmp/pipzo.env
  install -m 0640 -o root -g "$SERVICE_GROUP" /tmp/pipzo.env "$ENV_DIR/pipzo.env"
  rm -f /tmp/pipzo.env
else
  chown root:"$SERVICE_GROUP" "$ENV_DIR/pipzo.env"
  chmod 0640 "$ENV_DIR/pipzo.env"
fi
if ! grep -q '^PIPZO_KIOSK_BROWSER_SESSION_RESET_COMMAND=' "$ENV_DIR/pipzo.env"; then
  printf '\n# Fixed helper for Settings -> Spotify account switching Chromium profile reset.\nPIPZO_KIOSK_BROWSER_SESSION_RESET_COMMAND=/usr/local/bin/pipzo-reset-kiosk-browser-session\n' >> "$ENV_DIR/pipzo.env"
fi

if [[ ! -f "$ENV_DIR/kiosk.env" ]]; then
  sed \
    -e "s|PIPZO_CHROMIUM_EXTENSION_DIR=/opt/pipzo/app/provisioning/chromium-extension/virtual-keyboard|PIPZO_CHROMIUM_EXTENSION_DIR=$APP_DIR/provisioning/chromium-extension/virtual-keyboard|" \
    "$APP_DIR/provisioning/env/pipzo-kiosk.env.example" > /tmp/pipzo-kiosk.env
  install -m 0644 /tmp/pipzo-kiosk.env "$ENV_DIR/kiosk.env"
  rm -f /tmp/pipzo-kiosk.env
elif grep -q '^PIPZO_CHROMIUM_MODE=app-maximized$' "$ENV_DIR/kiosk.env"; then
  echo "Existing $ENV_DIR/kiosk.env keeps diagnostic PIPZO_CHROMIUM_MODE=app-maximized." >&2
  echo "For the V1 product runtime, set PIPZO_CHROMIUM_MODE=kiosk and restart pipzo-kiosk.service." >&2
fi
if ! grep -q '^PIPZO_CHROMIUM_EXTENSION_DIR=' "$ENV_DIR/kiosk.env"; then
  printf '\n# First-party local extension keyboard and Spotify session reset helper for true-kiosk setup input.\nPIPZO_CHROMIUM_EXTENSION_DIR=%s/provisioning/chromium-extension/virtual-keyboard\n' "$APP_DIR" >> "$ENV_DIR/kiosk.env"
fi

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -e "$APP_DIR"

if [[ -f "$APP_DIR/frontend/package-lock.json" ]]; then
  npm --prefix "$APP_DIR/frontend" ci
else
  npm --prefix "$APP_DIR/frontend" install
fi
VITE_PIPZO_BUILD_COMMIT="$BUILD_COMMIT" npm --prefix "$APP_DIR/frontend" run build

if [[ "$COPIED_APP" == "yes" || "$APP_DIR" == /opt/pipzo/* ]]; then
  chown -R root:root "$APP_DIR"
fi
chown -R root:root "$VENV_DIR"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$STATE_DIR"

install -m 0755 "$APP_DIR/provisioning/scripts/kiosk-launcher.sh" /usr/local/bin/pipzo-kiosk
install -m 0755 "$APP_DIR/provisioning/scripts/reset-kiosk-browser-session.sh" /usr/local/bin/pipzo-reset-kiosk-browser-session
if [[ -d /etc/polkit-1/rules.d ]]; then
  sed "s|__PIPZO_SERVICE_USER__|$SERVICE_USER|g" \
    "$APP_DIR/provisioning/polkit/50-pipzo-networkmanager.rules" > /tmp/50-pipzo-networkmanager.rules
  install -m 0644 -o root -g root /tmp/50-pipzo-networkmanager.rules /etc/polkit-1/rules.d/50-pipzo-networkmanager.rules
  rm -f /tmp/50-pipzo-networkmanager.rules
  sed "s|__PIPZO_SERVICE_USER__|$SERVICE_USER|g" \
    "$APP_DIR/provisioning/polkit/50-pipzo-power.rules" > /tmp/50-pipzo-power.rules
  install -m 0644 -o root -g root /tmp/50-pipzo-power.rules /etc/polkit-1/rules.d/50-pipzo-power.rules
  rm -f /tmp/50-pipzo-power.rules
else
  echo "polkit rules directory not found; hardware Wi-Fi and power actions may require manual permissions for $SERVICE_USER." >&2
fi
sed \
  -e "s|User=pipzo|User=$SERVICE_USER|" \
  -e "s|Group=pipzo|Group=$SERVICE_GROUP|" \
  -e "s|/opt/pipzo/app|$APP_DIR|g" \
  -e "s|/opt/pipzo/venv|$VENV_DIR|g" \
  "$APP_DIR/provisioning/systemd/pipzo-backend.service" > /tmp/pipzo-backend.service
install -m 0644 /tmp/pipzo-backend.service /etc/systemd/system/pipzo-backend.service
rm -f /tmp/pipzo-backend.service

KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
install -d -m 0755 -o "$KIOSK_USER" -g "$KIOSK_USER" "$KIOSK_HOME/.config/systemd/user"
install -m 0644 -o "$KIOSK_USER" -g "$KIOSK_USER" "$APP_DIR/provisioning/systemd/pipzo-kiosk.service" "$KIOSK_HOME/.config/systemd/user/pipzo-kiosk.service"

systemctl daemon-reload

if [[ "$ENABLE_SERVICES" == "yes" ]]; then
  systemctl enable --now pipzo-backend.service
  loginctl enable-linger "$KIOSK_USER" || true
  USER_ID="$(id -u "$KIOSK_USER")"
  if [[ -d "/run/user/$USER_ID" ]]; then
    runuser -u "$KIOSK_USER" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" systemctl --user daemon-reload
    runuser -u "$KIOSK_USER" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" systemctl --user enable --now pipzo-kiosk.service
  else
    echo "Installed kiosk user unit, but /run/user/$USER_ID is not active. Log in as $KIOSK_USER and run:" >&2
    echo "  systemctl --user daemon-reload && systemctl --user enable --now pipzo-kiosk.service" >&2
  fi
fi

echo "Pipzo install complete."
echo "Edit $ENV_DIR/pipzo.env to set SPOTIFY_CLIENT_ID before Spotify setup."
