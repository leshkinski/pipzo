import type { AppSnapshot, LibraryCategoryId, LibraryHomeResponse, LibraryItem, LibrarySearchResponse, PlaybackQueueResponse, ScenarioSummary } from "./contracts";

type LocalScenario = ScenarioSummary & { snapshot: AppSnapshot };

const now = () => new Date().toISOString();

function readySnapshot(): AppSnapshot {
  const updatedAt = now();
  return {
    appPhase: "ready",
    setup: {
      blockingStep: "none",
      steps: [
        "welcome",
        "wifi",
        "spotify_auth",
        "speaker",
        "playback_test",
        "complete",
      ].map((id) => ({ id: id as AppSnapshot["setup"]["steps"][number]["id"], status: "ready", required: id !== "welcome" })),
    },
    readiness: {
      networkConfigured: true,
      spotifyAuthorized: true,
      primarySpeakerSaved: true,
      playbackTestPassed: true,
      setupCompletedAt: updatedAt,
      minimumReady: true,
    },
    health: {
      network: { status: "online", ssid: "PipzoNet", ipAddress: "192.168.1.42", internetReachable: true },
      spotifyAuth: { status: "connected", accountDisplayName: "Pipzo" },
      speaker: {
        status: "connected",
        primary: {
          address: "AA:BB:CC:DD:EE:FF",
          displayName: "Pipzo Speaker",
          alias: "Bedroom speaker",
          connected: true,
        },
      },
      playbackDevice: { status: "available", deviceId: "pipzo-web-player" },
      volume: { status: "unified", value: 42, muted: false },
      display: { status: "normal", brightness: 80 },
      kiosk: { phase: "app_ready" },
    },
    surfaces: { current: "home", route: "/", idleMode: "clock" },
    warnings: [],
    capabilities: {
      canBrowse: true,
      canSearch: true,
      canStartPlayback: true,
      canControlPlayback: true,
      canControlVolume: true,
      canUseSleepTimer: true,
      canOpenSettings: true,
      canRunDiagnostics: true,
    },
    diagnostics: { safeMode: true, generatedAt: updatedAt },
    recoveryActions: [
      { id: "reset-app", kind: "reset_app", state: "confirm_required", requiresConfirmation: true },
    ],
    settings: {
      idleMode: "clock",
      idleTimeoutSeconds: 300,
      artworkInIdle: false,
      defaultSleepTimerMinutes: 30,
      brightness: 80,
      bedtimeBrightness: 20,
    },
    nowPlaying: {
      title: "Bedtime Song",
      artist: "Pipzo Mock",
      album: "Mock Library",
      isPlaying: false,
      progressMs: 12000,
      durationMs: 180000,
    },
    staleness: { isStale: false },
    updatedAt,
    schemaVersion: "v1",
  };
}

function clone(snapshot: AppSnapshot): AppSnapshot {
  return structuredClone(snapshot);
}

const ready = readySnapshot();

const firstBoot = clone(ready);
firstBoot.appPhase = "setup";
firstBoot.setup.blockingStep = "wifi";
firstBoot.setup.steps = firstBoot.setup.steps.map((step) => {
  if (step.id === "wifi") return { ...step, status: "action_required" };
  if (["spotify_auth", "speaker", "playback_test", "complete"].includes(step.id)) return { ...step, status: "blocked" };
  return step;
});
firstBoot.readiness = {
  networkConfigured: false,
  spotifyAuthorized: false,
  primarySpeakerSaved: false,
  playbackTestPassed: false,
  minimumReady: false,
};
firstBoot.health.network = { status: "offline", reason: "no_known_network", internetReachable: false };
firstBoot.health.spotifyAuth = { status: "none", reason: "no_session" };
firstBoot.health.speaker = { status: "none_saved", reason: "primary_missing" };
firstBoot.health.playbackDevice = { status: "unavailable", reason: "auth_required" };
firstBoot.health.volume = { status: "unavailable", reason: "bluetooth_sink_missing" };
firstBoot.surfaces = { current: "setup", route: "/setup/wifi", idleMode: "clock" };
firstBoot.capabilities = {
  ...firstBoot.capabilities,
  canBrowse: false,
  canSearch: false,
  canStartPlayback: false,
  canControlPlayback: false,
  canControlVolume: false,
  canUseSleepTimer: false,
};
firstBoot.nowPlaying = null;
firstBoot.recoveryActions = [
  { id: "connect-wifi", kind: "connect_wifi", state: "available", reason: "no_known_network", requiresConfirmation: false },
];

const degraded = clone(ready);
degraded.appPhase = "degraded";
degraded.health.network = { status: "offline", reason: "internet_probe_failed", internetReachable: false };
degraded.health.playbackDevice = { status: "unavailable", reason: "network_unavailable" };
degraded.surfaces = { current: "settings", route: "/settings/recovery", returnSurface: "home", idleMode: "clock" };
degraded.warnings = [
  { code: "network_offline", reason: "internet_probe_failed", surface: "settings" },
  { code: "playback_device_unavailable", reason: "network_unavailable" },
];
degraded.capabilities = { ...degraded.capabilities, canBrowse: false, canSearch: false, canStartPlayback: false };
degraded.recoveryActions = [
  { id: "retry-internet-probe", kind: "connect_wifi", state: "available", reason: "internet_probe_failed", requiresConfirmation: false },
];
degraded.staleness = { isStale: true, staleSince: now(), reason: "network_offline" };

const offlineSettingsMode = clone(degraded);
offlineSettingsMode.surfaces = { current: "settings", route: "/settings/network", returnSurface: "home", idleMode: "clock" };
offlineSettingsMode.warnings = [
  { code: "network_offline", reason: "no_known_network", surface: "settings", action: "connect_wifi" },
  { code: "stale_content", reason: "network_unavailable", surface: "home" },
  { code: "playback_device_unavailable", reason: "network_unavailable", surface: "now_playing" },
];
offlineSettingsMode.capabilities = { ...offlineSettingsMode.capabilities, canControlPlayback: false };
offlineSettingsMode.recoveryActions = [
  { id: "connect-wifi", kind: "connect_wifi", state: "available", reason: "no_known_network", requiresConfirmation: false },
  { id: "reconnect-speaker", kind: "reconnect_speaker", state: "available", requiresConfirmation: false },
  { id: "reset-app", kind: "reset_app", state: "confirm_required", requiresConfirmation: true },
];

const spotifyAuthUnavailable = clone(ready);
spotifyAuthUnavailable.appPhase = "degraded";
spotifyAuthUnavailable.health.spotifyAuth = { status: "reconnect_required", reason: "token_refresh_failed" };
spotifyAuthUnavailable.health.playbackDevice = { status: "unavailable", reason: "auth_required" };
spotifyAuthUnavailable.readiness = { ...spotifyAuthUnavailable.readiness, spotifyAuthorized: false, minimumReady: false };
spotifyAuthUnavailable.surfaces = { current: "settings", route: "/settings/spotify", returnSurface: "home", idleMode: "clock" };
spotifyAuthUnavailable.warnings = [
  { code: "spotify_reconnect_required", reason: "token_refresh_failed", surface: "settings", action: "spotify_reconnect" },
  { code: "playback_device_unavailable", reason: "auth_required", surface: "now_playing" },
];
spotifyAuthUnavailable.capabilities = {
  ...spotifyAuthUnavailable.capabilities,
  canBrowse: false,
  canSearch: false,
  canStartPlayback: false,
  canControlPlayback: false,
};
spotifyAuthUnavailable.recoveryActions = [
  { id: "start-spotify-auth", kind: "start_spotify_auth", state: "available", reason: "token_refresh_failed", requiresConfirmation: false },
  { id: "reset-app", kind: "reset_app", state: "confirm_required", requiresConfirmation: true },
];
spotifyAuthUnavailable.staleness = { isStale: true, staleSince: now(), reason: "spotify_reconnect_required" };

const speakerDisconnected = clone(ready);
speakerDisconnected.health.speaker.status = "saved_disconnected";
speakerDisconnected.health.speaker.reason = "device_out_of_range";
if (speakerDisconnected.health.speaker.primary) speakerDisconnected.health.speaker.primary.connected = false;
speakerDisconnected.health.playbackDevice = { status: "unavailable", reason: "speaker_unavailable" };
speakerDisconnected.warnings = [{ code: "speaker_disconnected", reason: "device_out_of_range" }];
speakerDisconnected.capabilities = { ...speakerDisconnected.capabilities, canStartPlayback: false, canControlPlayback: false };
speakerDisconnected.recoveryActions = [
  { id: "reconnect-speaker", kind: "reconnect_speaker", state: "available", reason: "device_out_of_range", requiresConfirmation: false },
];

const deviceConnectivityDegraded = clone(speakerDisconnected);
deviceConnectivityDegraded.appPhase = "degraded";
deviceConnectivityDegraded.surfaces = { current: "settings", route: "/settings/speaker", returnSurface: "now_playing", idleMode: "clock" };
deviceConnectivityDegraded.capabilities = {
  ...deviceConnectivityDegraded.capabilities,
  canBrowse: true,
  canSearch: true,
  canControlVolume: false,
};
deviceConnectivityDegraded.warnings = [
  { code: "speaker_disconnected", reason: "device_out_of_range", surface: "settings", action: "reconnect_speaker" },
  { code: "playback_device_unavailable", reason: "speaker_unavailable", surface: "now_playing" },
];
deviceConnectivityDegraded.recoveryActions = [
  { id: "reconnect-speaker", kind: "reconnect_speaker", state: "available", reason: "device_out_of_range", requiresConfirmation: false },
  { id: "forget-speaker", kind: "forget_speaker", state: "confirm_required", reason: "device_out_of_range", requiresConfirmation: true },
  { id: "reset-app", kind: "reset_app", state: "confirm_required", requiresConfirmation: true },
];

const wifiLocalOnly = clone(ready);
wifiLocalOnly.appPhase = "degraded";
wifiLocalOnly.health.network = {
  status: "local_only",
  reason: "internet_probe_failed",
  ssid: "PipzoNet",
  ipAddress: "192.168.1.42",
  internetReachable: false,
};
wifiLocalOnly.warnings = [{ code: "network_local_only", reason: "internet_probe_failed" }];
wifiLocalOnly.capabilities = { ...wifiLocalOnly.capabilities, canBrowse: false, canSearch: false, canStartPlayback: false };
wifiLocalOnly.staleness = { isStale: true, staleSince: now(), reason: "network_local_only" };

const volumeOutOfSync = clone(ready);
volumeOutOfSync.health.volume = { status: "out_of_sync", reason: "readback_mismatch", value: 42, muted: false };
volumeOutOfSync.warnings = [{ code: "volume_out_of_sync", reason: "readback_mismatch" }];

const bootProbeDelayed = clone(firstBoot);
bootProbeDelayed.appPhase = "starting";
bootProbeDelayed.setup.blockingStep = "none";
bootProbeDelayed.health.network = { status: "starting", reason: "boot_probe_pending" };
bootProbeDelayed.health.spotifyAuth = { status: "starting", reason: "boot_probe_pending" };
bootProbeDelayed.health.speaker = { status: "starting", reason: "boot_probe_pending" };
bootProbeDelayed.health.playbackDevice = { status: "starting", reason: "sdk_not_ready" };
bootProbeDelayed.health.volume = { status: "unavailable", reason: "boot_probe_pending" };
bootProbeDelayed.health.display = { status: "unavailable", reason: "boot_probe_pending", brightness: 0 };
bootProbeDelayed.health.kiosk = { phase: "adapters_probing" };
bootProbeDelayed.surfaces = { current: "setup", route: "/starting", idleMode: "clock" };
bootProbeDelayed.recoveryActions = [];
bootProbeDelayed.warnings = [];

const idleClock = clone(ready);
idleClock.surfaces = { current: "idle", route: "/idle", idleMode: "clock" };
idleClock.settings = { ...idleClock.settings, artworkInIdle: false, idleMode: "clock", brightness: 45 };
idleClock.health.display = { status: "dimmed", reason: "idle", brightness: 45 };

const idleArtwork = clone(ready);
idleArtwork.surfaces = { current: "idle", route: "/idle", idleMode: "clock_with_artwork" };
idleArtwork.settings = { ...idleArtwork.settings, artworkInIdle: true, idleMode: "clock_with_artwork", brightness: 65 };
idleArtwork.health.display = { status: "normal", reason: "idle", brightness: 65 };
idleArtwork.nowPlaying = { ...idleArtwork.nowPlaying!, isPlaying: true };

const dimmedBedtime = clone(idleClock);
dimmedBedtime.settings = { ...dimmedBedtime.settings, brightness: 12, bedtimeBrightness: 12 };
dimmedBedtime.health.display = { status: "dimmed", reason: "bedtime", brightness: 12 };

export const localScenarios: Record<string, LocalScenario> = {
  first_boot_empty: {
    id: "first_boot_empty",
    label: "First boot empty",
    description: "No Wi-Fi, Spotify session, speaker, or playback test readiness exists yet.",
    snapshot: firstBoot,
  },
  ready_healthy: {
    id: "ready_healthy",
    label: "Ready and healthy",
    description: "Setup is complete and all core adapters are healthy.",
    snapshot: ready,
  },
  degraded_recovery: {
    id: "degraded_recovery",
    label: "Degraded recovery",
    description: "Setup was completed earlier, but network loss blocks playback and browse.",
    snapshot: degraded,
  },
  offline_settings_mode: {
    id: "offline_settings_mode",
    label: "Offline settings mode",
    description: "Internet is unavailable, but Settings, Wi-Fi, Bluetooth, and reset recovery stay reachable.",
    snapshot: offlineSettingsMode,
  },
  spotify_auth_unavailable: {
    id: "spotify_auth_unavailable",
    label: "Spotify auth unavailable",
    description: "Spotify auth needs reconnect while local device settings remain usable.",
    snapshot: spotifyAuthUnavailable,
  },
  device_connectivity_degraded: {
    id: "device_connectivity_degraded",
    label: "Device connectivity degraded",
    description: "The network and Spotify are available, but the saved Bluetooth speaker is disconnected.",
    snapshot: deviceConnectivityDegraded,
  },
  speaker_saved_disconnected: {
    id: "speaker_saved_disconnected",
    label: "Saved speaker disconnected",
    description: "A primary speaker is saved but currently not connected.",
    snapshot: speakerDisconnected,
  },
  wifi_local_only: {
    id: "wifi_local_only",
    label: "Wi-Fi local only",
    description: "The Pi is connected to Wi-Fi without internet reachability.",
    snapshot: wifiLocalOnly,
  },
  volume_out_of_sync: {
    id: "volume_out_of_sync",
    label: "Volume out of sync",
    description: "Spotify and OS/Bluetooth volume readback disagree.",
    snapshot: volumeOutOfSync,
  },
  boot_probe_delayed: {
    id: "boot_probe_delayed",
    label: "Boot probe delayed",
    description: "Backend is up while adapters are still in the boot probing window.",
    snapshot: bootProbeDelayed,
  },
  idle_clock: {
    id: "idle_clock",
    label: "Idle clock",
    description: "Clock-first bedside idle mode with artwork disabled.",
    snapshot: idleClock,
  },
  idle_with_artwork: {
    id: "idle_with_artwork",
    label: "Idle with artwork",
    description: "Optional richer idle mode when artwork is enabled in settings.",
    snapshot: idleArtwork,
  },
  dimmed_bedtime: {
    id: "dimmed_bedtime",
    label: "Dimmed bedtime",
    description: "Bedtime display state with a lower mock brightness level.",
    snapshot: dimmedBedtime,
  },
};

export function localScenarioSummaries(): ScenarioSummary[] {
  return Object.values(localScenarios).map(({ id, label, description }) => ({ id, label, description }));
}

export function localScenarioSnapshot(scenarioId: string): AppSnapshot {
  const scenario = localScenarios[scenarioId] ?? localScenarios.first_boot_empty;
  const snapshot = clone(scenario.snapshot);
  const updatedAt = now();
  snapshot.updatedAt = updatedAt;
  snapshot.diagnostics.generatedAt = updatedAt;
  return snapshot;
}

export const localLibraryItems: Record<Exclude<LibraryCategoryId, "home">, LibraryItem[]> = {
  playlists: [
    {
      id: "playlist-bedtime",
      type: "playlist",
      uri: "spotify:playlist:pipzo-bedtime",
      title: "Bedtime Favorites",
      subtitle: "12 familiar songs",
      source: "playlists",
      playbackKind: "context",
      playable: true,
    },
    {
      id: "playlist-car",
      type: "playlist",
      uri: "spotify:playlist:pipzo-car",
      title: "Car Singalong",
      subtitle: "Family playlist",
      source: "playlists",
      playbackKind: "context",
      playable: true,
    },
  ],
  albums: [
    {
      id: "album-lullabies",
      type: "album",
      uri: "spotify:album:pipzo-lullabies",
      title: "Soft Lullabies",
      subtitle: "Pipzo Mock Artist",
      source: "albums",
      playbackKind: "context",
      playable: true,
    },
  ],
  artists: [
    {
      id: "artist-mock",
      type: "artist",
      uri: "spotify:artist:pipzo-mock",
      title: "Pipzo Mock Artist",
      subtitle: "From saved music",
      source: "artists",
      playbackKind: "unavailable",
      playable: false,
    },
  ],
  liked_songs: [
    {
      id: "track-bedtime-song",
      type: "track",
      uri: "spotify:track:pipzo-bedtime-song",
      title: "Bedtime Song",
      subtitle: "Pipzo Mock Artist / Mock Library",
      source: "liked_songs",
      playbackKind: "track",
      playable: true,
    },
    {
      id: "track-quiet-song",
      type: "track",
      uri: "spotify:track:pipzo-quiet-song",
      title: "Quiet Favorite",
      subtitle: "Pipzo Mock Artist / Soft Lullabies",
      source: "liked_songs",
      playbackKind: "track",
      playable: true,
    },
  ],
  recently_played: [
    {
      id: "playlist-bedtime-recent",
      type: "playlist",
      uri: "spotify:playlist:pipzo-bedtime",
      title: "Bedtime Favorites",
      subtitle: "Recently played playlist",
      source: "recently_played",
      playbackKind: "context",
      playable: true,
    },
    {
      id: "track-recent",
      type: "track",
      uri: "spotify:track:pipzo-recent",
      title: "Recently Played Tune",
      subtitle: "Pipzo Mock Artist / Today",
      source: "recently_played",
      playbackKind: "track",
      playable: true,
    },
  ],
};

export const localSingleSongPlaybackQueue: PlaybackQueueResponse = {
  current: localLibraryItems.liked_songs[0],
  items: [
    localLibraryItems.liked_songs[0],
    {
      ...localLibraryItems.liked_songs[0],
      id: "track-bedtime-song-repeat",
    },
  ],
  generatedAt: now(),
};

const localLibraryTitles: Record<Exclude<LibraryCategoryId, "home">, { title: string; description: string }> = {
  playlists: { title: "Playlists", description: "Saved and followed playlists visible to the connected account." },
  albums: { title: "Albums", description: "Albums saved in the Spotify library." },
  artists: { title: "Artists", description: "Artists derived from saved and recently played music." },
  liked_songs: { title: "Liked songs", description: "Tracks saved in the Spotify library." },
  recently_played: { title: "Recently played", description: "Recent tracks from the connected Spotify account." },
};

export function localLibraryHome(): LibraryHomeResponse {
  return {
    sections: Object.entries(localLibraryItems).map(([id, items]) => ({
      id: id as Exclude<LibraryCategoryId, "home">,
      ...localLibraryTitles[id as Exclude<LibraryCategoryId, "home">],
      items,
    })),
    generatedAt: now(),
    constrained: true,
  };
}

export function localLibrarySearch(query: string): LibrarySearchResponse {
  const normalized = query.trim().toLowerCase();
  return {
    query,
    sections: normalized
      ? Object.entries(localLibraryItems)
          .map(([id, items]) => ({
            id: id as Exclude<LibraryCategoryId, "home">,
            ...localLibraryTitles[id as Exclude<LibraryCategoryId, "home">],
            items: items.filter((item) =>
              item.title.toLowerCase().includes(normalized) || (item.subtitle ?? "").toLowerCase().includes(normalized),
            ),
          }))
          .filter((section) => section.items.length > 0)
      : [],
    generatedAt: now(),
    constrained: true,
  };
}
