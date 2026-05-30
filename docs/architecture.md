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

When `PIPZO_MODE=hardware`, `/api/v1/app/state` routes through explicit production adapter seams. The first production Wi-Fi slice reads NetworkManager state through `nmcli` and projects network readiness into setup state. The first production Bluetooth slice reads BlueZ state through `bluetoothctl`, persists one primary speaker address/display name, and projects connected-speaker readiness into setup state. The first volume slice reads and writes the default desktop audio sink through `wpctl` or `pactl` and coordinates it with Spotify device volume through the backend Spotify token boundary. Display and broader playback validation still have bounded placeholder or app-owned behavior until their adapters are implemented and validated.
This keeps desktop scenarios useful without implying that mock state is production device state.

The backend initializes a local SQLite database at startup using `PIPZO_DB_PATH`.
The schema includes durable `app_settings` for app-owned preferences, a single-account `spotify_auth` record for backend-owned Spotify access/refresh tokens and safe account metadata, and one `bluetooth_speaker` record for the selected primary speaker. `GET/PATCH /api/v1/settings` is available in both mock and hardware modes because it does not claim that any platform action succeeded. Hardware-facing operations remain behind adapter seams.
Token fields are protected by `SPOTIFY_TOKEN_STORAGE_PROTECTION=local_key_encrypted`: `SpotifyAuthStore` encrypts access and refresh tokens before SQLite writes and decrypts them only for backend auth/Spotify service code. Safe account/status metadata remains plaintext so UI health and setup state can be projected without exposing token material.

The V1 key strategy is an app-managed Fernet key at `PIPZO_TOKEN_KEY_PATH`, defaulting to `./data/spotify-token.key`, with `PIPZO_TOKEN_KEY_AUTO_CREATE=true` for local appliance setup. Generated key files are created with `0600` permissions where supported and the key directory should be private to the service user, for example `0700` on Raspberry Pi OS. If the key is missing, invalid, or wrong for the stored ciphertext, token reads fail safe into reconnect-required auth health; losing the key requires Spotify reconnect. Backups that need to preserve the Spotify connection must keep the DB and token key together. Logout/reset deletes the encrypted token record, not the key file.
Structured JSON logs are controlled by `PIPZO_LOG_LEVEL` and avoid request bodies and query strings by design.

On installed Pi kiosk builds, `PIPZO_FRONTEND_DIST` points the backend at the built Vite assets so Chromium can load `http://127.0.0.1:8000/` from the same local origin as `/api`. This keeps the kiosk launch contract to one local URL while preserving the separate frontend build step.

Spotify OAuth V1 setup is local to Pi/Chromium. The backend creates transient in-memory Authorization Code with PKCE sessions, owns the verifier/state, exposes only safe session metadata, redirects the local browser through `/api/v1/spotify/auth/start/{sessionId}`, receives the loopback callback at `/api/v1/spotify/auth/callback`, exchanges the code at Spotify's token endpoint with `client_id`, exact `redirect_uri`, and PKCE `code_verifier`, then fetches `/v1/me` for safe account/product metadata. Register `http://127.0.0.1:8000/api/v1/spotify/auth/callback` in the Spotify developer dashboard for local development.

Spotify token refresh is exposed as a backend helper for startup/pre-call integration. It refreshes with `grant_type=refresh_token`, the stored refresh token, and `client_id`, without a client secret. If Spotify omits a replacement refresh token, Pipzo retains the existing one. Refresh success updates access token, expiry, scopes, last refresh timestamp, and safe status metadata; refresh failures store coarse error codes and project safe `health.spotifyAuth` / reconnect warning state. A periodic background refresh worker is deferred until Spotify Web API call sites and retry/backoff policy exist.

`POST /api/v1/spotify/auth/logout` and the mock app reset path clear stored Spotify auth/account state and pending auth sessions, then emit safe auth/snapshot events. Phone QR/relay OAuth remains a follow-on surface.

Wi-Fi status, scan, connect, forget, and internet-probe retry are implemented behind a NetworkManager/nmcli adapter. The adapter invokes `nmcli` with argument vectors rather than shell strings, returns coarse contract reasons for failures, and does not expose Wi-Fi passwords in logs, events, or responses. The network health contract includes the active Wi-Fi IPv4 address when known so Network settings can support SSH/debug during hardware validation. Hardware mode without `nmcli` or required NetworkManager permissions returns honest unavailable responses instead of fake success.

Bluetooth speaker status, scan, pair/trust/connect, reconnect, and forget are implemented behind a BlueZ/bluetoothctl adapter. The adapter invokes `bluetoothctl` as a subprocess with fixed argument vectors and newline-delimited commands rather than shell strings, parses `devices` and `info` output through testable seams, stores only one primary speaker, and maps missing tools, disabled Bluetooth, pairing rejection, timeouts, out-of-range devices, connect failures, and audio-profile failures to coarse contract reasons. Hardware mode without `bluetoothctl` or BlueZ permissions returns unavailable responses instead of fake success. Real A2DP route selection and reconnect behavior still require target Pi validation.

Unified volume control is exposed as one app surface backed by `PATCH /api/v1/volume`. In mock mode it deterministically projects `health.volume` without audio hardware. In hardware mode the backend attempts Spotify device volume first, then the OS sink through the volume adapter. The response may be `unified`, `spotify_only`, `os_only`, `out_of_sync`, or `unavailable`, so the UI can show honest partial behavior when Spotify read/write, PipeWire/WirePlumber, the default sink, the kiosk user's audio session, or permissions are missing. The adapter uses fixed subprocess argument vectors, can target `PIPZO_AUDIO_USER` via `/run/user/<uid>`, and does not log Spotify tokens.

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
