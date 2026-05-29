import { describe, expect, it } from "vitest";

import { localScenarios } from "./localScenarios";
import type { SpotifyAuthSession } from "./contracts";
import { canOpenSurface, isSetupGated, preferredSurface, spotifyAuthViewModel } from "./viewModel";

describe("kiosk shell view model", () => {
  it("gates daily-use surfaces during first setup", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;

    expect(isSetupGated(snapshot)).toBe(true);
    expect(preferredSurface(snapshot)).toBe("setup");
    expect(canOpenSurface(snapshot, "home")).toBe(false);
    expect(canOpenSurface(snapshot, "settings")).toBe(true);
  });

  it("keeps settings reachable during degraded recovery", () => {
    const snapshot = localScenarios.degraded_recovery.snapshot;

    expect(isSetupGated(snapshot)).toBe(false);
    expect(preferredSurface(snapshot)).toBe("settings");
    expect(canOpenSurface(snapshot, "settings")).toBe(true);
    expect(canOpenSurface(snapshot, "browse")).toBe(false);
  });

  it("offers local Spotify setup when authorization is required", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;

    const view = spotifyAuthViewModel(snapshot);

    expect(view.title).toBe("Connect Spotify");
    expect(view.detail).toContain("local setup");
    expect(view.actions).toEqual(["start"]);
  });

  it("offers open, poll, and cancel controls while local Spotify auth is waiting", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;
    const session: SpotifyAuthSession = {
      sessionId: "safe-session-id",
      status: "waiting",
      createdAt: "2026-05-29T12:00:00.000Z",
      expiresAt: "2026-05-29T12:10:00.000Z",
      startUrl: "http://127.0.0.1:8000/api/v1/spotify/auth/start/safe-session-id",
      failureReason: null,
      accountDisplayName: null,
    };

    const view = spotifyAuthViewModel(snapshot, session);

    expect(view.title).toBe("Waiting for Spotify authorization");
    expect(view.actions).toEqual(["open", "refresh", "cancel"]);
  });

  it("shows safe account metadata and reconnect controls when Spotify is connected", () => {
    const snapshot = localScenarios.ready_healthy.snapshot;

    const view = spotifyAuthViewModel(snapshot);

    expect(view.title).toBe("Spotify account connected");
    expect(view.accountLabel).toBe("Pipzo");
    expect(view.actions).toEqual(["logout", "reconnect"]);
  });

  it("offers retry after expired, failed, or cancelled Spotify sessions", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;
    const baseSession: SpotifyAuthSession = {
      sessionId: "safe-session-id",
      status: "expired",
      createdAt: "2026-05-29T12:00:00.000Z",
      expiresAt: "2026-05-29T12:10:00.000Z",
      startUrl: "http://127.0.0.1:8000/api/v1/spotify/auth/start/safe-session-id",
      failureReason: "expired_state",
      accountDisplayName: null,
    };

    expect(spotifyAuthViewModel(snapshot, baseSession).actions).toEqual(["retry"]);
    expect(spotifyAuthViewModel(snapshot, { ...baseSession, status: "failed", failureReason: "spotify_error" }).actions).toEqual(["retry"]);
    expect(spotifyAuthViewModel(snapshot, { ...baseSession, status: "cancelled", failureReason: "cancelled" }).actions).toEqual(["retry"]);
  });
});
