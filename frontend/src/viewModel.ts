import type { AppSnapshot, IdleMode, SpeakerDevice, SpotifyAuthSession, SurfaceId, WifiNetwork } from "./contracts";

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

export type IdlePresentation = {
  enabled: boolean;
  showArtwork: boolean;
  brightness: number;
  mode: IdleMode;
  statusLabel: string;
};

export function idlePresentation(snapshot: AppSnapshot): IdlePresentation {
  const mode = snapshot.settings.idleMode;
  const enabled = mode !== "off" && !isSetupGated(snapshot);
  const showArtwork = enabled && (snapshot.settings.artworkInIdle || mode === "clock_with_artwork");
  const isPlaying = Boolean(snapshot.nowPlaying?.isPlaying);

  return {
    enabled,
    showArtwork,
    brightness: snapshot.settings.bedtimeBrightness,
    mode,
    statusLabel: snapshot.nowPlaying ? (isPlaying ? "Playing" : "Paused") : "Clock",
  };
}

export function shouldEnterIdleMode(snapshot: AppSnapshot, lastActivityAtMs: number, nowMs: number): boolean {
  const presentation = idlePresentation(snapshot);
  if (!presentation.enabled) {
    return false;
  }
  const timeoutMs = snapshot.settings.idleTimeoutSeconds * 1000;
  return nowMs - lastActivityAtMs >= timeoutMs;
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

export type WifiAction = "scan" | "connect" | "retry" | "forget";

export type WifiSetupViewModel = {
  title: string;
  detail: string;
  tone: "ready" | "waiting" | "attention";
  actions: WifiAction[];
};

export function wifiSetupViewModel(snapshot: AppSnapshot, networks: WifiNetwork[] = []): WifiSetupViewModel {
  const network = snapshot.health.network;
  if (network.status === "online") {
    return {
      title: network.ssid ? `Connected to ${network.ssid}` : "Wi-Fi connected",
      detail: "Internet is reachable. Continue setup from this device.",
      tone: "ready",
      actions: ["scan", "forget"],
    };
  }
  if (network.status === "local_only") {
    return {
      title: network.ssid ? `${network.ssid} has no internet` : "Wi-Fi has no internet",
      detail: "Pipzo can show settings, but Spotify setup and playback need internet access.",
      tone: "attention",
      actions: ["retry", "scan", "forget"],
    };
  }
  if (network.status === "starting") {
    return {
      title: "Checking Wi-Fi",
      detail: "The backend is waiting for NetworkManager before showing recovery choices.",
      tone: "waiting",
      actions: ["scan"],
    };
  }
  if (networks.length > 0) {
    return {
      title: "Choose a Wi-Fi network",
      detail: "Select the home network, enter its password when needed, then connect.",
      tone: "attention",
      actions: ["scan", "connect"],
    };
  }
  return {
    title: "Connect Wi-Fi",
    detail: network.reason ? `Current state: ${labelFromId(network.reason)}.` : "Scan for nearby Wi-Fi networks.",
    tone: "attention",
    actions: ["scan"],
  };
}

export type SpeakerAction = "scan" | "pair" | "reconnect" | "forget";

export type SpeakerSetupViewModel = {
  title: string;
  detail: string;
  tone: "ready" | "waiting" | "attention";
  actions: SpeakerAction[];
};

export function speakerSetupViewModel(snapshot: AppSnapshot, devices: SpeakerDevice[] = []): SpeakerSetupViewModel {
  const speaker = snapshot.health.speaker;
  if (speaker.status === "connected") {
    return {
      title: speaker.primary?.displayName ? `${speaker.primary.displayName} connected` : "Speaker connected",
      detail: "Pipzo has a primary Bluetooth speaker ready for playback.",
      tone: "ready",
      actions: ["scan", "reconnect", "forget"],
    };
  }
  if (speaker.status === "saved_disconnected") {
    return {
      title: speaker.primary?.displayName ? `${speaker.primary.displayName} is disconnected` : "Speaker disconnected",
      detail: "Reconnect the saved speaker or scan to choose a different one.",
      tone: "attention",
      actions: ["reconnect", "scan", "forget"],
    };
  }
  if (speaker.status === "scanning" || speaker.status === "pairing" || speaker.status === "reconnecting" || speaker.status === "starting") {
    return {
      title: "Checking speaker",
      detail: "Pipzo is waiting for the Bluetooth adapter to finish the current operation.",
      tone: "waiting",
      actions: ["scan"],
    };
  }
  if (devices.length > 0) {
    return {
      title: "Choose a Bluetooth speaker",
      detail: "Select one speaker for V1. Pipzo will trust it and use it as the primary output.",
      tone: "attention",
      actions: ["scan", "pair"],
    };
  }
  return {
    title: "Pair Bluetooth speaker",
    detail: speaker.reason ? `Current state: ${labelFromId(speaker.reason)}.` : "Scan for nearby Bluetooth audio devices.",
    tone: "attention",
    actions: ["scan"],
  };
}
