import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  activateBackendScenario,
  cancelSpotifyAuthSession,
  controlPlayback,
  createSpotifyAuthSession,
  fetchAppState,
  fetchBackendScenarios,
  fetchHealth,
  fetchNetworkScanResults,
  fetchSpeakerScanResults,
  fetchSpotifyAuthSession,
  forgetSpeaker,
  forgetNetwork,
  logoutSpotifyAuth,
  patchDisplay,
  patchSettings,
  pairSpeaker,
  retryInternetProbe,
  reconnectSpeaker,
  scanSpeakers,
  scanNetwork,
  connectNetwork,
} from "./api";
import type { AppSettingsPatch, AppSnapshot, DisplayStatus, ScenarioSummary, SpeakerDevice, SpotifyAuthSession, SurfaceId, WifiNetwork } from "./contracts";
import { localScenarioSnapshot, localScenarioSummaries } from "./localScenarios";
import {
  createSpotifyWebPlayer,
  spotifySdkGate,
  spotifySdkStatusLabel,
  type SpotifyPlayerInstance,
  type SpotifySdkState,
} from "./spotifyWebPlayback";
import {
  canOpenSurface,
  degradedModeViewModel,
  formatMs,
  idlePresentation,
  isSetupGated,
  labelFromId,
  preferredSurface,
  primarySurfaces,
  shouldEnterIdleMode,
  sleepTimerExpiryCommand,
  sleepTimerPresets,
  sleepTimerViewModel,
  speakerSetupViewModel,
  startSleepTimer,
  spotifyAuthViewModel,
  wifiSetupViewModel,
  type SleepTimerPresetMinutes,
  type SleepTimerState,
} from "./viewModel";

type DataSource = "backend" | "local";

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

const navLabels: Record<SurfaceId, string> = {
  setup: "Setup",
  home: "Home",
  browse: "Browse",
  now_playing: "Now Playing",
  settings: "Settings",
  idle: "Idle",
};

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(() => localScenarioSnapshot("first_boot_empty"));
  const [selectedSurface, setSelectedSurface] = useState<SurfaceId>("setup");
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
  const [spotifySdkState, setSpotifySdkState] = useState<SpotifySdkState>({
    status: "disabled",
    activated: false,
    transferred: false,
  });
  const spotifyPlayerRef = useRef<SpotifyPlayerInstance | null>(null);

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
        setScenarios([...backendScenarios, ...localScenarioSummaries().filter((item) => !backendScenarios.some((backend) => backend.id === item.id))]);
        setDataSource("backend");
        setSelectedScenario(backendScenarios[0]?.id ?? "ready_healthy");
        setStatusText(health.mode === "mock" ? "Connected to backend mock API." : "Connected to backend hardware API.");
      } catch {
        if (cancelled) return;
        const fallback = localScenarioSnapshot("first_boot_empty");
        setSnapshot(fallback);
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
    setSelectedSurface((current) => (canOpenSurface(snapshot, current) ? current : preferred));
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

  const gated = isSetupGated(snapshot);
  const activeSurface = idleActive ? "idle" : gated ? "setup" : selectedSurface;
  const visibleWarnings = snapshot.warnings;
  const degradedMode = degradedModeViewModel(snapshot);
  const spotifyPlaybackGate = useMemo(() => spotifySdkGate(snapshot, dataSource, backendMode ?? undefined), [snapshot, dataSource, backendMode]);
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
    const state = await fetchAppState();
    setSnapshot(state);
    return state;
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
          health: { ...current.health, network: { status: "online", ssid: selectedWifiSsid, internetReachable: true } },
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
            network: { status: "online", ssid: current.health.network.ssid ?? (selectedWifiSsid || "PipzoNet"), internetReachable: true },
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
      return;
    }
    try {
      await player.activateElement();
      setSpotifySdkState((current) => ({ ...current, activated: true }));
    } catch {
      setSpotifySdkState((current) => ({ ...current, status: "browser_not_ready", error: "spotify_activation_failed" }));
    }
  }

  async function sendPlaybackAction(action: "play" | "pause" | "next" | "previous") {
    const deviceId = spotifySdkState.deviceId ?? snapshot.health.playbackDevice.deviceId;
    if (dataSource === "backend") {
      try {
        const result = await controlPlayback({ action, deviceId });
        setStatusText(result.state === "succeeded" ? `Playback ${action} sent.` : `Playback ${action} blocked: ${labelFromId(result.reason ?? "unknown")}.`);
        return;
      } catch {
        setStatusText("Playback command could not be sent.");
      }
    }
    setStatusText("Local scenario playback controls do not call Spotify.");
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

  return (
    <div className={`app phase-${snapshot.appPhase}${idleActive ? " idle-active" : ""}`}>
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

      <DeveloperPanel
        scenarios={scenarios}
        selectedScenario={selectedScenario}
        currentScenario={currentScenario}
        dataSource={dataSource}
        display={snapshot.health.display}
        onChange={switchScenario}
        onDisplayChange={updateDisplay}
      />

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

        <section className="surface" aria-live="polite">
          {activeSurface === "setup" && <SetupSurface snapshot={snapshot} spotifyAuth={spotifyAuthControls} wifi={wifiControls} speaker={speakerControls} />}
          {activeSurface === "home" && <HomeSurface snapshot={snapshot} sleepTimer={sleepTimerControls} />}
          {activeSurface === "browse" && <BrowseSurface snapshot={snapshot} />}
          {activeSurface === "now_playing" && (
            <NowPlayingSurface
              snapshot={snapshot}
              spotifySdk={spotifySdkState}
              playbackGateDetail={spotifyPlaybackGate.detail}
              onActivateSpotify={activateSpotifyPlayer}
              onPlaybackAction={sendPlaybackAction}
              sleepTimer={sleepTimerControls}
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
            />
          )}
          {activeSurface === "idle" && <IdleSurface snapshot={snapshot} sleepTimer={sleepTimerControls} />}
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
}: {
  snapshot: AppSnapshot;
  spotifyAuth: SpotifyAuthControls;
  wifi: WifiControls;
  speaker: SpeakerControls;
}) {
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
      </div>
    </div>
  );
}

function HomeSurface({ snapshot, sleepTimer }: { snapshot: AppSnapshot; sleepTimer: SleepTimerControls }) {
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">Home</p>
        <h1>Library-first music for bedtime</h1>
        <p>{snapshot.staleness.isStale ? "Showing cached account content until connectivity recovers." : "Ready for library and account-context recommendations."}</p>
      </section>
      <div className="side-stack">
        <SleepTimerPanel snapshot={snapshot} controls={sleepTimer} compact />
        <TileGrid
          items={[
            ["Recently loved", "From the connected Spotify account"],
            ["Quiet favorites", "Saved music and familiar mixes"],
            ["Sleep timer", snapshot.capabilities.canUseSleepTimer ? "Available" : "Unavailable now"],
          ]}
        />
      </div>
    </div>
  );
}

function BrowseSurface({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">Browse</p>
        <h1>{snapshot.capabilities.canBrowse ? "Browse saved music" : "Browse is waiting for recovery"}</h1>
        <p>{snapshot.capabilities.canSearch ? "Search stays constrained to the account/library surface." : "Network or Spotify health is blocking live browse."}</p>
      </section>
      <TileGrid
        items={[
          ["Playlists", snapshot.capabilities.canBrowse ? "Open" : "Disabled"],
          ["Albums", snapshot.staleness.isStale ? "Cached" : "Fresh"],
          ["Search", snapshot.capabilities.canSearch ? "Ready" : "Blocked"],
        ]}
      />
    </div>
  );
}

function NowPlayingSurface({
  snapshot,
  spotifySdk,
  playbackGateDetail,
  onActivateSpotify,
  onPlaybackAction,
  sleepTimer,
}: {
  snapshot: AppSnapshot;
  spotifySdk: SpotifySdkState;
  playbackGateDetail: string;
  onActivateSpotify: () => void;
  onPlaybackAction: (action: "play" | "pause" | "next" | "previous") => void;
  sleepTimer: SleepTimerControls;
}) {
  const playing = snapshot.nowPlaying;
  const progress = playing?.durationMs ? Math.min(100, ((playing.progressMs ?? 0) / playing.durationMs) * 100) : 0;
  const canSendControls = snapshot.capabilities.canControlPlayback && spotifySdk.status === "ready";
  return (
    <div className="surface-grid">
      <section className="art-panel" aria-label="Artwork placeholder">
        <div>{playing?.artworkUrl ? "Artwork" : "P"}</div>
      </section>
      <section className="player-panel">
        <p className="eyebrow">Now Playing</p>
        <h1>{playing?.title ?? "Nothing playing"}</h1>
        <p>{playing ? `${playing.artist}${playing.album ? ` / ${playing.album}` : ""}` : "Choose music from Home or Browse when playback is available."}</p>
        <div className="progress"><span style={{ width: `${progress}%` }} /></div>
        <div className="time-row">
          <span>{formatMs(playing?.progressMs)}</span>
          <span>{formatMs(playing?.durationMs)}</span>
        </div>
        <div className="control-row">
          <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("previous")}>Previous</button>
          <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction(playing?.isPlaying ? "pause" : "play")}>{playing?.isPlaying ? "Pause" : "Play"}</button>
          <button disabled={!canSendControls} type="button" onClick={() => onPlaybackAction("next")}>Next</button>
        </div>
        <div className="volume-row">
          <span>Volume</span>
          <meter min="0" max="100" value={snapshot.health.volume.value ?? 0} />
          <strong>{snapshot.health.volume.status === "out_of_sync" ? "Out of sync" : `${snapshot.health.volume.value ?? 0}%`}</strong>
        </div>
        <SpotifyPlaybackPanel
          playbackGateDetail={playbackGateDetail}
          spotifySdk={spotifySdk}
          onActivateSpotify={onActivateSpotify}
        />
        <SleepTimerPanel snapshot={snapshot} controls={sleepTimer} />
      </section>
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
}: {
  spotifySdk: SpotifySdkState;
  playbackGateDetail: string;
  onActivateSpotify: () => void;
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
          Activate player
        </button>
      </div>
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
