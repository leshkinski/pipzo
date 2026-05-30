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
  fetchNetworkScanResults,
  fetchSpeakerScanResults,
  fetchSpotifyAuthSession,
  forgetSpeaker,
  forgetNetwork,
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
import type { AppSettingsPatch, AppSnapshot, DisplayStatus, LibraryCategoryId, LibraryHomeResponse, LibraryItem, ScenarioSummary, SpeakerDevice, SpotifyAuthSession, SurfaceId, WifiNetwork } from "./contracts";
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
  idlePresentation,
  isSetupGated,
  labelFromId,
  libraryAvailability,
  nextNowPlayingBoundaryRefreshDelayMs,
  nowPlayingEmptyState,
  nowPlayingCommandRefreshDelaysMs,
  nowPlayingRefreshIntervalMs,
  preferredSurface,
  primarySurfaces,
  shouldRefreshNowPlaying,
  shouldEnterIdleMode,
  sleepTimerExpiryCommand,
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

type DataSource = "backend" | "local";
type AppSurfaceId = SurfaceId | "sleep_timer";

type KeyboardState = {
  active: boolean;
  surface: SurfaceId | null;
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
  onRefresh: () => void;
  onCategory: (category: LibraryCategoryId) => void;
  onPlay: (item: LibraryItem) => void;
};

const navLabels: Record<SurfaceId, string> = {
  setup: "Setup",
  home: "Home",
  now_playing: "Now Playing",
  settings: "Settings",
  browse: "Browse",
  idle: "Idle",
};

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => localScenarioSnapshot("first_boot_empty"));
  const [selectedSurface, setSelectedSurface] = useState<AppSurfaceId>("setup");
  const [timerReturnSurface, setTimerReturnSurface] = useState<AppSurfaceId>("now_playing");
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>(() => localScenarioSummaries());
  const [selectedScenario, setSelectedScenario] = useState("first_boot_empty");
  const [dataSource, setDataSource] = useState<DataSource>("local");
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
  const [libraryHome, setLibraryHome] = useState<LibraryHomeResponse>(() => localLibraryHome());
  const [libraryCategory, setLibraryCategory] = useState<LibraryCategoryId>("playlists");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryMessage, setLibraryMessage] = useState("Library fixtures loaded for local development.");
  const [keyboardState, setKeyboardState] = useState<KeyboardState>({ active: false, surface: null });
  const [spotifySdkState, setSpotifySdkState] = useState<SpotifySdkState>({
    status: "disabled",
    activated: false,
    transferred: false,
  });
  const spotifyPlayerRef = useRef<SpotifyPlayerInstance | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const snapshotRefreshInFlightRef = useRef<Promise<AppSnapshot> | null>(null);
  const scheduledSnapshotRefreshIdsRef = useRef<number[]>([]);

  useExplicitDragScroll(appRef);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const [health, state] = await Promise.all([fetchHealth(), fetchAppState()]);
        if (cancelled) return;
        let backendScenarios: ScenarioSummary[] = [];
        if (health.mode === "mock") {
          backendScenarios = await fetchBackendScenarios().catch(() => []);
          if (cancelled) return;
        }
        setBackendMode(health.mode);
        setSnapshot(state);
        if (state.capabilities.canBrowse) {
          const home = await fetchLibraryHome().catch(() => null);
          if (home && !cancelled) {
            setLibraryHome(home);
            setLibraryMessage("Library loaded from backend.");
          }
        } else {
          setLibraryHome({ sections: [], generatedAt: new Date().toISOString(), constrained: true });
          setLibraryMessage("Library is unavailable until network and Spotify recovery complete.");
        }
        setScenarios([...backendScenarios, ...localScenarioSummaries().filter((item) => !backendScenarios.some((backend) => backend.id === item.id))]);
        setDataSource("backend");
        setSelectedScenario(backendScenarios[0]?.id ?? "ready_healthy");
        setStatusText(health.mode === "mock" ? "Connected to backend mock API." : "Connected to backend hardware API.");
      } catch {
        if (cancelled) return;
        const fallback = localScenarioSnapshot("first_boot_empty");
        setSnapshot(fallback);
        setLibraryHome(localLibraryHome());
        setScenarios(localScenarioSummaries());
        setDataSource("local");
        setBackendMode(null);
        setStatusText("Backend unavailable. Showing local fallback scenarios.");
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

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
      const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
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

  const gated = isSetupGated(snapshot);
  const activeSurface = idleActive ? "idle" : gated ? "setup" : selectedSurface;
  const visibleWarnings = snapshot.warnings;
  const degradedMode = degradedModeViewModel(snapshot);
  const spotifyPlaybackGate = useMemo(() => spotifySdkGate(snapshot, dataSource, backendMode ?? undefined), [snapshot, dataSource, backendMode]);
  const showDeveloperPanel = dataSource !== "backend" || backendMode === "mock";
  const currentScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenario),
    [scenarios, selectedScenario],
  );

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
        setSnapshot(state);
        return state;
      })
      .finally(() => {
        snapshotRefreshInFlightRef.current = null;
      });
    snapshotRefreshInFlightRef.current = request;
    return request;
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

  async function refreshLibraryHome() {
    setLibraryBusy(true);
    setLibraryMessage("Refreshing library.");
    try {
      if (dataSource === "backend") {
        const home = await fetchLibraryHome();
        setLibraryHome(home);
        setLibraryMessage(home.sections.some((section) => section.items.length > 0) ? "Library refreshed." : "Library is connected but empty.");
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
        await scanSpeakers();
        const results = await fetchSpeakerScanResults();
        setSpeakerDevices(results.devices);
        setSelectedSpeakerAddress((current) => current || results.devices[0]?.address || "");
        setSpeakerMessage(results.devices.length > 0 ? "Choose one speaker and pair it." : "No Bluetooth speakers found. Put the speaker in pairing mode and scan again.");
      } else {
        const fallback = [
          { address: "AA:BB:CC:DD:EE:FF", displayName: "Pipzo Speaker", alias: "Bedroom speaker", paired: snapshot.readiness.primarySpeakerSaved, connected: snapshot.health.speaker.status === "connected", signal: 88 },
          { address: "11:22:33:44:55:66", displayName: "Kitchen Speaker", paired: false, connected: false, signal: 62 },
        ];
        setSpeakerDevices(fallback);
        setSelectedSpeakerAddress((current) => current || fallback[0].address);
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
        await refreshSnapshot().catch(() => undefined);
        setSpeakerMessage(action.state === "succeeded" ? "Bluetooth speaker connected." : `Speaker pairing failed: ${labelFromId(action.reason ?? "unknown")}.`);
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
        await refreshSnapshot().catch(() => undefined);
        setSpeakerMessage(action.state === "succeeded" ? "Bluetooth speaker reconnected." : `Reconnect failed: ${labelFromId(action.reason ?? "unknown")}.`);
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
        setSpeakerMessage(action.state === "succeeded" ? "Bluetooth speaker forgotten." : `Forget failed: ${labelFromId(action.reason ?? "unknown")}.`);
      } else {
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

  async function sendPlaybackAction(action: "play" | "pause" | "next" | "previous") {
    const remotePlayback = snapshot.diagnostics.lastCommand === "spotify.current_playback" && snapshot.diagnostics.rawAdapterCode?.startsWith("device_mismatch:");
    const deviceId = remotePlayback ? undefined : spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    if (dataSource === "backend") {
      try {
        const result = await controlPlayback({ action, deviceId });
        setStatusText(result.state === "succeeded" ? `Playback ${action} sent.` : `Playback ${action} blocked: ${labelFromId(result.reason ?? "unknown")}.`);
        await refreshSnapshot().catch(() => undefined);
        if (result.state === "succeeded") {
          scheduleSnapshotRefreshes();
        }
        return;
      } catch {
        setStatusText("Playback command could not be sent.");
      }
    }
    setStatusText("Local scenario playback controls do not call Spotify.");
  }

  async function updateVolume(value: number, muted = snapshot.health.volume.muted ?? false) {
    const bounded = Math.max(0, Math.min(100, Math.round(value)));
    const deviceId = spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    setVolumeBusy(true);
    if (dataSource === "backend") {
      try {
        const volume = await patchVolume({ value: bounded, muted, deviceId });
        setSnapshot((current) => ({ ...current, health: { ...current.health, volume } }));
        setVolumeMessage(volume.status === "unified" ? "Volume updated." : `Volume partially updated: ${labelFromId(volume.reason ?? volume.status)}.`);
        setStatusText(volume.status === "unified" ? "Volume updated." : "Volume control is partially available.");
        return;
      } catch {
        setVolumeMessage("Volume command could not be sent.");
        setStatusText("Volume command could not be sent.");
      } finally {
        setVolumeBusy(false);
      }
    }
    setSnapshot((current) => ({
      ...current,
      health: {
        ...current.health,
        volume: {
          ...current.health.volume,
          status: current.capabilities.canControlVolume ? "unified" : "unavailable",
          value: bounded,
          muted,
        },
      },
    }));
    setVolumeMessage("Local volume mock updated.");
    setStatusText("Local volume mock updated.");
    setVolumeBusy(false);
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
    onRefresh: refreshLibraryHome,
    onCategory: selectLibraryCategory,
    onPlay: startLibraryItem,
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
      <header className="topbar">
        <div>
          <div className="brand">Pipzo</div>
          <div className="subtle">{statusText}</div>
        </div>
        <div className="status-strip" aria-label="System status">
          <StatusChip label="Network" value={snapshot.health.network.status} tone={snapshot.health.network.status === "online" ? "good" : "warn"} />
          <StatusChip label="Spotify" value={snapshot.health.spotifyAuth.status} tone={snapshot.health.spotifyAuth.status === "connected" ? "good" : "warn"} />
          <StatusChip label="Speaker" value={snapshot.health.speaker.status} tone={snapshot.health.speaker.status === "connected" ? "good" : "warn"} />
          <StatusChip label="Volume" value={snapshot.health.volume.status} tone={snapshot.health.volume.status === "unified" ? "good" : "warn"} />
        </div>
      </header>

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
          {primarySurfaces.map((surface) => {
            const disabled = !canOpenSurface(snapshot, surface);
            return (
              <button
                className={activeSurface === surface ? "active" : ""}
                disabled={disabled}
                key={surface}
                onClick={() => setSelectedSurface(surface)}
                type="button"
              >
                {navLabels[surface]}
              </button>
            );
          })}
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
          {activeSurface === "home" && <HomeSurface snapshot={snapshot} library={libraryControls} onStartIdle={() => setIdleActive(true)} />}
          {activeSurface === "now_playing" && (
            <NowPlayingSurface
              snapshot={snapshot}
              spotifySdk={spotifySdkState}
              onActivateSpotify={activateSpotifyPlayer}
              onPlaybackAction={sendPlaybackAction}
              sleepTimer={sleepTimerControls}
              volume={volumeControls}
              nowMs={nowMs}
              onOpenSleepTimer={() => {
                setTimerReturnSurface("now_playing");
                setSelectedSurface("sleep_timer");
              }}
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

function HomeSurface({ snapshot, library, onStartIdle }: { snapshot: AppSnapshot; library: LibraryControls; onStartIdle: () => void }) {
  const availability = libraryAvailability(snapshot);
  const categories: LibraryCategoryId[] = ["playlists", "albums", "artists", "liked_songs", "recently_played"];
  const activeSection = library.home.sections.find((section) => section.id === library.activeCategory) ?? library.home.sections[0];
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">Home</p>
        <h1>Saved music</h1>
        <p>{snapshot.staleness.isStale ? "Showing cached account content until connectivity recovers." : availability.detail}</p>
        <div className="home-actions">
          <button disabled={library.busy || !availability.canBrowse} type="button" onClick={library.onRefresh}>
            Refresh library
          </button>
          <button disabled={!idlePresentation(snapshot).enabled} type="button" onClick={onStartIdle}>
            Screensaver
          </button>
        </div>
        <p className="subtle">{library.message}</p>
      </section>
      <div className="side-stack" data-drag-scroll>
        <section className="category-tabs" aria-label="Library categories">
          {categories.map((category) => (
            <button
              className={library.activeCategory === category ? "active" : ""}
              disabled={!availability.canBrowse || library.busy}
              key={category}
              type="button"
              onClick={() => library.onCategory(category)}
            >
              {labelFromId(category)}
            </button>
          ))}
        </section>
        {activeSection ? (
          <LibrarySectionPanel section={activeSection} snapshot={snapshot} onPlay={library.onPlay} />
        ) : (
          <section className="library-section">
            <h2>No saved content shown</h2>
            <p>Refresh the library or recover Spotify/network access from Settings.</p>
          </section>
        )}
      </div>
    </div>
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
      <div className="library-section-heading">
        <div>
          <p className="eyebrow">{labelFromId(section.id)}</p>
          <h2>{section.title}</h2>
          <p>{section.description}</p>
        </div>
        {snapshot.staleness.isStale && <strong className="stale-pill">Stale</strong>}
      </div>
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
  sleepTimer,
  volume,
  nowMs,
  onOpenSleepTimer,
}: {
  snapshot: AppSnapshot;
  spotifySdk: SpotifySdkState;
  onActivateSpotify: () => void;
  onPlaybackAction: (action: "play" | "pause" | "next" | "previous") => void;
  sleepTimer: SleepTimerControls;
  volume: VolumeControls;
  nowMs: number;
  onOpenSleepTimer: () => void;
}) {
  const playing = snapshot.nowPlaying;
  const displayedProgressMs = currentProgressMs(playing, nowMs);
  const progress = playing?.durationMs ? Math.min(100, (displayedProgressMs / playing.durationMs) * 100) : 0;
  const canSendControls = snapshot.capabilities.canControlPlayback && (spotifySdk.status === "ready" || Boolean(snapshot.health.playbackDevice.deviceId));
  const emptyState = nowPlayingEmptyState(snapshot);
  const remotePlayback = snapshot.diagnostics.lastCommand === "spotify.current_playback" && snapshot.diagnostics.rawAdapterCode?.startsWith("device_mismatch:");
  return (
    <div className="surface-grid">
      <section className="art-panel" aria-label="Artwork placeholder">
        {playing?.artworkUrl ? <img src={playing.artworkUrl} alt="" draggable={false} /> : <div>P</div>}
      </section>
      <section className="player-panel">
        <p className="eyebrow">Now Playing</p>
        <h1 className="track-title">{emptyState.title}</h1>
        <p>{emptyState.detail}</p>
        <div className="progress"><span style={{ width: `${progress}%` }} /></div>
        <div className="time-row">
          <span>{formatMs(displayedProgressMs)}</span>
          <span>{formatMs(playing?.durationMs)}</span>
        </div>
        <div className="control-row">
          <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("previous")}>Previous</button>
          <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction(playing?.isPlaying ? "pause" : "play")}>{playing?.isPlaying ? "Pause" : "Play"}</button>
          <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("next")}>Next</button>
          <button className="icon-button" type="button" onClick={onOpenSleepTimer} aria-label="Sleep timer">
            <TimerIcon />
          </button>
        </div>
        <VolumeControlPanel snapshot={snapshot} controls={volume} compact />
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
        {sleepTimerViewModel(snapshot, sleepTimer.timer, sleepTimer.nowMs).active && (
          <p className="subtle">{sleepTimerViewModel(snapshot, sleepTimer.timer, sleepTimer.nowMs).label}</p>
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
  if (compact) {
    return (
      <section className={`volume-panel volume-${view.tone} compact icon-volume${view.muted ? " muted" : ""}`} aria-label="Volume">
        <div className="volume-controls">
          <button
            className="icon-button"
            disabled={view.disabled || controls.busy}
            type="button"
            onClick={() => controls.onChange(value, !view.muted)}
            aria-label={view.muted ? "Unmute" : "Mute"}
          >
            <SpeakerIcon muted={view.muted} />
          </button>
          <input
            aria-label="Volume level"
            disabled={view.disabled || controls.busy}
            min="0"
            max="100"
            type="range"
            value={value}
            onChange={(event) => controls.onChange(Number(event.target.value), view.muted)}
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
            type="range"
            value={value}
            onChange={(event) => controls.onChange(Number(event.target.value), view.muted)}
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

function StatusChip({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" }) {
  return (
    <div className={`chip ${tone}`}>
      <span>{label}</span>
      <strong>{labelFromId(value)}</strong>
    </div>
  );
}
