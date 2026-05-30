# Raspberry Pi Provisioning

These artifacts are the first repeatable provisioning and kiosk supervision slice for Raspberry Pi OS Desktop on Raspberry Pi 5 with Raspberry Pi Touch Display 2.

They are safe to review on non-Pi development machines. The install scripts intentionally stop unless run on Linux with the expected tools.

## Runtime Contract

- App checkout: `/opt/pipzo/app`
- Python virtualenv: `/opt/pipzo/venv`
- Backend service user: `pipzo`
- Kiosk desktop user: the invoking sudo user by default, or `--kiosk-user USER`
- Backend environment file: `/etc/pipzo/pipzo.env`
- Kiosk environment file: `/etc/pipzo/kiosk.env`
- SQLite DB: `/var/lib/pipzo/pipzo.sqlite3`
- Spotify token key: `/var/lib/pipzo/spotify-token.key`
- Backend URL and kiosk URL: `http://127.0.0.1:8000/`
- Backend systemd service: `pipzo-backend.service`
- Kiosk user systemd service: `pipzo-kiosk.service`

Generated DB/key files stay outside the repo in `/var/lib/pipzo` on the Pi and remain ignored by Git for local development.

## Install From A Clone

On Raspberry Pi OS Desktop:

```bash
git clone https://github.com/leshkinski/pipzo.git
cd pipzo
sudo provisioning/scripts/setup-packages.sh
sudo provisioning/scripts/install-app.sh --kiosk-user "$USER"
sudoedit /etc/pipzo/pipzo.env
sudo systemctl restart pipzo-backend.service
systemctl --user restart pipzo-kiosk.service
```

Set `SPOTIFY_CLIENT_ID` in `/etc/pipzo/pipzo.env`. Do not add Spotify client secrets; Pipzo uses Authorization Code with PKCE.

The installer copies the checkout to `/opt/pipzo/app`, creates or updates `/opt/pipzo/venv`, installs the backend package, runs `npm ci`, builds the frontend into `/opt/pipzo/app/frontend/dist`, installs systemd units, and enables the backend service. It enables the kiosk user service when the target user's user-systemd runtime is active; otherwise it prints the exact `systemctl --user` command to run after logging in as that user.

`setup-packages.sh` installs NetworkManager, polkit, BlueZ, and Raspberry Pi OS labwc on-screen keyboard packages when apt exposes them. On Raspberry Pi OS it also installs `pi-bluetooth` when that package is available. `install-app.sh` installs `/etc/polkit-1/rules.d/50-pipzo-networkmanager.rules` so the backend service user can run the bounded Wi-Fi setup operations through `nmcli` without an interactive desktop authorization prompt. It also adds the backend service user to the `bluetooth` group when the group exists, so BlueZ/bluetoothctl speaker operations have the normal Raspberry Pi OS Bluetooth access path.

If the polkit rules directory is missing on a nonstandard image, hardware Wi-Fi actions will report unavailable or permission failures until equivalent NetworkManager permissions are added manually. If `bluetoothctl` is missing, Bluetooth is disabled, the backend user lacks BlueZ access, or the speaker rejects pairing/connection, hardware Bluetooth actions report unavailable or failed contract states rather than simulated success.

Unified volume control uses Spotify Web API volume updates plus the local desktop audio sink when available. On Raspberry Pi OS Desktop Bookworm, Pipzo expects the existing PipeWire/WirePlumber stack and prefers `wpctl`; it falls back to `pactl` if `wpctl` is unavailable. If neither command exists, the default sink is missing, or the service user cannot access the user audio session, hardware volume actions report partial or unavailable states instead of simulated success. Do not install the legacy `pulseaudio` server alongside PipeWire for Pipzo; use the OS Desktop audio stack or validate a nonstandard audio stack separately.

Wi-Fi internet reachability uses `PIPZO_INTERNET_PROBE_URL`, defaulting to `https://www.google.com/generate_204`. Change this in `/etc/pipzo/pipzo.env` if the deployment network blocks that endpoint. Network settings shows the active Wi-Fi IPv4 address when available so the Pi can be identified for SSH/debug during hardware validation.

## Update

From an updated clone:

```bash
cd pipzo
git pull --ff-only
sudo provisioning/scripts/install-app.sh --kiosk-user "$USER"
sudo systemctl restart pipzo-backend.service
systemctl --user restart pipzo-kiosk.service
```

Existing `/etc/pipzo/*.env` files are not overwritten. Review `provisioning/env/*.example` after updates and manually carry over new settings when needed.

The kiosk keyring and Chromium launch-mode fixes are delivered in `/usr/local/bin/pipzo-kiosk`, so rerunning `install-app.sh` is enough to install them even when an existing `/etc/pipzo/kiosk.env` is preserved. Existing `/etc/pipzo/kiosk.env` files can opt back into true Chromium fullscreen by setting `PIPZO_CHROMIUM_MODE=kiosk`, but that mode can hide the on-screen keyboard under labwc.

## Service Operations

Backend status and logs:

```bash
systemctl status pipzo-backend.service
journalctl -u pipzo-backend.service -f
```

Kiosk status and logs:

```bash
systemctl --user status pipzo-kiosk.service
journalctl --user -u pipzo-kiosk.service -f
```

Both services are supervised by systemd. The backend restarts on failure after five seconds. The kiosk launcher restarts Chromium after three seconds so a browser crash returns to the local app URL.

## Kiosk Launcher

`/usr/local/bin/pipzo-kiosk` launches Chromium at `PIPZO_KIOSK_URL`, defaulting to `http://127.0.0.1:8000/`.

The launcher uses a dedicated Chromium profile directory and defaults to `PIPZO_CHROMIUM_MODE=app-maximized`. In this mode it launches Chromium with `--app="$PIPZO_KIOSK_URL"` and `--start-maximized` instead of true `--kiosk`. This preserves the app-only browser chrome while avoiding the labwc fullscreen layer behavior that can keep Squeekboard behind Chromium.

The launcher passes conservative Chromium flags:

- `--no-first-run`
- `--no-default-browser-check`
- `--disable-infobars`
- `--disable-session-crashed-bubble`
- `--disable-features=TranslateUI`
- `--autoplay-policy=no-user-gesture-required`
- `--password-store=basic`
- `--overscroll-history-navigation=0`
- `--check-for-update-interval=31536000`

`--password-store=basic` keeps the dedicated Pipzo Chromium profile from asking the desktop Secret Service/keyring to unlock before the kiosk is usable. This is intended only for the local kiosk profile; Spotify OAuth tokens remain backend-owned and encrypted in Pipzo storage, and Chromium still handles the local Spotify PKCE web flow and Spotify Web Playback SDK runtime.

If `PIPZO_CHROMIUM_MODE=kiosk` is set, Chromium launches with true `--kiosk`. This is useful as a fallback if app-maximized behavior regresses, but Raspberry Pi OS labwc can treat fullscreen Chromium as above the normal Squeekboard layer, making touch text input unavailable.

## On-Screen Keyboard

Raspberry Pi OS Desktop with labwc uses Squeekboard for touch text input. `setup-packages.sh` installs `squeekboard` and `wfplug-squeek` when those packages exist in apt. After package installation, reboot the Pi so the panel plugin and input-method pieces are loaded.

If the keyboard still does not appear when tapping Pipzo text fields, confirm Raspberry Pi Configuration has the on-screen keyboard enabled or always enabled. The manual panel keyboard toggle is expected to work in normal desktop windows. Under true fullscreen Chromium kiosk mode, labwc may hide Squeekboard behind Chromium; keep `PIPZO_CHROMIUM_MODE=app-maximized` unless a future Raspberry Pi OS update changes that behavior.

Pi-side checks:

```bash
dpkg -l squeekboard wfplug-squeek
pgrep -a squeekboard || true
systemctl --user status pipzo-kiosk.service
journalctl --user -u pipzo-kiosk.service -n 80 --no-pager
grep '^PIPZO_CHROMIUM_MODE=' /etc/pipzo/kiosk.env || true
```

If `/etc/pipzo/kiosk.env` predates this setting, either leave it unset to use the launcher default or add:

```bash
PIPZO_CHROMIUM_MODE=app-maximized
```

Then restart:

```bash
systemctl --user restart pipzo-kiosk.service
```

## Network Diagnostics

If Pipzo shows a mock or stale-looking IP while the Pi's real address is known from the router or SSH, first confirm the backend is in hardware mode and that NetworkManager can report the active Wi-Fi IPv4 address:

```bash
grep '^PIPZO_MODE=' /etc/pipzo/pipzo.env
systemctl status pipzo-backend.service --no-pager
journalctl -u pipzo-backend.service -n 120 --no-pager
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status
nmcli -t -f IP4.ADDRESS,GENERAL.DEVICE,GENERAL.CONNECTION device show wlan0
curl -s http://127.0.0.1:8000/api/v1/health
curl -s http://127.0.0.1:8000/api/v1/network/status
curl -s http://127.0.0.1:8000/api/v1/app/state
```

`PIPZO_MODE=mock` means the backend will intentionally serve mock network data. In `hardware` mode, missing `nmcli`, a down Wi-Fi device, or NetworkManager permission failures should be visible in the backend logs and API status rather than replaced with fake success.

After installing or updating the launcher on Raspberry Pi OS Desktop, reboot the Pi and confirm the desktop may appear briefly, then Chromium enters the Pipzo kiosk without an interactive desktop keyring password prompt.

Final Touch Display 2 timing, Chromium behavior, Spotify Web Playback SDK readiness, OAuth completion, and on-screen keyboard behavior still require real Pi validation.

## Rollback And Reset

Stop services:

```bash
systemctl --user stop pipzo-kiosk.service
sudo systemctl stop pipzo-backend.service
```

Disable services:

```bash
systemctl --user disable pipzo-kiosk.service
sudo systemctl disable pipzo-backend.service
```

Rollback code by checking out the previous commit in a clone and rerunning `sudo provisioning/scripts/install-app.sh --kiosk-user "$USER"`.

Reset app data only:

```bash
sudo systemctl stop pipzo-backend.service
sudo rm -f /var/lib/pipzo/pipzo.sqlite3 /var/lib/pipzo/spotify-token.key
sudo systemctl start pipzo-backend.service
```

This clears local app state and encrypted Spotify token material. It does not forget OS Wi-Fi networks or Bluetooth pairings.
