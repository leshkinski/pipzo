import type { AppSnapshot, ScenarioSummary } from "./contracts";

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
