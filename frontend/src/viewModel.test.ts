import { describe, expect, it } from "vitest";

import { localScenarios } from "./localScenarios";
import type { SpotifyAuthSession } from "./contracts";
import {
  canOpenSurface,
  degradedModeViewModel,
  idlePresentation,
  isSetupGated,
  preferredSurface,
  shouldEnterIdleMode,
  speakerSetupViewModel,
  spotifyAuthViewModel,
  wifiSetupViewModel,
} from "./viewModel";

describe("kiosk shell view model", () => {
  it("gates daily-use surfaces during first setup", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;

    expect(isSetupGated(snapshot)).toBe(true);
    expect(preferredSurface(snapshot)).toBe("setup");
    expect(canOpenSurface(snapshot, "home")).toBe(false);
    expect(canOpenSurface(snapshot, "settings")).toBe(true);
  });

  it("keeps settings reachable during degraded recovery", () => {
    const snapshot = localScenarios.degraded_recovery.snapshot;

    expect(isSetupGated(snapshot)).toBe(false);
    expect(preferredSurface(snapshot)).toBe("settings");
    expect(canOpenSurface(snapshot, "settings")).toBe(true);
    expect(canOpenSurface(snapshot, "browse")).toBe(false);
  });

  it("treats post-setup degraded auth loss as recovery mode instead of first-run setup", () => {
    const snapshot = localScenarios.spotify_auth_unavailable.snapshot;
    const degraded = degradedModeViewModel(snapshot);

    expect(isSetupGated(snapshot)).toBe(false);
    expect(preferredSurface(snapshot)).toBe("settings");
    expect(canOpenSurface(snapshot, "settings")).toBe(true);
    expect(canOpenSurface(snapshot, "home")).toBe(true);
    expect(canOpenSurface(snapshot, "browse")).toBe(false);
    expect(degraded.active).toBe(true);
    expect(degraded.detail).toContain("Offline music playback is not supported");
    expect(degraded.unavailable).toContain("Spotify library access");
    expect(degraded.unavailable).toContain("music playback");
  });

  it("keeps Wi-Fi, Bluetooth, and reset recovery visible in offline settings mode", () => {
    const snapshot = localScenarios.offline_settings_mode.snapshot;
    const degraded = degradedModeViewModel(snapshot);

    expect(isSetupGated(snapshot)).toBe(false);
    expect(canOpenSurface(snapshot, "settings")).toBe(true);
    expect(canOpenSurface(snapshot, "now_playing")).toBe(true);
    expect(degraded.available).toEqual(["Settings", "Wi-Fi recovery", "Bluetooth recovery", "App reset"]);
    expect(degraded.unavailable).toEqual(["live library browsing", "music playback"]);
  });

  it("offers local Spotify setup when authorization is required", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;

    const view = spotifyAuthViewModel(snapshot);

    expect(view.title).toBe("Connect Spotify");
    expect(view.detail).toContain("local setup");
    expect(view.actions).toEqual(["start"]);
  });

  it("describes Wi-Fi setup actions from network health and scan results", () => {
    const firstBoot = localScenarios.first_boot_empty.snapshot;
    const ready = localScenarios.ready_healthy.snapshot;
    const localOnly = localScenarios.wifi_local_only.snapshot;

    expect(wifiSetupViewModel(firstBoot).actions).toEqual(["scan"]);
    expect(
      wifiSetupViewModel(firstBoot, [{ ssid: "PipzoNet", signal: 90, security: "wpa2", known: false }]).actions,
    ).toEqual(["scan", "connect"]);
    expect(wifiSetupViewModel(ready).actions).toEqual(["scan", "forget"]);
    expect(wifiSetupViewModel(localOnly).actions).toEqual(["retry", "scan", "forget"]);
  });

  it("describes Bluetooth speaker setup actions from speaker health and scan results", () => {
    const firstBoot = localScenarios.first_boot_empty.snapshot;
    const ready = localScenarios.ready_healthy.snapshot;
    const disconnected = localScenarios.speaker_saved_disconnected.snapshot;

    expect(speakerSetupViewModel(firstBoot).actions).toEqual(["scan"]);
    expect(
      speakerSetupViewModel(firstBoot, [
        { address: "AA:BB:CC:DD:EE:FF", displayName: "Pipzo Speaker", paired: false, connected: false, signal: 88 },
      ]).actions,
    ).toEqual(["scan", "pair"]);
    expect(speakerSetupViewModel(ready).actions).toEqual(["scan", "reconnect", "forget"]);
    expect(speakerSetupViewModel(disconnected).actions).toEqual(["reconnect", "scan", "forget"]);
  });

  it("offers open, poll, and cancel controls while local Spotify auth is waiting", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;
    const session: SpotifyAuthSession = {
      sessionId: "safe-session-id",
      status: "waiting",
      createdAt: "2026-05-29T12:00:00.000Z",
      expiresAt: "2026-05-29T12:10:00.000Z",
      startUrl: "http://127.0.0.1:8000/api/v1/spotify/auth/start/safe-session-id",
      failureReason: null,
      accountDisplayName: null,
    };

    const view = spotifyAuthViewModel(snapshot, session);

    expect(view.title).toBe("Waiting for Spotify authorization");
    expect(view.actions).toEqual(["open", "refresh", "cancel"]);
  });

  it("shows safe account metadata and reconnect controls when Spotify is connected", () => {
    const snapshot = localScenarios.ready_healthy.snapshot;

    const view = spotifyAuthViewModel(snapshot);

    expect(view.title).toBe("Spotify account connected");
    expect(view.accountLabel).toBe("Pipzo");
    expect(view.actions).toEqual(["logout", "reconnect"]);
  });

  it("offers retry after expired, failed, or cancelled Spotify sessions", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;
    const baseSession: SpotifyAuthSession = {
      sessionId: "safe-session-id",
      status: "expired",
      createdAt: "2026-05-29T12:00:00.000Z",
      expiresAt: "2026-05-29T12:10:00.000Z",
      startUrl: "http://127.0.0.1:8000/api/v1/spotify/auth/start/safe-session-id",
      failureReason: "expired_state",
      accountDisplayName: null,
    };

    expect(spotifyAuthViewModel(snapshot, baseSession).actions).toEqual(["retry"]);
    expect(spotifyAuthViewModel(snapshot, { ...baseSession, status: "failed", failureReason: "spotify_error" }).actions).toEqual(["retry"]);
    expect(spotifyAuthViewModel(snapshot, { ...baseSession, status: "cancelled", failureReason: "cancelled" }).actions).toEqual(["retry"]);
  });

  it("enters idle only after the configured timeout on ready surfaces", () => {
    const snapshot = {
      ...localScenarios.ready_healthy.snapshot,
      settings: { ...localScenarios.ready_healthy.snapshot.settings, idleTimeoutSeconds: 60 },
    };

    expect(shouldEnterIdleMode(snapshot, 1_000, 60_999)).toBe(false);
    expect(shouldEnterIdleMode(snapshot, 1_000, 61_000)).toBe(true);
  });

  it("does not enter idle during setup or when idle mode is off", () => {
    const setupSnapshot = localScenarios.first_boot_empty.snapshot;
    const disabledSnapshot = {
      ...localScenarios.ready_healthy.snapshot,
      settings: { ...localScenarios.ready_healthy.snapshot.settings, idleMode: "off" as const },
    };

    expect(shouldEnterIdleMode(setupSnapshot, 1_000, 1_000_000)).toBe(false);
    expect(shouldEnterIdleMode(disabledSnapshot, 1_000, 1_000_000)).toBe(false);
  });

  it("keeps idle clock-first unless artwork is enabled by settings or mode", () => {
    const clock = localScenarios.idle_clock.snapshot;
    const artwork = localScenarios.idle_with_artwork.snapshot;
    const settingArtwork = {
      ...localScenarios.ready_healthy.snapshot,
      settings: { ...localScenarios.ready_healthy.snapshot.settings, artworkInIdle: true },
    };

    expect(idlePresentation(clock).showArtwork).toBe(false);
    expect(idlePresentation(artwork).showArtwork).toBe(true);
    expect(idlePresentation(settingArtwork).showArtwork).toBe(true);
    expect(idlePresentation(clock).brightness).toBe(clock.settings.bedtimeBrightness);
  });
});
