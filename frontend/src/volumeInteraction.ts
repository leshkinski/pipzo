import type { HealthState } from "./contracts";

export type VolumePatchTarget = {
  value: number;
  muted: boolean;
  deviceId?: string;
};

export type QueuedVolumePatch = VolumePatchTarget & {
  requestId: number;
};

export function normalizedVolumeTarget(value: number, muted: boolean, deviceId?: string): VolumePatchTarget {
  return {
    value: Math.max(0, Math.min(100, Math.round(value))),
    muted,
    deviceId,
  };
}

export function snapshotWithProtectedVolume<TSnapshot extends AppVolumeSnapshot>(
  incoming: TSnapshot,
  current: TSnapshot,
  protectVolume: boolean,
): TSnapshot {
  if (!protectVolume) {
    return incoming;
  }
  return {
    ...incoming,
    health: {
      ...incoming.health,
      volume: current.health.volume,
    },
  };
}

export function isLatestVolumeRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

type AppVolumeSnapshot = {
  health: {
    volume: HealthState["volume"];
  };
};
