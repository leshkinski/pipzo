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
When `PIPZO_MODE=hardware`, `/api/v1/app/state` routes through explicit production adapter seams. The first production Wi-Fi slice reads NetworkManager state through `nmcli` and projects network readiness into setup state; Bluetooth, display, volume, and playback remain bounded placeholders until their adapters are implemented and validated.
This keeps desktop scenarios useful without implying that mock state is production device state.

The backend initializes a local SQLite database at startup using `PIPZO_DB_PATH`.
The schema includes durable `app_settings` for app-owned preferences plus a single-account `spotify_auth` record for backend-owned Spotify access/refresh tokens and safe account metadata. `GET/PATCH /api/v1/settings` is available in both mock and hardware modes because it does not claim that any platform action succeeded. Hardware-facing operations remain behind adapter seams.
Token fields are protected by `SPOTIFY_TOKEN_STORAGE_PROTECTION=local_key_encrypted`: `SpotifyAuthStore` encrypts access and refresh tokens before SQLite writes and decrypts them only for backend auth/Spotify service code. Safe account/status metadata remains plaintext so UI health and setup state can be projected without exposing token material.

The V1 key strategy is an app-managed Fernet key at `PIPZO_TOKEN_KEY_PATH`, defaulting to `./data/spotify-token.key`, with `PIPZO_TOKEN_KEY_AUTO_CREATE=true` for local appliance setup. Generated key files are created with `0600` permissions where supported and the key directory should be private to the service user, for example `0700` on Raspberry Pi OS. If the key is missing, invalid, or wrong for the stored ciphertext, token reads fail safe into reconnect-required auth health; losing the key requires Spotify reconnect. Backups that need to preserve the Spotify connection must keep the DB and token key together. Logout/reset deletes the encrypted token record, not the key file.
Structured JSON logs are controlled by `PIPZO_LOG_LEVEL` and avoid request bodies and query strings by design.

On installed Pi kiosk builds, `PIPZO_FRONTEND_DIST` points the backend at the built Vite assets so Chromium can load `http://127.0.0.1:8000/` from the same local origin as `/api`. This keeps the kiosk launch contract to one local URL while preserving the separate frontend build step.

Spotify OAuth V1 setup is local to Pi/Chromium. The backend creates transient in-memory Authorization Code with PKCE sessions, owns the verifier/state, exposes only safe session metadata, redirects the local browser through `/api/v1/spotify/auth/start/{sessionId}`, receives the loopback callback at `/api/v1/spotify/auth/callback`, exchanges the code at Spotify's token endpoint with `client_id`, exact `redirect_uri`, and PKCE `code_verifier`, then fetches `/v1/me` for safe account/product metadata. Register `http://127.0.0.1:8000/api/v1/spotify/auth/callback` in the Spotify developer dashboard for local development.

Spotify token refresh is exposed as a backend helper for startup/pre-call integration. It refreshes with `grant_type=refresh_token`, the stored refresh token, and `client_id`, without a client secret. If Spotify omits a replacement refresh token, Pipzo retains the existing one. Refresh success updates access token, expiry, scopes, last refresh timestamp, and safe status metadata; refresh failures store coarse error codes and project safe `health.spotifyAuth` / reconnect warning state. A periodic background refresh worker is deferred until Spotify Web API call sites and retry/backoff policy exist.

`POST /api/v1/spotify/auth/logout` and the mock app reset path clear stored Spotify auth/account state and pending auth sessions, then emit safe auth/snapshot events. Phone QR/relay OAuth remains a follow-on surface.

Wi-Fi status, scan, connect, forget, and internet-probe retry are implemented behind a NetworkManager/nmcli adapter. The adapter invokes `nmcli` with argument vectors rather than shell strings, returns coarse contract reasons for failures, and does not expose Wi-Fi passwords in logs, events, or responses. Hardware mode without `nmcli` or required NetworkManager permissions returns honest unavailable responses instead of fake success. Bluetooth contract routes still return `501` until the BlueZ adapter slice is implemented and validated on the target Pi.

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
