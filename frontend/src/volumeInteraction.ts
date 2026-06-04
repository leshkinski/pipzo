import type { HealthState } from "./contracts";

export type VolumePatchTarget = {
  value: number;
  muted: boolean;
  deviceId?: string;
};

export type QueuedVolumePatch = VolumePatchTarget & {
  requestId: number;
};

export type VolumeSnapshotProtection = {
  active: boolean;
  intendedVolume?: VolumePatchTarget | null;
  lastIntentAtMs?: number;
  nowMs: number;
  graceMs: number;
};

export function normalizedVolumeTarget(value: number, muted: boolean, deviceId?: string): VolumePatchTarget {
  return {
    value: Math.max(0, Math.min(100, Math.round(value))),
    muted,
    deviceId,
  };
}

export function shouldCommitLiveVolumeChange(lastCommitAtMs: number | undefined, nowMs: number, intervalMs: number): boolean {
  return lastCommitAtMs === undefined || nowMs - lastCommitAtMs >= intervalMs;
}

export function volumePatchTargetsEqual(left: VolumePatchTarget | null | undefined, right: VolumePatchTarget): boolean {
  return Boolean(left && left.value === right.value && left.muted === right.muted && left.deviceId === right.deviceId);
}

export function snapshotWithProtectedVolume<TSnapshot extends AppVolumeSnapshot>(
  incoming: TSnapshot,
  current: TSnapshot,
  protection: boolean | VolumeSnapshotProtection,
): TSnapshot {
  const protectVolume = typeof protection === "boolean"
    ? protection
    : shouldProtectVolumeFromSnapshot(incoming.health.volume, protection);
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

export function shouldProtectVolumeFromSnapshot(
  incomingVolume: HealthState["volume"],
  protection: VolumeSnapshotProtection,
): boolean {
  if (protection.active) {
    return true;
  }
  if (!protection.intendedVolume || protection.lastIntentAtMs === undefined) {
    return false;
  }
  if (protection.nowMs - protection.lastIntentAtMs > protection.graceMs) {
    return false;
  }
  return incomingVolume.value !== protection.intendedVolume.value
    || incomingVolume.muted !== protection.intendedVolume.muted;
}

export function isLatestVolumeRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

type AppVolumeSnapshot = {
  health: {
    volume: HealthState["volume"];
  };
};
