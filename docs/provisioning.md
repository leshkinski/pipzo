# Raspberry Pi Provisioning

These artifacts are the first repeatable provisioning and kiosk supervision slice for Raspberry Pi OS Desktop on Raspberry Pi 5 with Raspberry Pi Touch Display 2.

They are safe to review on non-Pi development machines. The install scripts intentionally stop unless run on Linux with the expected tools.

## Runtime Contract

- App checkout: `/opt/pipzo/app`
- Python virtualenv: `/opt/pipzo/venv`
- Backend service user: the kiosk desktop user by default, or `--service-user USER`
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

The installer copies the checkout to `/opt/pipzo/app`, creates or updates `/opt/pipzo/venv`, installs the backend package, runs `npm ci`, builds the frontend into `/opt/pipzo/app/frontend/dist`, installs systemd units, and enables the backend service. With the normal `--kiosk-user USER` V1 path, the backend service deliberately runs as the kiosk desktop user so `wpctl` can access that user's active PipeWire/WirePlumber session without broad socket chmods or sudo workarounds. It enables the kiosk user service when the target user's user-systemd runtime is active; otherwise it prints the exact `systemctl --user` command to run after logging in as that user.

`setup-packages.sh` installs NetworkManager, polkit, BlueZ, and Raspberry Pi OS labwc on-screen keyboard packages when apt exposes them. On Raspberry Pi OS it also installs `pi-bluetooth` when that package is available. `install-app.sh` installs `/etc/polkit-1/rules.d/50-pipzo-networkmanager.rules` for the configured backend service user, so Wi-Fi setup operations through `nmcli` keep the same bounded non-interactive authorization path after migrating from the legacy `pipzo` service user to the kiosk user. It also adds the backend service user to the `bluetooth` group when the group exists, so BlueZ/bluetoothctl speaker operations keep the normal Raspberry Pi OS Bluetooth access path.

If the polkit rules directory is missing on a nonstandard image, hardware Wi-Fi actions will report unavailable or permission failures until equivalent NetworkManager permissions are added manually. If `bluetoothctl` is missing, Bluetooth is disabled, the backend user lacks BlueZ access, or the speaker rejects pairing/connection, hardware Bluetooth actions report unavailable or failed contract states rather than simulated success.

Unified volume control uses Spotify Web API volume updates plus the local desktop audio sink when available. On Raspberry Pi OS Desktop Bookworm, Pipzo expects the existing PipeWire/WirePlumber stack and prefers `wpctl`; it falls back to `pactl` if `wpctl` is unavailable. `install-app.sh --kiosk-user USER` seeds `PIPZO_AUDIO_USER=USER` in new `/etc/pipzo/pipzo.env` files so the backend invokes audio tools with `XDG_RUNTIME_DIR=/run/user/<uid>` and the matching user D-Bus address. The service user migration is the important V1 access fix; `PIPZO_AUDIO_USER` remains as an explicit diagnostic/runtime target and should match the kiosk user on normal installs.

If neither command exists, the default sink is missing, `/run/user/<uid>` is not active, or the backend service user cannot access the kiosk user's PipeWire session, hardware volume actions report partial or unavailable states with `os_sink_missing`, `audio_session_unavailable`, or `permission_denied` rather than simulated success. Do not install the legacy `pulseaudio` server alongside PipeWire for Pipzo; use the OS Desktop audio stack or validate a nonstandard audio stack separately. Do not grant broad sudo or chmod access to PipeWire sockets as a workaround.

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

The current V1 update path changes the default backend runtime identity from the legacy isolated `pipzo` user to the kiosk desktop user. Rerunning the installer with `--kiosk-user "$USER"` updates `pipzo-backend.service`, moves `/var/lib/pipzo` ownership to the new runtime user, and keeps `/etc/pipzo/pipzo.env` readable only by root and that user's primary group. This preserves the existing SQLite database and Spotify token key while allowing `wpctl` to access the active desktop audio session. If `/etc/pipzo/pipzo.env` predates `PIPZO_AUDIO_USER`, add it once:

```bash
sudo sh -c 'grep -q "^PIPZO_AUDIO_USER=" /etc/pipzo/pipzo.env || printf "\nPIPZO_AUDIO_USER=%s\n" "$SUDO_USER" >> /etc/pipzo/pipzo.env'
sudo sed -i "s/^PIPZO_AUDIO_USER=.*/PIPZO_AUDIO_USER=$USER/" /etc/pipzo/pipzo.env
```

Use `--service-user pipzo` only as an explicit legacy/debug override. That mode can still report `permission_denied` for OS volume because the isolated user does not own the kiosk PipeWire session.

The kiosk keyring and Chromium launch-mode fixes are delivered in `/usr/local/bin/pipzo-kiosk`, so rerunning `install-app.sh` is enough to install the launcher changes even when an existing `/etc/pipzo/kiosk.env` is preserved. Existing `/etc/pipzo/kiosk.env` files may need `PIPZO_CHROMIUM_MODE=kiosk` set explicitly to adopt the current fullscreen default; use `app-maximized` only as the on-screen keyboard fallback.

## Service Operations

Backend status and logs:

```bash
systemctl status pipzo-backend.service
journalctl -u pipzo-backend.service -f
systemctl show pipzo-backend.service -p User -p Group -p Environment
PID="$(systemctl show -p MainPID --value pipzo-backend.service)"
sudo sh -c "tr '\0' '\n' </proc/$PID/environ" | grep -E '^(PIPZO_AUDIO_USER|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' || true
```

Kiosk status and logs:

```bash
systemctl --user status pipzo-kiosk.service
journalctl --user -u pipzo-kiosk.service -f
```

Audio session diagnostics:

```bash
which wpctl || true
which pactl || true
wpctl status
systemctl --user status pipewire wireplumber
id
echo "$XDG_RUNTIME_DIR"
curl -s http://127.0.0.1:8000/api/v1/app/state | python3 -m json.tool | sed -n '/"volume"/,/"display"/p'
curl -s -X PATCH http://127.0.0.1:8000/api/v1/volume \
  -H 'Content-Type: application/json' \
  -d '{"value":35,"muted":false}' | python3 -m json.tool
```

Both services are supervised by systemd. The backend restarts on failure after five seconds. The kiosk launcher restarts Chromium after three seconds so a browser crash returns to the local app URL.

## Kiosk Launcher

`/usr/local/bin/pipzo-kiosk` launches Chromium at `PIPZO_KIOSK_URL`, defaulting to `http://127.0.0.1:8000/`.

The launcher uses a dedicated Chromium profile directory and defaults to `PIPZO_CHROMIUM_MODE=kiosk`. This is the normal appliance runtime: Chromium launches with true `--kiosk`, hiding the Raspberry Pi OS panel and window chrome so the touch display presents Pipzo as a dedicated device UI.

`PIPZO_CHROMIUM_MODE=app-maximized` remains the documented fallback when touch text input is more important than strict fullscreen. In that mode Chromium launches with `--app="$PIPZO_KIOSK_URL"` and `--start-maximized`, which keeps the app-only browser window path that has allowed Squeekboard to appear above Chromium under Raspberry Pi OS labwc. The tradeoff is that labwc panel/window chrome may remain visible.

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

`PIPZO_CHROMIUM_EXTRA_FLAGS` is a diagnostic-only escape hatch for Raspberry Pi validation. Leave it empty for normal runtime. Chromium documents command-line switches as temporary controls that may change, so use this only to isolate platform/browser behavior and then remove the flags after testing.

If `/etc/pipzo/kiosk.env` already exists from an older install, rerunning `install-app.sh` preserves that local file. Confirm or change the normal appliance setting explicitly:

```bash
grep '^PIPZO_CHROMIUM_MODE=' /etc/pipzo/kiosk.env || true
if grep -q '^PIPZO_CHROMIUM_MODE=' /etc/pipzo/kiosk.env; then
  sudo sed -i 's/^PIPZO_CHROMIUM_MODE=.*/PIPZO_CHROMIUM_MODE=kiosk/' /etc/pipzo/kiosk.env
else
  echo 'PIPZO_CHROMIUM_MODE=kiosk' | sudo tee -a /etc/pipzo/kiosk.env
fi
systemctl --user restart pipzo-kiosk.service
```

If Squeekboard does not appear over true kiosk fullscreen during setup or later text-entry flows, switch back to the OSK-compatible fallback:

```bash
sudo sed -i 's/^PIPZO_CHROMIUM_MODE=.*/PIPZO_CHROMIUM_MODE=app-maximized/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

## Touch Panning Diagnostics

If taps work but direct finger panning does not scroll Pipzo regions, first confirm whether Chromium is delivering move events from the touch device. The app has already been hardened against text selection and has explicit drag-scroll handling; if both native panning and explicit drag-scroll fail, the next boundary to test is browser/input event delivery.

Run the local event probe from an updated checkout on the Pi:

```bash
cd /opt/pipzo/app
PROBE_URL="file:///opt/pipzo/app/provisioning/touch-event-probe.html"
sudo sh -c "grep -q '^PIPZO_CHROMIUM_EXTRA_FLAGS=' /etc/pipzo/kiosk.env || printf '\nPIPZO_CHROMIUM_EXTRA_FLAGS=\n' >> /etc/pipzo/kiosk.env"
sudo sed -i "s|^PIPZO_KIOSK_URL=.*|PIPZO_KIOSK_URL=$PROBE_URL|" /etc/pipzo/kiosk.env
sudo sed -i 's/^PIPZO_CHROMIUM_MODE=.*/PIPZO_CHROMIUM_MODE=app-maximized/' /etc/pipzo/kiosk.env
sudo sed -i 's/^PIPZO_CHROMIUM_EXTRA_FLAGS=.*/PIPZO_CHROMIUM_EXTRA_FLAGS=/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

Drag inside the left probe region with a finger and record:

- whether the list itself scrolls;
- whether `pointermove` increments;
- whether `touchmove` increments;
- the displayed `navigator.maxTouchPoints` value.

Then force Chromium's touch-event feature detection on and repeat the same probe:

```bash
sudo sed -i 's/^PIPZO_CHROMIUM_EXTRA_FLAGS=.*/PIPZO_CHROMIUM_EXTRA_FLAGS=--touch-events=enabled/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

Interpretation:

- If `pointerdown` or `touchstart` increments but `pointermove` and `touchmove` stay at zero during a drag, Chromium/labwc is not exposing drag movement to the page.
- If `touchmove` appears only after `--touch-events=enabled`, keep that flag as a candidate workaround for one validation cycle and retest the real app for taps, Browse/Search with Squeekboard, playback, and direct panning.
- If move events appear but `scroll top` never changes in the probe, the browser is receiving events but native scrolling is blocked by browser/CSS behavior.
- If the probe scrolls normally but the real app does not, route back to frontend implementation with the probe result attached.

Restore normal Pipzo runtime after the probe:

```bash
sudo sed -i 's|^PIPZO_KIOSK_URL=.*|PIPZO_KIOSK_URL=http://127.0.0.1:8000/|' /etc/pipzo/kiosk.env
sudo sed -i 's/^PIPZO_CHROMIUM_EXTRA_FLAGS=.*/PIPZO_CHROMIUM_EXTRA_FLAGS=/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

## On-Screen Keyboard

Raspberry Pi OS Desktop with labwc uses Squeekboard for touch text input. `setup-packages.sh` installs `squeekboard` and `wfplug-squeek` when those packages exist in apt. After package installation, reboot the Pi so the panel plugin and input-method pieces are loaded.

If the keyboard still does not appear when tapping Pipzo text fields, confirm Raspberry Pi Configuration has the on-screen keyboard enabled or always enabled. The manual panel keyboard toggle is expected to work in normal desktop windows. Under true fullscreen Chromium kiosk mode, labwc may hide Squeekboard behind Chromium; use `PIPZO_CHROMIUM_MODE=app-maximized` as the supported fallback while validating whether a future Raspberry Pi OS update improves this behavior.

Current upstream evidence indicates this is a compositor layer ordering limit rather than a Pipzo text-input problem. In labwc, fullscreen application surfaces are above normal `top` layer surfaces; the Raspberry Pi OS Squeekboard path currently behaves like a `top` layer surface, so true Chromium `--kiosk` or `--start-fullscreen` can cover it. A locally rebuilt Squeekboard using the `overlay` layer has been reported to appear over fullscreen Chromium, but Pipzo does not ship or recommend that as V1 provisioning because it replaces Raspberry Pi OS packaging and can diverge from downstream Squeekboard patches.

Keep these expectations explicit:

- `PIPZO_CHROMIUM_MODE=kiosk`: supported appliance fullscreen; OS chrome hidden; Squeekboard may be hidden behind Chromium.
- `PIPZO_CHROMIUM_MODE=app-maximized`: supported V1 keyboard fallback; Squeekboard appears; Raspberry Pi OS panel/window chrome may remain visible.
- `PIPZO_CHROMIUM_EXTRA_FLAGS=--start-fullscreen` with `app-maximized`: diagnostic only; expected to reproduce the fullscreen layering problem if Chromium asks labwc for fullscreen.
- Rebuilt or patched Squeekboard on the `overlay` layer: research-only; validate only on a disposable Pi image or after recording package versions and rollback steps.

Pi-side checks:

```bash
dpkg -l squeekboard wfplug-squeek
pgrep -a squeekboard || true
systemctl --user status pipzo-kiosk.service
journalctl --user -u pipzo-kiosk.service -n 80 --no-pager
grep '^PIPZO_CHROMIUM_MODE=' /etc/pipzo/kiosk.env || true
```

If `/etc/pipzo/kiosk.env` predates this setting, either leave it unset to use the launcher default or add the normal appliance setting:

```bash
PIPZO_CHROMIUM_MODE=kiosk
```

Then restart:

```bash
systemctl --user restart pipzo-kiosk.service
```

For fullscreen/keyboard experiments, record the exact OS and compositor/browser package versions first:

```bash
cat /etc/os-release
uname -a
labwc --version || true
chromium --version || chromium-browser --version
dpkg -l squeekboard wfplug-squeek labwc chromium chromium-browser | sed -n '/^ii/p'
```

Then test the safe launcher modes:

```bash
sudo sed -i 's/^PIPZO_CHROMIUM_MODE=.*/PIPZO_CHROMIUM_MODE=kiosk/' /etc/pipzo/kiosk.env
sudo sed -i 's/^PIPZO_CHROMIUM_EXTRA_FLAGS=.*/PIPZO_CHROMIUM_EXTRA_FLAGS=/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

Tap Browse/Search and Spotify OAuth text fields. Record whether Chromium is true fullscreen, whether the panel is hidden, and whether Squeekboard appears above the page.

```bash
sudo sed -i 's/^PIPZO_CHROMIUM_MODE=.*/PIPZO_CHROMIUM_MODE=app-maximized/' /etc/pipzo/kiosk.env
sudo sed -i 's/^PIPZO_CHROMIUM_EXTRA_FLAGS=.*/PIPZO_CHROMIUM_EXTRA_FLAGS=/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

Repeat the same input checks. This is the V1 fallback if text entry is required.

```bash
sudo sed -i 's/^PIPZO_CHROMIUM_MODE=.*/PIPZO_CHROMIUM_MODE=app-maximized/' /etc/pipzo/kiosk.env
sudo sed -i 's/^PIPZO_CHROMIUM_EXTRA_FLAGS=.*/PIPZO_CHROMIUM_EXTRA_FLAGS=--start-fullscreen/' /etc/pipzo/kiosk.env
systemctl --user restart pipzo-kiosk.service
```

Use this only to confirm whether `--start-fullscreen` has the same OSK failure as `--kiosk` on the current Raspberry Pi OS image. Restore either `kiosk` or `app-maximized` and clear `PIPZO_CHROMIUM_EXTRA_FLAGS` after testing.

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
