# Spotify Developer Setup

Pipzo V1 uses Spotify Authorization Code with PKCE from the Pi's own Chromium browser. The backend owns the OAuth session, callback, token exchange, refresh helper, encrypted token persistence, logout, and reset cleanup.

Official Spotify references:

- App dashboard: https://developer.spotify.com/dashboard
- PKCE flow: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Redirect URI rules: https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- Scopes: https://developer.spotify.com/documentation/web-api/concepts/scopes
- Web Playback SDK guide: https://developer.spotify.com/documentation/web-playback-sdk/guide

## Create The Spotify App

1. Open the Spotify Developer Dashboard and create an app.
2. Copy the app's Client ID into local `.env` as `SPOTIFY_CLIENT_ID`.
3. Do not configure a client secret for Pipzo. The implemented flow is PKCE and sends `client_id` plus `code_verifier`, not a client secret.
4. Add this redirect URI exactly:

```text
http://127.0.0.1:8000/api/v1/spotify/auth/callback
```

Spotify requires redirect URIs to match the dashboard entry exactly. For loopback development, use explicit loopback IP literals such as `127.0.0.1`; `localhost` is not allowed by Spotify's current redirect URI rules. Non-loopback redirect URIs require HTTPS.

## V1 Redirect Strategy

V1 OAuth is local Pi/Chromium only:

- The backend runs on the device at `127.0.0.1:8000`.
- The kiosk UI starts a transient backend PKCE session through `POST /api/v1/spotify/auth/session`.
- The device browser opens `/api/v1/spotify/auth/start/{sessionId}`.
- The backend redirects local Chromium to Spotify Accounts with `response_type=code`, `code_challenge_method=S256`, the configured scopes, and the exact loopback redirect URI.
- Spotify redirects local Chromium back to `/api/v1/spotify/auth/callback`.
- The backend validates `state`, exchanges the code for tokens, fetches safe account profile metadata, and stores the single account record.

Phone QR/short-link OAuth and an HTTPS callback relay are deliberately deferred beyond V1. A phone cannot complete a loopback redirect to the Pi's `127.0.0.1`, and Spotify requires HTTPS for non-loopback callbacks. Do not add a phone QR or relay flow without a separate design/security pass.

## Local Environment

Copy `.env.example` to `.env` and set at least `SPOTIFY_CLIENT_ID`.

Current `.env.example` Spotify values:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/api/v1/spotify/auth/callback
SPOTIFY_AUTH_URL=https://accounts.spotify.com/authorize
SPOTIFY_TOKEN_URL=https://accounts.spotify.com/api/token
SPOTIFY_API_BASE_URL=https://api.spotify.com
SPOTIFY_SCOPES=streaming user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read user-read-recently-played user-read-private
SPOTIFY_TOKEN_STORAGE_PROTECTION=local_key_encrypted
PIPZO_TOKEN_KEY_PATH=./data/spotify-token.key
PIPZO_TOKEN_KEY_AUTO_CREATE=true
PIPZO_PUBLIC_BASE_URL=http://127.0.0.1:8000
```

The default auth-session TTL is 600 seconds. It can be overridden with `SPOTIFY_AUTH_SESSION_TTL_SECONDS`, but that variable is intentionally not required in `.env.example`.

## Scopes

Pipzo currently requests these scopes:

| Scope | Why Pipzo requests it |
|---|---|
| `streaming` | Enables Spotify Web Playback SDK playback in Chromium. |
| `user-read-playback-state` | Reads playback state and Spotify Connect device state. |
| `user-modify-playback-state` | Starts, pauses, skips, seeks, sets volume, and transfers playback. |
| `user-read-currently-playing` | Powers Now Playing and current-track display. |
| `playlist-read-private` | Reads private playlists for library-first browsing. |
| `playlist-read-collaborative` | Includes collaborative playlists in playlist browsing. |
| `user-library-read` | Reads saved tracks/albums for Liked Songs and library browsing. |
| `user-read-recently-played` | Supports recent listening and Continue Listening surfaces. |
| `user-read-private` | Reads safe profile/product/country metadata for account confirmation and Premium readiness. |

Avoid adding write scopes unless a feature requires them. Queue editing, library modification, and playlist editing are out of V1.

The V1 Artists browse category is derived from saved albums, liked songs, and recently played tracks. Pipzo does not request `user-follow-read` in V1, so adding a true followed-artists surface later would require a scope change and user reconnect.

## Premium Requirement

Pipzo is a playback appliance and requires a Spotify Premium account. Spotify player-control endpoints and Web Playback SDK playback are Premium surfaces. The backend stores safe profile metadata such as account ID, display name, product, country, Premium flag, scopes, and timestamps so the UI can show whether reconnect or Premium readiness is needed.

## Web Playback SDK Runtime

After local OAuth is complete, the kiosk frontend loads Spotify's Web Playback SDK once from `https://sdk.scdn.co/spotify-player.js` and registers a browser player named `Pipzo`.

The SDK receives access tokens only through:

```text
GET /api/v1/spotify/playback/token
```

That endpoint refreshes access on the backend when needed, returns only the short-lived access token, token type, scope, and expiry, and rejects missing auth or non-Premium accounts. Refresh tokens, PKCE verifier/state, encrypted token values, key material, and raw Spotify token responses remain backend-only.

When the SDK reports a ready browser device ID, the frontend asks the backend to transfer Spotify Connect playback to that device:

```text
POST /api/v1/spotify/playback/transfer
{"deviceId":"<sdk device id>","play":false}
```

The `play:false` transfer selects Pipzo without claiming that audio output has been validated. Actual Bluetooth output is still a separate platform validation item.

Playback controls use `POST /api/v1/playback/control` with an optional `deviceId`. In hardware mode, the backend maps play, pause/stop, next, and previous to Spotify Web API player endpoints using the backend-owned access-token boundary. In mock mode, existing simulated playback behavior remains available for desktop development.

Library browsing and constrained search use the same backend token boundary:

```text
GET /api/v1/library/home
GET /api/v1/library/{playlists|albums|artists|liked_songs|recently_played}
GET /api/v1/library/search?q=<query>
POST /api/v1/library/play
```

Search filters fetched library/account sections locally. It is intentionally not a broad Spotify Search discovery surface in V1.

## Token Key And Reset Caveats

Spotify access and refresh tokens are backend-only. They must not appear in frontend state, WebSocket events, logs, docs, issue comments, diagnostics, or commits.

Local storage behavior:

- Tokens are stored in SQLite under `PIPZO_DB_PATH` and encrypted with a local Fernet key at `PIPZO_TOKEN_KEY_PATH`.
- The generated key file is ignored by Git and should be private to the service user. Generated key files are written with `0600` permissions where supported.
- The SQLite DB and token key are a pair for preserving Spotify auth. Back up both together if preserving the connection matters.
- Losing, deleting, corrupting, or replacing the token key makes existing encrypted tokens unreadable. Pipzo fails safe into reconnect-required auth state.
- Logout and app reset delete the encrypted Spotify auth record and clear pending auth sessions, but leave the local token key in place.
- Deleting both the DB token record and token key is safe, but the user must reconnect Spotify.

Generated local files under `data/`, `.env`, `.env.*`, `*.key`, `*.sqlite`, and `*.sqlite3` are ignored.
