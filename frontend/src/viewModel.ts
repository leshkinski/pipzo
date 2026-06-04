import type { AppSnapshot, IdleMode, LibraryCategoryId, LibraryItem, PlaybackQueueResponse, SpeakerDevice, SpotifyAuthSession, SurfaceId, WifiNetwork } from "./contracts";

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
  activeSurface: SurfaceId | "sleep_timer",
  snapshot: AppSnapshot,
  dataSource: "backend" | "local",
): boolean {
  return activeSurface === "home" && dataSource === "backend" && libraryAvailability(snapshot).canBrowse;
}

export function canOpenSurface(snapshot: AppSnapshot, surface: SurfaceId): boolean {
  if (surface === "setup") {
    return isSetupGated(snapshot);
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
    return "setup";
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

export type SpotifyAuthAction = "start" | "open" | "refresh" | "cancel" | "retry" | "logout" | "reconnect";

export type SpotifyAuthViewModel = {
  title: string;
  detail: string;
  accountLabel?: string;
  tone: "ready" | "waiting" | "attention";
  actions: SpotifyAuthAction[];
};

export function spotifyAuthViewModel(snapshot: AppSnapshot, session?: SpotifyAuthSession | null): SpotifyAuthViewModel {
  const accountLabel = session?.accountDisplayName ?? snapshot.health.spotifyAuth.accountDisplayName;

  if (snapshot.readiness.spotifyAuthorized && snapshot.health.spotifyAuth.status === "connected") {
    return {
      title: "Spotify account connected",
      detail: accountLabel ? "Pipzo can use this account for playback and library browsing." : "Pipzo can use the connected account for playback and library browsing.",
      accountLabel: accountLabel ?? undefined,
      tone: "ready",
      actions: ["logout", "reconnect"],
    };
  }

  if (session?.status === "waiting" || session?.status === "callback_received") {
    return {
      title: session.status === "callback_received" ? "Finishing Spotify setup" : "Waiting for Spotify authorization",
      detail: "Use this Chromium window to sign in and approve Pipzo, then return here when Spotify sends you back.",
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
      title: "Spotify reconnect required",
      detail: "Reconnect locally in Chromium so Pipzo can refresh playback access.",
      accountLabel: accountLabel ?? undefined,
      tone: "attention",
      actions: ["start"],
    };
  }

  return {
    title: "Connect Spotify",
    detail: "Start local setup on this device. Pipzo uses Authorization Code with PKCE in Chromium.",
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
