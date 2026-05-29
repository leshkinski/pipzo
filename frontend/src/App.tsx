import { useEffect, useMemo, useState } from "react";

import { activateBackendScenario, fetchAppState, fetchBackendScenarios } from "./api";
import type { AppSnapshot, ScenarioSummary, SurfaceId } from "./contracts";
import { localScenarioSnapshot, localScenarioSummaries } from "./localScenarios";
import { canOpenSurface, formatMs, isSetupGated, labelFromId, preferredSurface, primarySurfaces } from "./viewModel";

type DataSource = "backend" | "local";

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

  const gated = isSetupGated(snapshot);
  const activeSurface = gated ? "setup" : selectedSurface;
  const visibleWarnings = snapshot.warnings;
  const currentScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenario),
    [scenarios, selectedScenario],
  );

  async function switchScenario(scenarioId: string) {
    setSelectedScenario(scenarioId);
    if (dataSource === "backend" && !["idle_clock", "idle_with_artwork"].includes(scenarioId)) {
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

  return (
    <div className={`app phase-${snapshot.appPhase}`}>
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
        onChange={switchScenario}
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
          {activeSurface === "setup" && <SetupSurface snapshot={snapshot} />}
          {activeSurface === "home" && <HomeSurface snapshot={snapshot} />}
          {activeSurface === "browse" && <BrowseSurface snapshot={snapshot} />}
          {activeSurface === "now_playing" && <NowPlayingSurface snapshot={snapshot} />}
          {activeSurface === "settings" && <SettingsSurface snapshot={snapshot} />}
          {activeSurface === "idle" && <IdleSurface snapshot={snapshot} />}
        </section>
      </main>
    </div>
  );
}

function DeveloperPanel(props: {
  scenarios: ScenarioSummary[];
  selectedScenario: string;
  currentScenario?: ScenarioSummary;
  dataSource: DataSource;
  onChange: (scenarioId: string) => void;
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
      <p>{props.currentScenario?.description}</p>
    </section>
  );
}

function SetupSurface({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="surface-grid">
      <section className="hero-panel">
        <p className="eyebrow">First run setup</p>
        <h1>{snapshot.appPhase === "starting" ? "Checking Pipzo hardware" : "Finish setup before music starts"}</h1>
        <p>
          Current blocker: <strong>{labelFromId(snapshot.setup.blockingStep)}</strong>
        </p>
      </section>
      <section className="checklist">
        {snapshot.setup.steps.map((step) => (
          <div className={`step step-${step.status}`} key={step.id}>
            <div>
              <strong>{labelFromId(step.id)}</strong>
              <span>{step.required ? "Required" : "Intro"}</span>
            </div>
            <b>{labelFromId(step.status)}</b>
          </div>
        ))}
      </section>
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

function SettingsSurface({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="settings-layout">
      <section className="hero-panel">
        <p className="eyebrow">Settings and recovery</p>
        <h1>{snapshot.appPhase === "degraded" ? "Recovery mode is available" : "Device settings"}</h1>
        <p>{snapshot.surfaces.returnSurface ? `Return target: ${labelFromId(snapshot.surfaces.returnSurface)}` : "App reset is separate from Wi-Fi and speaker forget actions."}</p>
      </section>
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

function IdleSurface({ snapshot }: { snapshot: AppSnapshot }) {
  const artwork = snapshot.settings.artworkInIdle || snapshot.surfaces.idleMode === "clock_with_artwork";
  return (
    <div className={`idle-surface ${artwork ? "with-art" : ""}`}>
      <div className="clock">{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date())}</div>
      {artwork && <div className="idle-art">{snapshot.nowPlaying?.title?.slice(0, 1) ?? "P"}</div>}
      <p>{snapshot.nowPlaying ? `${snapshot.nowPlaying.title} / ${snapshot.nowPlaying.artist}` : "Clock-first idle mode"}</p>
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
