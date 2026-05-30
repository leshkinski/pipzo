import { describe, expect, it } from "vitest";

// @ts-expect-error Node types are intentionally not part of the browser app tsconfig.
import { readFileSync } from "node:fs";
import { localScenarios } from "./localScenarios";
import type { SpotifyAuthSession } from "./contracts";
import {
  cancelSleepTimer,
  canPlayLibraryItem,
  canOpenSurface,
  canUseSleepTimer,
  degradedModeViewModel,
  idlePresentation,
  isSetupGated,
  libraryAvailability,
  nextNowPlayingBoundaryRefreshDelayMs,
  nowPlayingCommandRefreshDelaysMs,
  nowPlayingEmptyState,
  nowPlayingRefreshIntervalMs,
  preferredSurface,
  shouldRefreshNowPlaying,
  shouldEnterIdleMode,
  sleepTimerExpiryCommand,
  sleepTimerViewModel,
  speakerSetupViewModel,
  startSleepTimer,
  spotifyAuthViewModel,
  volumeControlViewModel,
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

  it("models library browse/search availability from app capabilities", () => {
    const ready = localScenarios.ready_healthy.snapshot;
    const offline = localScenarios.offline_settings_mode.snapshot;
    const item = {
      id: "track-id",
      type: "track" as const,
      uri: "spotify:track:track-id",
      title: "Quiet Song",
      source: "liked_songs" as const,
      playbackKind: "track" as const,
      playable: true,
    };

    expect(libraryAvailability(ready)).toMatchObject({
      canBrowse: true,
      canSearch: true,
      canStartPlayback: true,
      title: "Browse saved music",
    });
    expect(canPlayLibraryItem(ready, item)).toBe(true);
    expect(libraryAvailability(offline)).toMatchObject({
      canBrowse: false,
      canSearch: false,
      canStartPlayback: false,
      stale: true,
      title: "Library is in recovery mode",
    });
    expect(canPlayLibraryItem(offline, item)).toBe(false);
    expect(canPlayLibraryItem(ready, { ...item, playbackKind: "unavailable", playable: false })).toBe(false);
  });

  it("models the single app volume control from volume health", () => {
    const ready = localScenarios.ready_healthy.snapshot;
    const outOfSync = localScenarios.volume_out_of_sync.snapshot;
    const unavailable = localScenarios.first_boot_empty.snapshot;

    expect(volumeControlViewModel(ready)).toMatchObject({
      value: 42,
      disabled: false,
      statusLabel: "42%",
      tone: "ready",
    });
    expect(volumeControlViewModel(outOfSync)).toMatchObject({
      value: 42,
      disabled: false,
      statusLabel: "Out of sync",
      tone: "attention",
    });
    expect(volumeControlViewModel(unavailable)).toMatchObject({
      disabled: true,
      statusLabel: "Unavailable",
      tone: "attention",
    });
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
    expect(wifiSetupViewModel(firstBoot).ipAddressLabel).toBe("Unknown");
    expect(
      wifiSetupViewModel(firstBoot, [{ ssid: "PipzoNet", signal: 90, security: "wpa2", known: false }]).actions,
    ).toEqual(["scan", "connect"]);
    expect(wifiSetupViewModel(ready).actions).toEqual(["scan", "forget"]);
    expect(wifiSetupViewModel(ready).ipAddressLabel).toBe("192.168.1.42");
    expect(wifiSetupViewModel(localOnly).actions).toEqual(["retry", "scan", "forget"]);
    expect(wifiSetupViewModel(localOnly).ipAddressLabel).toBe("192.168.1.42");
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

  it("creates preset sleep timers and reports countdown state without waiting real minutes", () => {
    const snapshot = localScenarios.ready_healthy.snapshot;
    const timer = startSleepTimer(30, 1_000);

    const active = sleepTimerViewModel(snapshot, timer, 1_000 + 10 * 60 * 1000);
    const due = sleepTimerViewModel(snapshot, timer, 1_000 + 30 * 60 * 1000);

    expect(active.canStart).toBe(true);
    expect(active.canCancel).toBe(true);
    expect(active.label).toBe("Stops in 20:00");
    expect(due.expired).toBe(true);
    expect(due.label).toBe("Timer ended");
  });

  it("cancels sleep timers back to the idle state", () => {
    const snapshot = localScenarios.ready_healthy.snapshot;
    const view = sleepTimerViewModel(snapshot, cancelSleepTimer(), 1_000);

    expect(view.active).toBe(false);
    expect(view.canCancel).toBe(false);
    expect(view.label).toBe("Sleep timer ready");
  });

  it("blocks sleep timer use honestly when playback control is unavailable", () => {
    const snapshot = localScenarios.offline_settings_mode.snapshot;
    const timer = startSleepTimer(15, 1_000);
    const view = sleepTimerViewModel(snapshot, timer, 1_000);
    const command = sleepTimerExpiryCommand(snapshot, timer, 1_000 + 15 * 60 * 1000);

    expect(canUseSleepTimer(snapshot)).toBe(false);
    expect(view.detail).toContain("Playback control is currently unavailable");
    expect(command.shouldStop).toBe(false);
    expect(command.blockedReason).toBe("network_unavailable");
  });

  it("emits a playback stop command at sleep timer expiry when playback is controllable", () => {
    const snapshot = localScenarios.ready_healthy.snapshot;
    const timer = startSleepTimer(60, 1_000);

    expect(sleepTimerExpiryCommand(snapshot, timer, 1_000 + 59 * 60 * 1000).shouldStop).toBe(false);
    expect(sleepTimerExpiryCommand(snapshot, timer, 1_000 + 60 * 60 * 1000)).toEqual({
      shouldStop: true,
      action: "stop",
      deviceId: "pipzo-web-player",
    });
  });

  it("keeps now-playing artwork panels square in CSS", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const artPanelRule = css.match(/\.art-panel\s*\{[^}]+\}/)?.[0] ?? "";

    expect(artPanelRule).toContain("aspect-ratio: 1 / 1");
    expect(artPanelRule).toContain("min-height: 0");
  });

  it("shows Spotify current-playback diagnostics instead of a plain empty state", () => {
    const snapshot = {
      ...localScenarios.ready_healthy.snapshot,
      nowPlaying: null,
      diagnostics: {
        ...localScenarios.ready_healthy.snapshot.diagnostics,
        lastCommand: "spotify.current_playback",
        rawAdapterCode: "device_mismatch:stored=old:active=new",
      },
    };

    expect(nowPlayingEmptyState(snapshot)).toEqual({
      title: "Playback is on another Spotify device",
      detail: "device_mismatch:stored=old:active=new",
    });
  });

  it("bounds Now Playing backend refreshes to ready playback state", () => {
    const ready = localScenarios.ready_healthy.snapshot;
    const firstBoot = localScenarios.first_boot_empty.snapshot;
    const offline = localScenarios.offline_settings_mode.snapshot;

    expect(nowPlayingRefreshIntervalMs).toBe(10_000);
    expect(nowPlayingCommandRefreshDelaysMs).toEqual([900, 2_500]);
    expect(shouldRefreshNowPlaying(ready, "backend")).toBe(true);
    expect(shouldRefreshNowPlaying({ ...ready, nowPlaying: null }, "backend")).toBe(true);
    expect(shouldRefreshNowPlaying(ready, "local")).toBe(false);
    expect(shouldRefreshNowPlaying(firstBoot, "backend")).toBe(false);
    expect(shouldRefreshNowPlaying(offline, "backend")).toBe(false);
  });

  it("schedules a bounded Now Playing refresh near the expected track boundary", () => {
    const snapshot = {
      ...localScenarios.ready_healthy.snapshot,
      nowPlaying: {
        ...localScenarios.ready_healthy.snapshot.nowPlaying!,
        isPlaying: true,
        progressMs: 118_000,
        durationMs: 120_000,
        capturedAt: "2026-05-30T12:00:00.000Z",
      },
    };

    expect(nextNowPlayingBoundaryRefreshDelayMs(snapshot, Date.parse("2026-05-30T12:00:00.500Z"))).toBe(3_000);
    expect(nextNowPlayingBoundaryRefreshDelayMs(snapshot, Date.parse("2026-05-30T12:00:03.000Z"))).toBe(1_000);
    expect(nextNowPlayingBoundaryRefreshDelayMs(localScenarios.first_boot_empty.snapshot, Date.now())).toBeNull();
  });
});
