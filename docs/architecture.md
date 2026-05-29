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
