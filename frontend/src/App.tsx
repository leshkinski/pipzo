import { useEffect, useMemo, useState, type CSSProperties } from "react";

import {
  activateBackendScenario,
  cancelSpotifyAuthSession,
  createSpotifyAuthSession,
  fetchAppState,
  fetchBackendScenarios,
  fetchSpotifyAuthSession,
  logoutSpotifyAuth,
  patchDisplay,
  patchSettings,
} from "./api";
import type { AppSettingsPatch, AppSnapshot, DisplayStatus, ScenarioSummary, SpotifyAuthSession, SurfaceId } from "./contracts";
import { localScenarioSnapshot, localScenarioSummaries } from "./localScenarios";
import {
  canOpenSurface,
  formatMs,
  idlePresentation,
  isSetupGated,
  labelFromId,
  preferredSurface,
  primarySurfaces,
  shouldEnterIdleMode,
  spotifyAuthViewModel,
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
  const [statusText, setStatusText] = useState("Using local fallback scenarios.");
  const [spotifyAuthSession, setSpotifyAuthSession] = useState<SpotifyAuthSession | null>(null);
  const [spotifyAuthBusy, setSpotifyAuthBusy] = useState(false);
  const [spotifyAuthMessage, setSpotifyAuthMessage] = useState("Use local Chromium on this device to connect Spotify.");
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());
  const [idleActive, setIdleActive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const [state, backendScenarios] = await Promise.all([fetchAppState(), fetchBackendScenarios()]);
        if (cancelled) return;
        setSnapshot(state);
        setScenarios([...backendScenarios, ...localScenarioSummaries().filter((item) => !backendScenarios.some((backend) => backend.id === item.id))]);
        setDataSource("backend");
        setSelectedScenario(backendScenarios[0]?.id ?? "ready_healthy");
        setStatusText("Connected to backend mock API.");
      } catch {
        if (cancelled) return;
        const fallback = localScenarioSnapshot("first_boot_empty");
        setSnapshot(fallback);
        setScenarios(localScenarioSummaries());
        setDataSource("local");
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

  const gated = isSetupGated(snapshot);
  const activeSurface = idleActive ? "idle" : gated ? "setup" : selectedSurface;
  const visibleWarnings = snapshot.warnings;
  const currentScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenario),
    [scenarios, selectedScenario],
  );

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

  return (
    <div className={`app phase-${snapshot.appPhase}${idleActive ? " idle-active" : ""}`}>
      {idleActive ? (
        <IdleSurface snapshot={snapshot} active />
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
          {activeSurface === "setup" && <SetupSurface snapshot={snapshot} spotifyAuth={spotifyAuthControls} />}
          {activeSurface === "home" && <HomeSurface snapshot={snapshot} />}
          {activeSurface === "browse" && <BrowseSurface snapshot={snapshot} />}
          {activeSurface === "now_playing" && <NowPlayingSurface snapshot={snapshot} />}
          {activeSurface === "settings" && <SettingsSurface snapshot={snapshot} spotifyAuth={spotifyAuthControls} onIdleSettingsChange={updateIdleSettings} />}
          {activeSurface === "idle" && <IdleSurface snapshot={snapshot} />}
        </section>
      </main>
        </>
      )}
    </div>
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

function SetupSurface({ snapshot, spotifyAuth }: { snapshot: AppSnapshot; spotifyAuth: SpotifyAuthControls }) {
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">First run setup</p>
        <h1>{snapshot.appPhase === "starting" ? "Checking Pipzo hardware" : "Finish setup before music starts"}</h1>
        <p>
          Current blocker: <strong>{labelFromId(snapshot.setup.blockingStep)}</strong>
        </p>
        <p>Spotify must be connected locally in Chromium before setup can complete.</p>
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
        <SpotifyAuthPanel snapshot={snapshot} controls={spotifyAuth} context="setup" />
      </div>
    </div>
  );
}

function HomeSurface({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">Home</p>
        <h1>Library-first music for bedtime</h1>
        <p>{snapshot.staleness.isStale ? "Showing cached account content until connectivity recovers." : "Ready for library and account-context recommendations."}</p>
      </section>
      <TileGrid
        items={[
          ["Recently loved", "From the connected Spotify account"],
          ["Quiet favorites", "Saved music and familiar mixes"],
          ["Sleep timer", snapshot.capabilities.canUseSleepTimer ? "Available" : "Unavailable now"],
        ]}
      />
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

function NowPlayingSurface({ snapshot }: { snapshot: AppSnapshot }) {
  const playing = snapshot.nowPlaying;
  const progress = playing?.durationMs ? Math.min(100, ((playing.progressMs ?? 0) / playing.durationMs) * 100) : 0;
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
          <button disabled={!snapshot.capabilities.canControlPlayback} type="button">Previous</button>
          <button disabled={!snapshot.capabilities.canControlPlayback} type="button">{playing?.isPlaying ? "Pause" : "Play"}</button>
          <button disabled={!snapshot.capabilities.canControlPlayback} type="button">Next</button>
        </div>
        <div className="volume-row">
          <span>Volume</span>
          <meter min="0" max="100" value={snapshot.health.volume.value ?? 0} />
          <strong>{snapshot.health.volume.status === "out_of_sync" ? "Out of sync" : `${snapshot.health.volume.value ?? 0}%`}</strong>
        </div>
      </section>
    </div>
  );
}

function SettingsSurface({
  snapshot,
  spotifyAuth,
  onIdleSettingsChange,
}: {
  snapshot: AppSnapshot;
  spotifyAuth: SpotifyAuthControls;
  onIdleSettingsChange: (patch: AppSettingsPatch) => void;
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
      <SpotifyAuthPanel snapshot={snapshot} controls={spotifyAuth} context="settings" />
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

function IdleSurface({ snapshot, active = false }: { snapshot: AppSnapshot; active?: boolean }) {
  const [clockNow, setClockNow] = useState(() => new Date());
  const presentation = idlePresentation(snapshot);
  const playing = snapshot.nowPlaying;
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
