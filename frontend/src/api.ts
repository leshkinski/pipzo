import type {
  ActionResult,
  AppSettings,
  AppSettingsPatch,
  AppSnapshot,
  DisplayPatch,
  HealthState,
  PlaybackControlRequest,
  RecoveryAction,
  RunRecoveryActionRequest,
  ScenarioSummary,
  SetupPlaybackTestRequest,
  SetupState,
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

export function fetchBackendScenarios(): Promise<ScenarioSummary[]> {
  return request<ScenarioSummary[]>("/api/v1/mock/scenarios");
}

export function activateBackendScenario(scenarioId: string): Promise<AppSnapshot> {
  return request<AppSnapshot>(`/api/v1/mock/scenarios/${scenarioId}/activate`, { method: "POST" });
}

export function startSetup(): Promise<SetupState> {
  return request<SetupState>("/api/v1/setup/start", { method: "POST" });
}

export function completeSetup(): Promise<AppSnapshot> {
  return request<AppSnapshot>("/api/v1/setup/complete", { method: "POST" });
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

export function fetchRecoveryActions(): Promise<RecoveryAction[]> {
  return request<RecoveryAction[]>("/api/v1/recovery/actions");
}

export function runRecoveryAction(actionId: string, body: RunRecoveryActionRequest): Promise<RecoveryAction> {
  return request<RecoveryAction>(`/api/v1/recovery/actions/${actionId}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
