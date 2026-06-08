#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${PIPZO_KIOSK_ENV_FILE:-/etc/pipzo/kiosk.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

PROFILE_PATH="${PIPZO_CHROMIUM_PROFILE:-$HOME/.local/share/pipzo/chromium-profile}"
if [[ "$PROFILE_PATH" != /* ]]; then
  PROFILE_PATH="$HOME/$PROFILE_PATH"
fi

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR
fi

case "$PROFILE_PATH" in
  "$HOME"/.local/share/pipzo/chromium-profile|"$HOME"/.local/share/pipzo/chromium-profile/*)
    ;;
  *)
    echo "Refusing to reset unexpected Chromium profile path: $PROFILE_PATH" >&2
    exit 2
    ;;
esac

systemctl --user stop pipzo-kiosk.service >/dev/null 2>&1 || true
rm -rf -- "$PROFILE_PATH"
mkdir -p "$PROFILE_PATH"
systemctl --user start pipzo-kiosk.service
