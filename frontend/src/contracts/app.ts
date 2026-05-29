export type AppPhase = "starting" | "setup" | "ready" | "degraded";

export type SetupStepId = "welcome" | "wifi" | "spotify_auth" | "speaker" | "playback_test" | "complete" | "none";
export type SetupStepStatus = "not_started" | "in_progress" | "action_required" | "ready" | "blocked";

export type SurfaceId = "setup" | "home" | "browse" | "now_playing" | "settings" | "idle";
export type IdleMode = "off" | "clock" | "clock_with_artwork";

export type RecoveryActionState = "available" | "confirm_required" | "running" | "succeeded" | "failed" | "blocked";

export type NetworkStatus = "starting" | "online" | "local_only" | "offline" | "disabled" | "error";
export type NetworkReason =
  | "boot_probe_pending"
  | "no_wifi_device"
  | "wifi_radio_disabled"
  | "no_known_network"
  | "scan_empty"
  | "bad_credentials"
  | "association_failed"
  | "dhcp_failed"
  | "dns_failed"
  | "internet_probe_failed"
  | "captive_portal_suspected"
  | "user_switching_network"
  | "unknown";

export type SpeakerStatus =
  | "starting"
  | "none_saved"
  | "scanning"
  | "pairing"
  | "connected"
  | "saved_disconnected"
  | "reconnecting"
  | "forgetting"
  | "error";
export type SpeakerReason =
  | "boot_probe_pending"
  | "bluetooth_disabled"
  | "adapter_unavailable"
  | "scan_empty"
  | "device_out_of_range"
  | "pair_rejected"
  | "pair_timeout"
  | "connect_failed"
  | "audio_profile_unavailable"
  | "primary_missing"
  | "user_forgot"
  | "unknown";

export type PlaybackDeviceStatus = "starting" | "available" | "registering" | "transfer_required" | "unavailable" | "error";
export type PlaybackDeviceReason =
  | "chromium_not_ready"
  | "sdk_not_ready"
  | "premium_required"
  | "auth_required"
  | "device_not_registered"
  | "transfer_failed"
  | "spotify_api_error"
  | "network_unavailable"
  | "speaker_unavailable"
  | "unknown";

export type VolumeStatus = "unified" | "spotify_only" | "os_only" | "write_only" | "out_of_sync" | "unavailable";
export type VolumeReason =
  | "boot_probe_pending"
  | "spotify_volume_unsupported"
  | "os_sink_missing"
  | "bluetooth_sink_missing"
  | "readback_mismatch"
  | "reconnect_resync_needed"
  | "permission_denied"
  | "unknown";

export type DisplayStatus = "normal" | "dimmed" | "off" | "unavailable";
export type DisplayReason = "idle" | "bedtime" | "user_setting" | "boot_probe_pending" | "hardware_unavailable" | "unknown";

export type SpotifyAuthStatus = "starting" | "none" | "waiting" | "connected" | "expired" | "reconnect_required" | "error";
export type SpotifyAuthReason =
  | "boot_probe_pending"
  | "no_session"
  | "oauth_pending"
  | "oauth_expired"
  | "token_refresh_failed"
  | "revoked"
  | "premium_required"
  | "network_unavailable"
  | "unknown";

export type SpotifyAuthSessionStatus = "waiting" | "callback_received" | "connected" | "expired" | "failed" | "cancelled";
export type SpotifyAuthSessionFailureReason =
  | "spotify_error"
  | "missing_state"
  | "unknown_state"
  | "state_mismatch"
  | "expired_state"
  | "cancelled"
  | "missing_code";

export type KioskBootPhase = "system_booting" | "backend_starting" | "frontend_loading" | "adapters_probing" | "app_ready";

export type WarningCode =
  | "network_offline"
  | "network_local_only"
  | "spotify_reconnect_required"
  | "speaker_disconnected"
  | "speaker_pair_failed"
  | "playback_device_unavailable"
  | "volume_limited"
  | "volume_out_of_sync"
  | "stale_content"
  | "kiosk_recovered"
  | "diagnostics_limited";

export type Reason = NetworkReason | SpeakerReason | SpotifyAuthReason | PlaybackDeviceReason | VolumeReason | DisplayReason;

export type SetupStep = {
  id: SetupStepId;
  status: SetupStepStatus;
  reason?: Reason;
  required: boolean;
};

export type SetupState = {
  blockingStep: SetupStepId;
  steps: SetupStep[];
};

export type ReadinessState = {
  networkConfigured: boolean;
  spotifyAuthorized: boolean;
  primarySpeakerSaved: boolean;
  playbackTestPassed: boolean;
  setupCompletedAt?: string;
  minimumReady: boolean;
};

export type SpeakerSummary = {
  address: string;
  displayName: string;
  alias?: string;
  connected: boolean;
};

export type HealthState = {
  network: { status: NetworkStatus; reason?: NetworkReason; ssid?: string; internetReachable?: boolean };
  spotifyAuth: { status: SpotifyAuthStatus; reason?: SpotifyAuthReason; accountDisplayName?: string };
  speaker: { status: SpeakerStatus; reason?: SpeakerReason; primary?: SpeakerSummary };
  playbackDevice: { status: PlaybackDeviceStatus; reason?: PlaybackDeviceReason; deviceId?: string };
  volume: { status: VolumeStatus; reason?: VolumeReason; value?: number; muted?: boolean };
  display: { status: DisplayStatus; reason?: DisplayReason; brightness: number };
  kiosk: { phase: KioskBootPhase; lastRestartAt?: string };
};

export type WifiSecurity = "open" | "wpa" | "wpa2" | "wpa3" | "unknown";

export type WifiNetwork = {
  ssid: string;
  signal: number;
  security: WifiSecurity;
  known: boolean;
};

export type WifiScanResults = {
  networks: WifiNetwork[];
  scannedAt: string;
};

export type NetworkConnectRequest = {
  ssid: string;
  password?: string;
  hidden?: boolean;
};

export type NetworkForgetRequest = {
  ssid: string;
  confirm: true;
};

export type SpeakerDevice = {
  address: string;
  displayName: string;
  alias?: string;
  paired: boolean;
  connected: boolean;
  signal?: number | null;
};

export type SpeakerScanResults = {
  devices: SpeakerDevice[];
  scannedAt: string;
};

export type SpeakerPairRequest = {
  address: string;
  displayName?: string;
};

export type SpeakerForgetRequest = {
  address: string;
  confirm: true;
};

export type SurfaceState = {
  current: SurfaceId;
  route?: string;
  returnSurface?: SurfaceId;
  idleMode: IdleMode;
};

export type Warning = {
  code: WarningCode;
  reason?: Reason;
  surface?: SurfaceId;
  action?: string;
};

export type CapabilityState = {
  canBrowse: boolean;
  canSearch: boolean;
  canStartPlayback: boolean;
  canControlPlayback: boolean;
  canControlVolume: boolean;
  canUseSleepTimer: boolean;
  canOpenSettings: true;
  canRunDiagnostics: boolean;
};

export type DiagnosticsSummary = {
  safeMode: boolean;
  rawAdapterCode?: string;
  lastCommand?: string;
  lastLogRef?: string;
  generatedAt: string;
};

export type RecoveryActionKind =
  | "connect_wifi"
  | "forget_wifi"
  | "start_spotify_auth"
  | "reconnect_speaker"
  | "forget_speaker"
  | "run_playback_test"
  | "retry_playback_device"
  | "reset_app";

export type RecoveryAction = {
  id: string;
  kind: RecoveryActionKind;
  state: RecoveryActionState;
  reason?: Reason;
  requiresConfirmation: boolean;
  startedAt?: string;
  completedAt?: string;
};

export type ActionResult = {
  id: string;
  domain: "setup" | "settings" | "playback" | "recovery";
  action: string;
  state: RecoveryActionState;
  reason?: Reason;
  mock: boolean;
  startedAt: string;
  completedAt?: string;
};

export type AppSettings = {
  idleMode: IdleMode;
  idleTimeoutSeconds: number;
  artworkInIdle: boolean;
  defaultSleepTimerMinutes?: number | null;
  brightness: number;
  bedtimeBrightness: number;
};

export type AppSettingsPatch = Partial<AppSettings>;

export type DisplayPatch = {
  brightness?: number;
  status?: DisplayStatus;
};

export type PlaybackControlRequest = {
  action: "play" | "pause" | "next" | "previous" | "stop";
};

export type SetupPlaybackTestRequest = {
  action: "start" | "stop";
};

export type RunRecoveryActionRequest = {
  confirm: boolean;
};

export type NowPlayingSummary = {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  isPlaying: boolean;
  progressMs?: number;
  durationMs?: number;
};

export type StalenessState = {
  isStale: boolean;
  staleSince?: string;
  reason?: string;
};

export type AppSnapshot = {
  appPhase: AppPhase;
  setup: SetupState;
  readiness: ReadinessState;
  health: HealthState;
  surfaces: SurfaceState;
  warnings: Warning[];
  capabilities: CapabilityState;
  diagnostics: DiagnosticsSummary;
  recoveryActions: RecoveryAction[];
  settings: AppSettings;
  nowPlaying?: NowPlayingSummary | null;
  staleness: StalenessState;
  updatedAt: string;
  schemaVersion: "v1";
};

export type ScenarioSummary = {
  id: string;
  label: string;
  description: string;
};

export type HealthResponse = {
  status: "ok";
  service: "pipzo-api";
  mode: string;
  schemaVersion: "v1";
  checkedAt: string;
};

export type SpotifyAuthSession = {
  sessionId: string;
  status: SpotifyAuthSessionStatus;
  createdAt: string;
  expiresAt: string;
  startUrl: string;
  failureReason?: SpotifyAuthSessionFailureReason | null;
  accountDisplayName?: string | null;
};

export type AppEvent =
  | { type: "app.snapshot"; payload: AppSnapshot; emittedAt: string; schemaVersion: "v1" }
  | { type: "settings.changed"; payload: AppSettings; emittedAt: string; schemaVersion: "v1" }
  | { type: "display.changed"; payload: HealthState["display"]; emittedAt: string; schemaVersion: "v1" }
  | { type: "setup.step_changed"; payload: SetupState; emittedAt: string; schemaVersion: "v1" }
  | { type: "setup.completed"; payload: AppSnapshot; emittedAt: string; schemaVersion: "v1" }
  | { type: "setup.playback_test_changed"; payload: RecoveryAction; emittedAt: string; schemaVersion: "v1" }
  | { type: "playback.control_changed"; payload: ActionResult; emittedAt: string; schemaVersion: "v1" }
  | { type: "recovery.action_changed"; payload: RecoveryAction; emittedAt: string; schemaVersion: "v1" }
  | { type: "spotify.auth_session_changed"; payload: SpotifyAuthSession; emittedAt: string; schemaVersion: "v1" }
  | { type: "spotify.auth_changed"; payload: HealthState["spotifyAuth"]; emittedAt: string; schemaVersion: "v1" }
  | { type: "mock.scenario_activated"; payload: AppSnapshot; emittedAt: string; schemaVersion: "v1" };
