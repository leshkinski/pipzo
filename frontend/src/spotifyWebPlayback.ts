import { fetchSpotifyPlaybackToken, transferSpotifyPlayback } from "./api";
import type { ActionResult, AppSnapshot } from "./contracts";

export type SpotifySdkStatus =
  | "disabled"
  | "auth_required"
  | "premium_required"
  | "browser_not_ready"
  | "loading"
  | "connecting"
  | "ready"
  | "device_not_ready"
  | "error";

export type SpotifySdkState = {
  status: SpotifySdkStatus;
  deviceId?: string;
  error?: string;
  activated: boolean;
  transferred: boolean;
};

export type SpotifySdkGate = {
  enabled: boolean;
  status: SpotifySdkStatus;
  detail: string;
};

type SpotifyPlayerReadyEvent = { device_id: string };
type SpotifyPlayerErrorEvent = { message?: string };
type SpotifyTokenCallback = (token: string) => void;

export type SpotifyPlayerInstance = {
  addListener(event: "ready" | "not_ready", listener: (event: SpotifyPlayerReadyEvent) => void): boolean;
  addListener(
    event: "initialization_error" | "authentication_error" | "account_error" | "playback_error",
    listener: (event: SpotifyPlayerErrorEvent) => void,
  ): boolean;
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement?: () => Promise<void>;
};

export type SpotifyPlayerConstructor = new (options: {
  name: string;
  getOAuthToken: (callback: SpotifyTokenCallback) => void;
  volume?: number;
}) => SpotifyPlayerInstance;

type SpotifySdkWindow = Window & {
  Spotify?: { Player: SpotifyPlayerConstructor };
  onSpotifyWebPlaybackSDKReady?: () => void;
};

let sdkLoadPromise: Promise<void> | null = null;

export function spotifySdkGate(snapshot: AppSnapshot, dataSource: "backend" | "local", backendMode?: string): SpotifySdkGate {
  if (dataSource !== "backend") {
    return {
      enabled: false,
      status: "disabled",
      detail: "Live Spotify playback is disabled for local fallback scenarios.",
    };
  }
  if (backendMode !== "hardware") {
    return {
      enabled: false,
      status: "disabled",
      detail: "Live Spotify playback is disabled in backend mock mode.",
    };
  }
  if (snapshot.health.spotifyAuth.status !== "connected" || !snapshot.readiness.spotifyAuthorized) {
    return {
      enabled: false,
      status: "auth_required",
      detail: "Connect Spotify locally before registering the playback device.",
    };
  }
  if (snapshot.health.spotifyAuth.reason === "premium_required") {
    return {
      enabled: false,
      status: "premium_required",
      detail: "Spotify Premium is required for Web Playback SDK playback.",
    };
  }
  if (snapshot.health.network.status !== "online") {
    return {
      enabled: false,
      status: "browser_not_ready",
      detail: "Network recovery is required before the browser player can connect.",
    };
  }
  return {
    enabled: true,
    status: "loading",
    detail: "Chromium can register Pipzo as a Spotify Connect playback device.",
  };
}

export function spotifySdkStatusLabel(state: SpotifySdkState): string {
  if (state.status === "ready" && state.deviceId) {
    return state.transferred ? "Pipzo playback device is ready and selected." : "Pipzo playback device is ready.";
  }
  if (state.status === "device_not_ready") return "Spotify marked the browser player offline.";
  if (state.status === "premium_required") return "Spotify Premium is required for browser playback.";
  if (state.status === "auth_required") return "Reconnect Spotify before starting browser playback.";
  if (state.status === "browser_not_ready") return "Chromium or the network is not ready for browser playback.";
  if (state.status === "connecting") return "Registering the Pipzo browser player.";
  if (state.status === "loading") return "Loading the Spotify Web Playback SDK.";
  if (state.status === "error") return state.error ?? "Spotify browser playback is unavailable.";
  return "Spotify browser playback is idle.";
}

export async function loadSpotifyWebPlaybackSdk(win: SpotifySdkWindow = window as SpotifySdkWindow): Promise<void> {
  if (win.Spotify?.Player) {
    return;
  }
  if (sdkLoadPromise) {
    return sdkLoadPromise;
  }

  sdkLoadPromise = new Promise((resolve, reject) => {
    const existingReady = win.onSpotifyWebPlaybackSDKReady;
    const script = win.document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => reject(new Error("spotify_sdk_load_failed"));
    win.onSpotifyWebPlaybackSDKReady = () => {
      existingReady?.();
      resolve();
    };
    win.document.body.appendChild(script);
  });
  return sdkLoadPromise;
}

export async function createSpotifyWebPlayer(
  options: {
    onState: (state: Partial<SpotifySdkState>) => void;
    tokenProvider?: typeof fetchSpotifyPlaybackToken;
    transferPlayback?: typeof transferSpotifyPlayback;
    win?: SpotifySdkWindow;
  },
): Promise<SpotifyPlayerInstance> {
  const win = options.win ?? (window as SpotifySdkWindow);
  const tokenProvider = options.tokenProvider ?? fetchSpotifyPlaybackToken;
  const transferPlayback = options.transferPlayback ?? transferSpotifyPlayback;

  await loadSpotifyWebPlaybackSdk(win);
  if (!win.Spotify?.Player) {
    throw new Error("spotify_sdk_unavailable");
  }

  const player = new win.Spotify.Player({
    name: "Pipzo",
    getOAuthToken: (callback) => {
      void tokenProvider()
        .then((token) => callback(token.accessToken))
        .catch(() => {
          options.onState({ status: "auth_required", error: "spotify_playback_token_unavailable" });
          callback("");
        });
    },
    volume: 0.5,
  });

  player.addListener("ready", ({ device_id }) => {
    options.onState({ status: "ready", deviceId: device_id, error: undefined });
    void transferPlayback({ deviceId: device_id, play: false })
      .then((result: ActionResult) => {
        options.onState({
          transferred: result.state === "succeeded",
          status: result.state === "succeeded" ? "ready" : "error",
          error: result.reason,
        });
      })
      .catch(() => options.onState({ status: "error", error: "spotify_transfer_failed" }));
  });
  player.addListener("not_ready", ({ device_id }) => {
    options.onState({ status: "device_not_ready", deviceId: device_id, transferred: false });
  });
  player.addListener("initialization_error", ({ message }) => options.onState({ status: "browser_not_ready", error: message }));
  player.addListener("authentication_error", ({ message }) => options.onState({ status: "auth_required", error: message }));
  player.addListener("account_error", ({ message }) => options.onState({ status: "premium_required", error: message }));
  player.addListener("playback_error", ({ message }) => options.onState({ status: "error", error: message }));

  options.onState({ status: "connecting" });
  const connected = await player.connect();
  if (!connected) {
    options.onState({ status: "error", error: "spotify_player_connect_failed" });
  }
  return player;
}
