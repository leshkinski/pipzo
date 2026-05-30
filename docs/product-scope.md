# Product Scope

## Product Intent

Pipzo is a stand-alone music appliance, not a general Spotify display or tablet replacement.

The user should be able to walk up to the device, use the touchscreen, browse her Spotify music from Home, and start playback through a Bluetooth speaker without using another screen.

## V1 Must Have

- Spotify login using OAuth Authorization Code with PKCE.
- Local Pi/Chromium Spotify OAuth setup using the loopback callback registered in the Spotify developer dashboard.
- Single Spotify Premium user account.
- True fullscreen kiosk interface for daily use.
- Auto-start on boot.
- Touch-first UI.
- Browse user Spotify content from Home:
  - Playlists.
  - Albums.
  - Artists.
  - Recently played.
  - Liked songs.
- Continue Listening home screen.
- Now Playing screen.
- Album art display.
- Play/pause.
- Next/previous.
- One volume control for Spotify and Pi/Bluetooth output where reliable.
- Bluetooth speaker output.
- In-app Wi-Fi setup.
- In-app single-speaker Bluetooth pairing, forget, status, display name, and auto-reconnect.
- Settings page.
- App-level reset.
- Bedtime idle mode.
- Simple sleep timer.
- Degraded offline/settings mode.

## Deferred

- Daily-use text search.
- Speech search investigation for a future hardware version.
- Built-in speaker.
- Physical controls.
- Offline Spotify playback.
- Local MP3 support.
- Multiple Spotify accounts.
- Multiple saved Bluetooth speakers.
- Weather.
- Voice control.
- Queue editing.
- Explicit content filtering beyond Spotify account/family controls.
- Parent lock system.
- Battery operation.
- Phone QR/short-link OAuth and HTTPS callback relay.
