# Seed Issues

These drafts should be created as GitHub Issues after the private remote is configured.

## M0 Project Foundation

### Define repo structure and contribution conventions

Labels: `type:task`, `area:docs`, `priority:p0`

Create the initial software/provisioning repository structure, coding conventions, local commands, and documentation standards.

### Document Spotify developer app setup

Labels: `type:docs`, `area:spotify`, `priority:p0`

Document Spotify developer app creation, redirect URI strategy, scopes, Premium requirement, and local secret/config handling.

### Define backend/frontend API contract

Labels: `type:task`, `area:backend`, `area:frontend`, `priority:p0`

Define the initial HTTP/WebSocket API for app state, setup flow, playback state, settings, and device integrations.

## M1 Local App Skeleton

### Build FastAPI service skeleton

Labels: `type:feature`, `area:backend`, `priority:p0`

Create the backend service skeleton with health checks, config loading, SQLite setup, logging, and mock device adapters.

### Build React kiosk UI skeleton

Labels: `type:feature`, `area:frontend`, `area:ux`, `priority:p0`

Create the touchscreen UI shell with Home, Now Playing, Browse/Search, Setup, and Settings routes.

### Add desktop mock mode

Labels: `type:feature`, `area:device`, `area:test`, `priority:p0`

Support local development with mocked Wi-Fi, Bluetooth, brightness, volume, and playback-device state.

## M2 Spotify Playback

### Implement QR OAuth setup flow

Labels: `type:feature`, `area:spotify`, `area:backend`, `area:frontend`, `priority:p0`

Implement Spotify Authorization Code with PKCE, QR/short-link setup, token refresh, secure local storage, and logout/reset handling.

### Integrate Spotify Web Playback SDK

Labels: `type:feature`, `area:spotify`, `area:frontend`, `priority:p0`

Run Spotify Web Playback SDK inside Chromium, register the Pi as the playback device, and transfer playback to it.

### Implement library browsing and constrained search

Labels: `type:feature`, `area:spotify`, `area:frontend`, `priority:p1`

Support playlists, albums, artists, liked songs, recently played, recommendations, and library-first search.

## M3 Device Setup

### Implement touchscreen Wi-Fi setup

Labels: `type:feature`, `area:device`, `area:backend`, `area:frontend`, `priority:p0`

Scan networks, connect to a selected network with touchscreen password entry, show status, and support recovery from failed connection.

### Implement single-speaker Bluetooth pairing

Labels: `type:feature`, `area:device`, `area:backend`, `area:frontend`, `priority:p0`

Scan, pair, select, forget, auto-reconnect, and display the primary Bluetooth speaker name/status.

### Implement unified volume control

Labels: `type:feature`, `area:device`, `area:spotify`, `priority:p1`

Expose one volume control and coordinate Spotify device volume with Pi/Bluetooth output volume where reliable.

## M4 Bedside Polish

### Implement bedtime idle mode

Labels: `type:feature`, `area:frontend`, `area:ux`, `priority:p0`

Dim the screen and show a quiet clock plus minimal now-playing status after timeout; restore full UI on touch.

### Implement sleep timer

Labels: `type:feature`, `area:frontend`, `area:spotify`, `priority:p1`

Add preset timers such as 15, 30, 45, and 60 minutes and stop playback when the timer expires.

### Implement degraded offline/settings mode

Labels: `type:feature`, `area:frontend`, `area:backend`, `priority:p1`

When Spotify or internet access is unavailable, keep settings, Wi-Fi, Bluetooth, and reset flows reachable.

## M5 Pi Provisioning & Hardening

### Add repeatable provisioning scripts

Labels: `type:task`, `area:provisioning`, `priority:p0`

Automate Raspberry Pi OS package setup, services, kiosk launch, dependencies, and application install.

### Add systemd services and kiosk launcher

Labels: `type:task`, `area:provisioning`, `area:device`, `priority:p0`

Configure backend startup, frontend serving, Chromium kiosk startup, logging, and restart behavior.

### Add hardware validation checklist

Labels: `type:test`, `area:device`, `area:provisioning`, `priority:p1`

Document and verify touchscreen, Wi-Fi, Bluetooth audio, Spotify playback, sleep timer, idle mode, and reset flows on hardware.
