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
backend/        Python backend service
frontend/       React touchscreen UI
provisioning/   Raspberry Pi OS, systemd, kiosk, Wi-Fi, and Bluetooth setup
scripts/        Local developer and maintenance scripts
docs/           Architecture, setup, product, and runbook docs
```

## Local Contract API

The skeleton exposes the app-state contract, a WebSocket event channel, desktop mock scenarios, and initial mutation/action endpoints for frontend development.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
PIPZO_MODE=mock uvicorn pipzo_api.main:app --app-dir backend --reload
```

Configuration is environment-driven:

- `PIPZO_MODE=mock|hardware`; mock is the desktop development default.
- `PIPZO_DB_PATH=./data/pipzo.sqlite3`; startup creates the parent directory and initializes the minimal schema marker table.
- `PIPZO_LOG_LEVEL=debug|info|warning|error|critical`; logs are JSON lines.

Startup, request, and mock action logs use structured fields. Request logs include method, path, status, and duration only; they do not log query strings or request bodies, so future Wi-Fi passwords and OAuth secrets are not captured by the skeleton logger.

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
- `GET http://127.0.0.1:8000/api/v1/recovery/actions`
- `POST http://127.0.0.1:8000/api/v1/recovery/actions/{actionId}/run`
- `GET http://127.0.0.1:8000/api/v1/mock/scenarios`
- `POST http://127.0.0.1:8000/api/v1/mock/scenarios/ready_healthy/activate`

WebSocket clients receive an initial `app.snapshot` event followed by mock/action events such as `settings.changed`, `display.changed`, `playback.control_changed`, and `recovery.action_changed`. Clients should still refetch `GET /api/v1/app/state` after reconnect because events are not durable state.

Mock endpoints are intended for desktop development only and are gated by `PIPZO_MODE=mock`.
The action endpoints currently simulate behavior only in mock mode, including display brightness/status changes through `PATCH /api/v1/display` with fields such as `{"brightness": 25, "status": "dimmed"}`. The hardware adapter path is an explicit future seam; unimplemented hardware-mode actions return `501` rather than fake Wi-Fi, Bluetooth, Spotify, playback, display, or reset success.

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
