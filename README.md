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

## Planning

Implementation planning, bugs, and feature work are tracked in GitHub Issues using outcome-oriented milestones:

- M0 Project Foundation
- M1 Local App Skeleton
- M2 Spotify Playback
- M3 Device Setup
- M4 Bedside Polish
- M5 Pi Provisioning & Hardening

MyOS coordination, dispatches, and specialist handoffs live outside this repo in `Active Work/Pipzo`.
