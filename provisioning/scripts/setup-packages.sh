#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "setup-packages.sh is intended for Raspberry Pi OS or another Debian-family Linux host." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get was not found; install packages manually for this platform." >&2
  exit 1
fi

SUDO_CMD=()
if [[ "${EUID}" -ne 0 ]]; then
  SUDO_CMD=(sudo)
fi

"${SUDO_CMD[@]}" apt-get update
"${SUDO_CMD[@]}" apt-get install -y \
  bluez \
  ca-certificates \
  curl \
  git \
  network-manager \
  polkitd \
  rsync \
  python3 \
  python3-pip \
  python3-venv \
  nodejs \
  npm \
  xdg-utils

if apt-cache show pi-bluetooth >/dev/null 2>&1; then
  "${SUDO_CMD[@]}" apt-get install -y pi-bluetooth
fi

if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  if apt-cache show chromium-browser >/dev/null 2>&1; then
    "${SUDO_CMD[@]}" apt-get install -y chromium-browser
  elif apt-cache show chromium >/dev/null 2>&1; then
    "${SUDO_CMD[@]}" apt-get install -y chromium
  else
    echo "Chromium package was not found by apt; install Raspberry Pi OS Desktop Chromium before enabling kiosk." >&2
  fi
fi
