#!/usr/bin/env bash
set -euo pipefail

KIOSK_URL="${PIPZO_KIOSK_URL:-http://127.0.0.1:8000/}"
PROFILE_PATH="${PIPZO_CHROMIUM_PROFILE:-$HOME/.local/share/pipzo/chromium-profile}"

if [[ "$PROFILE_PATH" != /* ]]; then
  PROFILE_PATH="$HOME/$PROFILE_PATH"
fi

find_chromium() {
  local candidate
  for candidate in chromium-browser chromium; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

CHROMIUM_BIN="$(find_chromium)" || {
  echo "Pipzo kiosk requires chromium-browser or chromium in PATH." >&2
  exit 1
}

mkdir -p "$PROFILE_PATH"

exec "$CHROMIUM_BIN" \
  --kiosk "$KIOSK_URL" \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --user-data-dir="$PROFILE_PATH"
