import type { AppSnapshot, SpotifyAuthSession, SurfaceId } from "./contracts";

export const primarySurfaces: SurfaceId[] = ["home", "browse", "now_playing", "settings", "idle"];

export function isSetupGated(snapshot: AppSnapshot): boolean {
  return snapshot.appPhase === "setup" || !snapshot.readiness.minimumReady;
}

export function canOpenSurface(snapshot: AppSnapshot, surface: SurfaceId): boolean {
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
  if (snapshot.appPhase === "degraded") {
    return canOpenSurface(snapshot, snapshot.surfaces.current) ? snapshot.surfaces.current : "settings";
  }
  return snapshot.surfaces.current;
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
