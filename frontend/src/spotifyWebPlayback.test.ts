import { describe, expect, it } from "vitest";

import { localScenarios } from "./localScenarios";
import { spotifySdkGate, spotifySdkStatusLabel } from "./spotifyWebPlayback";

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
});
