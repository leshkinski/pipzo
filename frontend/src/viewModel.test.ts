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
  homeLibraryCategoryOrder,
  nextNowPlayingBoundaryRefreshDelayMs,
  nowPlayingCommandRefreshDelaysMs,
  nowPlayingEmptyState,
  nowPlayingRefreshIntervalMs,
  preferredSpeakerSelection,
  preferredSurface,
  primarySurfaces,
  shouldRefreshNowPlaying,
  shouldPollAppStateForSetupReadiness,
  shouldRetryBackendRecovery,
  shouldRefreshHomeOnOpen,
  shouldShowDeveloperPanel,
  shellNavigationItems,
  shouldEnterIdleMode,
  shouldSuppressBluetoothSuccessAlert,
  sleepTimerExpiryCommand,
  speakerDeviceRows,
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

  it("defaults completed setup away from stale setup surfaces on fresh kiosk start", () => {
    const snapshot = {
      ...localScenarios.ready_healthy.snapshot,
      surfaces: { ...localScenarios.ready_healthy.snapshot.surfaces, current: "setup" as const, route: "/setup/complete" },
    };

    expect(isSetupGated(snapshot)).toBe(false);
    expect(canOpenSurface(snapshot, "setup")).toBe(false);
    expect(preferredSurface(snapshot)).toBe("home");
  });

  it("treats backend ready connected speaker snapshots as ungated even with stale setup metadata", () => {
    const snapshot = {
      ...localScenarios.ready_healthy.snapshot,
      appPhase: "ready" as const,
      setup: { ...localScenarios.ready_healthy.snapshot.setup, blockingStep: "speaker" as const },
      readiness: {
        ...localScenarios.ready_healthy.snapshot.readiness,
        minimumReady: true,
        primarySpeakerSaved: true,
        setupCompletedAt: undefined,
      },
      health: {
        ...localScenarios.ready_healthy.snapshot.health,
        speaker: {
          status: "connected" as const,
          primary: {
            address: "CC:98:8B:94:B5:1C",
            displayName: "WH-1000XM3",
            connected: true,
          },
        },
      },
      surfaces: { ...localScenarios.ready_healthy.snapshot.surfaces, current: "setup" as const, route: "/setup/speaker" },
    };

    expect(isSetupGated(snapshot)).toBe(false);
    expect(preferredSurface(snapshot)).toBe("home");
    expect(canOpenSurface(snapshot, "setup")).toBe(false);
    expect(shouldPollAppStateForSetupReadiness(snapshot, "backend")).toBe(false);
  });

  it("polls backend app state only while setup readiness is gated", () => {
    expect(shouldPollAppStateForSetupReadiness(localScenarios.first_boot_empty.snapshot, "backend")).toBe(true);
    expect(shouldPollAppStateForSetupReadiness(localScenarios.first_boot_empty.snapshot, "local")).toBe(false);
    expect(shouldPollAppStateForSetupReadiness(localScenarios.ready_healthy.snapshot, "backend")).toBe(false);
  });

  it("retries backend recovery only from local fallback mode", () => {
    expect(shouldRetryBackendRecovery("local")).toBe(true);
    expect(shouldRetryBackendRecovery("backend")).toBe(false);
  });

  it("hides mock controls in hardware fallback unless local development enables them", () => {
    expect(shouldShowDeveloperPanel("backend", "hardware", false)).toBe(false);
    expect(shouldShowDeveloperPanel("local", null, false)).toBe(false);
    expect(shouldShowDeveloperPanel("local", null, true)).toBe(true);
    expect(shouldShowDeveloperPanel("backend", "mock", false)).toBe(true);
  });

  it("auto-refreshes Home only when backend library browsing is available", () => {
    expect(shouldRefreshHomeOnOpen("home", localScenarios.ready_healthy.snapshot, "backend")).toBe(true);
    expect(shouldRefreshHomeOnOpen("home", localScenarios.ready_healthy.snapshot, "local")).toBe(false);
    expect(shouldRefreshHomeOnOpen("settings", localScenarios.ready_healthy.snapshot, "backend")).toBe(false);
    expect(shouldRefreshHomeOnOpen("home", localScenarios.offline_settings_mode.snapshot, "backend")).toBe(false);
  });

  it("suppresses blocking Bluetooth success alerts but leaves unrelated alerts alone", () => {
    expect(shouldSuppressBluetoothSuccessAlert("Pairing successful")).toBe(true);
    expect(shouldSuppressBluetoothSuccessAlert("Connection successful")).toBe(true);
    expect(shouldSuppressBluetoothSuccessAlert("Bluetooth speaker connected.")).toBe(true);
    expect(shouldSuppressBluetoothSuccessAlert("Connected to SRS-XE300")).toBe(true);

    expect(shouldSuppressBluetoothSuccessAlert("Speaker pairing failed")).toBe(false);
    expect(shouldSuppressBluetoothSuccessAlert("Spotify account connected.")).toBe(false);
    expect(shouldSuppressBluetoothSuccessAlert("")).toBe(false);
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

  it("models library availability from app capabilities while search remains deferred", () => {
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
      title: "Saved music",
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

  it("keeps Browse and Idle out of primary kiosk navigation", () => {
    expect(primarySurfaces).toEqual(["home", "now_playing", "settings"]);
  });

  it("demotes Settings behind the two daily kiosk destinations", () => {
    expect(shellNavigationItems()).toEqual([
      { surface: "home", label: "Home", priority: "primary" },
      { surface: "now_playing", label: "Now Playing", priority: "primary" },
      { surface: "settings", label: "Settings", priority: "utility" },
    ]);
  });

  it("prioritizes the default Home library order around recent listening", () => {
    expect(homeLibraryCategoryOrder).toEqual(["recently_played", "playlists", "albums", "liked_songs", "artists"]);
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
    expect(volumeControlViewModel({ ...ready, health: { ...ready.health, volume: { status: "os_only", value: 31, muted: false } } })).toMatchObject({
      value: 31,
      disabled: false,
      statusLabel: "31%",
      tone: "ready",
      detail: "Pi output volume is controlled locally.",
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
    expect(
      speakerSetupViewModel(ready, [
        { address: "11:22:33:44:55:66", displayName: "Kitchen Headset", paired: false, connected: false, signal: 62 },
      ]).actions,
    ).toEqual(["scan", "pair", "reconnect", "forget"]);
    expect(speakerSetupViewModel(disconnected).actions).toEqual(["reconnect", "scan", "forget"]);
    expect(
      speakerSetupViewModel(disconnected, [
        { address: "11:22:33:44:55:66", displayName: "Kitchen Headset", paired: false, connected: false, signal: 62 },
      ]).actions,
    ).toEqual(["reconnect", "scan", "pair", "forget"]);
  });

  it("surfaces replacement speaker rows while a primary speaker is connected", () => {
    const ready = localScenarios.ready_healthy.snapshot;
    const devices = [
      { address: "AA:BB:CC:DD:EE:FF", displayName: "Bedroom speaker", paired: true, connected: true, signal: 88 },
      { address: "CC:98:8B:94:B5:1C", displayName: "WH-1000XM3", alias: "WH-1000XM3", paired: false, connected: false, signal: null },
    ];

    expect(speakerSetupViewModel(ready, devices).actions).toContain("pair");
    expect(preferredSpeakerSelection(ready, devices, "AA:BB:CC:DD:EE:FF")).toBe("CC:98:8B:94:B5:1C");
    expect(speakerDeviceRows(ready, devices, "CC:98:8B:94:B5:1C")).toEqual([
      expect.objectContaining({ title: "Bedroom speaker", selected: false, currentPrimary: true }),
      expect.objectContaining({ title: "WH-1000XM3", selected: true, currentPrimary: false }),
    ]);
  });

  it("keeps scanned replacement speaker visible after the primary is forgotten", () => {
    const forgotten = {
      ...localScenarios.ready_healthy.snapshot,
      health: { ...localScenarios.ready_healthy.snapshot.health, speaker: { status: "none_saved" as const, reason: "user_forgot" as const } },
      readiness: { ...localScenarios.ready_healthy.snapshot.readiness, primarySpeakerSaved: false },
    };
    const devices = [
      { address: "CC:98:8B:94:B5:1C", displayName: "WH-1000XM3", alias: "WH-1000XM3", paired: false, connected: false, signal: null },
    ];

    expect(speakerSetupViewModel(forgotten, devices).actions).toEqual(["scan", "pair"]);
    expect(preferredSpeakerSelection(forgotten, devices, "")).toBe("CC:98:8B:94:B5:1C");
    expect(speakerDeviceRows(forgotten, devices, "CC:98:8B:94:B5:1C")[0]).toEqual(
      expect.objectContaining({ title: "WH-1000XM3", selected: true, currentPrimary: false }),
    );
  });

  it("prefers a discovered replacement when the saved primary is disconnected", () => {
    const disconnected = localScenarios.speaker_saved_disconnected.snapshot;
    const primaryAddress = disconnected.health.speaker.primary?.address ?? "";
    const devices = [
      { address: primaryAddress, displayName: "Bedroom speaker", paired: true, connected: false, signal: null },
      { address: "CC:98:8B:94:B5:1C", displayName: "WH-1000XM3", alias: "WH-1000XM3", paired: false, connected: false, signal: 71 },
    ];

    expect(speakerSetupViewModel(disconnected, devices).actions).toContain("pair");
    expect(preferredSpeakerSelection(disconnected, devices, primaryAddress)).toBe("CC:98:8B:94:B5:1C");
    expect(speakerDeviceRows(disconnected, devices, "CC:98:8B:94:B5:1C")).toEqual([
      expect.objectContaining({ title: "Bedroom speaker", selected: false, currentPrimary: true }),
      expect.objectContaining({ title: "WH-1000XM3", selected: true, currentPrimary: false }),
    ]);
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

  it("uses the visual viewport for the kiosk shell while an OSK is open", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const rootRule = css.match(/:root\s*\{[^}]+\}/)?.[0] ?? "";
    const appRule = css.match(/\.app\s*\{[^}]+\}/)?.[0] ?? "";
    const keyboardShellRule = css.match(/\.app\.keyboard-active \.shell\s*\{[^}]+\}/)?.[0] ?? "";

    expect(rootRule).toContain("--pipzo-viewport-height: 100dvh");
    expect(rootRule).toContain("--pipzo-keyboard-inset: 0px");
    expect(appRule).toContain("height: var(--pipzo-viewport-height)");
    expect(appRule).toContain("overflow: hidden");
    expect(appRule).toContain("padding-bottom: max(16px, calc(var(--pipzo-keyboard-inset) + 16px))");
    expect(keyboardShellRule).toContain("height: calc(var(--pipzo-viewport-height) - 36px)");
    expect(appSource).toContain('!["range", "checkbox", "radio", "button", "submit", "reset"].includes(element.type)');
  });

  it("keeps V1 daily library browsing free of text search controls", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(css).not.toContain(".library-search");
    expect(appSource).not.toContain("Search saved music");
    expect(appSource).not.toContain("type=\"search\"");
  });

  it("keeps the horizontal kiosk rail and player controls touch sized", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const shellRule = (css.match(/\.shell\s*\{[^}]+\}/g) ?? []).find((rule: string) => rule.includes("grid-template-columns")) ?? "";
    const navButtonRule = css.match(/\.nav button\s*\{[^}]+\}/)?.[0] ?? "";
    const primaryControlRule = css.match(/\.transport-primary\s*\{[^}]+\}/)?.[0] ?? "";
    const utilityRowRule = (css.match(/\.player-utility-row\s*\{[^}]+\}/g) ?? []).find((rule: string) => rule.includes("grid-template-columns")) ?? "";

    expect(shellRule).toContain("grid-template-columns: 76px minmax(0, 1fr)");
    expect(shellRule).toContain("height: calc(var(--pipzo-viewport-height) - 32px)");
    expect(shellRule).toContain("width: 100%");
    expect(shellRule).toContain("margin: 0");
    expect(navButtonRule).toContain("min-height: 86px");
    expect(navButtonRule).toContain("font-size: 12px");
    expect(primaryControlRule).toContain("min-height: 120px");
    expect(utilityRowRule).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps ready-state shell chrome minimal", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).not.toContain("className=\"brand\"");
    expect(appSource).not.toContain("className=\"status-strip\"");
    expect(appSource).not.toContain(">Screensaver<");
    expect(appSource).toContain('now_playing: "Now"');
  });

  it("prevents accidental text selection while preserving text entry selection", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const bodyRule = css.match(/body\s*\{[^}]+\}/)?.[0] ?? "";
    const appNoSelectRule = css.match(/button,\nselect,\nlabel,\n\.app,[^}]+\}/)?.[0] ?? "";
    const textEntryRule = css.match(/input,\ntextarea\s*\{[^}]+\}/)?.[0] ?? "";

    expect(bodyRule).toContain("user-select: none");
    expect(appNoSelectRule).toContain(".library-list button");
    expect(appNoSelectRule).toContain("-webkit-touch-callout: none");
    expect(textEntryRule).toContain("user-select: text");
    expect(textEntryRule).toContain("-webkit-touch-callout: default");
  });

  it("provides immediate touch feedback for interactive controls", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const buttonRule = css.match(/button\s*\{[^}]+\}/)?.[0] ?? "";
    const pressedRule = css.match(/button:not\(:disabled\):active,[^}]+\}/)?.[0] ?? "";
    const formPressedRule = css.match(/input\.touch-pressed,[^}]+\}/)?.[0] ?? "";
    const toastRule = css.match(/\.interaction-toast\s*\{[^}]+\}/)?.[0] ?? "";

    expect(appSource).toContain("type TouchFeedback");
    expect(appSource).toContain("classList.add(\"touch-pressed\")");
    expect(appSource).toContain("className=\"interaction-toast\"");
    expect(buttonRule).toContain("transition:");
    expect(pressedRule).toContain("transform: translateY(1px) scale(0.985)");
    expect(pressedRule).toContain("box-shadow:");
    expect(formPressedRule).toContain("outline: 3px solid");
    expect(toastRule).toContain("position: fixed");
    expect(toastRule).toContain("animation: interaction-toast-pop");
    expect(toastRule).toContain("pointer-events: none");
  });

  it("keeps direct finger panning on page and surface scrollers without button-level touch overrides", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appRule = css.match(/\.app\s*\{[^}]+\}/)?.[0] ?? "";
    const shellRules: string[] = css.match(/\.shell\s*\{[^}]+\}/g) ?? [];
    const shellRule = shellRules.find((rule) => rule.includes("grid-template-columns")) ?? "";
    const surfaceRule = css.match(/\.surface\s*\{[^}]+\}/)?.[0] ?? "";
    const sideStackRules: string[] = css.match(/\.side-stack\s*\{[^}]+\}/g) ?? [];
    const sideStackRule = sideStackRules.find((rule) => rule.includes("align-content: start")) ?? "";
    const listButtonRule = css.match(/\.library-list button\s*\{[^}]+\}/)?.[0] ?? "";
    const scrollbarRule = css.match(/\.app::-webkit-scrollbar,\s*\.surface::-webkit-scrollbar\s*\{[^}]+\}/)?.[0] ?? "";
    const scrollbarTrackRule = css.match(/\.app::-webkit-scrollbar-track,\s*\.surface::-webkit-scrollbar-track\s*\{[^}]+\}/)?.[0] ?? "";

    expect(appRule).toContain("overflow: hidden");
    expect(appRule).toContain("touch-action: none");
    expect(shellRule).not.toContain("overflow: hidden");
    expect(surfaceRule).toContain("height: 100%");
    expect(surfaceRule).toContain("min-height: 0");
    expect(surfaceRule).toContain("overflow-y: auto");
    expect(surfaceRule).toContain("touch-action: pan-y");
    expect(sideStackRule).not.toContain("overflow-y: auto");
    expect(sideStackRule).not.toContain("touch-action: pan-y");
    expect(listButtonRule).not.toContain("touch-action: pan-y");
    expect(scrollbarRule).toContain("width: 18px");
    expect(scrollbarTrackRule).toContain("background: rgba(246, 240, 223, 0.08)");
  });

  it("renders Home library sections as stacked draggable horizontal rails", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const featureGridRule = css.match(/\.library-feature-grid\s*\{[^}]+\}/)?.[0] ?? "";

    expect(featureGridRule).toContain("display: flex");
    expect(featureGridRule).toContain("overflow-x: auto");
    expect(featureGridRule).toContain("touch-action: none");
    expect(appSource).not.toContain('className={library.activeCategory === category ? "active" : ""}');
    expect(appSource).toContain('className="home-library-feed"');
    expect(appSource).toContain('className="library-feature-grid" data-drag-scroll');
  });

  it("keeps Home top bar controls touch-friendly with clock and playing indicator", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const headerRules: string[] = css.match(/\.home-header\s*\{[^}]+\}/g) ?? [];
    const headerRule = headerRules.find((rule) => rule.includes("grid-template-columns")) ?? "";
    const controlsButtonRule = css.match(/\.home-mini-controls button\s*\{[^}]+\}/)?.[0] ?? "";
    const miniArtRule = css.match(/\.home-mini-art\s*\{[^}]+\}/)?.[0] ?? "";
    const playButtonRule = css.match(/\.home-mini-controls button:nth-child\(2\)\s*\{[^}]+\}/)?.[0] ?? "";
    const eqPlayingRule = css.match(/\.home-mini-art\.playing \.home-mini-eq span\s*\{[^}]+\}/)?.[0] ?? "";
    const clockRule = css.match(/\.home-clock strong\s*\{[^}]+\}/)?.[0] ?? "";

    expect(appSource).toContain("<HomeClock nowMs={nowMs} onOpenClock={onOpenClock} />");
    expect(appSource).toContain("onOpenClock={() => setIdleActive(true)}");
    expect(appSource).toContain('onOpenNowPlaying={() => setSelectedSurface("now_playing")}');
    expect(appSource).toContain('aria-label="Open Now Playing"');
    expect(appSource).toContain('className={`home-mini-art${playing.isPlaying ? " playing" : ""}`}');
    expect(appSource).toContain('className="home-mini-eq"');
    expect(headerRule).toContain("grid-template-columns: minmax(0, 1fr) 156px");
    expect(headerRule).toContain("position: sticky");
    expect(headerRule).toContain("top: 0");
    expect(headerRule).toContain("z-index: 5");
    expect(controlsButtonRule).toContain("min-width: 72px");
    expect(controlsButtonRule).toContain("min-height: 56px");
    expect(controlsButtonRule).toContain("border-radius: 12px");
    expect(miniArtRule).toContain("min-height: 58px");
    expect(miniArtRule).toContain("min-width: 58px");
    expect(playButtonRule).toContain("min-width: 84px");
    expect(eqPlayingRule).toContain("animation: mini-eq-bounce");
    expect(clockRule).toContain("font-size: 30px");
  });

  it("keeps Now Playing transport controls reserved when track text is long", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const playerCopyRule = css.match(/\.player-copy\s*\{[^}]+\}/)?.[0] ?? "";
    const trackTitleRule = css.match(/\.player-panel h1\.track-title\s*\{[^}]+\}/)?.[0] ?? "";
    const transportRowRule = css.match(/\.transport-row\s*\{[^}]+\}/)?.[0] ?? "";
    const primaryButtonRule = css.match(/\.transport-primary\s*\{[^}]+\}/)?.[0] ?? "";

    expect(playerCopyRule).toContain("max-height: 168px");
    expect(playerCopyRule).toContain("overflow: hidden");
    expect(trackTitleRule).toContain("-webkit-line-clamp: 2");
    expect(trackTitleRule).toContain("overflow-wrap: anywhere");
    expect(transportRowRule).toContain("min-height: 120px");
    expect(primaryButtonRule).toContain("width: 120px");
  });

  it("supports the latest kiosk Now Playing controls and queue affordances", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    const navBottomRules: string[] = css.match(/\.nav-bottom\s*\{[^}]+\}/g) ?? [];
    const navBottomRule = navBottomRules.find((rule) => rule.includes("align-content: end")) ?? "";
    const transportSecondaryRule = css.match(/\.transport-secondary\s*\{[^}]+\}/)?.[0] ?? "";
    const utilityRowRules: string[] = css.match(/\.player-utility-row\s*\{[^}]+\}/g) ?? [];
    const utilityRowRule = utilityRowRules.find((rule) => rule.includes("grid-template-columns")) ?? "";
    const volumeInputRule = css.match(/\.volume-panel\.icon-volume input\[type="range"\],[^}]+\}/)?.[0] ?? "";
    const volumeThumbRule = css.match(/\.volume-panel\.icon-volume input\[type="range"\]::-webkit-slider-thumb,[^}]+\}/)?.[0] ?? "";
    const queuePanelRule = css.match(/\.queue-panel\s*\{[^}]+\}/)?.[0] ?? "";

    expect(appSource).toContain("const railPrimaryItems = railNavItems.filter((item) => item.priority === \"primary\")");
    expect(appSource).toContain("const railUtilityItems = railNavItems.filter((item) => item.priority === \"utility\")");
    expect(appSource).toContain('aria-label="Show current queue"');
    expect(appSource).toContain("function QueuePanel");
    expect(appSource).not.toContain('<span>{timerView.active ? timerView.label.replace("Stops in ", "") : "Timer"}</span>');
    expect(apiSource).toContain('"/api/v1/spotify/queue"');
    expect(navBottomRule).toContain("align-content: end");
    expect(transportSecondaryRule).toContain("width: 86px");
    expect(utilityRowRule).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(appSource).not.toContain("player-utility-button");
    expect(appSource).toContain("volumeRequestSeqRef");
    expect(appSource).toContain("requestId !== volumeRequestSeqRef.current");
    expect(appSource).toContain('disabled={view.disabled}');
    expect(appSource).toContain('step="1"');
    expect(volumeInputRule).toContain("min-height: 82px");
    expect(volumeThumbRule).toContain("width: 54px");
    expect(queuePanelRule).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
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
      title: "Remote Spotify playback",
      detail: "Control the active Spotify device here, or select Pipzo when you want this screen to take over.",
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
