import type { AppSnapshot, DevicePowerAction, IdleMode, LibraryCategoryId, LibraryItem, PlaybackQueueResponse, RecoveryActionState, SpeakerDevice, SpotifyAuthSession, SurfaceId, WifiNetwork } from "./contracts";

export const primarySurfaces: SurfaceId[] = ["home", "now_playing", "settings"];
export const dailyPrimarySurfaces: SurfaceId[] = ["home", "now_playing"];
export const demotedUtilitySurfaces: SurfaceId[] = ["settings"];
export const sleepTimerPresets = [15, 30, 45, 60] as const;
export const homeLibraryCategoryOrder: Exclude<LibraryCategoryId, "home">[] = [
  "recently_played",
  "playlists",
  "albums",
  "liked_songs",
  "artists",
];

export type SleepTimerPresetMinutes = (typeof sleepTimerPresets)[number];
export type AppSurfaceId = SurfaceId | "sleep_timer";
export type NowPlayingSubview = "artwork" | "queue";
export type NowPlayingSubviewEvent =
  | { type: "open_queue" }
  | { type: "close_queue" }
  | { type: "select_surface"; surface: AppSurfaceId }
  | { type: "library_playback_start_succeeded" }
  | { type: "queue_selection_succeeded" };

export type SleepTimerState = {
  status: "idle" | "active" | "expired" | "blocked" | "failed";
  durationMinutes?: SleepTimerPresetMinutes;
  startedAtMs?: number;
  expiresAtMs?: number;
  message?: string;
};

export type SleepTimerViewModel = {
  presets: readonly SleepTimerPresetMinutes[];
  canStart: boolean;
  canCancel: boolean;
  active: boolean;
  expired: boolean;
  remainingMs: number;
  label: string;
  detail: string;
  tone: "ready" | "waiting" | "attention";
};

export type SleepTimerExpiryCommand = {
  shouldStop: boolean;
  action: "stop";
  deviceId?: string;
  blockedReason?: string;
};

export type ShellNavigationItem = {
  surface: SurfaceId;
  label: string;
  priority: "primary" | "utility";
};

export type SettingsPageId = "overview" | "wifi" | "spotify" | "audio" | "device";
export type SettingsStatusTone = "ready" | "warning" | "error" | "action_needed";
export type SettingsStatusRow = {
  id: Exclude<SettingsPageId, "overview"> | "internet";
  title: string;
  status: string;
  detail: string;
  tone: SettingsStatusTone;
  targetPage: SettingsPageId;
  actionLabel?: string;
};

export type DevicePowerConfirmation = {
  action: DevicePowerAction | null;
  state: "idle" | "confirming" | "running" | "succeeded" | "failed";
};

export type DevicePowerActionView = {
  action: DevicePowerAction;
  title: string;
  detail: string;
  confirmLabel: string;
  requestLabel: string;
  cancelLabel: string;
  busy: boolean;
  confirming: boolean;
  terminal: boolean;
  message: string;
};

export type NowPlayingEmptyState = {
  title: string;
  detail: string;
};

export type PlaybackQueueRow = {
  item: LibraryItem;
  current: boolean;
  indexLabel: string;
};

export type PlaybackQueueViewModel = {
  rows: PlaybackQueueRow[];
  upcomingCount: number;
  emptyCopy: string | null;
};

export type QueueSelectionPlayback = {
  selectedUri: string;
  continuationUris: string[];
};

export function shellNavigationItems(): ShellNavigationItem[] {
  return [
    ...dailyPrimarySurfaces.map((surface) => ({ surface, label: labelFromId(surface), priority: "primary" as const })),
    ...demotedUtilitySurfaces.map((surface) => ({ surface, label: labelFromId(surface), priority: "utility" as const })),
  ];
}

export function settingsStatusRows(snapshot: AppSnapshot, authSession?: SpotifyAuthSession | null): SettingsStatusRow[] {
  return [
    wifiSettingsStatusRow(snapshot),
    internetSettingsStatusRow(snapshot),
    spotifySettingsStatusRow(snapshot, authSession),
    audioSettingsStatusRow(snapshot),
    deviceSettingsStatusRow(snapshot),
  ];
}

function wifiSettingsStatusRow(snapshot: AppSnapshot): SettingsStatusRow {
  const network = snapshot.health.network;
  const setupRequired = isSetupGated(snapshot) && !snapshot.readiness.networkConfigured;
  if (setupRequired) {
    return {
      id: "wifi",
      title: "Wi-Fi",
      status: "Required for setup",
      detail: "Connect Wi-Fi to continue",
      tone: "action_needed",
      targetPage: "wifi",
      actionLabel: "Connect",
    };
  }
  if (network.status === "online") {
    return {
      id: "wifi",
      title: "Wi-Fi",
      status: "Connected",
      detail: network.ssid ?? "Network ready",
      tone: "ready",
      targetPage: "wifi",
    };
  }
  if (network.status === "local_only") {
    return {
      id: "wifi",
      title: "Wi-Fi",
      status: "Connected, no internet",
      detail: network.ssid ?? "Local network",
      tone: "warning",
      targetPage: "wifi",
      actionLabel: "Check network",
    };
  }
  if (network.status === "starting") {
    return {
      id: "wifi",
      title: "Wi-Fi",
      status: "Checking",
      detail: "Device is checking Wi-Fi",
      tone: "warning",
      targetPage: "wifi",
    };
  }
  return {
    id: "wifi",
    title: "Wi-Fi",
    status: "Not connected",
    detail: "Tap to connect",
    tone: "error",
    targetPage: "wifi",
    actionLabel: "Connect",
  };
}

function internetSettingsStatusRow(snapshot: AppSnapshot): SettingsStatusRow {
  const network = snapshot.health.network;
  if (network.status === "online" && network.internetReachable !== false) {
    return {
      id: "internet",
      title: "Internet",
      status: "Online",
      detail: "Spotify can connect",
      tone: "ready",
      targetPage: "wifi",
    };
  }
  if (network.status === "starting" || network.reason === "boot_probe_pending") {
    return {
      id: "internet",
      title: "Internet",
      status: "Checking",
      detail: "Device is still checking internet access",
      tone: "warning",
      targetPage: "wifi",
    };
  }
  return {
    id: "internet",
    title: "Internet",
    status: "Offline",
    detail: "Playback and Spotify setup are unavailable",
    tone: "error",
    targetPage: "wifi",
    actionLabel: "Open Wi-Fi",
  };
}

function spotifySettingsStatusRow(snapshot: AppSnapshot, authSession?: SpotifyAuthSession | null): SettingsStatusRow {
  const auth = snapshot.health.spotifyAuth;
  const activeSession = authSession && ["waiting", "callback_received"].includes(authSession.status);
  const justConnected = authSession?.status === "connected";
  const setupRequired = isSetupGated(snapshot) && !snapshot.readiness.spotifyAuthorized;
  const accountLabel = auth.accountDisplayName ?? authSession?.accountDisplayName ?? "Spotify account";
  if (activeSession || auth.status === "waiting") {
    return {
      id: "spotify",
      title: "Spotify",
      status: "In progress",
      detail: "Finish connecting Spotify in this browser",
      tone: "warning",
      targetPage: "spotify",
      actionLabel: "Open Spotify",
    };
  }
  if (justConnected && auth.status === "connected") {
    return {
      id: "spotify",
      title: "Spotify",
      status: "Connected",
      detail: "Spotify is ready",
      tone: "ready",
      targetPage: "spotify",
    };
  }
  if (setupRequired) {
    return {
      id: "spotify",
      title: "Spotify",
      status: "Required for setup",
      detail: "Connect Spotify to continue",
      tone: "action_needed",
      targetPage: "spotify",
      actionLabel: "Connect",
    };
  }
  if (auth.status === "connected") {
    return {
      id: "spotify",
      title: "Spotify",
      status: "Connected",
      detail: accountLabel,
      tone: "ready",
      targetPage: "spotify",
    };
  }
  return {
    id: "spotify",
    title: "Spotify",
    status: "Reconnect needed",
    detail: auth.reason === "token_refresh_failed" || auth.reason === "revoked"
      ? "Reconnect or switch accounts"
      : "Reconnect Spotify to continue",
    tone: "error",
    targetPage: "spotify",
    actionLabel: "Reconnect",
  };
}

function audioSettingsStatusRow(snapshot: AppSnapshot): SettingsStatusRow {
  const speaker = snapshot.health.speaker;
  const setupRequired = isSetupGated(snapshot) && !snapshot.readiness.primarySpeakerSaved;
  if (setupRequired) {
    return {
      id: "audio",
      title: "Bluetooth audio",
      status: "Required for setup",
      detail: "Pair a speaker to continue",
      tone: "action_needed",
      targetPage: "audio",
      actionLabel: "Open audio",
    };
  }
  if (speaker.status === "connected" && speaker.primary?.connected) {
    return {
      id: "audio",
      title: "Bluetooth audio",
      status: "Connected",
      detail: speaker.primary.displayName,
      tone: "ready",
      targetPage: "audio",
    };
  }
  if (speaker.status === "saved_disconnected" || speaker.status === "reconnecting" || speaker.status === "starting") {
    return {
      id: "audio",
      title: "Bluetooth audio",
      status: "Speaker disconnected",
      detail: speaker.primary?.displayName ?? "Saved speaker",
      tone: "warning",
      targetPage: "audio",
      actionLabel: "Reconnect",
    };
  }
  return {
    id: "audio",
    title: "Bluetooth audio",
    status: "No speaker ready",
    detail: "Playback is unavailable until a speaker is connected",
    tone: "error",
    targetPage: "audio",
    actionLabel: "Open audio",
  };
}

function deviceSettingsStatusRow(snapshot: AppSnapshot): SettingsStatusRow {
  const playback = snapshot.health.playbackDevice;
  if (isSetupGated(snapshot) && snapshot.setup.blockingStep === "playback_test") {
    return {
      id: "device",
      title: "Device",
      status: "Playback test needed",
      detail: "Confirm Pipzo can play sound",
      tone: "action_needed",
      targetPage: "device",
      actionLabel: "Open device",
    };
  }
  if (playback.status === "starting" || playback.status === "registering") {
    return {
      id: "device",
      title: "Device",
      status: "Needs attention",
      detail: "Some device features are still starting",
      tone: "warning",
      targetPage: "device",
    };
  }
  if (playback.status === "error") {
    return {
      id: "device",
      title: "Device",
      status: "Recovery tools available",
      detail: "Use for reboot, power off, brightness, and idle tools",
      tone: "error",
      targetPage: "device",
      actionLabel: "Open device",
    };
  }
  if (playback.status === "transfer_required" || playback.reason === "device_not_registered" || playback.reason === "sdk_not_ready") {
    return {
      id: "device",
      title: "Device",
      status: "Almost ready",
      detail: "Finish setup on this device",
      tone: "warning",
      targetPage: "device",
      actionLabel: "Finish setup",
    };
  }
  return {
    id: "device",
    title: "Device",
    status: "Ready",
    detail: "Brightness, idle, and power controls",
    tone: "ready",
    targetPage: "device",
  };
}

export function devicePowerActionView(
  action: DevicePowerAction,
  confirmation: DevicePowerConfirmation,
  resultState?: RecoveryActionState,
): DevicePowerActionView {
  const title = action === "reboot" ? "Reboot Pipzo" : "Power off Pipzo";
  const confirming = confirmation.action === action && confirmation.state === "confirming";
  const running = confirmation.action === action && confirmation.state === "running";
  const succeeded = confirmation.action === action && confirmation.state === "succeeded";
  const failed = confirmation.action === action && confirmation.state === "failed";
  const terminal = succeeded || failed || resultState === "succeeded" || resultState === "failed";
  const message = running
    ? action === "reboot" ? "Reboot request sent. The screen may disconnect while Pipzo restarts." : "Power-off request sent. The screen may disconnect as Pipzo shuts down."
    : succeeded || resultState === "succeeded"
      ? action === "reboot" ? "Reboot accepted. Pipzo will come back after startup." : "Power off accepted. It is safe to wait for shutdown."
      : failed || resultState === "failed"
        ? `${title} could not be sent.`
        : confirming
          ? `Confirm ${action === "reboot" ? "reboot" : "power off"} now.`
          : "";
  return {
    action,
    title,
    detail: "",
    confirmLabel: action === "reboot" ? "Confirm reboot" : "Confirm power off",
    requestLabel: action === "reboot" ? "Reboot" : "Power off",
    cancelLabel: "Cancel",
    busy: running,
    confirming,
    terminal,
    message,
  };
}

export function playbackQueueViewModel(queue: Pick<PlaybackQueueResponse, "current" | "items">): PlaybackQueueViewModel {
  const seen = new Set<string>();
  const rows: PlaybackQueueRow[] = [];
  const current = queue.current ?? null;
  let upcomingCount = 0;

  if (current) {
    seen.add(queueItemIdentity(current));
    rows.push({ item: current, current: true, indexLabel: "Now" });
  }

  for (const item of queue.items) {
    const identity = queueItemIdentity(item);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    upcomingCount += 1;
    rows.push({ item, current: false, indexLabel: String(upcomingCount) });
  }

  let emptyCopy: string | null = null;
  if (rows.length === 0) {
    emptyCopy = "Spotify has no current or upcoming songs right now.";
  } else if (current && upcomingCount === 0) {
    emptyCopy = "Only this song is playing. Spotify has no upcoming songs right now.";
  }

  return { rows, upcomingCount, emptyCopy };
}

export function queueSelectionPlayback(
  queue: Pick<PlaybackQueueResponse, "current" | "items">,
  selected: LibraryItem,
): QueueSelectionPlayback {
  const rows = playbackQueueViewModel(queue).rows.map((row) => row.item);
  const selectedIndex = rows.findIndex((item) => queueItemIdentity(item) === queueItemIdentity(selected));
  const sequence = selectedIndex >= 0 ? rows.slice(selectedIndex) : [selected];
  return {
    selectedUri: selected.uri,
    continuationUris: sequence.slice(1).map((item) => item.uri),
  };
}

export function playbackQueueAfterSelection(
  queue: Pick<PlaybackQueueResponse, "current" | "items" | "generatedAt">,
  selected: LibraryItem,
  generatedAt: string,
): PlaybackQueueResponse {
  const rows = playbackQueueViewModel(queue).rows.map((row) => row.item);
  const selectedIndex = rows.findIndex((item) => queueItemIdentity(item) === queueItemIdentity(selected));
  const sequence = selectedIndex >= 0 ? rows.slice(selectedIndex) : [selected];
  return {
    current: sequence[0] ?? selected,
    items: sequence.slice(1),
    generatedAt,
  };
}

export function playbackQueueAfterNewPlaybackIntent(generatedAt: string): PlaybackQueueResponse {
  return {
    current: null,
    items: [],
    generatedAt,
  };
}

export function playbackQueueAfterStableRefresh(
  current: PlaybackQueueResponse,
  incoming: PlaybackQueueResponse,
  options: { preserveTransientCollapse: boolean },
): PlaybackQueueResponse {
  if (!options.preserveTransientCollapse) {
    return incoming;
  }
  const currentView = playbackQueueViewModel(current);
  const incomingView = playbackQueueViewModel(incoming);
  if (currentView.upcomingCount > 0 && incomingView.upcomingCount === 0) {
    return current;
  }
  if (currentView.rows.length > 0 && incomingView.rows.length === 0) {
    return current;
  }
  return incoming;
}

export function playbackQueueAfterRefreshRequest(
  current: PlaybackQueueResponse,
  incoming: PlaybackQueueResponse,
  options: { preserveTransientCollapse: boolean; requestVersion: number; activeVersion: number },
): PlaybackQueueResponse {
  if (options.requestVersion !== options.activeVersion) {
    return current;
  }
  return playbackQueueAfterStableRefresh(current, incoming, {
    preserveTransientCollapse: options.preserveTransientCollapse,
  });
}

function queueItemIdentity(item: LibraryItem): string {
  return item.uri || item.id || `${item.type}:${item.title}:${item.subtitle ?? ""}`;
}

export const nowPlayingRefreshIntervalMs = 10_000;
export const nowPlayingCommandRefreshDelaysMs = [900, 2_500] as const;

export function shouldSuppressBluetoothSuccessAlert(message: unknown): boolean {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (!text.trim()) {
    return false;
  }

  const bluetoothSuccessHint = /\b(bluetooth|speaker|pair|pairing|paired|reconnect|reconnected|connection)\b/i.test(text) || /\bconnected to\b/i.test(text);
  const successHint = /\b(success|successful|succeeded|connected)\b/i.test(text);
  return bluetoothSuccessHint && successHint;
}

export function shouldRefreshNowPlaying(snapshot: AppSnapshot, dataSource: "backend" | "local"): boolean {
  if (dataSource !== "backend") {
    return false;
  }
  if (snapshot.health.spotifyAuth.status !== "connected") {
    return false;
  }
  if (snapshot.health.network.status !== "online") {
    return false;
  }
  return snapshot.health.playbackDevice.status === "available" || Boolean(snapshot.nowPlaying);
}

export function nextNowPlayingBoundaryRefreshDelayMs(snapshot: AppSnapshot, nowMs: number): number | null {
  const playing = snapshot.nowPlaying;
  if (!playing?.isPlaying || !playing.durationMs || playing.progressMs === undefined || playing.progressMs === null) {
    return null;
  }
  const capturedAtMs = playing.capturedAt ? Date.parse(playing.capturedAt) : Number.NaN;
  const elapsedSinceCaptureMs = Number.isFinite(capturedAtMs) ? Math.max(0, nowMs - capturedAtMs) : 0;
  const remainingMs = playing.durationMs - playing.progressMs - elapsedSinceCaptureMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 1_000;
  }
  const delayMs = Math.max(1_000, remainingMs + 1_500);
  return delayMs < nowPlayingRefreshIntervalMs ? delayMs : null;
}

export function nowPlayingEmptyState(snapshot: AppSnapshot): NowPlayingEmptyState {
  if (snapshot.nowPlaying) {
    return {
      title: snapshot.nowPlaying.title,
      detail: `${snapshot.nowPlaying.artist}${snapshot.nowPlaying.album ? ` / ${snapshot.nowPlaying.album}` : ""}`,
    };
  }
  if (snapshot.health.playbackDevice.reason === "spotify_api_error") {
    return {
      title: "Playback state unavailable",
      detail: "Spotify did not return current track details. Open Settings if this persists.",
    };
  }
  if (snapshot.diagnostics.lastCommand === "spotify.current_playback") {
    const code = snapshot.diagnostics.rawAdapterCode ?? "unknown";
    if (code.startsWith("device_mismatch:")) {
      return {
        title: "Remote Spotify playback",
        detail: "Control the active Spotify device here, or select Pipzo when you want this screen to take over.",
      };
    }
    if (code === "empty_response") {
      return {
        title: "Nothing playing",
        detail: "Choose music from Home when playback is available.",
      };
    }
    if (code.startsWith("unsupported_payload:")) {
      return {
        title: "Current Spotify item is not a track",
        detail: code,
      };
    }
  }
  return {
    title: "Nothing playing",
    detail: "Choose music from Home when playback is available.",
  };
}

export function isSetupGated(snapshot: AppSnapshot): boolean {
  if (snapshot.appPhase === "setup") {
    return true;
  }
  if (snapshot.appPhase === "degraded" || snapshot.readiness.setupCompletedAt) {
    return false;
  }
  return !snapshot.readiness.minimumReady;
}

export function shouldPollAppStateForSetupReadiness(snapshot: AppSnapshot, dataSource: "backend" | "local"): boolean {
  return dataSource === "backend" && isSetupGated(snapshot);
}

export function shouldRetryBackendRecovery(dataSource: "backend" | "local"): boolean {
  return dataSource === "local";
}

export function shouldShowDeveloperPanel(
  dataSource: "backend" | "local",
  backendMode: string | null | undefined,
  localDeveloperControlsEnabled: boolean,
): boolean {
  if (backendMode === "mock") {
    return true;
  }
  return dataSource === "local" && localDeveloperControlsEnabled;
}

export function shouldRefreshHomeOnOpen(
  activeSurface: AppSurfaceId,
  snapshot: AppSnapshot,
  dataSource: "backend" | "local",
): boolean {
  return activeSurface === "home" && dataSource === "backend" && libraryAvailability(snapshot).canBrowse;
}

export function nowPlayingSubviewAfterSurfaceChange(current: NowPlayingSubview, surface: AppSurfaceId): NowPlayingSubview {
  return nowPlayingSubviewReducer(current, { type: "select_surface", surface });
}

export function nowPlayingSubviewAfterLibraryPlaybackStart(): NowPlayingSubview {
  return nowPlayingSubviewReducer("queue", { type: "library_playback_start_succeeded" });
}

export function nowPlayingSubviewReducer(current: NowPlayingSubview, event: NowPlayingSubviewEvent): NowPlayingSubview {
  switch (event.type) {
    case "open_queue":
      return "queue";
    case "close_queue":
    case "library_playback_start_succeeded":
      return "artwork";
    case "select_surface":
      return event.surface === "now_playing" ? current : "artwork";
    case "queue_selection_succeeded":
      return current;
  }
}

export function shouldRenderQueuePanel(surface: AppSurfaceId, subview: NowPlayingSubview): boolean {
  return surface === "now_playing" && subview === "queue";
}

export function canOpenSurface(snapshot: AppSnapshot, surface: SurfaceId): boolean {
  if (surface === "setup") {
    return false;
  }
  if (surface === "settings") {
    return snapshot.capabilities.canOpenSettings;
  }
  if (surface === "idle") {
    return !isSetupGated(snapshot);
  }
  if (isSetupGated(snapshot)) {
    return false;
  }
  if (surface === "home") {
    return true;
  }
  if (surface === "browse") {
    return snapshot.capabilities.canBrowse;
  }
  if (surface === "now_playing") {
    return snapshot.capabilities.canControlPlayback || snapshot.capabilities.canStartPlayback || Boolean(snapshot.nowPlaying);
  }
  return true;
}

export function preferredSurface(snapshot: AppSnapshot): SurfaceId {
  if (isSetupGated(snapshot)) {
    return "settings";
  }
  if (snapshot.surfaces.current === "setup") {
    return "home";
  }
  if (snapshot.appPhase === "degraded") {
    return canOpenSurface(snapshot, snapshot.surfaces.current) ? snapshot.surfaces.current : "settings";
  }
  return snapshot.surfaces.current;
}

export type DegradedModeViewModel = {
  active: boolean;
  title: string;
  detail: string;
  available: string[];
  unavailable: string[];
};

export function degradedModeViewModel(snapshot: AppSnapshot): DegradedModeViewModel {
  const offline = snapshot.health.network.status !== "online";
  const spotifyUnavailable = snapshot.health.spotifyAuth.status !== "connected" || !snapshot.readiness.spotifyAuthorized;
  const speakerUnavailable = snapshot.health.speaker.status !== "connected";
  const playbackUnavailable = !snapshot.capabilities.canStartPlayback || !snapshot.capabilities.canControlPlayback;
  const active = snapshot.appPhase === "degraded" || offline || spotifyUnavailable || speakerUnavailable || playbackUnavailable;

  const unavailable: string[] = [];
  if (offline) unavailable.push("live library browsing");
  if (spotifyUnavailable) unavailable.push("Spotify library access");
  if (speakerUnavailable) unavailable.push("speaker playback");
  if (playbackUnavailable) unavailable.push("music playback");

  const primaryReason = offline
    ? "Internet is unavailable."
    : spotifyUnavailable
      ? "Spotify needs reconnecting."
      : speakerUnavailable
        ? "The Bluetooth speaker is not connected."
        : "Playback is unavailable right now.";

  return {
    active,
    title: active ? "Recovery mode" : "Ready",
    detail: active
      ? `${primaryReason} Settings, Wi-Fi, Bluetooth, and reset stay available. Offline music playback is not supported.`
      : "All core playback dependencies are available.",
    available: ["Settings", "Wi-Fi recovery", "Bluetooth recovery", "App reset"],
    unavailable: Array.from(new Set(unavailable)),
  };
}

export type LibraryAvailability = {
  canBrowse: boolean;
  canSearch: boolean;
  canStartPlayback: boolean;
  stale: boolean;
  title: string;
  detail: string;
};

export function libraryAvailability(snapshot: AppSnapshot): LibraryAvailability {
  const canBrowse = !isSetupGated(snapshot) && snapshot.capabilities.canBrowse;
  const canSearch = !isSetupGated(snapshot) && snapshot.capabilities.canSearch;
  const canStartPlayback = !isSetupGated(snapshot) && snapshot.capabilities.canStartPlayback;

  if (snapshot.staleness.isStale || !canBrowse || !canSearch) {
    const reason = snapshot.health.network.status !== "online"
      ? "Network is unavailable."
      : snapshot.health.spotifyAuth.status !== "connected"
        ? "Spotify needs reconnecting."
        : "Playback services are not fully ready.";
    return {
      canBrowse,
      canSearch,
      canStartPlayback,
      stale: snapshot.staleness.isStale,
      title: "Library is in recovery mode",
      detail: `${reason} Saved content may be visible in mock or cached views, but live library access stays disabled until recovery completes.`,
    };
  }

  return {
    canBrowse,
    canSearch,
    canStartPlayback,
    stale: false,
    title: "Saved music",
    detail: "Playlists, albums, artists, liked songs, and recent listening stay constrained to the connected account.",
  };
}

export function canPlayLibraryItem(snapshot: AppSnapshot, item: LibraryItem): boolean {
  return libraryAvailability(snapshot).canStartPlayback && item.playable && item.playbackKind !== "unavailable";
}

export type VolumeControlViewModel = {
  value: number;
  muted: boolean;
  disabled: boolean;
  statusLabel: string;
  detail: string;
  tone: "ready" | "waiting" | "attention";
};

export function volumeControlViewModel(snapshot: AppSnapshot): VolumeControlViewModel {
  const volume = snapshot.health.volume;
  const value = volume.value ?? 0;
  const muted = volume.muted ?? false;
  const disabled = !snapshot.capabilities.canControlVolume || volume.status === "unavailable";
  const reason = volume.reason ? labelFromId(volume.reason) : undefined;

  if (volume.status === "unified") {
    return {
      value,
      muted,
      disabled,
      statusLabel: muted ? "Muted" : `${value}%`,
      detail: "Spotify and Pi output volume are linked.",
      tone: "ready",
    };
  }
  if (volume.status === "os_only") {
    return {
      value,
      muted,
      disabled,
      statusLabel: muted ? "Muted" : `${value}%`,
      detail: "Pi output volume is controlled locally.",
      tone: "ready",
    };
  }
  if (volume.status === "spotify_only" || volume.status === "write_only") {
    return {
      value,
      muted,
      disabled,
      statusLabel: `${value}%`,
      detail: `${labelFromId(volume.status)}${reason ? `: ${reason}` : "."}`,
      tone: "waiting",
    };
  }
  return {
    value,
    muted,
    disabled,
    statusLabel: volume.status === "out_of_sync" ? "Out of sync" : "Unavailable",
    detail: reason ? `Volume is limited: ${reason}.` : "Volume control is unavailable right now.",
    tone: "attention",
  };
}

export function labelFromId(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatMs(ms?: number): string {
  if (!ms || ms < 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function startSleepTimer(minutes: SleepTimerPresetMinutes, nowMs: number): SleepTimerState {
  return {
    status: "active",
    durationMinutes: minutes,
    startedAtMs: nowMs,
    expiresAtMs: nowMs + minutes * 60 * 1000,
  };
}

export function cancelSleepTimer(): SleepTimerState {
  return { status: "idle" };
}

export function canUseSleepTimer(snapshot: AppSnapshot): boolean {
  return (
    !isSetupGated(snapshot)
    && snapshot.capabilities.canUseSleepTimer
    && snapshot.capabilities.canControlPlayback
    && snapshot.health.playbackDevice.status === "available"
  );
}

export function sleepTimerViewModel(snapshot: AppSnapshot, timer: SleepTimerState, nowMs: number): SleepTimerViewModel {
  const remainingMs = Math.max(0, (timer.expiresAtMs ?? nowMs) - nowMs);
  const active = timer.status === "active" && remainingMs > 0;
  const expired = ["expired", "blocked", "failed"].includes(timer.status) || (timer.status === "active" && remainingMs <= 0);
  const usable = canUseSleepTimer(snapshot);
  const deviceReason = snapshot.health.playbackDevice.reason;

  if (active) {
    return {
      presets: sleepTimerPresets,
      canStart: usable,
      canCancel: true,
      active,
      expired: false,
      remainingMs,
      label: `Stops in ${formatMs(remainingMs)}`,
      detail: usable
        ? "Pipzo will send stop through the playback control path when this timer ends."
        : `Playback control is currently unavailable${deviceReason ? `: ${labelFromId(deviceReason)}` : "."}`,
      tone: "waiting",
    };
  }

  if (expired) {
    return {
      presets: sleepTimerPresets,
      canStart: usable,
      canCancel: false,
      active: false,
      expired: true,
      remainingMs: 0,
      label: "Timer ended",
      detail: timer.message ?? "Playback stop was requested.",
      tone: timer.status === "blocked" || timer.status === "failed" ? "attention" : "ready",
    };
  }

  return {
    presets: sleepTimerPresets,
    canStart: usable,
    canCancel: false,
    active: false,
    expired: false,
    remainingMs: 0,
    label: usable ? "Sleep timer ready" : "Sleep timer unavailable",
    detail: usable
      ? "Choose a preset. Active timers are local to this browser session."
      : `Playback control is unavailable${deviceReason ? `: ${labelFromId(deviceReason)}` : "."}`,
    tone: usable ? "ready" : "attention",
  };
}

export function sleepTimerExpiryCommand(snapshot: AppSnapshot, timer: SleepTimerState, nowMs: number): SleepTimerExpiryCommand {
  const due = timer.status === "active" && typeof timer.expiresAtMs === "number" && nowMs >= timer.expiresAtMs;
  if (!due) {
    return { shouldStop: false, action: "stop" };
  }
  if (!canUseSleepTimer(snapshot)) {
    return {
      shouldStop: false,
      action: "stop",
      blockedReason: snapshot.health.playbackDevice.reason ?? snapshot.health.playbackDevice.status,
    };
  }
  return {
    shouldStop: true,
    action: "stop",
    deviceId: snapshot.health.playbackDevice.deviceId,
  };
}

export type IdlePresentation = {
  enabled: boolean;
  showArtwork: boolean;
  brightness: number;
  mode: IdleMode;
  statusLabel: string;
};

export function idlePresentation(snapshot: AppSnapshot): IdlePresentation {
  const mode = snapshot.settings.idleMode;
  const enabled = mode !== "off" && !isSetupGated(snapshot);
  const showArtwork = enabled && (snapshot.settings.artworkInIdle || mode === "clock_with_artwork");
  const isPlaying = Boolean(snapshot.nowPlaying?.isPlaying);

  return {
    enabled,
    showArtwork,
    brightness: snapshot.settings.bedtimeBrightness,
    mode,
    statusLabel: snapshot.nowPlaying ? (isPlaying ? "Playing" : "Paused") : "Clock",
  };
}

export function shouldEnterIdleMode(snapshot: AppSnapshot, lastActivityAtMs: number, nowMs: number): boolean {
  const presentation = idlePresentation(snapshot);
  if (!presentation.enabled) {
    return false;
  }
  const timeoutMs = snapshot.settings.idleTimeoutSeconds * 1000;
  return nowMs - lastActivityAtMs >= timeoutMs;
}

export type SpotifyAuthAction = "start" | "open" | "refresh" | "cancel" | "retry" | "logout" | "reconnect" | "finish";

export type SpotifyAuthViewModel = {
  title: string;
  detail: string;
  accountLabel?: string;
  tone: "ready" | "waiting" | "attention";
  actions: SpotifyAuthAction[];
};

export function spotifyAuthViewModel(snapshot: AppSnapshot, session?: SpotifyAuthSession | null): SpotifyAuthViewModel {
  const accountLabel = session?.accountDisplayName ?? snapshot.health.spotifyAuth.accountDisplayName;
  const playback = snapshot.health.playbackDevice;
  const finalGestureRequired = playback.status === "transfer_required" || playback.reason === "device_not_registered" || playback.reason === "sdk_not_ready";

  if (session?.status === "connected" && snapshot.health.spotifyAuth.status === "connected") {
    if (finalGestureRequired) {
      return {
        title: "One last step",
        detail: "Tap once to finish setting up Spotify playback on this device.",
        accountLabel: accountLabel ?? undefined,
        tone: "waiting",
        actions: ["finish"],
      };
    }
    if (playback.status === "error") {
      return {
        title: "Spotify playback is not ready yet",
        detail: "Your account is connected, but Pipzo could not finish preparing playback on this device.",
        accountLabel: accountLabel ?? undefined,
        tone: "attention",
        actions: ["finish"],
      };
    }
    return {
      title: "Spotify is ready",
      detail: "Pipzo is ready to play from this account.",
      accountLabel: accountLabel ?? undefined,
      tone: "ready",
      actions: [],
    };
  }

  if (snapshot.readiness.spotifyAuthorized && snapshot.health.spotifyAuth.status === "connected") {
    return {
      title: "Spotify connected",
      detail: accountLabel
        ? "Pipzo is using this Spotify account. Switch accounts if this device should use someone else's Spotify Premium account."
        : "Pipzo is using the connected Spotify account. Switch accounts if this device should use someone else's Spotify Premium account.",
      accountLabel: accountLabel ?? undefined,
      tone: "ready",
      actions: ["reconnect", "logout"],
    };
  }

  if (session?.status === "waiting" || session?.status === "callback_received") {
    return {
      title: "Finish connecting Spotify",
      detail: "Sign in and approve Pipzo in this browser, then return here automatically.",
      accountLabel: accountLabel ?? undefined,
      tone: "waiting",
      actions: ["open", "refresh", "cancel"],
    };
  }

  if (session?.status === "expired") {
    return {
      title: "Spotify setup expired",
      detail: "Start a fresh local authorization session. Wi-Fi and speaker progress will stay in place.",
      tone: "attention",
      actions: ["retry"],
    };
  }

  if (session?.status === "failed" || session?.status === "cancelled") {
    return {
      title: session.status === "cancelled" ? "Spotify setup cancelled" : "Spotify setup did not finish",
      detail: "Try again from this screen. Pipzo will only show safe setup status here.",
      tone: "attention",
      actions: ["retry"],
    };
  }

  if (snapshot.health.spotifyAuth.status === "reconnect_required" || snapshot.health.spotifyAuth.status === "error") {
    return {
      title: "Spotify needs attention",
      detail: snapshot.health.spotifyAuth.reason === "token_refresh_failed" || snapshot.health.spotifyAuth.reason === "revoked"
        ? "This Spotify connection is no longer valid. Reconnect or switch accounts."
        : "Pipzo needs permission to keep using Spotify on this device.",
      accountLabel: accountLabel ?? undefined,
      tone: "attention",
      actions: accountLabel ? ["start", "reconnect", "logout"] : ["start"],
    };
  }

  return {
    title: "Connect Spotify",
    detail: "Connect a Spotify Premium account for music, playlists, and liked songs on Pipzo.",
    accountLabel: accountLabel ?? undefined,
    tone: "attention",
    actions: ["start"],
  };
}

export type WifiAction = "scan" | "connect" | "retry" | "forget";

export type WifiSetupViewModel = {
  title: string;
  detail: string;
  ipAddressLabel: string;
  tone: "ready" | "waiting" | "attention";
  actions: WifiAction[];
};

export function wifiSetupViewModel(snapshot: AppSnapshot, networks: WifiNetwork[] = []): WifiSetupViewModel {
  const network = snapshot.health.network;
  if (network.status === "online") {
    return {
      title: network.ssid ? `Connected to ${network.ssid}` : "Wi-Fi connected",
      detail: "Internet is reachable. Continue setup from this device.",
      ipAddressLabel: network.ipAddress ?? "Unknown",
      tone: "ready",
      actions: ["scan", "forget"],
    };
  }
  if (network.status === "local_only") {
    return {
      title: network.ssid ? `${network.ssid} has no internet` : "Wi-Fi has no internet",
      detail: "Pipzo can show settings, but Spotify setup and playback need internet access.",
      ipAddressLabel: network.ipAddress ?? "Unknown",
      tone: "attention",
      actions: ["retry", "scan", "forget"],
    };
  }
  if (network.status === "starting") {
    return {
      title: "Checking Wi-Fi",
      detail: "The backend is waiting for NetworkManager before showing recovery choices.",
      ipAddressLabel: "Unknown",
      tone: "waiting",
      actions: ["scan"],
    };
  }
  if (networks.length > 0) {
    return {
      title: "Choose a Wi-Fi network",
      detail: "Select the home network, enter its password when needed, then connect.",
      ipAddressLabel: "Unknown",
      tone: "attention",
      actions: ["scan", "connect"],
    };
  }
  return {
    title: "Connect Wi-Fi",
    detail: network.reason ? `Current state: ${labelFromId(network.reason)}.` : "Scan for nearby Wi-Fi networks.",
    ipAddressLabel: "Unknown",
    tone: "attention",
    actions: ["scan"],
  };
}

export type SpeakerAction = "scan" | "pair" | "reconnect" | "forget";

export type SpeakerSetupViewModel = {
  title: string;
  detail: string;
  tone: "ready" | "waiting" | "attention";
  actions: SpeakerAction[];
};

export type SpeakerDeviceRow = {
  address: string;
  title: string;
  detail: string;
  selected: boolean;
  currentPrimary: boolean;
};

export function preferredSpeakerSelection(
  snapshot: AppSnapshot,
  devices: SpeakerDevice[] = [],
  currentAddress = "",
): string {
  const primaryAddress = snapshot.health.speaker.primary?.address;
  const current = devices.find((device) => device.address === currentAddress);
  if (current && current.address !== primaryAddress) {
    return current.address;
  }
  return devices.find((device) => device.address !== primaryAddress)?.address ?? current?.address ?? devices[0]?.address ?? "";
}

export function speakerDeviceRows(snapshot: AppSnapshot, devices: SpeakerDevice[] = [], selectedAddress = ""): SpeakerDeviceRow[] {
  const primaryAddress = snapshot.health.speaker.primary?.address;
  return devices.map((device) => {
    const currentPrimary = device.address === primaryAddress;
    const status = currentPrimary
      ? "Current primary"
      : device.connected
        ? "Connected"
        : device.paired
          ? "Paired"
          : "New";
    return {
      address: device.address,
      title: device.displayName || device.alias || device.address,
      detail: `${status} / ${device.address}`,
      selected: device.address === selectedAddress,
      currentPrimary,
    };
  });
}

export function speakerSetupViewModel(snapshot: AppSnapshot, devices: SpeakerDevice[] = []): SpeakerSetupViewModel {
  const speaker = snapshot.health.speaker;
  if (speaker.status === "connected") {
    return {
      title: speaker.primary?.displayName ? `${speaker.primary.displayName} connected` : "Speaker connected",
      detail: devices.length > 0 ? "Choose another discovered audio device to replace the current primary speaker." : "Pipzo has a primary Bluetooth speaker ready for playback.",
      tone: "ready",
      actions: devices.length > 0 ? ["scan", "pair", "reconnect", "forget"] : ["scan", "reconnect", "forget"],
    };
  }
  if (speaker.status === "saved_disconnected") {
    return {
      title: speaker.primary?.displayName ? `${speaker.primary.displayName} is disconnected` : "Speaker disconnected",
      detail: "Reconnect the saved speaker or scan to choose a different one.",
      tone: "attention",
      actions: devices.length > 0 ? ["reconnect", "scan", "pair", "forget"] : ["reconnect", "scan", "forget"],
    };
  }
  if (speaker.status === "scanning" || speaker.status === "pairing" || speaker.status === "reconnecting" || speaker.status === "starting") {
    return {
      title: "Checking speaker",
      detail: "Pipzo is waiting for the Bluetooth adapter to finish the current operation.",
      tone: "waiting",
      actions: ["scan"],
    };
  }
  if (devices.length > 0) {
    return {
      title: "Choose a Bluetooth speaker",
      detail: "Select one speaker for V1. Pipzo will trust it and use it as the primary output.",
      tone: "attention",
      actions: ["scan", "pair"],
    };
  }
  return {
    title: "Pair Bluetooth speaker",
    detail: speaker.reason ? `Current state: ${labelFromId(speaker.reason)}.` : "Scan for nearby Bluetooth audio devices.",
    tone: "attention",
    actions: ["scan"],
  };
}
