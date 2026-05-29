# Architecture Notes

## Target Stack

- Backend: Python 3, FastAPI, Uvicorn, SQLite.
- Frontend: React, Vite, TypeScript.
- Playback: Spotify Web Playback SDK inside Chromium.
- Music data/control: Spotify Web API.
- OS target: Raspberry Pi OS Desktop.
- Kiosk: Chromium launched full-screen at boot.
- Services: systemd units for backend and kiosk launcher.
- Device integration: OS adapters for Wi-Fi, Bluetooth, brightness, audio volume, and app reset.

## Design Principle

All hardware and OS integrations should sit behind clear interfaces with mock implementations for desktop development.

This lets the app be developed and tested without a Raspberry Pi attached, while the real adapters can be validated on hardware.

The current backend skeleton only implements the mock adapter path for the `AppSnapshot` contract.
When `PIPZO_MODE=hardware`, `/api/v1/app/state` routes through explicit production adapter seams and deliberately returns an unimplemented response until real NetworkManager, BlueZ, Spotify, volume, and kiosk adapters are added.
This keeps desktop scenarios useful without implying that mock state is production device state.

The backend initializes a local SQLite database at startup using `PIPZO_DB_PATH`.
The schema includes a single-account `spotify_auth` record for backend-owned Spotify access/refresh tokens plus safe account metadata. Current token protection is explicit dev/plaintext SQLite via `SPOTIFY_TOKEN_STORAGE_PROTECTION=sqlite_plaintext_dev`; encryption or OS keyring-backed storage remains a hardening seam before broader release.
Structured JSON logs are controlled by `PIPZO_LOG_LEVEL` and avoid request bodies and query strings by design.

Spotify OAuth V1 setup is local to Pi/Chromium. The backend creates transient in-memory Authorization Code with PKCE sessions, owns the verifier/state, exposes only safe session metadata, redirects the local browser through `/api/v1/spotify/auth/start/{sessionId}`, receives the loopback callback at `/api/v1/spotify/auth/callback`, exchanges the code at Spotify's token endpoint with `client_id`, exact `redirect_uri`, and PKCE `code_verifier`, then fetches `/v1/me` for safe account/product metadata. Register `http://127.0.0.1:8000/api/v1/spotify/auth/callback` in the Spotify developer dashboard for local development. Refresh scheduling, logout/reset cleanup, frontend setup UI integration, encryption/keyring-backed token protection, and phone QR/relay OAuth remain follow-on surfaces.

## High-Level Components

```text
React UI
  -> Backend HTTP/WebSocket API
    -> Spotify auth/session service
    -> Spotify Web API client
    -> Device state/settings store
    -> OS integration adapters
       -> Wi-Fi
       -> Bluetooth
       -> Audio volume
       -> Brightness
       -> Kiosk/reset

Chromium Web Playback SDK
  -> Spotify playback device
  -> Pi audio output
  -> Bluetooth speaker
```
