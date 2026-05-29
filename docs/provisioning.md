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

The launcher uses a dedicated Chromium profile directory and passes conservative kiosk flags:

- `--kiosk`
- `--no-first-run`
- `--no-default-browser-check`
- `--disable-infobars`
- `--disable-session-crashed-bubble`
- `--disable-features=TranslateUI`
- `--autoplay-policy=no-user-gesture-required`
- `--overscroll-history-navigation=0`
- `--check-for-update-interval=31536000`

Final Touch Display 2 timing, Chromium behavior, Spotify Web Playback SDK readiness, and on-screen keyboard behavior still require real Pi validation.

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
