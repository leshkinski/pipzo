import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  activateBackendScenario,
  cancelSpotifyAuthSession,
  controlPlayback,
  createSpotifyAuthSession,
  fetchAppState,
  fetchBackendScenarios,
  fetchHealth,
  fetchLibraryCategory,
  fetchLibraryHome,
  fetchCurrentTrackLikeStatus,
  fetchNetworkScanResults,
  fetchPlaybackQueue,
  fetchSpeakerScanResults,
  fetchSpotifyAuthSession,
  forgetSpeaker,
  forgetNetwork,
  likeCurrentTrack,
  logoutSpotifyAuth,
  patchDisplay,
  patchSettings,
  patchVolume,
  pairSpeaker,
  playLibraryItem,
  retryInternetProbe,
  reconnectSpeaker,
  runSetupPlaybackTest,
  scanSpeakers,
  scanNetwork,
  connectNetwork,
  transferSpotifyPlayback,
} from "./api";
import type { AppSettingsPatch, AppSnapshot, DisplayStatus, LibraryCategoryId, LibraryHomeResponse, LibraryItem, PlaybackQueueResponse, ScenarioSummary, SpeakerDevice, SpotifyAuthSession, SurfaceId, WifiNetwork } from "./contracts";
import { localLibraryHome, localScenarioSnapshot, localScenarioSummaries } from "./localScenarios";
import {
  createSpotifyWebPlayer,
  spotifySdkGate,
  spotifySdkStatusLabel,
  type SpotifyPlayerInstance,
  type SpotifySdkState,
} from "./spotifyWebPlayback";
import { useExplicitDragScroll } from "./explicitDragScroll";
import {
  canOpenSurface,
  canPlayLibraryItem,
  degradedModeViewModel,
  formatMs,
  homeLibraryCategoryOrder,
  idlePresentation,
  isSetupGated,
  labelFromId,
  libraryAvailability,
  nextNowPlayingBoundaryRefreshDelayMs,
  nowPlayingEmptyState,
  nowPlayingCommandRefreshDelaysMs,
  nowPlayingRefreshIntervalMs,
  preferredSpeakerSelection,
  preferredSurface,
  shellNavigationItems,
  shouldRefreshNowPlaying,
  shouldRefreshHomeOnOpen,
  shouldPollAppStateForSetupReadiness,
  shouldRetryBackendRecovery,
  shouldShowDeveloperPanel,
  shouldEnterIdleMode,
  sleepTimerExpiryCommand,
  speakerDeviceRows,
  sleepTimerPresets,
  sleepTimerViewModel,
  speakerSetupViewModel,
  startSleepTimer,
  spotifyAuthViewModel,
  volumeControlViewModel,
  wifiSetupViewModel,
  type SleepTimerPresetMinutes,
  type SleepTimerState,
} from "./viewModel";
import {
  bluetoothSuccessAlertSuppressedEvent,
  installBluetoothSuccessAlertSuppression,
  type BluetoothSuccessAlertSuppressedDetail,
} from "./bluetoothSuccessAlerts";
import {
  isLatestVolumeRequest,
  normalizedVolumeTarget,
  snapshotWithProtectedVolume,
  type QueuedVolumePatch,
  type VolumePatchTarget,
} from "./volumeInteraction";

type DataSource = "backend" | "local";
type AppSurfaceId = SurfaceId | "sleep_timer";
type PipzoImportMeta = ImportMeta & {
  env?: {
    DEV?: boolean;
    VITE_PIPZO_SHOW_MOCK_CONTROLS?: string;
  };
};

type KeyboardState = {
  active: boolean;
  surface: SurfaceId | null;
};

type TouchFeedback = {
  id: number;
  label: string;
};

type SpotifyAuthControls = {
  session: SpotifyAuthSession | null;
  busy: boolean;
  message: string;
  onStart: () => void;
  onOpen: () => void;
  onRefresh: () => void;
  onCancel: () => void;
  onLogout: () => void;
  onReconnect: () => void;
};

type WifiControls = {
  networks: WifiNetwork[];
  selectedSsid: string;
  password: string;
  busy: boolean;
  message: string;
  onScan: () => void;
  onSelect: (ssid: string) => void;
  onPassword: (password: string) => void;
  onConnect: () => void;
  onRetry: () => void;
  onForget: () => void;
};

type SpeakerControls = {
  devices: SpeakerDevice[];
  selectedAddress: string;
  busy: boolean;
  message: string;
  onScan: () => void;
  onSelect: (address: string) => void;
  onPair: () => void;
  onReconnect: () => void;
  onForget: () => void;
};

type SleepTimerControls = {
  timer: SleepTimerState;
  nowMs: number;
  busy: boolean;
  onStart: (minutes: SleepTimerPresetMinutes) => void;
  onCancel: () => void;
};

type VolumeControls = {
  busy: boolean;
  message: string;
  onChange: (value: number, muted?: boolean) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
};

type LikeControls = {
  busy: boolean;
  liked: boolean;
  message: string;
  onLike: () => void;
};

type SetupPlaybackControls = {
  busy: boolean;
  message: string;
  onConfirm: () => void;
};

type LibraryControls = {
  home: LibraryHomeResponse;
  activeCategory: LibraryCategoryId;
  busy: boolean;
  message: string;
  onCategory: (category: LibraryCategoryId) => void;
  onPlay: (item: LibraryItem) => void;
};

type QueueControls = {
  open: boolean;
  busy: boolean;
  message: string;
  current: LibraryItem | null;
  items: LibraryItem[];
  onOpen: () => void;
  onClose: () => void;
  onPlay: (item: LibraryItem) => void;
};

type PlaybackCommand = "play" | "pause" | "next" | "previous" | "previous_track" | "shuffle" | "repeat";

const navLabels: Record<SurfaceId, string> = {
  setup: "Setup",
  home: "Home",
  now_playing: "Now",
  settings: "Settings",
  browse: "Browse",
  idle: "Idle",
};

const speakerStateRefreshDelaysMs = [0, 500, 1500, 3000] as const;
const bluetoothMutationSnapshotRefreshDelaysMs = [500, 1500, 3000, 6000, 10000] as const;
const setupReadinessRefreshIntervalMs = 2500;
const backendRecoveryRefreshIntervalMs = 2500;
const volumeLocalIntentGraceMs = 3000;
const pipzoImportMeta = import.meta as PipzoImportMeta;
const localDeveloperControlsEnabled = pipzoImportMeta.env?.DEV === true || pipzoImportMeta.env?.VITE_PIPZO_SHOW_MOCK_CONTROLS === "true";

function isConfirmedSpeakerConnected(state: AppSnapshot) {
  return state.health.speaker.status === "connected" && Boolean(state.health.speaker.primary?.connected);
}

function itemInitials(title: string) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase() || "P";
}

function categoryFallbackInitial(category: LibraryCategoryId) {
  if (category === "playlists") return "P";
  if (category === "albums") return "A";
  if (category === "artists") return "AR";
  if (category === "liked_songs") return "L";
  if (category === "recently_played") return "R";
  return "P";
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => localScenarioSnapshot("first_boot_empty"));
  const [selectedSurface, setSelectedSurface] = useState<AppSurfaceId>("setup");
  const [timerReturnSurface, setTimerReturnSurface] = useState<AppSurfaceId>("now_playing");
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>(() => localScenarioSummaries());
  const [selectedScenario, setSelectedScenario] = useState("first_boot_empty");
  const [dataSource, setDataSource] = useState<DataSource>("local");
  const [bootAttempted, setBootAttempted] = useState(false);
  const [backendMode, setBackendMode] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Using local fallback scenarios.");
  const [spotifyAuthSession, setSpotifyAuthSession] = useState<SpotifyAuthSession | null>(null);
  const [spotifyAuthBusy, setSpotifyAuthBusy] = useState(false);
  const [spotifyAuthMessage, setSpotifyAuthMessage] = useState("Use local Chromium on this device to connect Spotify.");
  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[]>([]);
  const [selectedWifiSsid, setSelectedWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [wifiBusy, setWifiBusy] = useState(false);
  const [wifiMessage, setWifiMessage] = useState("Scan for Wi-Fi networks to start.");
  const [speakerDevices, setSpeakerDevices] = useState<SpeakerDevice[]>([]);
  const [selectedSpeakerAddress, setSelectedSpeakerAddress] = useState("");
  const [speakerBusy, setSpeakerBusy] = useState(false);
  const [speakerMessage, setSpeakerMessage] = useState("Scan for a Bluetooth speaker after Wi-Fi and Spotify are ready.");
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());
  const [idleActive, setIdleActive] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>({ status: "idle" });
  const [sleepTimerBusy, setSleepTimerBusy] = useState(false);
  const [volumeBusy, setVolumeBusy] = useState(false);
  const [volumeMessage, setVolumeMessage] = useState("Volume follows the app control.");
  const [playbackTestBusy, setPlaybackTestBusy] = useState(false);
  const [playbackTestMessage, setPlaybackTestMessage] = useState("Activate and select the browser player before confirming playback.");
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [libraryHome, setLibraryHome] = useState<LibraryHomeResponse>(() => localLibraryHome());
  const [libraryCategory, setLibraryCategory] = useState<LibraryCategoryId>("recently_played");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryMessage, setLibraryMessage] = useState("Library fixtures loaded for local development.");
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueMessage, setQueueMessage] = useState("Tap the artwork to show songs coming up.");
  const [likeBusy, setLikeBusy] = useState(false);
  const [likeMessage, setLikeMessage] = useState("Save the current song.");
  const [currentTrackLiked, setCurrentTrackLiked] = useState(false);
  const [playbackQueue, setPlaybackQueue] = useState<PlaybackQueueResponse>(() => ({
    current: null,
    items: [],
    generatedAt: new Date().toISOString(),
  }));
  const [keyboardState, setKeyboardState] = useState<KeyboardState>({ active: false, surface: null });
  const [touchFeedback, setTouchFeedback] = useState<TouchFeedback | null>(null);
  const [spotifySdkState, setSpotifySdkState] = useState<SpotifySdkState>({
    status: "disabled",
    activated: false,
    transferred: false,
  });
  const spotifyPlayerRef = useRef<SpotifyPlayerInstance | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const snapshotRefreshInFlightRef = useRef<Promise<AppSnapshot> | null>(null);
  const scheduledSnapshotRefreshIdsRef = useRef<number[]>([]);
  const previousTapTimeoutRef = useRef<number | null>(null);
  const homeAutoRefreshActiveRef = useRef(false);
  const touchFeedbackTimeoutRef = useRef<number | null>(null);
  const volumeRequestSeqRef = useRef(0);
  const volumeInFlightRef = useRef(false);
  const pendingVolumeRequestRef = useRef<QueuedVolumePatch | null>(null);
  const volumeInteractionActiveRef = useRef(false);
  const volumeInteractionIdleTimeoutRef = useRef<number | null>(null);
  const latestVolumeIntentRef = useRef<VolumePatchTarget | null>(null);
  const latestVolumeIntentAtMsRef = useRef<number | undefined>(undefined);

  useExplicitDragScroll(appRef);

  useEffect(() => () => {
    if (touchFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(touchFeedbackTimeoutRef.current);
    }
    if (volumeInteractionIdleTimeoutRef.current !== null) {
      window.clearTimeout(volumeInteractionIdleTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        await loadBackendState({ cancelled: () => cancelled });
        if (cancelled) return;
      } catch {
        if (cancelled) return;
        const fallback = localScenarioSnapshot("first_boot_empty");
        setSnapshot(fallback);
        setLibraryHome(localLibraryHome());
        setScenarios(localScenarioSummaries());
        setDataSource("local");
        setBackendMode(null);
        setStatusText("Backend unavailable. Showing local fallback scenarios.");
      } finally {
        if (!cancelled) {
          setBootAttempted(true);
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bootAttempted || !shouldRetryBackendRecovery(dataSource)) {
      return;
    }

    let cancelled = false;
    const retry = () => {
      void loadBackendState({ cancelled: () => cancelled, recovery: true }).catch(() => undefined);
    };
    retry();
    const intervalId = window.setInterval(retry, backendRecoveryRefreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [bootAttempted, dataSource]);

  useEffect(() => {
    const preferred = preferredSurface(snapshot);
    setSelectedSurface((current) => (current === "sleep_timer" || canOpenSurface(snapshot, current) ? current : preferred));
  }, [snapshot]);

  useEffect(() => {
    if (snapshot.health.spotifyAuth.status === "connected") {
      setSpotifyAuthSession(null);
    }
  }, [snapshot.health.spotifyAuth.status]);

  useEffect(() => {
    function wake() {
      setLastActivityAt(Date.now());
      setIdleActive(false);
    }

    window.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("touchstart", wake, { passive: true });
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    function updateVisualViewportVars() {
      const visualViewport = window.visualViewport;
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      const keyboardInset = Math.max(0, window.innerHeight - viewportHeight - (visualViewport?.offsetTop ?? 0));
      root.style.setProperty("--pipzo-viewport-height", `${Math.round(viewportHeight)}px`);
      root.style.setProperty("--pipzo-keyboard-inset", `${Math.round(keyboardInset)}px`);
    }

    function activeElementSurface(element: Element | null): SurfaceId | null {
      const surface = element?.closest<HTMLElement>("[data-surface]");
      return (surface?.dataset.surface as SurfaceId | undefined) ?? null;
    }

    function updateKeyboardFocus() {
      const element = document.activeElement;
      const editable = element instanceof HTMLTextAreaElement
        || (element instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset"].includes(element.type));
      setKeyboardState({ active: editable, surface: editable ? activeElementSurface(element) : null });
    }

    updateVisualViewportVars();
    updateKeyboardFocus();

    window.visualViewport?.addEventListener("resize", updateVisualViewportVars);
    window.visualViewport?.addEventListener("scroll", updateVisualViewportVars);
    window.addEventListener("resize", updateVisualViewportVars);
    document.addEventListener("focusin", updateKeyboardFocus);
    document.addEventListener("focusout", updateKeyboardFocus);

    return () => {
      window.visualViewport?.removeEventListener("resize", updateVisualViewportVars);
      window.visualViewport?.removeEventListener("scroll", updateVisualViewportVars);
      window.removeEventListener("resize", updateVisualViewportVars);
      document.removeEventListener("focusin", updateKeyboardFocus);
      document.removeEventListener("focusout", updateKeyboardFocus);
      root.style.removeProperty("--pipzo-viewport-height");
      root.style.removeProperty("--pipzo-keyboard-inset");
    };
  }, []);

  useEffect(() => {
    return () => {
      clearScheduledSnapshotRefreshes();
      if (touchFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(touchFeedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = appRef.current;
    if (!root) {
      return;
    }
    const interactionRoot = root;

    let pressedElement: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;

    function clearPressedElement() {
      pressedElement?.classList.remove("touch-pressed");
      pressedElement = null;
    }

    function feedbackLabel(element: HTMLElement): string {
      const label = element.getAttribute("aria-label") ?? element.textContent ?? "Selected";
      const normalized = label.replace(/\s+/g, " ").trim();
      return normalized || "Selected";
    }

    function onPointerDown(event: PointerEvent) {
      if (!(event.target instanceof Element)) {
        return;
      }
      const element = event.target.closest<HTMLElement>("button, [role='button'], input, select, textarea, label");
      if (!element || !interactionRoot.contains(element) || element.matches(":disabled, [aria-disabled='true']")) {
        return;
      }

      clearPressedElement();
      pressedElement = element;
      startX = event.clientX;
      startY = event.clientY;
      element.classList.add("touch-pressed");
      setTouchFeedback({ id: Date.now(), label: feedbackLabel(element) });
      if (touchFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(touchFeedbackTimeoutRef.current);
      }
      touchFeedbackTimeoutRef.current = window.setTimeout(() => {
        setTouchFeedback(null);
        touchFeedbackTimeoutRef.current = null;
      }, 900);
    }

    function onPointerMove(event: PointerEvent) {
      if (!pressedElement) {
        return;
      }
      if (Math.max(Math.abs(event.clientX - startX), Math.abs(event.clientY - startY)) > 14) {
        clearPressedElement();
      }
    }

    interactionRoot.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    interactionRoot.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    interactionRoot.addEventListener("pointerup", clearPressedElement, { capture: true, passive: true });
    interactionRoot.addEventListener("pointercancel", clearPressedElement, { capture: true, passive: true });
    interactionRoot.addEventListener("pointerleave", clearPressedElement, { capture: true, passive: true });

    return () => {
      clearPressedElement();
      interactionRoot.removeEventListener("pointerdown", onPointerDown, true);
      interactionRoot.removeEventListener("pointermove", onPointerMove, true);
      interactionRoot.removeEventListener("pointerup", clearPressedElement, true);
      interactionRoot.removeEventListener("pointercancel", clearPressedElement, true);
      interactionRoot.removeEventListener("pointerleave", clearPressedElement, true);
    };
  }, []);

  useEffect(() => {
    installBluetoothSuccessAlertSuppression();

    function updateSuppressedBluetoothSuccess(event: Event) {
      const detail = (event as CustomEvent<BluetoothSuccessAlertSuppressedDetail>).detail;
      if (detail?.message) {
        setStatusText(detail.message);
      }
    }

    window.addEventListener(bluetoothSuccessAlertSuppressedEvent, updateSuppressedBluetoothSuccess);
    return () => {
      window.removeEventListener(bluetoothSuccessAlertSuppressedEvent, updateSuppressedBluetoothSuccess);
    };
  }, []);

  useEffect(() => {
    if (!idlePresentation(snapshot).enabled) {
      setIdleActive(false);
      return;
    }
    if (idleActive) {
      return;
    }

    const now = Date.now();
    const timeoutMs = snapshot.settings.idleTimeoutSeconds * 1000;
    const remainingMs = Math.max(0, lastActivityAt + timeoutMs - now);
    const timeoutId = window.setTimeout(() => {
      setIdleActive(shouldEnterIdleMode(snapshot, lastActivityAt, Date.now()));
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [idleActive, lastActivityAt, snapshot]);

  useEffect(() => {
    if (!spotifyAuthSession || !["waiting", "callback_received"].includes(spotifyAuthSession.status)) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void refreshSpotifySession({ quiet: true, cancelled: () => cancelled });
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [spotifyAuthSession?.sessionId, spotifyAuthSession?.status]);

  useEffect(() => {
    const command = sleepTimerExpiryCommand(snapshot, sleepTimer, nowMs);
    if (sleepTimer.status !== "active" || !sleepTimer.expiresAtMs || nowMs < sleepTimer.expiresAtMs) {
      return;
    }

    if (!command.shouldStop) {
      setSleepTimer({
        ...sleepTimer,
        status: "blocked",
        message: `Timer ended, but playback control is unavailable${command.blockedReason ? `: ${labelFromId(command.blockedReason)}` : "."}`,
      });
      return;
    }

    if (dataSource !== "backend") {
      setSleepTimer({
        ...sleepTimer,
        status: "blocked",
        message: "Timer ended, but local fallback scenarios do not call Spotify playback.",
      });
      return;
    }

    setSleepTimerBusy(true);
    setSleepTimer({ ...sleepTimer, status: "expired", message: "Timer ended. Sending playback stop." });
    void controlPlayback({ action: command.action, deviceId: command.deviceId })
      .then((result) => {
        setSleepTimer((current) => ({
          ...current,
          status: result.state === "succeeded" ? "expired" : "blocked",
          message: result.state === "succeeded"
            ? "Timer ended and playback stop was sent."
            : `Timer ended, but stop was blocked: ${labelFromId(result.reason ?? "unknown")}.`,
        }));
        setStatusText(result.state === "succeeded" ? "Sleep timer stopped playback." : "Sleep timer ended, but playback stop was blocked.");
      })
      .catch(() => {
        setSleepTimer((current) => ({
          ...current,
          status: "failed",
          message: "Timer ended, but playback stop could not be sent.",
        }));
        setStatusText("Sleep timer ended, but playback stop could not be sent.");
      })
      .finally(() => {
        setSleepTimerBusy(false);
      });
  }, [dataSource, nowMs, sleepTimer, snapshot]);

  useEffect(() => {
    if (!shouldRefreshNowPlaying(snapshot, dataSource)) {
      return;
    }

    let cancelled = false;
    const refresh = () => {
      if (!cancelled) {
        void refreshSnapshot().catch(() => undefined);
      }
    };
    const intervalId = window.setInterval(refresh, nowPlayingRefreshIntervalMs);
    const boundaryDelayMs = nextNowPlayingBoundaryRefreshDelayMs(snapshot, Date.now());
    const boundaryTimeoutId = boundaryDelayMs === null ? null : window.setTimeout(refresh, boundaryDelayMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      if (boundaryTimeoutId !== null) {
        window.clearTimeout(boundaryTimeoutId);
      }
    };
  }, [dataSource, snapshot]);

  useEffect(() => {
    if (!shouldPollAppStateForSetupReadiness(snapshot, dataSource)) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        void refreshSnapshot().catch(() => undefined);
      }
    }, setupReadinessRefreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [dataSource, snapshot]);

  const gated = isSetupGated(snapshot);
  const activeSurface = idleActive ? "idle" : gated ? "setup" : selectedSurface;
  const visibleWarnings = snapshot.warnings;
  const degradedMode = degradedModeViewModel(snapshot);
  const spotifyPlaybackGate = useMemo(() => spotifySdkGate(snapshot, dataSource, backendMode ?? undefined), [snapshot, dataSource, backendMode]);
  const showDeveloperPanel = shouldShowDeveloperPanel(dataSource, backendMode, localDeveloperControlsEnabled);
  const currentScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenario),
    [scenarios, selectedScenario],
  );
  const nowPlayingLikeKey = snapshot.nowPlaying
    ? `${snapshot.nowPlaying.title}\n${snapshot.nowPlaying.artist}\n${snapshot.nowPlaying.album ?? ""}`
    : "";

  useEffect(() => {
    let cancelled = false;
    setCurrentTrackLiked(false);
    if (!snapshot.nowPlaying) {
      setLikeMessage("No song is playing.");
      return;
    }
    if (dataSource !== "backend") {
      setLikeMessage("Save the current song.");
      return;
    }
    setLikeMessage("Checking Liked Songs.");
    void fetchCurrentTrackLikeStatus()
      .then((status) => {
        if (cancelled) return;
        setCurrentTrackLiked(status.liked);
        setLikeMessage(status.liked ? "Already in Liked Songs." : "Save the current song.");
      })
      .catch(() => {
        if (cancelled) return;
        setLikeMessage("Liked Songs status unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, nowPlayingLikeKey]);

  useEffect(() => {
    if (!shouldRefreshHomeOnOpen(activeSurface, snapshot, dataSource)) {
      homeAutoRefreshActiveRef.current = false;
      return;
    }
    if (homeAutoRefreshActiveRef.current) {
      return;
    }
    homeAutoRefreshActiveRef.current = true;
    void refreshLibraryHome({ automatic: true });
  }, [activeSurface, dataSource, snapshot]);

  useEffect(() => {
    if (!spotifyPlaybackGate.enabled) {
      spotifyPlayerRef.current?.disconnect();
      spotifyPlayerRef.current = null;
      setSpotifySdkState((current) => ({
        status: spotifyPlaybackGate.status,
        activated: current.activated,
        transferred: false,
      }));
      return;
    }
    if (spotifyPlayerRef.current) {
      return;
    }

    let cancelled = false;
    setSpotifySdkState((current) => ({ ...current, status: "loading", error: undefined }));
    void createSpotifyWebPlayer({
      onState: (patch) => {
        if (!cancelled) {
          setSpotifySdkState((current) => ({ ...current, ...patch }));
        }
      },
    })
      .then((player) => {
        if (cancelled) {
          player.disconnect();
          return;
        }
        spotifyPlayerRef.current = player;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSpotifySdkState((current) => ({
            ...current,
            status: "browser_not_ready",
            error: error instanceof Error ? error.message : "spotify_sdk_unavailable",
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [spotifyPlaybackGate.enabled, spotifyPlaybackGate.status]);

  async function switchScenario(scenarioId: string) {
    setIdleActive(false);
    setLastActivityAt(Date.now());
    setSelectedScenario(scenarioId);
    if (dataSource === "backend") {
      try {
        const state = await activateBackendScenario(scenarioId);
        setSnapshot(state);
        if (state.capabilities.canBrowse) {
          const home = await fetchLibraryHome().catch(() => null);
          if (home) {
            setLibraryHome(home);
          }
        } else {
          setLibraryHome({ sections: [], generatedAt: new Date().toISOString(), constrained: true });
        }
        setStatusText("Backend scenario active.");
        return;
      } catch {
        setDataSource("local");
      }
    }
    setSnapshot(localScenarioSnapshot(scenarioId));
    setStatusText("Local scenario active.");
  }

  async function loadBackendState(options?: { cancelled?: () => boolean; recovery?: boolean }) {
    const [health, state] = await Promise.all([fetchHealth(), fetchAppState()]);
    if (options?.cancelled?.()) return;
    let backendScenarios: ScenarioSummary[] = [];
    if (health.mode === "mock") {
      backendScenarios = await fetchBackendScenarios().catch(() => []);
      if (options?.cancelled?.()) return;
    }
    setBackendMode(health.mode);
    applyBackendSnapshot(state);
    if (state.capabilities.canBrowse) {
      setLibraryBusy(true);
      setLibraryMessage("Loading library from backend.");
      void fetchLibraryHome()
        .then((home) => {
          if (options?.cancelled?.()) return;
          setLibraryHome(home);
          setLibraryMessage("Library loaded from backend.");
        })
        .catch(() => {
          if (!options?.cancelled?.()) {
            setLibraryMessage("Library refresh is still starting. Playback can be used when available.");
          }
        })
        .finally(() => {
          if (!options?.cancelled?.()) {
            setLibraryBusy(false);
          }
        });
    } else {
      setLibraryBusy(false);
      setLibraryHome({ sections: [], generatedAt: new Date().toISOString(), constrained: true });
      setLibraryMessage("Library is unavailable until network and Spotify recovery complete.");
    }
    void fetchSpeakerScanResults()
      .then((speakerResults) => {
        if (options?.cancelled?.()) return;
        setSpeakerDevices(speakerResults.devices);
        setSelectedSpeakerAddress((current) => preferredSpeakerSelection(state, speakerResults.devices, current));
        if (speakerResults.devices.length > 0) {
          setSpeakerMessage("Choose one discovered audio device to pair or replace the current speaker.");
        }
      })
      .catch(() => undefined);
    setScenarios([...backendScenarios, ...localScenarioSummaries().filter((item) => !backendScenarios.some((backend) => backend.id === item.id))]);
    setDataSource("backend");
    setSelectedScenario(backendScenarios[0]?.id ?? "ready_healthy");
    setStatusText(
      options?.recovery
        ? health.mode === "mock"
          ? "Recovered backend mock API."
          : "Recovered backend hardware API."
        : health.mode === "mock"
          ? "Connected to backend mock API."
          : "Connected to backend hardware API.",
    );
  }

  async function updateDisplay(brightness: number, status: DisplayStatus = snapshot.health.display.status) {
    if (dataSource === "backend") {
      try {
        const display = await patchDisplay({ brightness, status });
        setSnapshot((current) => ({
          ...current,
          health: { ...current.health, display },
          settings: { ...current.settings, brightness: display.brightness },
        }));
        setStatusText("Backend display mock updated.");
        return;
      } catch {
        setDataSource("local");
      }
    }
    setSnapshot((current) => ({
      ...current,
      health: {
        ...current.health,
        display: { ...current.health.display, brightness, status, reason: "user_setting" },
      },
      settings: { ...current.settings, brightness },
    }));
    setStatusText("Local display mock updated.");
  }

  async function updateIdleSettings(patch: AppSettingsPatch) {
    setIdleActive(false);
    setLastActivityAt(Date.now());
    if (dataSource === "backend") {
      try {
        const settings = await patchSettings(patch);
        setSnapshot((current) => ({
          ...current,
          settings,
          surfaces: { ...current.surfaces, idleMode: settings.idleMode },
        }));
        setStatusText("Backend idle settings updated.");
        return;
      } catch {
        setDataSource("local");
      }
    }
    setSnapshot((current) => {
      const settings = { ...current.settings, ...patch };
      return {
        ...current,
        settings,
        surfaces: { ...current.surfaces, idleMode: settings.idleMode },
      };
    });
    setStatusText("Local idle settings updated.");
  }

  async function refreshSnapshot() {
    if (snapshotRefreshInFlightRef.current) {
      return snapshotRefreshInFlightRef.current;
    }
    const request = fetchAppState()
      .then((state) => {
        applyBackendSnapshot(state);
        return state;
      })
      .finally(() => {
        snapshotRefreshInFlightRef.current = null;
      });
    snapshotRefreshInFlightRef.current = request;
    return request;
  }

  function applyBackendSnapshot(state: AppSnapshot) {
    setSnapshot((current) => snapshotWithProtectedVolume(state, current, {
      active: volumeInteractionActiveRef.current,
      intendedVolume: latestVolumeIntentRef.current,
      lastIntentAtMs: latestVolumeIntentAtMsRef.current,
      nowMs: Date.now(),
      graceMs: volumeLocalIntentGraceMs,
    }));
  }

  function markVolumeInteractionActive() {
    if (volumeInteractionIdleTimeoutRef.current !== null) {
      window.clearTimeout(volumeInteractionIdleTimeoutRef.current);
      volumeInteractionIdleTimeoutRef.current = null;
    }
    volumeInteractionActiveRef.current = true;
  }

  function releaseVolumeInteractionWhenIdle() {
    if (volumeInFlightRef.current || pendingVolumeRequestRef.current) {
      return;
    }
    if (volumeInteractionIdleTimeoutRef.current !== null) {
      window.clearTimeout(volumeInteractionIdleTimeoutRef.current);
    }
    volumeInteractionIdleTimeoutRef.current = window.setTimeout(() => {
      if (!volumeInFlightRef.current && !pendingVolumeRequestRef.current) {
        volumeInteractionActiveRef.current = false;
      }
      volumeInteractionIdleTimeoutRef.current = null;
    }, 250);
  }

  async function refreshSpeakerStateUntilConnected() {
    let latest = await refreshSnapshot();
    if (isConfirmedSpeakerConnected(latest)) {
      return latest;
    }
    for (const delayMs of speakerStateRefreshDelaysMs) {
      if (delayMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
      latest = await refreshSnapshot();
      if (isConfirmedSpeakerConnected(latest)) {
        return latest;
      }
    }
    return latest;
  }

  function scheduleSnapshotRefreshes(delaysMs: readonly number[] = nowPlayingCommandRefreshDelaysMs) {
    if (dataSource !== "backend") {
      return;
    }
    clearScheduledSnapshotRefreshes();
    for (const delayMs of delaysMs) {
      const timeoutId = window.setTimeout(() => {
        scheduledSnapshotRefreshIdsRef.current = scheduledSnapshotRefreshIdsRef.current.filter((id) => id !== timeoutId);
        void refreshSnapshot().catch(() => undefined);
      }, delayMs);
      scheduledSnapshotRefreshIdsRef.current.push(timeoutId);
    }
  }

  function clearScheduledSnapshotRefreshes() {
    for (const timeoutId of scheduledSnapshotRefreshIdsRef.current) {
      window.clearTimeout(timeoutId);
    }
    scheduledSnapshotRefreshIdsRef.current = [];
  }

  async function refreshLibraryHome(options?: { automatic?: boolean }) {
    setLibraryBusy(true);
    setLibraryMessage(options?.automatic ? "Updating library." : "Refreshing library.");
    try {
      if (dataSource === "backend") {
        const home = await fetchLibraryHome();
        setLibraryHome(home);
        setLibraryMessage(home.sections.some((section) => section.items.length > 0) ? "Library updated." : "Library is connected but empty.");
      } else {
        setLibraryHome(localLibraryHome());
        setLibraryMessage("Local library fixtures refreshed.");
      }
    } catch {
      setLibraryMessage("Library refresh is unavailable. Check Wi-Fi and Spotify connection.");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function selectLibraryCategory(category: LibraryCategoryId) {
    setLibraryCategory(category);
    setLibraryBusy(true);
    setLibraryMessage(`Opening ${labelFromId(category)}.`);
    try {
      if (dataSource === "backend" && category !== "home") {
        const response = await fetchLibraryCategory(category);
        setLibraryHome((current) => ({
          ...current,
          sections: current.sections.map((section) =>
            section.id === category
              ? { id: response.category, title: response.title, description: response.description, items: response.items }
              : section,
          ),
        }));
      }
      setLibraryMessage(`${labelFromId(category)} ready.`);
    } catch {
      setLibraryMessage(`${labelFromId(category)} is unavailable right now.`);
    } finally {
      setLibraryBusy(false);
    }
  }

  async function startLibraryItem(item: LibraryItem) {
    if (!item.playable || item.playbackKind === "unavailable") {
      setLibraryMessage("That item cannot be started directly in V1.");
      return;
    }
    if (!snapshot.capabilities.canStartPlayback) {
      setLibraryMessage("Playback is unavailable until recovery completes.");
      return;
    }
    const deviceId = spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    setLibraryBusy(true);
    setLibraryMessage(`Starting ${item.title}.`);
    try {
      if (dataSource === "backend") {
        const result = await playLibraryItem({ uri: item.uri, playbackKind: item.playbackKind, deviceId });
        setLibraryMessage(result.state === "succeeded" ? `Playback start sent for ${item.title}.` : `Playback blocked: ${labelFromId(result.reason ?? "unknown")}.`);
        if (result.state === "succeeded") {
          await refreshSnapshot().catch(() => undefined);
          scheduleSnapshotRefreshes();
          if (snapshot.setup.blockingStep === "playback_test") {
            setPlaybackTestMessage("Playback worked, so setup can finish.");
            setStatusText("Playback worked. Setup is finishing.");
          }
        }
      } else {
        setLibraryMessage(`Local fixture selected: ${item.title}. Backend playback is not called in local fallback mode.`);
      }
      setSelectedSurface("now_playing");
    } catch {
      setLibraryMessage("Playback start could not be sent.");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function loadPlaybackQueue(options: { automatic?: boolean } = {}) {
    setQueueBusy(true);
    setQueueMessage(options.automatic ? "Updating songs coming up." : "Loading songs coming up.");
    try {
      if (dataSource === "backend") {
        const queue = await fetchPlaybackQueue();
        setPlaybackQueue(queue);
        setQueueMessage(queue.items.length > 0 ? "Songs coming up loaded." : "Spotify has no upcoming songs right now.");
      } else {
        const fallbackItems = uniqueLibraryItems(localLibraryHome().sections.flatMap((section) => section.items))
          .filter((item) => item.playbackKind === "track")
          .slice(0, 12);
        setPlaybackQueue({
          current: fallbackItems[0] ?? null,
          items: fallbackItems.slice(1),
          generatedAt: new Date().toISOString(),
        });
        setQueueMessage("Local queue preview loaded.");
      }
    } catch {
      setQueueMessage("Songs coming up are unavailable from Spotify right now.");
    } finally {
      setQueueBusy(false);
    }
  }

  async function openPlaybackQueue() {
    setQueueOpen(true);
    await loadPlaybackQueue();
  }

  function closePlaybackQueue() {
    setQueueOpen(false);
    setQueueMessage("Tap the artwork to show songs coming up.");
  }

  async function scanWifi() {
    setWifiBusy(true);
    setWifiMessage("Scanning for Wi-Fi networks.");
    try {
      if (dataSource === "backend") {
        await scanNetwork();
        const results = await fetchNetworkScanResults();
        setWifiNetworks(results.networks);
        setSelectedWifiSsid((current) => current || results.networks[0]?.ssid || "");
        setWifiMessage(results.networks.length > 0 ? "Choose a network and connect." : "No Wi-Fi networks found. Try again nearby.");
      } else {
        const fallback = [
          { ssid: "PipzoNet", signal: 92, security: "wpa2" as const, known: snapshot.readiness.networkConfigured },
          { ssid: "Grandma WiFi", signal: 68, security: "wpa2" as const, known: false },
          { ssid: "Open Setup Lab", signal: 41, security: "open" as const, known: false },
        ];
        setWifiNetworks(fallback);
        setSelectedWifiSsid((current) => current || fallback[0].ssid);
        setWifiMessage("Local Wi-Fi mock networks loaded.");
      }
    } catch {
      setWifiMessage("Wi-Fi scan is unavailable on this device.");
    } finally {
      setWifiBusy(false);
    }
  }

  async function submitWifiConnect() {
    if (!selectedWifiSsid) {
      setWifiMessage("Select a Wi-Fi network first.");
      return;
    }
    setWifiBusy(true);
    setWifiMessage(`Connecting to ${selectedWifiSsid}.`);
    try {
      if (dataSource === "backend") {
        const action = await connectNetwork({ ssid: selectedWifiSsid, password: wifiPassword || undefined });
        await refreshSnapshot().catch(() => undefined);
        setWifiMessage(action.state === "succeeded" ? "Wi-Fi connected." : `Wi-Fi connection failed: ${labelFromId(action.reason ?? "unknown")}.`);
      } else if (wifiPassword === "wrong") {
        setWifiMessage("Wi-Fi connection failed: bad credentials.");
      } else {
        setSnapshot((current) => ({
          ...current,
          health: { ...current.health, network: { status: "online", ssid: selectedWifiSsid, ipAddress: "192.168.1.42", internetReachable: true } },
          readiness: { ...current.readiness, networkConfigured: true },
          setup: { ...current.setup, blockingStep: current.setup.blockingStep === "wifi" ? "spotify_auth" : current.setup.blockingStep },
        }));
        setWifiMessage("Local Wi-Fi mock connected.");
      }
    } catch {
      setWifiMessage("Wi-Fi connect is unavailable on this device.");
    } finally {
      setWifiBusy(false);
    }
  }

  async function retryWifiProbe() {
    setWifiBusy(true);
    setWifiMessage("Checking internet reachability.");
    try {
      if (dataSource === "backend") {
        const action = await retryInternetProbe();
        await refreshSnapshot().catch(() => undefined);
        setWifiMessage(action.state === "succeeded" ? "Internet is reachable." : `Internet check failed: ${labelFromId(action.reason ?? "unknown")}.`);
      } else {
        setSnapshot((current) => ({
          ...current,
          health: {
            ...current.health,
            network: {
              status: "online",
              ssid: current.health.network.ssid ?? (selectedWifiSsid || "PipzoNet"),
              ipAddress: current.health.network.ipAddress ?? "192.168.1.42",
              internetReachable: true,
            },
          },
        }));
        setWifiMessage("Local internet probe succeeded.");
      }
    } catch {
      setWifiMessage("Internet probe is unavailable on this device.");
    } finally {
      setWifiBusy(false);
    }
  }

  async function forgetWifi() {
    const ssid = snapshot.health.network.ssid ?? selectedWifiSsid;
    if (!ssid) {
      setWifiMessage("No Wi-Fi network is selected or connected.");
      return;
    }
    setWifiBusy(true);
    setWifiMessage(`Forgetting ${ssid}.`);
    try {
      if (dataSource === "backend") {
        const action = await forgetNetwork({ ssid, confirm: true });
        await refreshSnapshot().catch(() => undefined);
        setWifiMessage(action.state === "succeeded" ? "Wi-Fi network forgotten." : `Forget failed: ${labelFromId(action.reason ?? "unknown")}.`);
      } else {
        setSnapshot((current) => ({
          ...current,
          health: { ...current.health, network: { status: "offline", reason: "no_known_network", internetReachable: false } },
          readiness: { ...current.readiness, networkConfigured: false, minimumReady: false },
        }));
        setWifiMessage("Local Wi-Fi mock forgotten.");
      }
    } catch {
      setWifiMessage("Wi-Fi forget is unavailable on this device.");
    } finally {
      setWifiBusy(false);
    }
  }

  async function scanBluetoothSpeakers() {
    setSpeakerBusy(true);
    setSpeakerMessage("Scanning for Bluetooth speakers.");
    try {
      if (dataSource === "backend") {
        const action = await scanSpeakers();
        const results = await fetchSpeakerScanResults();
        setSpeakerDevices(results.devices);
        setSelectedSpeakerAddress((current) => preferredSpeakerSelection(snapshot, results.devices, current));
        if (results.devices.length > 0) {
          setSpeakerMessage("Choose one discovered audio device to pair or replace the current speaker.");
        } else {
          setSpeakerMessage(action.state === "succeeded" ? "No Bluetooth speakers found. Put the speaker in pairing mode and scan again." : `Bluetooth scan found no usable speaker: ${labelFromId(action.reason ?? "unknown")}.`);
        }
      } else {
        const fallback = [
          { address: "AA:BB:CC:DD:EE:FF", displayName: "Pipzo Speaker", alias: "Bedroom speaker", paired: snapshot.readiness.primarySpeakerSaved, connected: snapshot.health.speaker.status === "connected", signal: 88 },
          { address: "11:22:33:44:55:66", displayName: "Kitchen Speaker", paired: false, connected: false, signal: 62 },
        ];
        setSpeakerDevices(fallback);
        setSelectedSpeakerAddress((current) => (fallback.some((device) => device.address === current) ? current : fallback[0].address));
        setSpeakerMessage("Local Bluetooth mock speakers loaded.");
      }
    } catch {
      setSpeakerMessage("Bluetooth scan is unavailable on this device.");
    } finally {
      setSpeakerBusy(false);
    }
  }

  async function submitSpeakerPair() {
    if (!selectedSpeakerAddress) {
      setSpeakerMessage("Select a Bluetooth speaker first.");
      return;
    }
    const selected = speakerDevices.find((device) => device.address === selectedSpeakerAddress);
    setSpeakerBusy(true);
    setSpeakerMessage(`Pairing ${selected?.displayName ?? selectedSpeakerAddress}.`);
    try {
      if (dataSource === "backend") {
        const action = await pairSpeaker({ address: selectedSpeakerAddress, displayName: selected?.displayName });
        if (action.state !== "succeeded") {
          await refreshSnapshot().catch(() => undefined);
          setSpeakerMessage(`Speaker pairing failed: ${labelFromId(action.reason ?? "unknown")}.`);
          return;
        }

        let latest = await refreshSpeakerStateUntilConnected();
        if (!isConfirmedSpeakerConnected(latest)) {
          const reconnectAction = await reconnectSpeaker().catch(() => null);
          latest = await refreshSpeakerStateUntilConnected();
          if (reconnectAction?.state !== "succeeded" && !isConfirmedSpeakerConnected(latest)) {
            setSpeakerMessage(`Speaker paired, but reconnect failed: ${labelFromId(reconnectAction?.reason ?? latest.health.speaker.reason ?? "unknown")}.`);
            return;
          }
        }

        if (isConfirmedSpeakerConnected(latest)) {
          setSpeakerMessage("Bluetooth speaker connected.");
          scheduleSnapshotRefreshes(bluetoothMutationSnapshotRefreshDelaysMs);
        } else {
          setSpeakerMessage(`Speaker paired, but status is still ${labelFromId(latest.health.speaker.status)}.`);
        }
      } else {
        setSnapshot((current) => ({
          ...current,
          health: {
            ...current.health,
            speaker: {
              status: "connected",
              primary: {
                address: selectedSpeakerAddress,
                displayName: selected?.displayName ?? "Pipzo Speaker",
                alias: selected?.alias,
                connected: true,
              },
            },
          },
          readiness: { ...current.readiness, primarySpeakerSaved: true },
          setup: { ...current.setup, blockingStep: current.setup.blockingStep === "speaker" ? "playback_test" : current.setup.blockingStep },
        }));
        setSpeakerMessage("Local Bluetooth mock connected.");
      }
    } catch {
      setSpeakerMessage("Bluetooth pair is unavailable on this device.");
    } finally {
      setSpeakerBusy(false);
    }
  }

  async function reconnectBluetoothSpeaker() {
    setSpeakerBusy(true);
    setSpeakerMessage("Reconnecting Bluetooth speaker.");
    try {
      if (dataSource === "backend") {
        const action = await reconnectSpeaker();
        if (action.state !== "succeeded") {
          await refreshSnapshot().catch(() => undefined);
          setSpeakerMessage(`Reconnect failed: ${labelFromId(action.reason ?? "unknown")}.`);
          return;
        }
        const latest = await refreshSpeakerStateUntilConnected();
        setSpeakerMessage(isConfirmedSpeakerConnected(latest) ? "Bluetooth speaker reconnected." : `Reconnect sent, but status is still ${labelFromId(latest.health.speaker.status)}.`);
        if (isConfirmedSpeakerConnected(latest)) {
          scheduleSnapshotRefreshes(bluetoothMutationSnapshotRefreshDelaysMs);
        }
      } else {
        setSnapshot((current) => ({
          ...current,
          health: {
            ...current.health,
            speaker: {
              status: "connected",
              primary: {
                address: current.health.speaker.primary?.address ?? "AA:BB:CC:DD:EE:FF",
                displayName: current.health.speaker.primary?.displayName ?? "Pipzo Speaker",
                alias: current.health.speaker.primary?.alias,
                connected: true,
              },
            },
          },
          readiness: { ...current.readiness, primarySpeakerSaved: true },
        }));
        setSpeakerMessage("Local Bluetooth mock reconnected.");
      }
    } catch {
      setSpeakerMessage("Bluetooth reconnect is unavailable on this device.");
    } finally {
      setSpeakerBusy(false);
    }
  }

  async function forgetBluetoothSpeaker() {
    const address = snapshot.health.speaker.primary?.address ?? selectedSpeakerAddress;
    if (!address) {
      setSpeakerMessage("No Bluetooth speaker is selected or saved.");
      return;
    }
    setSpeakerBusy(true);
    setSpeakerMessage("Forgetting Bluetooth speaker.");
    try {
      if (dataSource === "backend") {
        const action = await forgetSpeaker({ address, confirm: true });
        await refreshSnapshot().catch(() => undefined);
        if (action.state === "succeeded") {
          const remaining = speakerDevices.filter((device) => device.address !== address);
          setSpeakerDevices(remaining);
          setSelectedSpeakerAddress((current) => preferredSpeakerSelection(snapshot, remaining, current === address ? "" : current));
          scheduleSnapshotRefreshes(bluetoothMutationSnapshotRefreshDelaysMs);
        }
        setSpeakerMessage(action.state === "succeeded" ? "Bluetooth speaker forgotten." : `Forget failed: ${labelFromId(action.reason ?? "unknown")}.`);
      } else {
        const remaining = speakerDevices.filter((device) => device.address !== address);
        setSpeakerDevices(remaining);
        setSelectedSpeakerAddress((current) => preferredSpeakerSelection(snapshot, remaining, current === address ? "" : current));
        setSnapshot((current) => ({
          ...current,
          health: { ...current.health, speaker: { status: "none_saved", reason: "user_forgot" }, playbackDevice: { status: "unavailable", reason: "speaker_unavailable" } },
          readiness: { ...current.readiness, primarySpeakerSaved: false, minimumReady: false },
        }));
        setSpeakerMessage("Local Bluetooth mock forgotten.");
      }
    } catch {
      setSpeakerMessage("Bluetooth forget is unavailable on this device.");
    } finally {
      setSpeakerBusy(false);
    }
  }

  async function startSpotifyAuth() {
    setSpotifyAuthBusy(true);
    setSpotifyAuthMessage("Starting local Spotify setup.");
    try {
      const session = await createSpotifyAuthSession();
      setSpotifyAuthSession(session);
      setSpotifyAuthMessage("Spotify setup is ready in this Chromium window.");
    } catch {
      setSpotifyAuthMessage("Spotify setup could not start. Check configuration and try again.");
    } finally {
      setSpotifyAuthBusy(false);
    }
  }

  function openSpotifyAuth() {
    if (!spotifyAuthSession || !["waiting", "callback_received"].includes(spotifyAuthSession.status)) {
      setSpotifyAuthMessage("Start a fresh Spotify setup session first.");
      return;
    }
    window.location.assign(spotifyAuthSession.startUrl);
  }

  async function refreshSpotifySession(options?: { quiet?: boolean; cancelled?: () => boolean }) {
    if (!spotifyAuthSession) {
      return;
    }
    if (!options?.quiet) {
      setSpotifyAuthBusy(true);
      setSpotifyAuthMessage("Checking Spotify setup status.");
    }
    try {
      const session = await fetchSpotifyAuthSession(spotifyAuthSession.sessionId);
      if (options?.cancelled?.()) return;
      setSpotifyAuthSession(session);
      if (session.status === "connected") {
        await refreshSnapshot();
        setSpotifyAuthMessage("Spotify account connected.");
      } else if (!options?.quiet) {
        setSpotifyAuthMessage("Spotify setup status updated.");
      }
    } catch {
      if (!options?.cancelled?.()) {
        setSpotifyAuthMessage("Spotify setup status is unavailable. Try again from this screen.");
      }
    } finally {
      if (!options?.quiet) {
        setSpotifyAuthBusy(false);
      }
    }
  }

  async function cancelSpotifyAuth() {
    if (!spotifyAuthSession) {
      return;
    }
    setSpotifyAuthBusy(true);
    setSpotifyAuthMessage("Cancelling Spotify setup.");
    try {
      const session = await cancelSpotifyAuthSession(spotifyAuthSession.sessionId);
      setSpotifyAuthSession(session);
      setSpotifyAuthMessage("Spotify setup cancelled.");
    } catch {
      setSpotifyAuthMessage("Spotify setup could not be cancelled. Check status and try again.");
    } finally {
      setSpotifyAuthBusy(false);
    }
  }

  async function logoutSpotify() {
    setSpotifyAuthBusy(true);
    setSpotifyAuthMessage("Disconnecting Spotify account.");
    try {
      const spotifyAuth = await logoutSpotifyAuth();
      setSpotifyAuthSession(null);
      setSnapshot((current) => ({
        ...current,
        readiness: { ...current.readiness, spotifyAuthorized: false, minimumReady: false },
        health: { ...current.health, spotifyAuth },
        appPhase: "setup",
        setup: {
          ...current.setup,
          blockingStep: "spotify_auth",
          steps: current.setup.steps.map((step) =>
            step.id === "spotify_auth" ? { ...step, status: "action_required" } : step,
          ),
        },
        surfaces: { ...current.surfaces, current: "setup", route: "/setup/spotify" },
      }));
      await refreshSnapshot().catch(() => undefined);
      setSelectedSurface("setup");
      setSpotifyAuthMessage("Spotify disconnected. Reconnect locally when ready.");
      return true;
    } catch {
      setSpotifyAuthMessage("Spotify account could not be disconnected. Try again.");
      return false;
    } finally {
      setSpotifyAuthBusy(false);
    }
  }

  async function reconnectSpotify() {
    const loggedOut = await logoutSpotify();
    if (loggedOut) {
      await startSpotifyAuth();
    }
  }

  async function activateSpotifyPlayer() {
    const player = spotifyPlayerRef.current;
    if (!player?.activateElement) {
      setSpotifySdkState((current) => ({ ...current, activated: true }));
    } else {
      try {
        await player.activateElement();
        setSpotifySdkState((current) => ({ ...current, activated: true }));
      } catch {
        setSpotifySdkState((current) => ({ ...current, status: "browser_not_ready", error: "spotify_activation_failed" }));
        return;
      }
    }

    const deviceId = spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    if (!deviceId || dataSource !== "backend") {
      return;
    }
    try {
      const result = await transferSpotifyPlayback({ deviceId, play: false });
      setSpotifySdkState((current) => ({
        ...current,
        transferred: result.state === "succeeded",
        status: result.state === "succeeded" ? "ready" : current.status,
        error: result.reason,
      }));
      setStatusText(result.state === "succeeded" ? "Pipzo selected for Spotify playback." : `Playback selection blocked: ${labelFromId(result.reason ?? "unknown")}.`);
      await refreshSnapshot().catch(() => undefined);
      if (result.state === "succeeded") {
        scheduleSnapshotRefreshes();
      }
    } catch {
      setSpotifySdkState((current) => ({ ...current, error: "spotify_transfer_failed" }));
      setStatusText("Pipzo playback selection could not be sent.");
    }
  }

  async function confirmSetupPlaybackTest() {
    const deviceId = spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    setPlaybackTestBusy(true);
    if (!deviceId) {
      setPlaybackTestMessage("Activate the browser player so Spotify registers a Pipzo device.");
      setStatusText("Playback test is waiting for the browser player.");
      setPlaybackTestBusy(false);
      return;
    }
    try {
      if (dataSource === "backend") {
        const result = await runSetupPlaybackTest({ action: "start", deviceId });
        setPlaybackTestMessage(result.state === "succeeded" ? "Playback device selected and test passed." : `Playback test blocked: ${labelFromId(result.reason ?? "unknown")}.`);
        setStatusText(result.state === "succeeded" ? "Playback test passed." : "Playback test is still blocked.");
        await refreshSnapshot();
        if (result.state === "succeeded") {
          scheduleSnapshotRefreshes();
        }
      } else {
        setPlaybackTestMessage("Local playback test confirmed.");
        setStatusText("Local playback test confirmed.");
      }
    } catch {
      setPlaybackTestMessage("Playback test could not be confirmed.");
      setStatusText("Playback test could not be confirmed.");
    } finally {
      setPlaybackTestBusy(false);
    }
  }

  async function sendPlaybackAction(action: PlaybackCommand) {
    if (action === "previous") {
      if (previousTapTimeoutRef.current !== null) {
        window.clearTimeout(previousTapTimeoutRef.current);
        previousTapTimeoutRef.current = null;
        await dispatchPlaybackAction("previous_track");
        return;
      }
      previousTapTimeoutRef.current = window.setTimeout(() => {
        previousTapTimeoutRef.current = null;
        void dispatchPlaybackAction("previous");
      }, 260);
      return;
    }
    await dispatchPlaybackAction(action);
  }

  async function dispatchPlaybackAction(action: PlaybackCommand) {
    const remotePlayback = snapshot.diagnostics.lastCommand === "spotify.current_playback" && snapshot.diagnostics.rawAdapterCode?.startsWith("device_mismatch:");
    const deviceId = remotePlayback ? undefined : spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    const requestedAction =
      action === "previous"
        ? "seek_start"
        : action === "previous_track"
          ? "previous"
          : action === "shuffle"
          ? shuffleEnabled ? "shuffle_off" : "shuffle_on"
          : action === "repeat"
            ? repeatEnabled ? "repeat_off" : "repeat_context"
            : action;
    if (dataSource === "backend") {
      try {
        const result = await controlPlayback({ action: requestedAction, deviceId });
        if (result.state === "succeeded" && action === "shuffle") {
          setShuffleEnabled((current) => !current);
        }
        if (result.state === "succeeded" && action === "repeat") {
          setRepeatEnabled((current) => !current);
        }
        const label = requestedAction === "seek_start" ? "restart" : action === "previous_track" ? "previous track" : action;
        setStatusText(result.state === "succeeded" ? `Playback ${label} sent.` : `Playback ${label} blocked: ${labelFromId(result.reason ?? "unknown")}.`);
        await refreshSnapshot().catch(() => undefined);
        if (result.state === "succeeded") {
          scheduleSnapshotRefreshes();
          if (queueOpen) {
            void loadPlaybackQueue({ automatic: true });
            window.setTimeout(() => void loadPlaybackQueue({ automatic: true }), 900);
          }
        }
        return;
      } catch {
        setStatusText("Playback command could not be sent.");
      }
    }
    setStatusText("Local scenario playback controls do not call Spotify.");
  }

  async function likeCurrentPlayingTrack() {
    if (!snapshot.nowPlaying) {
      setLikeMessage("No song is playing.");
      setStatusText("No song is playing.");
      return;
    }
    setLikeBusy(true);
    setLikeMessage(`Saving ${snapshot.nowPlaying.title}.`);
    try {
      if (dataSource === "backend") {
        const result = await likeCurrentTrack();
        setLikeMessage(result.state === "succeeded" ? "Saved to Liked Songs." : `Like blocked: ${labelFromId(result.reason ?? "unknown")}.`);
        setStatusText(result.state === "succeeded" ? "Saved to Liked Songs." : "Like action was blocked.");
        if (result.state === "succeeded") {
          setCurrentTrackLiked(true);
          void refreshLibraryHome({ automatic: true });
        }
      } else {
        setCurrentTrackLiked(true);
        setLikeMessage("Local fixture song saved.");
        setStatusText("Local fixture song saved.");
      }
    } catch {
      setLikeMessage("Like action could not be sent.");
      setStatusText("Like action could not be sent.");
    } finally {
      setLikeBusy(false);
    }
  }

  async function drainVolumeRequests(initialRequest: QueuedVolumePatch) {
    volumeInFlightRef.current = true;
    let nextRequest: QueuedVolumePatch | null = initialRequest;
    while (nextRequest) {
      const request = nextRequest;
      try {
        const volume = await patchVolume({ value: request.value, muted: request.muted, deviceId: request.deviceId });
        if (isLatestVolumeRequest(request.requestId, volumeRequestSeqRef.current)) {
          setSnapshot((current) => ({ ...current, health: { ...current.health, volume } }));
          setVolumeMessage(volume.status === "unified" ? "Volume updated." : `Volume partially updated: ${labelFromId(volume.reason ?? volume.status)}.`);
          setStatusText(volume.status === "unified" ? "Volume updated." : "Volume control is partially available.");
        }
      } catch {
        if (isLatestVolumeRequest(request.requestId, volumeRequestSeqRef.current)) {
          setVolumeMessage("Volume command could not be sent.");
          setStatusText("Volume command could not be sent.");
        }
      }
      nextRequest = pendingVolumeRequestRef.current;
      pendingVolumeRequestRef.current = null;
    }
    volumeInFlightRef.current = false;
    setVolumeBusy(false);
    releaseVolumeInteractionWhenIdle();
  }

  async function updateVolume(value: number, muted = snapshot.health.volume.muted ?? false) {
    const deviceId = spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    const target = normalizedVolumeTarget(value, muted, deviceId);
    const requestId = volumeRequestSeqRef.current + 1;
    volumeRequestSeqRef.current = requestId;
    latestVolumeIntentRef.current = target;
    latestVolumeIntentAtMsRef.current = Date.now();
    markVolumeInteractionActive();
    setIdleActive(false);
    setLastActivityAt(Date.now());
    setVolumeBusy(true);
    setSnapshot((current) => ({
      ...current,
      health: {
        ...current.health,
        volume: {
          ...current.health.volume,
          value: target.value,
          muted: target.muted,
        },
      },
    }));
    if (dataSource === "backend") {
      const queuedRequest: QueuedVolumePatch = { ...target, requestId };
      if (volumeInFlightRef.current) {
        pendingVolumeRequestRef.current = queuedRequest;
        return;
      }
      void drainVolumeRequests(queuedRequest);
      return;
    }
    setVolumeMessage("Local volume mock updated.");
    setStatusText("Local volume mock updated.");
    setVolumeBusy(false);
    releaseVolumeInteractionWhenIdle();
  }

  function setSleepTimerPreset(minutes: SleepTimerPresetMinutes) {
    const startedAt = Date.now();
    setIdleActive(false);
    setLastActivityAt(startedAt);
    setNowMs(startedAt);
    setSleepTimer(startSleepTimer(minutes, startedAt));
    setStatusText(`Sleep timer set for ${minutes} minutes.`);
  }

  function clearSleepTimer() {
    setIdleActive(false);
    setLastActivityAt(Date.now());
    setSleepTimer({ status: "idle" });
    setSleepTimerBusy(false);
    setStatusText("Sleep timer cleared.");
  }

  const spotifyAuthControls = {
    session: spotifyAuthSession,
    busy: spotifyAuthBusy,
    message: spotifyAuthMessage,
    onStart: startSpotifyAuth,
    onOpen: openSpotifyAuth,
    onRefresh: () => refreshSpotifySession(),
    onCancel: cancelSpotifyAuth,
    onLogout: logoutSpotify,
    onReconnect: reconnectSpotify,
  };
  const wifiControls = {
    networks: wifiNetworks,
    selectedSsid: selectedWifiSsid,
    password: wifiPassword,
    busy: wifiBusy,
    message: wifiMessage,
    onScan: scanWifi,
    onSelect: setSelectedWifiSsid,
    onPassword: setWifiPassword,
    onConnect: submitWifiConnect,
    onRetry: retryWifiProbe,
    onForget: forgetWifi,
  };
  const speakerControls = {
    devices: speakerDevices,
    selectedAddress: selectedSpeakerAddress,
    busy: speakerBusy,
    message: speakerMessage,
    onScan: scanBluetoothSpeakers,
    onSelect: setSelectedSpeakerAddress,
    onPair: submitSpeakerPair,
    onReconnect: reconnectBluetoothSpeaker,
    onForget: forgetBluetoothSpeaker,
  };
  const sleepTimerControls = {
    timer: sleepTimer,
    nowMs,
    busy: sleepTimerBusy,
    onStart: setSleepTimerPreset,
    onCancel: clearSleepTimer,
  };
  const volumeControls = {
    busy: volumeBusy,
    message: volumeMessage,
    onChange: updateVolume,
    onInteractionStart: markVolumeInteractionActive,
    onInteractionEnd: releaseVolumeInteractionWhenIdle,
  };
  const likeControls = {
    busy: likeBusy,
    liked: currentTrackLiked,
    message: likeMessage,
    onLike: likeCurrentPlayingTrack,
  };
  const setupPlaybackControls = {
    busy: playbackTestBusy,
    message: playbackTestMessage,
    onConfirm: confirmSetupPlaybackTest,
  };
  const libraryControls = {
    home: libraryHome,
    activeCategory: libraryCategory,
    busy: libraryBusy,
    message: libraryMessage,
    onCategory: selectLibraryCategory,
    onPlay: startLibraryItem,
  };
  const railTimerView = sleepTimerViewModel(snapshot, sleepTimer, nowMs);
  const railNavItems = shellNavigationItems();
  const railPrimaryItems = railNavItems.filter((item) => item.priority === "primary");
  const railUtilityItems = railNavItems.filter((item) => item.priority === "utility");
  const queueControls = {
    open: queueOpen,
    busy: queueBusy,
    message: queueMessage,
    current: playbackQueue.current ?? null,
    items: playbackQueue.items,
    onOpen: openPlaybackQueue,
    onClose: closePlaybackQueue,
    onPlay: (item: LibraryItem) => {
      setQueueOpen(false);
      void startLibraryItem(item);
    },
  };

  const appClassName = [
    "app",
    `phase-${snapshot.appPhase}`,
    idleActive ? "idle-active" : "",
    keyboardState.active ? "keyboard-active" : "",
    keyboardState.surface ? `keyboard-surface-${keyboardState.surface}` : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={appClassName} data-drag-scroll ref={appRef}>
      {idleActive ? (
        <IdleSurface snapshot={snapshot} sleepTimer={sleepTimerControls} active />
      ) : (
        <>
      <div className="sr-only" aria-live="polite">{statusText}</div>
      {touchFeedback && (
        <div className="interaction-toast" role="status" aria-live="polite" key={touchFeedback.id}>
          {touchFeedback.label}
        </div>
      )}
      {showDeveloperPanel && (
        <DeveloperPanel
          scenarios={scenarios}
          selectedScenario={selectedScenario}
          currentScenario={currentScenario}
          dataSource={dataSource}
          display={snapshot.health.display}
          onChange={switchScenario}
          onDisplayChange={updateDisplay}
        />
      )}

      {visibleWarnings.length > 0 && (
        <section className="warning-band" aria-label="Warnings">
          {visibleWarnings.map((warning) => (
            <div key={`${warning.code}-${warning.reason ?? "none"}`}>
              <strong>{labelFromId(warning.code)}</strong>
              <span>{warning.reason ? labelFromId(warning.reason) : "Action recommended"}</span>
            </div>
          ))}
        </section>
      )}

      {degradedMode.active && !gated && (
        <DegradedModeBanner
          available={degradedMode.available}
          detail={degradedMode.detail}
          title={degradedMode.title}
          unavailable={degradedMode.unavailable}
        />
      )}

      <main className="shell">
        <nav className="nav" aria-label="Primary">
          <div className="nav-primary">
          {railPrimaryItems.map((item) => {
            const surface = item.surface;
            const disabled = !canOpenSurface(snapshot, surface);
            const icon = surface === "home" ? <HomeIcon /> : surface === "now_playing" ? <NowPlayingIcon /> : <SettingsIcon />;
            return (
              <button
                className={[
                  activeSurface === surface ? "active" : "",
                  item.priority === "utility" ? "nav-utility" : "nav-main",
                ].filter(Boolean).join(" ")}
                disabled={disabled}
                key={surface}
                onClick={() => setSelectedSurface(surface)}
                type="button"
                aria-label={navLabels[surface]}
              >
                <span className="nav-icon" aria-hidden="true">{icon}</span>
                <span>{navLabels[surface]}</span>
              </button>
            );
          })}
          </div>
          <div className="nav-bottom">
            {(railTimerView.active || railTimerView.expired) && (
              <button className="nav-utility timer-rail-button" type="button" onClick={() => setSelectedSurface("sleep_timer")}>
                <span className="nav-icon" aria-hidden="true"><TimerIcon /></span>
                <span>{railTimerView.active ? railTimerView.label.replace("Stops in ", "") : "Timer"}</span>
              </button>
            )}
            {railUtilityItems.map((item) => {
              const surface = item.surface;
              const disabled = !canOpenSurface(snapshot, surface);
              return (
                <button
                  className={[
                    activeSurface === surface ? "active" : "",
                    "nav-utility",
                  ].filter(Boolean).join(" ")}
                  disabled={disabled}
                  key={surface}
                  onClick={() => setSelectedSurface(surface)}
                  type="button"
                  aria-label={navLabels[surface]}
                >
                  <span className="nav-icon" aria-hidden="true"><SettingsIcon /></span>
                  <span>{navLabels[surface]}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <section className="surface" aria-live="polite" data-drag-scroll data-surface={activeSurface}>
          {activeSurface === "setup" && (
            <SetupSurface
              snapshot={snapshot}
              spotifyAuth={spotifyAuthControls}
              wifi={wifiControls}
              speaker={speakerControls}
              spotifySdk={spotifySdkState}
              playbackGateDetail={spotifyPlaybackGate.detail}
              onActivateSpotify={activateSpotifyPlayer}
              playbackTest={setupPlaybackControls}
            />
          )}
          {activeSurface === "home" && (
            <HomeSurface
              snapshot={snapshot}
              library={libraryControls}
              nowMs={nowMs}
              onOpenClock={() => setIdleActive(true)}
              onOpenNowPlaying={() => setSelectedSurface("now_playing")}
              onPlaybackAction={sendPlaybackAction}
              canSendControls={snapshot.capabilities.canControlPlayback && (spotifySdkState.status === "ready" || Boolean(snapshot.health.playbackDevice.deviceId))}
            />
          )}
          {activeSurface === "now_playing" && (
            <NowPlayingSurface
              snapshot={snapshot}
              spotifySdk={spotifySdkState}
              onActivateSpotify={activateSpotifyPlayer}
              onPlaybackAction={sendPlaybackAction}
              shuffleEnabled={shuffleEnabled}
              repeatEnabled={repeatEnabled}
              sleepTimer={sleepTimerControls}
              volume={volumeControls}
              like={likeControls}
              queue={queueControls}
              nowMs={nowMs}
            />
          )}
          {activeSurface === "sleep_timer" && (
            <SleepTimerSurface
              snapshot={snapshot}
              controls={sleepTimerControls}
              onBack={() => setSelectedSurface(timerReturnSurface)}
            />
          )}
          {activeSurface === "settings" && (
            <SettingsSurface
              snapshot={snapshot}
              spotifyAuth={spotifyAuthControls}
              wifi={wifiControls}
              speaker={speakerControls}
              spotifySdk={spotifySdkState}
              playbackGateDetail={spotifyPlaybackGate.detail}
              onActivateSpotify={activateSpotifyPlayer}
              onIdleSettingsChange={updateIdleSettings}
              sleepTimer={sleepTimerControls}
              volume={volumeControls}
            />
          )}
        </section>
      </main>
        </>
      )}
    </div>
  );
}

function DegradedModeBanner({
  title,
  detail,
  available,
  unavailable,
}: {
  title: string;
  detail: string;
  available: string[];
  unavailable: string[];
}) {
  return (
    <section className="degraded-banner" aria-label="Recovery mode">
      <div>
        <p className="eyebrow">Degraded mode</p>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      <div className="degraded-lists">
        <div>
          <strong>Available</strong>
          <span>{available.join(", ")}</span>
        </div>
        <div>
          <strong>Unavailable</strong>
          <span>{unavailable.length > 0 ? unavailable.join(", ") : "None"}</span>
        </div>
      </div>
    </section>
  );
}

function DeveloperPanel(props: {
  scenarios: ScenarioSummary[];
  selectedScenario: string;
  currentScenario?: ScenarioSummary;
  dataSource: DataSource;
  display: AppSnapshot["health"]["display"];
  onChange: (scenarioId: string) => void;
  onDisplayChange: (brightness: number, status?: DisplayStatus) => void;
}) {
  return (
    <section className="developer-panel" aria-label="Developer mock scenarios">
      <div>
        <strong>Mock scenario</strong>
        <span>{props.dataSource === "backend" ? "Backend endpoints" : "Local fallback"}</span>
      </div>
      <select value={props.selectedScenario} onChange={(event) => props.onChange(event.target.value)}>
        {props.scenarios.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            {scenario.label}
          </option>
        ))}
      </select>
      <div className="display-controls">
        <label>
          <span>Brightness</span>
          <input
            min="0"
            max="100"
            type="range"
            value={props.display.brightness}
            onChange={(event) => props.onDisplayChange(Number(event.target.value))}
          />
          <strong>{props.display.brightness}%</strong>
        </label>
        <select
          value={props.display.status}
          onChange={(event) => props.onDisplayChange(props.display.brightness, event.target.value as DisplayStatus)}
        >
          <option value="normal">Normal</option>
          <option value="dimmed">Dimmed</option>
          <option value="off">Off</option>
        </select>
      </div>
      <p>{props.currentScenario?.description}</p>
    </section>
  );
}

function SetupSurface({
  snapshot,
  spotifyAuth,
  wifi,
  speaker,
  spotifySdk,
  playbackGateDetail,
  onActivateSpotify,
  playbackTest,
}: {
  snapshot: AppSnapshot;
  spotifyAuth: SpotifyAuthControls;
  wifi: WifiControls;
  speaker: SpeakerControls;
  spotifySdk: SpotifySdkState;
  playbackGateDetail: string;
  onActivateSpotify: () => void;
  playbackTest: SetupPlaybackControls;
}) {
  const playbackActive = snapshot.setup.blockingStep === "playback_test" || snapshot.readiness.primarySpeakerSaved;
  const completionActive = snapshot.setup.blockingStep === "playback_test";
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">First run setup</p>
        <h1>{snapshot.appPhase === "starting" ? "Checking Pipzo hardware" : "Finish setup before music starts"}</h1>
        <p>
          Current blocker: <strong>{labelFromId(snapshot.setup.blockingStep)}</strong>
        </p>
        <p>Wi-Fi, Spotify, and one connected Bluetooth speaker are required before setup can complete.</p>
      </section>
      <div className="setup-side">
        {completionActive && (
          <SetupPlaybackCompletionPanel
            spotifySdk={spotifySdk}
            playbackTest={playbackTest}
          />
        )}
        <section className="checklist">
          {snapshot.setup.steps.map((step) => (
            <div className={`step step-${step.status}`} key={step.id}>
              <div>
                <strong>{step.id === "spotify_auth" ? "Spotify" : labelFromId(step.id)}</strong>
                <span>{step.required ? "Required" : "Intro"}</span>
              </div>
              <b>{labelFromId(step.status)}</b>
            </div>
          ))}
        </section>
        <WifiPanel snapshot={snapshot} controls={wifi} context="setup" />
        <SpotifyAuthPanel snapshot={snapshot} controls={spotifyAuth} context="setup" />
        <SpeakerPanel snapshot={snapshot} controls={speaker} context="setup" />
        {playbackActive && (
          <SpotifyPlaybackPanel
            playbackGateDetail={playbackGateDetail}
            spotifySdk={spotifySdk}
            onActivateSpotify={onActivateSpotify}
            playbackTest={playbackTest}
          />
        )}
      </div>
    </div>
  );
}

function SetupPlaybackCompletionPanel({
  spotifySdk,
  playbackTest,
}: {
  spotifySdk: SpotifySdkState;
  playbackTest: SetupPlaybackControls;
}) {
  const hasDevice = Boolean(spotifySdk.deviceId);
  return (
    <section className="setup-completion-panel" aria-label="Finish setup">
      <div>
        <p className="eyebrow">Final step</p>
        <h2>Did music play through Pipzo?</h2>
        <p>Tap once after you hear music from the connected speaker or headphones. Pipzo will finish setup from the real playback device.</p>
        <p className="subtle">{hasDevice ? playbackTest.message : "Start the player once so Pipzo can see this browser as the playback device."}</p>
      </div>
      <button disabled={playbackTest.busy || !hasDevice} type="button" onClick={playbackTest.onConfirm}>
        Playback works
      </button>
    </section>
  );
}

function HomeSurface({
  snapshot,
  library,
  nowMs,
  onOpenClock,
  onOpenNowPlaying,
  onPlaybackAction,
  canSendControls,
}: {
  snapshot: AppSnapshot;
  library: LibraryControls;
  nowMs: number;
  onOpenClock: () => void;
  onOpenNowPlaying: () => void;
  onPlaybackAction: (action: PlaybackCommand) => void;
  canSendControls: boolean;
}) {
  const availability = libraryAvailability(snapshot);
  const orderedSections = orderedHomeSections(library.home.sections);
  const nowPlaying = snapshot.nowPlaying;
  return (
    <div className="home-surface">
      <section className="home-header" aria-label="Home status">
        <div className="home-header-main">
          {nowPlaying && (
            <HomeMiniPlayer
              playing={nowPlaying}
              canSendControls={canSendControls}
              onOpenNowPlaying={onOpenNowPlaying}
              onPlaybackAction={onPlaybackAction}
            />
          )}
          {(!availability.canBrowse || snapshot.staleness.isStale) && (
            <p>{snapshot.staleness.isStale ? "Showing cached account content until connectivity recovers." : availability.detail}</p>
          )}
        </div>
        <HomeClock nowMs={nowMs} onOpenClock={onOpenClock} />
      </section>

      {orderedSections.length > 0 ? (
        <div className="home-library-feed">
          {orderedSections.map((section) => (
            <LibraryFeatureSection section={section} snapshot={snapshot} onPlay={library.onPlay} key={section.id} />
          ))}
        </div>
      ) : (
        <section className="library-section">
          <h2>No saved content shown</h2>
          <p>Refresh the library or recover Spotify/network access from Settings.</p>
        </section>
      )}
    </div>
  );
}

function orderedHomeSections(sections: LibraryHomeResponse["sections"]): LibraryHomeResponse["sections"] {
  const rank = new Map<LibraryCategoryId, number>(homeLibraryCategoryOrder.map((category, index) => [category, index]));
  return [...sections].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
}

function HomeMiniPlayer({
  playing,
  canSendControls,
  onOpenNowPlaying,
  onPlaybackAction,
}: {
  playing: NonNullable<AppSnapshot["nowPlaying"]>;
  canSendControls: boolean;
  onOpenNowPlaying: () => void;
  onPlaybackAction: (action: PlaybackCommand) => void;
}) {
  return (
    <div className="home-mini-player">
      <button
        className={`home-mini-art${playing.isPlaying ? " playing" : ""}`}
        type="button"
        onClick={onOpenNowPlaying}
        aria-label="Open Now Playing"
      >
        {playing.artworkUrl ? <img src={playing.artworkUrl} alt="" draggable={false} /> : <span>{itemInitials(playing.title)}</span>}
        <span className="home-mini-eq" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
      </button>
      <div className="home-mini-copy">
        <strong>{playing.title}</strong>
        <span>{playing.artist}</span>
      </div>
      <div className="home-mini-controls" aria-label="Home playback controls">
        <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("previous")} aria-label="Restart track">
          <PreviousIcon />
        </button>
        <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction(playing.isPlaying ? "pause" : "play")} aria-label={playing.isPlaying ? "Pause" : "Play"}>
          {playing.isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("next")} aria-label="Next track">
          <NextIcon />
        </button>
      </div>
    </div>
  );
}

function HomeClock({ nowMs, onOpenClock }: { nowMs: number; onOpenClock: () => void }) {
  const now = new Date(nowMs);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(now);

  return (
    <button className="home-clock" type="button" onClick={onOpenClock} aria-label={`Open clock view. Current time ${time}, ${date}`}>
      <strong>{time}</strong>
      <span>{date}</span>
    </button>
  );
}

function LibraryFeatureSection({
  section,
  snapshot,
  onPlay,
}: {
  section: LibraryHomeResponse["sections"][number];
  snapshot: AppSnapshot;
  onPlay: (item: LibraryItem) => void;
}) {
  const featured = uniqueLibraryItems(section.items).slice(0, 50);
  return (
    <section className="library-feature-section" aria-label={section.title}>
      {snapshot.staleness.isStale && <strong className="stale-pill">Stale</strong>}
      <div className="library-feature-grid" data-drag-scroll>
        {featured.map((item) => (
          <LibraryArtworkCard item={item} snapshot={snapshot} onPlay={onPlay} sectionId={section.id} key={`${item.type}-${item.id}-${item.uri}`} />
        ))}
      </div>
      {featured.length === 0 && <p className="subtle">No items in this constrained section.</p>}
    </section>
  );
}

function uniqueLibraryItems(items: LibraryItem[]): LibraryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.uri || `${item.type}:${item.id}:${item.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function LibraryArtworkCard({
  item,
  snapshot,
  onPlay,
  sectionId,
}: {
  item: LibraryItem;
  snapshot: AppSnapshot;
  onPlay: (item: LibraryItem) => void;
  sectionId: LibraryCategoryId;
}) {
  const disabled = !canPlayLibraryItem(snapshot, item);
  return (
    <button className="library-art-card" disabled={disabled} type="button" onClick={() => onPlay(item)}>
      <ArtworkTile item={item} sectionId={sectionId} />
      <span>
        <strong>{item.title}</strong>
        <small>{item.subtitle ?? labelFromId(item.type)}</small>
      </span>
    </button>
  );
}

function ArtworkTile({ item, sectionId }: { item: LibraryItem; sectionId: LibraryCategoryId }) {
  return (
    <span className={`artwork-tile artwork-${item.type}`}>
      {item.artworkUrl ? (
        <img src={item.artworkUrl} alt="" draggable={false} />
      ) : (
        <span>{itemInitials(item.title) || categoryFallbackInitial(sectionId)}</span>
      )}
    </span>
  );
}

function LibrarySectionPanel({
  section,
  snapshot,
  onPlay,
  compact = false,
}: {
  section: LibraryHomeResponse["sections"][number];
  snapshot: AppSnapshot;
  onPlay: (item: LibraryItem) => void;
  compact?: boolean;
}) {
  return (
    <section className={`library-section${compact ? " compact" : ""}`} aria-label={section.title}>
      {snapshot.staleness.isStale && <strong className="stale-pill">Stale</strong>}
      <div className="library-list">
        {section.items.map((item) => {
          const disabled = !canPlayLibraryItem(snapshot, item);
          return (
            <button disabled={disabled} key={`${item.type}-${item.id}-${item.uri}`} type="button" onClick={() => onPlay(item)}>
              <span className="library-art">{item.artworkUrl ? "" : item.title.slice(0, 1)}</span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle ?? labelFromId(item.type)}</small>
              </span>
              <b>{disabled ? "Unavailable" : item.playbackKind === "track" ? "Play track" : "Play"}</b>
            </button>
          );
        })}
      </div>
      {section.items.length === 0 && <p className="subtle">No items in this constrained section.</p>}
    </section>
  );
}

function NowPlayingSurface({
  snapshot,
  spotifySdk,
  onActivateSpotify,
  onPlaybackAction,
  shuffleEnabled,
  repeatEnabled,
  sleepTimer,
  volume,
  like,
  queue,
  nowMs,
}: {
  snapshot: AppSnapshot;
  spotifySdk: SpotifySdkState;
  onActivateSpotify: () => void;
  onPlaybackAction: (action: PlaybackCommand) => void;
  shuffleEnabled: boolean;
  repeatEnabled: boolean;
  sleepTimer: SleepTimerControls;
  volume: VolumeControls;
  like: LikeControls;
  queue: QueueControls;
  nowMs: number;
}) {
  const playing = snapshot.nowPlaying;
  const displayedProgressMs = currentProgressMs(playing, nowMs);
  const progress = playing?.durationMs ? Math.min(100, (displayedProgressMs / playing.durationMs) * 100) : 0;
  const canSendControls = snapshot.capabilities.canControlPlayback && (spotifySdk.status === "ready" || Boolean(snapshot.health.playbackDevice.deviceId));
  const emptyState = nowPlayingEmptyState(snapshot);
  const remotePlayback = snapshot.diagnostics.lastCommand === "spotify.current_playback" && snapshot.diagnostics.rawAdapterCode?.startsWith("device_mismatch:");
  const timerView = sleepTimerViewModel(snapshot, sleepTimer.timer, sleepTimer.nowMs);
  return (
    <div className="player-surface">
      <section className={queue.open ? "art-panel queue-open" : "art-panel"} aria-label={queue.open ? "Songs coming up" : "Artwork"}>
        {queue.open ? (
          <QueuePanel queue={queue} />
        ) : (
          <button className="artwork-queue-button" type="button" onClick={queue.onOpen} aria-label="Show songs coming up">
            {playing?.artworkUrl ? <img src={playing.artworkUrl} alt="" draggable={false} /> : <div>{playing ? itemInitials(playing.title) : "P"}</div>}
          </button>
        )}
      </section>
      <section className="player-panel">
        <div className="player-copy">
          <p className="eyebrow">{remotePlayback ? "Remote playback" : "Now playing"}</p>
          <h1 className="track-title">{emptyState.title}</h1>
          <p>{emptyState.detail}</p>
        </div>
        <div className="progress" aria-label="Playback progress"><span style={{ width: `${progress}%` }} /></div>
        <div className="time-row">
          <span>{formatMs(displayedProgressMs)}</span>
          <span>{formatMs(playing?.durationMs)}</span>
        </div>
        <div className="mode-row" aria-label="Playback modes">
          <button className={shuffleEnabled ? "mode-button active" : "mode-button"} disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("shuffle")} aria-label={shuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"}>
            <ShuffleIcon />
          </button>
          <button className={repeatEnabled ? "mode-button active" : "mode-button"} disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("repeat")} aria-label={repeatEnabled ? "Turn repeat off" : "Turn repeat on"}>
            <RepeatIcon />
          </button>
          <button
            className={like.liked ? "mode-button active like-button" : "mode-button like-button"}
            disabled={!playing || like.busy}
            type="button"
            onClick={like.onLike}
            aria-label={like.liked ? "Current song is in Liked Songs" : "Save current song to Liked Songs"}
            aria-pressed={like.liked}
            title={like.message}
          >
            <HeartIcon />
          </button>
          <button className="mode-button mode-button-wide unavailable" disabled type="button" aria-label="Radio is a follow-up feature">
            <RadioIcon />
            <span>Radio</span>
          </button>
          <button className="mode-button mode-button-wide unavailable" disabled type="button" aria-label="Queue is a follow-up feature">
            <QueueIcon />
            <span>Queue</span>
          </button>
        </div>
        <div className="transport-row" aria-label="Playback controls">
          <button className="transport-secondary" disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("previous")} aria-label="Previous track">
            <PreviousIcon />
          </button>
          <button className="transport-primary" disabled={!canSendControls} type="button" onClick={() => onPlaybackAction(playing?.isPlaying ? "pause" : "play")} aria-label={playing?.isPlaying ? "Pause" : "Play"}>
            {playing?.isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="transport-secondary" disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("next")} aria-label="Next track">
            <NextIcon />
          </button>
        </div>
        <div className="player-utility-row">
          <VolumeControlPanel snapshot={snapshot} controls={volume} compact />
        </div>
        {remotePlayback && (
          <button
            className="takeover-button"
            disabled={spotifySdk.status === "disabled" || spotifySdk.status === "auth_required"}
            type="button"
            onClick={onActivateSpotify}
          >
            Select Pipzo
          </button>
        )}
        {(timerView.active || timerView.expired) && (
          <p className="player-note">{timerView.label}</p>
        )}
      </section>
    </div>
  );
}

function currentProgressMs(playing: AppSnapshot["nowPlaying"], nowMs: number): number {
  if (!playing || playing.progressMs === undefined || playing.progressMs === null) {
    return 0;
  }
  if (!playing.isPlaying || !playing.capturedAt) {
    return playing.progressMs;
  }
  const capturedAtMs = Date.parse(playing.capturedAt);
  if (!Number.isFinite(capturedAtMs)) {
    return playing.progressMs;
  }
  return Math.min(playing.durationMs ?? Number.MAX_SAFE_INTEGER, playing.progressMs + Math.max(0, nowMs - capturedAtMs));
}

function QueuePanel({ queue }: { queue: QueueControls }) {
  const rows = [
    ...(queue.current ? [{ item: queue.current, current: true }] : []),
    ...queue.items.map((item) => ({ item, current: false })),
  ];
  return (
    <div className="queue-panel">
      <div className="queue-heading">
        <div>
          <h2>Songs coming up</h2>
        </div>
        <button type="button" onClick={queue.onClose} aria-label="Back to Now Playing">
          Back to Now Playing
        </button>
      </div>
      <div className="queue-list" data-drag-scroll>
        {rows.map(({ item, current }, index) => (
          <button
            className={current ? "queue-row current" : "queue-row"}
            disabled={queue.busy || item.playbackKind !== "track"}
            key={`${item.uri}-${index}`}
            type="button"
            onClick={() => queue.onPlay(item)}
          >
            <span className="queue-index">{current ? "Now" : index}</span>
            <span className="queue-art">{item.artworkUrl ? <img src={item.artworkUrl} alt="" draggable={false} /> : itemInitials(item.title)}</span>
            <span className="queue-copy">
              <strong>{item.title}</strong>
              <small>{item.subtitle ?? labelFromId(item.type)}</small>
            </span>
          </button>
        ))}
        {rows.length === 0 && <p className="subtle">No queue songs are available yet.</p>}
      </div>
    </div>
  );
}

function SettingsSurface({
  snapshot,
  spotifyAuth,
  wifi,
  speaker,
  spotifySdk,
  playbackGateDetail,
  onActivateSpotify,
  onIdleSettingsChange,
  sleepTimer,
  volume,
}: {
  snapshot: AppSnapshot;
  spotifyAuth: SpotifyAuthControls;
  wifi: WifiControls;
  speaker: SpeakerControls;
  spotifySdk: SpotifySdkState;
  playbackGateDetail: string;
  onActivateSpotify: () => void;
  onIdleSettingsChange: (patch: AppSettingsPatch) => void;
  sleepTimer: SleepTimerControls;
  volume: VolumeControls;
}) {
  return (
    <div className="settings-layout">
      <section className="hero-panel">
        <p className="eyebrow">Settings and recovery</p>
        <h1>{snapshot.appPhase === "degraded" ? "Recovery mode is available" : "Device settings"}</h1>
        <p>{snapshot.surfaces.returnSurface ? `Return target: ${labelFromId(snapshot.surfaces.returnSurface)}` : "App reset is separate from Wi-Fi and speaker forget actions."}</p>
        <div className="display-summary">
          <span>Display</span>
          <strong>{snapshot.health.display.brightness}%</strong>
          <small>{labelFromId(snapshot.health.display.status)}{snapshot.health.display.reason ? ` / ${labelFromId(snapshot.health.display.reason)}` : ""}</small>
        </div>
      </section>
      <IdleSettingsPanel snapshot={snapshot} onChange={onIdleSettingsChange} />
      <VolumeControlPanel snapshot={snapshot} controls={volume} />
      <SleepTimerPanel snapshot={snapshot} controls={sleepTimer} />
      <WifiPanel snapshot={snapshot} controls={wifi} context="settings" />
      <SpotifyAuthPanel snapshot={snapshot} controls={spotifyAuth} context="settings" />
      <SpeakerPanel snapshot={snapshot} controls={speaker} context="settings" />
      <SpotifyPlaybackPanel
        playbackGateDetail={playbackGateDetail}
        spotifySdk={spotifySdk}
        onActivateSpotify={onActivateSpotify}
      />
      <HealthRows snapshot={snapshot} />
      <section className="actions">
        {snapshot.recoveryActions.map((action) => (
          <button key={action.id} type="button">
            {labelFromId(action.kind)}
            <span>{labelFromId(action.state)}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function VolumeControlPanel({
  snapshot,
  controls,
  compact = false,
}: {
  snapshot: AppSnapshot;
  controls: VolumeControls;
  compact?: boolean;
}) {
  const view = volumeControlViewModel(snapshot);
  const value = view.value;
  const [dragValue, setDragValue] = useState(value);
  const dragValueRef = useRef(value);
  const draggingRef = useRef(false);
  const commitTimeoutRef = useRef<number | null>(null);
  const commitGenerationRef = useRef(0);

  useEffect(() => {
    if (draggingRef.current) {
      return;
    }
    dragValueRef.current = value;
    setDragValue(value);
  }, [value]);

  useEffect(() => () => {
    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
    }
  }, []);

  function scheduleVolumeChange(nextValue: number, muted = view.muted) {
    draggingRef.current = true;
    controls.onInteractionStart();
    dragValueRef.current = nextValue;
    setDragValue(nextValue);
    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
    }
    const commitGeneration = commitGenerationRef.current + 1;
    commitGenerationRef.current = commitGeneration;
    commitTimeoutRef.current = window.setTimeout(() => {
      if (commitGeneration !== commitGenerationRef.current) {
        return;
      }
      controls.onChange(nextValue, muted);
      commitTimeoutRef.current = null;
    }, compact ? 180 : 0);
  }

  function commitVolumeChange(nextValue = dragValueRef.current, muted = view.muted) {
    commitGenerationRef.current += 1;
    if (commitTimeoutRef.current !== null) {
      window.clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = null;
    }
    draggingRef.current = false;
    controls.onChange(nextValue, muted);
    controls.onInteractionEnd();
  }

  function finishVolumeInteraction() {
    if (!draggingRef.current && commitTimeoutRef.current === null) {
      return;
    }
    commitVolumeChange();
  }

  if (compact) {
    return (
      <section className={`volume-panel volume-${view.tone} compact icon-volume${view.muted ? " muted" : ""}`} aria-label="Volume">
        <div className="volume-controls">
          <button
            className="icon-button"
            disabled={view.disabled}
            type="button"
            onClick={() => controls.onChange(value, !view.muted)}
            aria-label={view.muted ? "Unmute" : "Mute"}
          >
            <SpeakerIcon muted={view.muted} />
          </button>
          <input
            aria-label="Volume level"
            disabled={view.disabled}
            min="0"
            max="100"
            step="1"
            type="range"
            value={dragValue}
            onPointerDown={() => {
              draggingRef.current = true;
              controls.onInteractionStart();
            }}
            onChange={(event) => scheduleVolumeChange(Number(event.target.value))}
            onPointerUp={finishVolumeInteraction}
            onPointerCancel={finishVolumeInteraction}
            onTouchEnd={finishVolumeInteraction}
            onBlur={() => {
              if (draggingRef.current) {
                finishVolumeInteraction();
              }
            }}
          />
        </div>
      </section>
    );
  }
  return (
    <section className={`volume-panel volume-${view.tone}${compact ? " compact" : ""}`} aria-label="Volume">
      <div>
        <p className="eyebrow">Volume</p>
        <h2>App volume</h2>
        <p>{view.detail}</p>
        <p className="subtle">{controls.message}</p>
      </div>
      <div className="volume-controls">
        <label>
          <span>Level</span>
          <input
            disabled={view.disabled || controls.busy}
            min="0"
            max="100"
            step="1"
            type="range"
            value={dragValue}
            onPointerDown={() => {
              draggingRef.current = true;
              controls.onInteractionStart();
            }}
            onChange={(event) => scheduleVolumeChange(Number(event.target.value))}
            onPointerUp={finishVolumeInteraction}
            onPointerCancel={finishVolumeInteraction}
            onTouchEnd={finishVolumeInteraction}
            onBlur={() => {
              if (draggingRef.current) {
                finishVolumeInteraction();
              }
            }}
          />
          <strong>{view.statusLabel}</strong>
        </label>
        <button
          disabled={view.disabled || controls.busy}
          type="button"
          onClick={() => controls.onChange(value, !view.muted)}
        >
          {view.muted ? "Unmute" : "Mute"}
        </button>
      </div>
    </section>
  );
}

function IdleSettingsPanel({
  snapshot,
  onChange,
}: {
  snapshot: AppSnapshot;
  onChange: (patch: AppSettingsPatch) => void;
}) {
  return (
    <section className="idle-settings" aria-label="Display and idle settings">
      <div>
        <p className="eyebrow">Display and idle</p>
        <h2>Bedtime idle mode</h2>
        <p>Clock-first by default, with artwork only when the setting is enabled.</p>
      </div>
      <label>
        <span>Mode</span>
        <select value={snapshot.settings.idleMode} onChange={(event) => onChange({ idleMode: event.target.value as AppSnapshot["settings"]["idleMode"] })}>
          <option value="clock">Clock</option>
          <option value="clock_with_artwork">Clock with artwork</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label>
        <span>Timeout</span>
        <select value={snapshot.settings.idleTimeoutSeconds} onChange={(event) => onChange({ idleTimeoutSeconds: Number(event.target.value) })}>
          <option value="30">30 seconds</option>
          <option value="60">1 minute</option>
          <option value="120">2 minutes</option>
          <option value="300">5 minutes</option>
          <option value="600">10 minutes</option>
        </select>
      </label>
      <label className="checkbox-row">
        <input
          checked={snapshot.settings.artworkInIdle}
          type="checkbox"
          onChange={(event) => onChange({ artworkInIdle: event.target.checked })}
        />
        <span>Show album art in idle</span>
      </label>
      <label>
        <span>Bedtime brightness</span>
        <input
          min="0"
          max="60"
          type="range"
          value={snapshot.settings.bedtimeBrightness}
          onChange={(event) => onChange({ bedtimeBrightness: Number(event.target.value) })}
        />
        <strong>{snapshot.settings.bedtimeBrightness}%</strong>
      </label>
    </section>
  );
}

function WifiPanel({
  snapshot,
  controls,
  context,
}: {
  snapshot: AppSnapshot;
  controls: WifiControls;
  context: "setup" | "settings";
}) {
  const view = wifiSetupViewModel(snapshot, controls.networks);
  const selectedNetwork = controls.networks.find((network) => network.ssid === controls.selectedSsid);
  const needsPassword = selectedNetwork ? selectedNetwork.security !== "open" : true;

  return (
    <section className={`wifi-panel wifi-${view.tone}`} aria-label="Wi-Fi setup">
      <div className="wifi-heading">
        <p className="eyebrow">{context === "setup" ? "Setup step" : "Wi-Fi"}</p>
        <h2>{view.title}</h2>
        <p>{view.detail}</p>
        <div className="wifi-status-grid">
          <div className="spotify-status">
            <span>Status</span>
            <strong>{labelFromId(snapshot.health.network.status)}</strong>
          </div>
          <div className="spotify-status">
            <span>Network</span>
            <strong>{snapshot.health.network.ssid ?? (controls.selectedSsid || "Not selected")}</strong>
          </div>
          <div className="spotify-status">
            <span>IP address</span>
            <strong>{view.ipAddressLabel}</strong>
          </div>
        </div>
        <p className="subtle">{controls.message}</p>
      </div>
      <div className="wifi-form">
        <label>
          <span>Network</span>
          <select value={controls.selectedSsid} onChange={(event) => controls.onSelect(event.target.value)}>
            <option value="">Select network</option>
            {controls.networks.map((network) => (
              <option key={network.ssid} value={network.ssid}>
                {network.ssid} / {network.signal}% / {labelFromId(network.security)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Password</span>
          <input
            autoComplete="current-password"
            disabled={!needsPassword}
            inputMode="text"
            placeholder={needsPassword ? "Wi-Fi password" : "Open network"}
            type="password"
            value={controls.password}
            onChange={(event) => controls.onPassword(event.target.value)}
          />
        </label>
        <div className="wifi-actions">
          <button disabled={controls.busy} type="button" onClick={controls.onScan}>
            Scan
          </button>
          {view.actions.includes("connect") && (
            <button disabled={controls.busy || !controls.selectedSsid} type="button" onClick={controls.onConnect}>
              Connect
            </button>
          )}
          {view.actions.includes("retry") && (
            <button disabled={controls.busy} type="button" onClick={controls.onRetry}>
              Retry internet
            </button>
          )}
          {view.actions.includes("forget") && (
            <button disabled={controls.busy} type="button" onClick={controls.onForget}>
              Forget
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function SpeakerPanel({
  snapshot,
  controls,
  context,
}: {
  snapshot: AppSnapshot;
  controls: SpeakerControls;
  context: "setup" | "settings";
}) {
  const view = speakerSetupViewModel(snapshot, controls.devices);
  const selected = controls.devices.find((device) => device.address === controls.selectedAddress);
  const primary = snapshot.health.speaker.primary;
  const deviceRows = speakerDeviceRows(snapshot, controls.devices, controls.selectedAddress);

  return (
    <section className={`speaker-panel speaker-${view.tone}`} aria-label="Bluetooth speaker setup">
      <div className="speaker-heading">
        <p className="eyebrow">{context === "setup" ? "Setup step" : "Bluetooth speaker"}</p>
        <h2>{view.title}</h2>
        <p>{view.detail}</p>
        <div className="wifi-status-grid">
          <div className="spotify-status">
            <span>Status</span>
            <strong>{labelFromId(snapshot.health.speaker.status)}</strong>
          </div>
          <div className="spotify-status">
            <span>Primary</span>
            <strong>{primary?.displayName ?? selected?.displayName ?? "Not selected"}</strong>
          </div>
        </div>
        <p className="subtle">{controls.message}</p>
      </div>
      <div className="speaker-form">
        <label>
          <span>Speaker</span>
          <select value={controls.selectedAddress} onChange={(event) => controls.onSelect(event.target.value)}>
            <option value="">Select speaker</option>
            {controls.devices.map((device) => (
              <option key={device.address} value={device.address}>
                {device.displayName} / {device.connected ? "Connected" : device.paired ? "Paired" : "New"}
              </option>
            ))}
          </select>
        </label>
        {deviceRows.length > 0 && (
          <div className="speaker-device-list" aria-label="Discovered Bluetooth audio devices">
            {deviceRows.map((device) => (
              <button
                key={device.address}
                className={`speaker-device-row${device.selected ? " is-selected" : ""}`}
                disabled={controls.busy}
                type="button"
                onClick={() => controls.onSelect(device.address)}
              >
                <span>
                  <strong>{device.title}</strong>
                  <small>{device.detail}</small>
                </span>
                {device.selected && <em>Selected</em>}
              </button>
            ))}
          </div>
        )}
        <div className="speaker-actions">
          <button disabled={controls.busy} type="button" onClick={controls.onScan}>
            Scan
          </button>
          {view.actions.includes("pair") && (
            <button disabled={controls.busy || !controls.selectedAddress} type="button" onClick={controls.onPair}>
              Pair and connect
            </button>
          )}
          {view.actions.includes("reconnect") && (
            <button disabled={controls.busy} type="button" onClick={controls.onReconnect}>
              Reconnect
            </button>
          )}
          {view.actions.includes("forget") && (
            <button disabled={controls.busy} type="button" onClick={controls.onForget}>
              Forget
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function SpotifyAuthPanel({
  snapshot,
  controls,
  context,
}: {
  snapshot: AppSnapshot;
  controls: SpotifyAuthControls;
  context: "setup" | "settings";
}) {
  const view = spotifyAuthViewModel(snapshot, controls.session);
  const isConnected = view.tone === "ready";

  return (
    <section className={`spotify-panel spotify-${view.tone}`} aria-label="Spotify account setup">
      <div>
        <p className="eyebrow">{context === "setup" ? "Setup step" : "Spotify account"}</p>
        <h2>{view.title}</h2>
        <p>{view.detail}</p>
        <div className="spotify-status">
          <span>Account</span>
          <strong>{view.accountLabel ?? (isConnected ? "Connected" : "Not connected")}</strong>
        </div>
        <div className="spotify-status">
          <span>Status</span>
          <strong>{controls.session ? labelFromId(controls.session.status) : labelFromId(snapshot.health.spotifyAuth.status)}</strong>
        </div>
        <p className="subtle">{controls.message}</p>
      </div>
      <div className="spotify-actions">
        {view.actions.includes("start") && (
          <button disabled={controls.busy} type="button" onClick={controls.onStart}>
            Start local Spotify setup
          </button>
        )}
        {view.actions.includes("open") && (
          <button disabled={controls.busy} type="button" onClick={controls.onOpen}>
            Open Spotify authorization
          </button>
        )}
        {view.actions.includes("refresh") && (
          <button disabled={controls.busy} type="button" onClick={controls.onRefresh}>
            Check status
          </button>
        )}
        {view.actions.includes("cancel") && (
          <button disabled={controls.busy} type="button" onClick={controls.onCancel}>
            Cancel setup
          </button>
        )}
        {view.actions.includes("retry") && (
          <button disabled={controls.busy} type="button" onClick={controls.onStart}>
            Try again
          </button>
        )}
        {view.actions.includes("logout") && (
          <button disabled={controls.busy} type="button" onClick={controls.onLogout}>
            Logout
          </button>
        )}
        {view.actions.includes("reconnect") && (
          <button disabled={controls.busy} type="button" onClick={controls.onReconnect}>
            Reconnect
          </button>
        )}
      </div>
    </section>
  );
}

function SpotifyPlaybackPanel({
  spotifySdk,
  playbackGateDetail,
  onActivateSpotify,
  playbackTest,
  takeoverLabel = "Activate player",
}: {
  spotifySdk: SpotifySdkState;
  playbackGateDetail: string;
  onActivateSpotify: () => void;
  playbackTest?: SetupPlaybackControls;
  takeoverLabel?: string;
}) {
  return (
    <section className={`spotify-panel playback-${spotifySdk.status}`} aria-label="Spotify browser playback">
      <div>
        <p className="eyebrow">Browser playback</p>
        <h2>{labelFromId(spotifySdk.status)}</h2>
        <p>{spotifySdkStatusLabel(spotifySdk)}</p>
        <div className="spotify-status">
          <span>Device</span>
          <strong>{spotifySdk.deviceId ?? "Not registered"}</strong>
        </div>
        <div className="spotify-status">
          <span>Transfer</span>
          <strong>{spotifySdk.transferred ? "Selected" : "Pending"}</strong>
        </div>
        <p className="subtle">{playbackGateDetail}</p>
      </div>
      <div className="spotify-actions">
        <button disabled={spotifySdk.status === "disabled" || spotifySdk.status === "auth_required"} type="button" onClick={onActivateSpotify}>
          {takeoverLabel}
        </button>
        {playbackTest && (
          <button disabled={playbackTest.busy || spotifySdk.status !== "ready" || !spotifySdk.transferred} type="button" onClick={playbackTest.onConfirm}>
            Confirm playback test
          </button>
        )}
      </div>
      {playbackTest && <p className="subtle">{playbackTest.message}</p>}
    </section>
  );
}

function SleepTimerPanel({
  snapshot,
  controls,
  compact = false,
}: {
  snapshot: AppSnapshot;
  controls: SleepTimerControls;
  compact?: boolean;
}) {
  const view = sleepTimerViewModel(snapshot, controls.timer, controls.nowMs);

  return (
    <section className={`sleep-timer sleep-timer-${view.tone}${compact ? " compact" : ""}`} aria-label="Sleep timer">
      <div>
        <p className="eyebrow">Sleep timer</p>
        <h2>{view.label}</h2>
        <p>{view.detail}</p>
      </div>
      <div className="sleep-presets" aria-label="Sleep timer presets">
        {sleepTimerPresets.map((minutes) => (
          <button
            disabled={!view.canStart || controls.busy}
            key={minutes}
            type="button"
            onClick={() => controls.onStart(minutes)}
          >
            {minutes}
            <span>min</span>
          </button>
        ))}
        <button disabled={!view.canCancel || controls.busy} type="button" onClick={controls.onCancel}>
          Clear
        </button>
      </div>
    </section>
  );
}

function SleepTimerSurface({
  snapshot,
  controls,
  onBack,
}: {
  snapshot: AppSnapshot;
  controls: SleepTimerControls;
  onBack: () => void;
}) {
  return (
    <div className="settings-layout timer-layout">
      <section className="hero-panel">
        <p className="eyebrow">Sleep timer</p>
        <h1>Timer</h1>
        <p>Choose when playback should stop.</p>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </section>
      <SleepTimerPanel snapshot={snapshot} controls={controls} />
    </div>
  );
}

function IdleSurface({ snapshot, sleepTimer, active = false }: { snapshot: AppSnapshot; sleepTimer: SleepTimerControls; active?: boolean }) {
  const [clockNow, setClockNow] = useState(() => new Date());
  const presentation = idlePresentation(snapshot);
  const playing = snapshot.nowPlaying;
  const timerView = sleepTimerViewModel(snapshot, sleepTimer.timer, sleepTimer.nowMs);
  const style = { "--idle-brightness": `${Math.max(0.22, presentation.brightness / 100)}` } as CSSProperties;

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className={`idle-surface ${presentation.showArtwork ? "with-art" : ""}${active ? " active-idle" : ""}`} style={style}>
      <div className="idle-clock-stack">
        <div className="clock">{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(clockNow)}</div>
        <p className="idle-status">{presentation.statusLabel}</p>
      </div>
      {presentation.showArtwork && <div className="idle-art">{playing?.artworkUrl ? "Art" : playing?.title?.slice(0, 1) ?? "P"}</div>}
      <p className="idle-now-playing">{playing ? `${playing.title} / ${playing.artist}` : "Clock-first idle mode"}</p>
      {(timerView.active || timerView.expired) && <p className="idle-timer">{timerView.label}</p>}
    </div>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      {muted ? (
        <>
          <path d="m17 9 4 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="m21 9-4 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M16 9.5a4 4 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18.5 7a7 7 0 0 1 0 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path
        d="M12 20s-7-4.4-9-9.2C1.5 7.2 3.8 4 7 4c1.9 0 3.4 1 4 2.3C11.6 5 13.1 4 15 4c3.2 0 5.5 3.2 4 6.8C17 15.6 12 20 12 20Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M4 11.5 12 5l8 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 10.5V20h11V10.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M10 20v-5h4v5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  );
}

function NowPlayingIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <path d="M15.5 8.5v7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M8.5 9.5v5l4-2.5-4-2.5Z" fill="currentColor" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path
        d="M9.7 3.2h4.6l.7 2.4 1.8.8 2.2-1.2 2.3 4-1.8 1.6v2.4l1.8 1.6-2.3 4-2.2-1.2-1.8.8-.7 2.4H9.7L9 18.4l-1.8-.8L5 18.8l-2.3-4 1.8-1.6v-2.4L2.7 9.2l2.3-4 2.2 1.2 1.8-.8.7-2.4Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function TimerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="13" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9 2h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 6V3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 13V9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 13h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8 5v14l11-7L8 5Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

function PreviousIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M6 5h2v14H6zM9 12l9-7v14l-9-7Z" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M16 5h2v14h-2zM6 5l9 7-9 7V5Z" fill="currentColor" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M4 7h2.6c4.6 0 5.6 10 10.4 10H20" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
      <path d="M4 17h2.6c1.9 0 3.1-1.7 4.2-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
      <path d="M16.8 4.4 20 7l-3.2 2.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
      <path d="M16.8 14.4 20 17l-3.2 2.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M17 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 22l-4-4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function RadioIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M5 12a7 7 0 0 1 14 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 12a4 4 0 0 1 8 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M5 7h14M5 12h14M5 17h9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HealthRows({ snapshot }: { snapshot: AppSnapshot }) {
  const rows = [
    ["Wi-Fi", snapshot.health.network.status, snapshot.health.network.reason ?? snapshot.health.network.ssid],
    ["Spotify", snapshot.health.spotifyAuth.status, snapshot.health.spotifyAuth.reason ?? snapshot.health.spotifyAuth.accountDisplayName],
    ["Speaker", snapshot.health.speaker.status, snapshot.health.speaker.reason ?? snapshot.health.speaker.primary?.displayName],
    ["Playback", snapshot.health.playbackDevice.status, snapshot.health.playbackDevice.reason ?? snapshot.health.playbackDevice.deviceId],
    ["Volume", snapshot.health.volume.status, snapshot.health.volume.reason ?? `${snapshot.health.volume.value ?? 0}%`],
    ["Display", snapshot.health.display.status, snapshot.health.display.reason ?? `${snapshot.health.display.brightness}%`],
  ];
  return (
    <section className="health-list">
      {rows.map(([label, status, detail]) => (
        <div className="health-row" key={label}>
          <strong>{label}</strong>
          <span>{labelFromId(status ?? "unknown")}</span>
          <small>{detail ? labelFromId(detail) : "No detail"}</small>
        </div>
      ))}
    </section>
  );
}

function TileGrid({ items }: { items: [string, string][] }) {
  return (
    <section className="tile-grid">
      {items.map(([title, body]) => (
        <button key={title} type="button">
          <strong>{title}</strong>
          <span>{body}</span>
        </button>
      ))}
    </section>
  );
}
