import type {
  ActionResult,
  AppSettings,
  AppSettingsPatch,
  AppSnapshot,
  CurrentTrackLikeStatus,
  DevicePowerActionRequest,
  DisplayPatch,
  ExtensionDiagnosticsSnapshot,
  HealthState,
  HealthResponse,
  LibraryCategoryId,
  LibraryCategoryResponse,
  LibraryHomeResponse,
  LibraryPlayRequest,
  PlaybackQueueResponse,
  LibrarySearchResponse,
  KioskBrowserSessionResetRequest,
  NetworkConnectRequest,
  NetworkForgetRequest,
  PlaybackControlRequest,
  RecoveryAction,
  QueuePlayRequest,
  RunRecoveryActionRequest,
  ScenarioSummary,
  SpeakerForgetRequest,
  SpeakerPairRequest,
  SpeakerScanResults,
  SetupPlaybackTestRequest,
  SpotifyAuthSession,
  SpotifyPlaybackToken,
  SpotifyPlaybackTransferRequest,
  VolumePatch,
  WifiScanResults,
} from "./contracts";

const headers = { "Content-Type": "application/json" };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function fetchAppState(): Promise<AppSnapshot> {
  return request<AppSnapshot>("/api/v1/app/state");
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/v1/health");
}

export function fetchExtensionDiagnostics(): Promise<ExtensionDiagnosticsSnapshot> {
  return request<ExtensionDiagnosticsSnapshot>("/api/v1/diagnostics/extension");
}

export function fetchBackendScenarios(): Promise<ScenarioSummary[]> {
  return request<ScenarioSummary[]>("/api/v1/mock/scenarios");
}

export function activateBackendScenario(scenarioId: string): Promise<AppSnapshot> {
  return request<AppSnapshot>(`/api/v1/mock/scenarios/${scenarioId}/activate`, { method: "POST" });
}

export function runSetupPlaybackTest(body: SetupPlaybackTestRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/setup/playback-test", { method: "POST", body: JSON.stringify(body) });
}

export function fetchSettings(): Promise<AppSettings> {
  return request<AppSettings>("/api/v1/settings");
}

export function patchSettings(body: AppSettingsPatch): Promise<AppSettings> {
  return request<AppSettings>("/api/v1/settings", { method: "PATCH", body: JSON.stringify(body) });
}

export function patchDisplay(body: DisplayPatch): Promise<HealthState["display"]> {
  return request<HealthState["display"]>("/api/v1/display", { method: "PATCH", body: JSON.stringify(body) });
}

export function controlPlayback(body: PlaybackControlRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/playback/control", { method: "POST", body: JSON.stringify(body) });
}

export function patchVolume(body: VolumePatch): Promise<HealthState["volume"]> {
  return request<HealthState["volume"]>("/api/v1/volume", { method: "PATCH", body: JSON.stringify(body) });
}

export function rebootDevice(body: DevicePowerActionRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/device/reboot", { method: "POST", body: JSON.stringify(body) });
}

export function powerOffDevice(body: DevicePowerActionRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/device/poweroff", { method: "POST", body: JSON.stringify(body) });
}

export function fetchSpotifyPlaybackToken(): Promise<SpotifyPlaybackToken> {
  return request<SpotifyPlaybackToken>("/api/v1/spotify/playback/token");
}

export function transferSpotifyPlayback(body: SpotifyPlaybackTransferRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/spotify/playback/transfer", { method: "POST", body: JSON.stringify(body) });
}

export function fetchLibraryHome(limit = 12): Promise<LibraryHomeResponse> {
  return request<LibraryHomeResponse>(`/api/v1/library/home?limit=${limit}`);
}

export function fetchLibraryCategory(category: LibraryCategoryId, limit = 50): Promise<LibraryCategoryResponse> {
  return request<LibraryCategoryResponse>(`/api/v1/library/${category}?limit=${limit}`);
}

export function searchLibrary(query: string): Promise<LibrarySearchResponse> {
  return request<LibrarySearchResponse>(`/api/v1/library/search?q=${encodeURIComponent(query)}`);
}

export function playLibraryItem(body: LibraryPlayRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/library/play", { method: "POST", body: JSON.stringify(body) });
}

export function likeCurrentTrack(): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/library/like-current", { method: "POST" });
}

export function fetchCurrentTrackLikeStatus(): Promise<CurrentTrackLikeStatus> {
  return request<CurrentTrackLikeStatus>("/api/v1/library/current-like");
}

export function fetchPlaybackQueue(): Promise<PlaybackQueueResponse> {
  return request<PlaybackQueueResponse>("/api/v1/spotify/queue");
}

export function playQueueSelection(body: QueuePlayRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/spotify/queue/play", { method: "POST", body: JSON.stringify(body) });
}

export function fetchNetworkStatus(): Promise<HealthState["network"]> {
  return request<HealthState["network"]>("/api/v1/network/status");
}

export function scanNetwork(): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/network/scan", { method: "POST" });
}

export function fetchNetworkScanResults(): Promise<WifiScanResults> {
  return request<WifiScanResults>("/api/v1/network/scan-results");
}

export function connectNetwork(body: NetworkConnectRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/network/connect", { method: "POST", body: JSON.stringify(body) });
}

export function forgetNetwork(body: NetworkForgetRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/network/forget", { method: "POST", body: JSON.stringify(body) });
}

export function retryInternetProbe(): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/network/retry-internet-probe", { method: "POST" });
}

export function fetchSpeakerStatus(): Promise<HealthState["speaker"]> {
  return request<HealthState["speaker"]>("/api/v1/speaker/status");
}

export function scanSpeakers(): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/speaker/scan", { method: "POST" });
}

export function fetchSpeakerScanResults(): Promise<SpeakerScanResults> {
  return request<SpeakerScanResults>("/api/v1/speaker/scan-results");
}

export function pairSpeaker(body: SpeakerPairRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/speaker/pair", { method: "POST", body: JSON.stringify(body) });
}

export function reconnectSpeaker(): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/speaker/reconnect", { method: "POST" });
}

export function forgetSpeaker(body: SpeakerForgetRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>("/api/v1/speaker/forget", { method: "POST", body: JSON.stringify(body) });
}

export function fetchRecoveryActions(): Promise<RecoveryAction[]> {
  return request<RecoveryAction[]>("/api/v1/recovery/actions");
}

export function runRecoveryAction(actionId: string, body: RunRecoveryActionRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>(`/api/v1/recovery/actions/${actionId}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function createSpotifyAuthSession(): Promise<SpotifyAuthSession> {
  return request<SpotifyAuthSession>("/api/v1/spotify/auth/session", { method: "POST" });
}

export function fetchSpotifyAuthSession(sessionId: string): Promise<SpotifyAuthSession> {
  return request<SpotifyAuthSession>(`/api/v1/spotify/auth/session/${sessionId}`);
}

export function cancelSpotifyAuthSession(sessionId: string): Promise<SpotifyAuthSession> {
  return request<SpotifyAuthSession>(`/api/v1/spotify/auth/session/${sessionId}/cancel`, { method: "POST" });
}

export function logoutSpotifyAuth(): Promise<HealthState["spotifyAuth"]> {
  return request<HealthState["spotifyAuth"]>("/api/v1/spotify/auth/logout", { method: "POST" });
}

export function resetSpotifyBrowserSession(body: KioskBrowserSessionResetRequest): Promise<ActionResult> {
  return request<ActionResult>("/api/v1/spotify/browser-session/reset", { method: "POST", body: JSON.stringify(body) });
}
