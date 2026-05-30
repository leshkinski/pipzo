import { describe, expect, it } from "vitest";

import { localScenarios } from "./localScenarios";
import { createSpotifyWebPlayer, spotifySdkGate, spotifySdkStatusLabel, type SpotifyPlayerInstance } from "./spotifyWebPlayback";

describe("Spotify Web Playback SDK view model", () => {
  it("keeps live SDK disabled for local fallback scenarios", () => {
    const gate = spotifySdkGate(localScenarios.ready_healthy.snapshot, "local", undefined);

    expect(gate.enabled).toBe(false);
    expect(gate.status).toBe("disabled");
    expect(gate.detail).toContain("local fallback");
  });

  it("keeps live SDK disabled for backend mock mode", () => {
    const gate = spotifySdkGate(localScenarios.ready_healthy.snapshot, "backend", "mock");

    expect(gate.enabled).toBe(false);
    expect(gate.status).toBe("disabled");
    expect(gate.detail).toContain("mock mode");
  });

  it("allows SDK registration only when hardware backend Spotify auth and network are ready", () => {
    const gate = spotifySdkGate(localScenarios.ready_healthy.snapshot, "backend", "hardware");

    expect(gate.enabled).toBe(true);
    expect(gate.status).toBe("loading");
  });

  it("reports auth and Premium blockers without requiring Spotify", () => {
    const authGate = spotifySdkGate(localScenarios.first_boot_empty.snapshot, "backend", "hardware");
    const premiumSnapshot = {
      ...localScenarios.ready_healthy.snapshot,
      health: {
        ...localScenarios.ready_healthy.snapshot.health,
        spotifyAuth: {
          ...localScenarios.ready_healthy.snapshot.health.spotifyAuth,
          reason: "premium_required" as const,
        },
      },
    };
    const premiumGate = spotifySdkGate(premiumSnapshot, "backend", "hardware");

    expect(authGate.status).toBe("auth_required");
    expect(premiumGate.status).toBe("premium_required");
  });

  it("summarizes ready, transfer, and blocked SDK states for UI", () => {
    expect(
      spotifySdkStatusLabel({
        status: "ready",
        deviceId: "pipzo-device",
        activated: true,
        transferred: true,
      }),
    ).toContain("ready and selected");
    expect(
      spotifySdkStatusLabel({
        status: "device_not_ready",
        activated: true,
        transferred: false,
      }),
    ).toContain("offline");
  });

  it("does not transfer playback when the SDK device registers", async () => {
    const statePatches: object[] = [];
    const listeners: Record<string, (event: { device_id: string }) => void> = {};
    const player: SpotifyPlayerInstance = {
      addListener: (event: string, listener: (event: { device_id: string }) => void) => {
        listeners[event] = listener;
        return true;
      },
      connect: async () => true,
      disconnect: () => undefined,
    } as SpotifyPlayerInstance;
    const win = {
      Spotify: {
        Player: class {
          constructor() {
            return player;
          }
        },
      },
    } as unknown as Window & { Spotify: { Player: new () => SpotifyPlayerInstance } };

    await createSpotifyWebPlayer({
      win,
      tokenProvider: async () => ({
        accessToken: "safe-access-token",
        tokenType: "Bearer",
        expiresAt: new Date().toISOString(),
        scope: "streaming",
      }),
      onState: (patch) => statePatches.push(patch),
    });
    listeners.ready({ device_id: "pipzo-device" });

    expect(statePatches).toContainEqual({ status: "ready", deviceId: "pipzo-device", error: undefined });
    expect(statePatches).not.toContainEqual(expect.objectContaining({ transferred: true }));
  });
});
