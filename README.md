# Pipzo

Pipzo is a stand-alone Raspberry Pi Spotify playback appliance for a single Spotify Premium user.

The goal is a calm touchscreen-first bedside player: no phone for playback, no general desktop access, true fullscreen appliance kiosk operation, large touch targets, simple Spotify library browsing on Home, Bluetooth speaker output, and a low-light bedtime mode. V1 defaults to Chromium true kiosk mode; visible OS panel/window chrome is not part of the product runtime.

## Status

Private early project scaffold. GitHub Issues are the canonical backlog once the private remote is configured.

## V1 Direction

- Raspberry Pi 5, 2GB.
- Raspberry Pi Touch Display 2, 7 inch.
- Raspberry Pi OS Desktop with Chromium kiosk.
- Python/FastAPI backend.
- React/Vite/TypeScript frontend.
- Spotify OAuth Authorization Code with PKCE.
- Spotify Web Playback SDK running in Chromium.
- Bluetooth speaker output.
- In-app Wi-Fi setup and single-speaker Bluetooth pairing.
- Bedtime idle mode and sleep timer.
- Repeatable provisioning scripts.
- Desktop development mode with mocked OS integrations.

## Repository Layout

```text
backend/        FastAPI backend, contracts, persistence, auth/session logic, tests
frontend/       React/Vite/TypeScript kiosk UI, API helpers, view models, tests
provisioning/   Raspberry Pi OS, systemd, Chromium kiosk, Wi-Fi, Bluetooth setup work
scripts/        Local developer and maintenance scripts
docs/           Architecture, product scope, setup, contribution, and planning docs
data/           Local generated SQLite/key material; ignored by Git
```

See [Contributing](docs/contributing.md) for local setup, validation commands, commit hygiene, issue sync, and documentation conventions.
See [Raspberry Pi Provisioning](docs/provisioning.md) for the repeatable Pi install/update path, systemd service names, kiosk launcher, environment files, and reset notes.

## Local Contract API

The skeleton exposes the app-state contract, a WebSocket event channel, desktop mock scenarios, durable app settings, and mutation/action endpoints for frontend development.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
PIPZO_MODE=mock uvicorn pipzo_api.main:app --app-dir backend --reload
```

Configuration is environment-driven:

- `PIPZO_MODE=mock|hardware`; mock is the desktop development default.
- `PIPZO_DB_PATH=./data/pipzo.sqlite3`; startup creates the parent directory and initializes the local SQLite schema.
- `PIPZO_LOG_LEVEL=debug|info|warning|error|critical`; logs are JSON lines.
- `SPOTIFY_CLIENT_ID`; public client ID from the Spotify developer app. Do not configure or store a client secret for the PKCE flow.
- `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/api/v1/spotify/auth/callback`; register this exact local callback in the Spotify dashboard for desktop/Pi Chromium setup.
- `SPOTIFY_AUTH_URL`, `SPOTIFY_TOKEN_URL`, and `SPOTIFY_SCOPES`; Spotify Accounts endpoints and requested scopes.
- `SPOTIFY_TOKEN_STORAGE_PROTECTION=local_key_encrypted`; Spotify access and refresh token fields are encrypted before SQLite writes with a local app-managed key.
- `PIPZO_TOKEN_KEY_PATH=./data/spotify-token.key`; local Fernet key file used for Spotify token encryption.
- `PIPZO_TOKEN_KEY_AUTO_CREATE=true`; when true, the backend creates the token key if it is missing.
- `PIPZO_PUBLIC_BASE_URL=http://127.0.0.1:8000`; base URL used to build the local auth start route returned to the kiosk.
- `PIPZO_FRONTEND_DIST`; optional built frontend asset directory served by the backend for kiosk installs, for example `/opt/pipzo/app/frontend/dist`.
- `PIPZO_INTERNET_PROBE_URL=https://www.google.com/generate_204`; endpoint used by hardware-mode Wi-Fi status to distinguish online from local-only connectivity.
- `PIPZO_AUDIO_USER`; optional desktop user whose `/run/user/<uid>` audio session should be targeted for hardware volume control. Pi provisioning sets this to the kiosk user and runs the backend as that same user by default.

See [Spotify Developer Setup](docs/spotify-developer-setup.md) for app creation, redirect URI rules, scopes, Premium requirement, token-key caveats, and V1 deferred OAuth surfaces.

Startup, request, and mock action logs use structured fields. Request logs include method, path, status, and duration only; they do not log query strings or request bodies, so Wi-Fi passwords and OAuth secrets are not captured by the logger. Spotify access tokens, refresh tokens, authorization codes, PKCE verifiers, OAuth state, Authorization headers, and raw Spotify response bodies must remain backend-only and out of APIs, frontend contracts, events, diagnostics, issue comments, and logs.

Useful endpoints:

- `GET http://127.0.0.1:8000/api/v1/health`
- `GET http://127.0.0.1:8000/api/v1/app/state`
- `WS  ws://127.0.0.1:8000/api/v1/events/ws`
- `POST http://127.0.0.1:8000/api/v1/setup/start`
- `POST http://127.0.0.1:8000/api/v1/setup/complete`
- `POST http://127.0.0.1:8000/api/v1/setup/playback-test`
- `GET/PATCH http://127.0.0.1:8000/api/v1/settings`
- `PATCH http://127.0.0.1:8000/api/v1/display`
- `POST http://127.0.0.1:8000/api/v1/playback/control`
- `PATCH http://127.0.0.1:8000/api/v1/volume`
- `POST http://127.0.0.1:8000/api/v1/device/reboot`
- `POST http://127.0.0.1:8000/api/v1/device/poweroff`
- `GET http://127.0.0.1:8000/api/v1/network/status`
- `POST http://127.0.0.1:8000/api/v1/network/scan`
- `GET http://127.0.0.1:8000/api/v1/network/scan-results`
- `POST http://127.0.0.1:8000/api/v1/network/connect`
- `POST http://127.0.0.1:8000/api/v1/network/forget`
- `POST http://127.0.0.1:8000/api/v1/network/retry-internet-probe`
- `GET http://127.0.0.1:8000/api/v1/speaker/status`
- `POST http://127.0.0.1:8000/api/v1/speaker/scan`
- `GET http://127.0.0.1:8000/api/v1/speaker/scan-results`
- `POST http://127.0.0.1:8000/api/v1/speaker/pair`
- `POST http://127.0.0.1:8000/api/v1/speaker/reconnect`
- `POST http://127.0.0.1:8000/api/v1/speaker/forget`
- `POST http://127.0.0.1:8000/api/v1/spotify/auth/session`
- `GET http://127.0.0.1:8000/api/v1/spotify/auth/session/{sessionId}`
- `POST http://127.0.0.1:8000/api/v1/spotify/auth/session/{sessionId}/cancel`
- `GET http://127.0.0.1:8000/api/v1/spotify/auth/start/{sessionId}`
- `GET http://127.0.0.1:8000/api/v1/spotify/auth/callback`
- `POST http://127.0.0.1:8000/api/v1/spotify/auth/logout`
- `POST http://127.0.0.1:8000/api/v1/spotify/browser-session/reset`
- `GET http://127.0.0.1:8000/api/v1/spotify/playback/token`
- `POST http://127.0.0.1:8000/api/v1/spotify/playback/transfer`
- `GET http://127.0.0.1:8000/api/v1/library/home`
- `GET http://127.0.0.1:8000/api/v1/library/playlists`
- `GET http://127.0.0.1:8000/api/v1/library/albums`
- `GET http://127.0.0.1:8000/api/v1/library/artists`
- `GET http://127.0.0.1:8000/api/v1/library/liked_songs`
- `GET http://127.0.0.1:8000/api/v1/library/recently_played`
- `GET http://127.0.0.1:8000/api/v1/library/search?q=bedtime` (deferred backend capability; not exposed in the V1 daily kiosk UI)
- `POST http://127.0.0.1:8000/api/v1/library/play`
- `GET http://127.0.0.1:8000/api/v1/recovery/actions`
- `POST http://127.0.0.1:8000/api/v1/recovery/actions/{actionId}/run`
- `GET http://127.0.0.1:8000/api/v1/mock/scenarios`
- `POST http://127.0.0.1:8000/api/v1/mock/scenarios/ready_healthy/activate`

The local Spotify OAuth flow creates transient in-memory PKCE sessions, redirects local Chromium to Spotify, validates callback state, exchanges the authorization code with Spotify using PKCE and no client secret, fetches the current user's safe profile summary, and persists the single-account token/account record backend-side in SQLite. Token fields are encrypted in the store before SQLite writes and decrypted only when backend auth/Spotify service code reads the record. Safe account metadata such as Spotify account ID, display name, product, country, Premium flag, scopes, and timestamps remains plaintext for UI/status projection.

The SQLite DB and token key are a pair for backup and restore. Back up both together if preserving the Spotify connection matters. Losing, deleting, corrupting, or replacing the key makes the encrypted token fields unreadable; Pipzo will fail safe by treating Spotify auth as reconnect-required, and the user must reconnect Spotify. Logout and app reset delete the encrypted Spotify auth record but leave the local key in place so a future reconnect can use the same key. Deleting both the DB token record and key is safe, but it also requires Spotify reconnect.

The React Setup and Settings surfaces expose local-device controls to start authorization, open/continue the local Chromium flow, poll status, cancel pending setup, and logout/reconnect an account using only safe session/account metadata. After Spotify redirects back to the local callback, the backend shows a kiosk-safe completion page with a large Return button and automatic return to `/`, so the app reloads normal state without browser chrome, keyboard, or SSH intervention. Pipzo provisions a first-party local Chromium extension keyboard for true-kiosk text entry on narrow approved origins: the local Pipzo app and `https://accounts.spotify.com/*`. The extension renders the touch keyboard by mutating focused editable text/password/email/search fields and dispatching DOM input/change events. It also has a narrow MV3 service worker with `cookies` and `browsingData` permissions for `https://*.spotify.com/*`; Settings uses that local bridge during Spotify disconnect/switch-account flows for coarse browser-session clearing evidence. Hardware account switching then invokes a bounded backend helper that restarts the kiosk with a fresh Pipzo Chromium profile, preserving backend SQLite/app state while removing Chromium-held Spotify web login state. The extension has no persistent extension storage, network fetch, external messaging, remote code, or analytics. The backend has an explicit refresh helper for startup/pre-call integration: it uses the stored refresh token plus `client_id`, keeps the existing refresh token when Spotify omits a replacement, updates safe auth metadata, and maps network/revoked/key failures to safe `health.spotifyAuth` state. Phone QR/relay OAuth remains follow-on work.

Degraded runtime mode keeps Settings, Wi-Fi recovery, Bluetooth speaker recovery, and app reset reachable after setup when internet, Spotify auth, or the playback device is unavailable. Library browsing and playback controls are blocked honestly in those states, and Pipzo does not offer or imply offline music playback.

Library browsing V1 exposes backend-owned Spotify Web API catalog endpoints for playlists, saved albums, liked songs, recently played tracks, and an Artists category derived from saved/recent music so no extra `user-follow-read` scope is required. Home is the primary daily library surface, with touch category controls and playable list rows. The existing constrained library search endpoint remains backend-only/deferred because V1 daily use avoids normal text search; setup and recovery text entry must preserve true kiosk mode and use the first-party extension keyboard rather than depending on the OSK-compatible Chromium app-maximized fallback. Selecting playable playlist/album contexts or tracks calls the backend `POST /api/v1/library/play` start seam when playback/device readiness allows it. Mock and local fallback modes include representative library fixtures and do not require a live Spotify account.

The kiosk frontend loads Spotify's Web Playback SDK once when it is connected to the backend and Spotify auth is ready, registers the browser player as `Pipzo`, surfaces SDK readiness/device ID/error/transfer state in Now Playing and Settings, and requests backend playback transfer only when the user taps the explicit select/takeover action. The backend exposes `GET /api/v1/spotify/playback/token` for the SDK's short-lived access-token callback; it refreshes access backend-side when needed and never returns refresh tokens, PKCE data, encryption key material, or raw token responses. Hardware-mode playback transfer and play/pause/next/previous controls call Spotify Web API through the backend token boundary. Now Playing shows current remote Spotify playback as a controller when another Spotify device is active, and otherwise falls back to the last known track in paused state when Spotify returns no active payload. The single app volume control calls Spotify device volume and the local OS output sink where available; partial failures are reported as `spotify_only`, `os_only`, `out_of_sync`, or `unavailable` volume health rather than fake success. Mock/local modes remain usable without a live Spotify account or audio hardware.

This SDK slice registers and selects the browser playback device only. Bluetooth speaker pairing/output and full audio validation are separate V1 platform work.

WebSocket clients receive an initial `app.snapshot` event followed by mock/action events such as `settings.changed`, `display.changed`, `playback.control_changed`, `recovery.action_changed`, `spotify.auth_session_changed`, and `spotify.auth_changed`. Clients should still refetch `GET /api/v1/app/state` after reconnect because events are not durable state.

App settings are persisted in SQLite through `GET/PATCH /api/v1/settings` in both mock and hardware modes. Bedtime idle mode uses `idleTimeoutSeconds`, `idleMode`, `artworkInIdle`, and `bedtimeBrightness`: after inactivity, the frontend switches to a dim clock-first view and wakes on touch, pointer, or key activity. Settings also exposes confirmed Reboot and Power off actions through bounded `/api/v1/device/reboot` and `/api/v1/device/poweroff` endpoints. Mock mode simulates those actions; hardware mode uses fixed-argument `systemctl reboot` and `systemctl poweroff` adapter calls and relies on local-only backend binding plus minimal logind/polkit privilege for the service user. Settings updates are app-owned preferences; hardware actions such as display brightness writes and app reset still require concrete platform adapters before they can succeed outside mock-specific endpoints.

Sleep timer V1 is frontend-local and offers 15, 30, 45, and 60 minute presets plus Clear from a Now Playing timer action. While the browser session stays alive, the runtime UI and idle clock show the active countdown; when it expires the frontend sends `{"action":"stop"}` through `POST /api/v1/playback/control`, which maps to Spotify pause in hardware mode. If playback control is degraded or the app is using local fallback scenarios, the UI reports that the stop could not be sent. Active timers are not persisted across page reloads, Chromium restarts, or backend/service restarts.

Mock endpoints are intended for desktop development only and are gated by `PIPZO_MODE=mock`.
Wi-Fi status, scan, connect, forget, and internet-probe retry are implemented in hardware mode through NetworkManager/nmcli. Network settings also shows the active Wi-Fi IPv4 address when NetworkManager reports one, which is useful for SSH/debug during Pi hardware validation. If hardware mode cannot read a non-loopback, non-link-local IPv4 address, the API leaves `ipAddress` empty and the UI shows `Unknown` instead of substituting desktop mock data. Missing `nmcli` or missing NetworkManager authorization returns unavailable responses rather than fake success. Bluetooth speaker status, scan, pair/trust/connect, reconnect, and forget are implemented in hardware mode through BlueZ/bluetoothctl with one persisted primary speaker record in SQLite. Missing `bluetoothctl`, missing adapter access, disabled Bluetooth, pairing rejection, and connect failures map to coarse safe contract states instead of fake success. Setup readiness requires Wi-Fi, Spotify auth, a connected primary Bluetooth speaker, and playback-test readiness; desktop mock/local flows keep deterministic simulated speaker behavior.

Backend tests:

```bash
pytest
```

Frontend kiosk shell:

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. When the backend is running in `PIPZO_MODE=mock`, Vite proxies `/api` to `http://127.0.0.1:8000` and the developer mock panel activates backend scenarios or adjusts mock display brightness/status. In `PIPZO_MODE=hardware`, the kiosk hides the developer mock panel so local scenarios cannot be mistaken for real Pi state. If the backend is not running, the UI falls back to checked-in local scenarios for first boot, ready, degraded recovery, offline settings mode, Spotify auth unavailable, device connectivity degraded, speaker disconnected, Wi-Fi local only, volume out of sync, boot probe delayed, idle clock, idle with artwork, and dimmed bedtime.

Frontend validation:

```bash
cd frontend
npm run typecheck
npm test
npm run build
```

## Planning

Implementation planning, bugs, and feature work are tracked in GitHub Issues using outcome-oriented milestones:

- M0 Project Foundation
- M1 Local App Skeleton
- M2 Spotify Playback
- M3 Device Setup
- M4 Bedside Polish
- M5 Pi Provisioning & Hardening

MyOS coordination, dispatches, and specialist handoffs live outside this repo in `Active Work/Pipzo`.

## Repo Hygiene

Keep implementation slices reviewable. Each slice should normally end with the documented validation commands passing, one focused commit when reasonable, commit and PR/issue text that references the relevant GitHub Issues, and concise issue comments or closures when the work is done. Split the work when validation failures, mixed concerns, or large diffs would make review unclear.
