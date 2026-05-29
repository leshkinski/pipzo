# Pipzo

Pipzo is a stand-alone Raspberry Pi Spotify playback appliance for a single Spotify Premium user.

The goal is a calm touchscreen-first bedside player: no phone for playback, no general desktop access, large touch targets, simple Spotify browsing, Bluetooth speaker output, and a low-light bedtime mode.

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

## Local Contract API

The skeleton exposes the app-state contract, a WebSocket event channel, desktop mock scenarios, durable app settings, and initial mutation/action endpoints for frontend development.

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

See [Spotify Developer Setup](docs/spotify-developer-setup.md) for app creation, redirect URI rules, scopes, Premium requirement, token-key caveats, and V1 deferred OAuth surfaces.

Startup, request, and mock action logs use structured fields. Request logs include method, path, status, and duration only; they do not log query strings or request bodies, so future Wi-Fi passwords and OAuth secrets are not captured by the skeleton logger. Spotify access tokens, refresh tokens, authorization codes, PKCE verifiers, OAuth state, Authorization headers, and raw Spotify response bodies must remain backend-only and out of APIs, frontend contracts, events, diagnostics, issue comments, and logs.

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
- `GET http://127.0.0.1:8000/api/v1/recovery/actions`
- `POST http://127.0.0.1:8000/api/v1/recovery/actions/{actionId}/run`
- `GET http://127.0.0.1:8000/api/v1/mock/scenarios`
- `POST http://127.0.0.1:8000/api/v1/mock/scenarios/ready_healthy/activate`

The local Spotify OAuth flow creates transient in-memory PKCE sessions, redirects local Chromium to Spotify, validates callback state, exchanges the authorization code with Spotify using PKCE and no client secret, fetches the current user's safe profile summary, and persists the single-account token/account record backend-side in SQLite. Token fields are encrypted in the store before SQLite writes and decrypted only when backend auth/Spotify service code reads the record. Safe account metadata such as Spotify account ID, display name, product, country, Premium flag, scopes, and timestamps remains plaintext for UI/status projection.

The SQLite DB and token key are a pair for backup and restore. Back up both together if preserving the Spotify connection matters. Losing, deleting, corrupting, or replacing the key makes the encrypted token fields unreadable; Pipzo will fail safe by treating Spotify auth as reconnect-required, and the user must reconnect Spotify. Logout and app reset delete the encrypted Spotify auth record but leave the local key in place so a future reconnect can use the same key. Deleting both the DB token record and key is safe, but it also requires Spotify reconnect.

The React Setup and Settings surfaces expose local-device controls to start authorization, open/continue the local Chromium flow, poll status, cancel pending setup, and logout/reconnect an account using only safe session/account metadata. The backend has an explicit refresh helper for startup/pre-call integration: it uses the stored refresh token plus `client_id`, keeps the existing refresh token when Spotify omits a replacement, updates safe auth metadata, and maps network/revoked/key failures to safe `health.spotifyAuth` state. Periodic background refresh scheduling is deferred until the Spotify Web API call sites are implemented. Phone QR/relay OAuth remains follow-on work.

WebSocket clients receive an initial `app.snapshot` event followed by mock/action events such as `settings.changed`, `display.changed`, `playback.control_changed`, `recovery.action_changed`, `spotify.auth_session_changed`, and `spotify.auth_changed`. Clients should still refetch `GET /api/v1/app/state` after reconnect because events are not durable state.

App settings are persisted in SQLite through `GET/PATCH /api/v1/settings` in both mock and hardware modes. Settings updates are app-owned preferences; hardware actions such as display brightness writes, Wi-Fi connect/forget, Bluetooth scan/pair/reconnect/forget, playback control, and app reset still require concrete platform adapters before they can succeed outside mock-specific endpoints.

Mock endpoints are intended for desktop development only and are gated by `PIPZO_MODE=mock`.
The action endpoints currently simulate behavior only in mock mode, including display brightness/status changes through `PATCH /api/v1/display` with fields such as `{"brightness": 25, "status": "dimmed"}`. The hardware adapter path is an explicit future seam; unimplemented hardware-mode actions return `501` rather than fake Wi-Fi, Bluetooth, Spotify playback, display, or reset success. Wi-Fi and Bluetooth endpoint shapes are present for contract work, but their operation endpoints also return `501` until NetworkManager/BlueZ adapters are implemented and validated on the Pi.

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

Open `http://127.0.0.1:5173`. When the backend is running in `PIPZO_MODE=mock`, Vite proxies `/api` to `http://127.0.0.1:8000` and the developer mock panel activates backend scenarios or adjusts mock display brightness/status. If the backend is not running, the UI falls back to checked-in local scenarios for first boot, ready, degraded, speaker disconnected, Wi-Fi local only, volume out of sync, boot probe delayed, idle clock, idle with artwork, and dimmed bedtime.

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
