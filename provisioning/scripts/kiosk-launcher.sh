#!/usr/bin/env bash
set -euo pipefail

KIOSK_URL="${PIPZO_KIOSK_URL:-http://127.0.0.1:8000/}"
PROFILE_PATH="${PIPZO_CHROMIUM_PROFILE:-$HOME/.local/share/pipzo/chromium-profile}"
CHROMIUM_MODE="${PIPZO_CHROMIUM_MODE:-app-maximized}"

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

COMMON_FLAGS=(
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
)

case "$CHROMIUM_MODE" in
  app-maximized)
    exec "$CHROMIUM_BIN" \
      --app="$KIOSK_URL" \
      --start-maximized \
      "${COMMON_FLAGS[@]}"
    ;;
  kiosk)
    exec "$CHROMIUM_BIN" \
      --kiosk "$KIOSK_URL" \
      "${COMMON_FLAGS[@]}"
    ;;
  *)
    echo "Unsupported PIPZO_CHROMIUM_MODE '$CHROMIUM_MODE'. Use app-maximized or kiosk." >&2
    exit 2
    ;;
esac
