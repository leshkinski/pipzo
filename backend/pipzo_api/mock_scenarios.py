from copy import deepcopy
from typing import Callable, Dict, List, Optional

from .contract import (
    ActionResult,
    AppPhase,
    AppSettings,
    AppSettingsPatch,
    AppSnapshot,
    CapabilityState,
    DiagnosticsSummary,
    DisplayHealth,
    DisplayPatch,
    DisplayReason,
    DisplayStatus,
    HealthState,
    IdleMode,
    KioskBootPhase,
    KioskHealth,
    NetworkHealth,
    NetworkReason,
    NetworkStatus,
    NowPlayingSummary,
    PlaybackDeviceHealth,
    PlaybackDeviceReason,
    PlaybackDeviceStatus,
    ReadinessState,
    RecoveryAction,
    RecoveryActionKind,
    RecoveryActionState,
    ScenarioSummary,
    SetupState,
    SetupStep,
    SetupStepId,
    SetupStepStatus,
    SpeakerHealth,
    SpeakerDevice,
    SpeakerReason,
    SpeakerScanResults,
    SpeakerStatus,
    SpeakerSummary,
    SpotifyAuthHealth,
    SpotifyAuthReason,
    SpotifyAuthStatus,
    StalenessState,
    SurfaceId,
    SurfaceState,
    VolumeHealth,
    VolumeReason,
    VolumeStatus,
    Warning,
    WarningCode,
    WifiNetwork,
    WifiScanResults,
    WifiSecurity,
    utc_now,
)


def _setup_steps(blocking: SetupStepId) -> List[SetupStep]:
    order = [
        SetupStepId.WELCOME,
        SetupStepId.WIFI,
        SetupStepId.SPOTIFY_AUTH,
        SetupStepId.SPEAKER,
        SetupStepId.PLAYBACK_TEST,
        SetupStepId.COMPLETE,
    ]
    steps: List[SetupStep] = []
    blocked = False
    for step_id in order:
        if step_id == blocking:
            blocked = True
            status = SetupStepStatus.ACTION_REQUIRED
        elif blocked:
            status = SetupStepStatus.BLOCKED
        else:
            status = SetupStepStatus.READY
        steps.append(SetupStep(id=step_id, status=status, required=step_id != SetupStepId.WELCOME))
    return steps


def _ready_steps() -> List[SetupStep]:
    return [
        SetupStep(id=step_id, status=SetupStepStatus.READY, required=step_id != SetupStepId.WELCOME)
        for step_id in [
            SetupStepId.WELCOME,
            SetupStepId.WIFI,
            SetupStepId.SPOTIFY_AUTH,
            SetupStepId.SPEAKER,
            SetupStepId.PLAYBACK_TEST,
            SetupStepId.COMPLETE,
        ]
    ]


def _base_snapshot() -> AppSnapshot:
    now = utc_now()
    setup_done = now
    speaker = SpeakerSummary(
        address="AA:BB:CC:DD:EE:FF",
        display_name="Pipzo Speaker",
        alias="Bedroom speaker",
        connected=True,
    )
    return AppSnapshot(
        app_phase=AppPhase.READY,
        setup=SetupState(blocking_step=SetupStepId.NONE, steps=_ready_steps()),
        readiness=ReadinessState(
            network_configured=True,
            spotify_authorized=True,
            primary_speaker_saved=True,
            playback_test_passed=True,
            setup_completed_at=setup_done,
            minimum_ready=True,
        ),
        health=HealthState(
            network=NetworkHealth(status=NetworkStatus.ONLINE, ssid="PipzoNet", internet_reachable=True),
            spotify_auth=SpotifyAuthHealth(status=SpotifyAuthStatus.CONNECTED, account_display_name="Pipzo"),
            speaker=SpeakerHealth(status=SpeakerStatus.CONNECTED, primary=speaker),
            playback_device=PlaybackDeviceHealth(status=PlaybackDeviceStatus.AVAILABLE, device_id="pipzo-web-player"),
            volume=VolumeHealth(status=VolumeStatus.UNIFIED, value=42, muted=False),
            display=DisplayHealth(status=DisplayStatus.NORMAL, brightness=80),
            kiosk=KioskHealth(phase=KioskBootPhase.APP_READY),
        ),
        surfaces=SurfaceState(current=SurfaceId.HOME, route="/", idle_mode=IdleMode.CLOCK),
        warnings=[],
        capabilities=CapabilityState(
            can_browse=True,
            can_search=True,
            can_start_playback=True,
            can_control_playback=True,
            can_control_volume=True,
            can_use_sleep_timer=True,
            can_run_diagnostics=True,
        ),
        diagnostics=DiagnosticsSummary(generated_at=now),
        recovery_actions=[
            RecoveryAction(
                id="reset-app",
                kind=RecoveryActionKind.RESET_APP,
                state=RecoveryActionState.CONFIRM_REQUIRED,
                requires_confirmation=True,
            )
        ],
        settings=AppSettings(),
        now_playing=NowPlayingSummary(
            title="Bedtime Song",
            artist="Pipzo Mock",
            album="Mock Library",
            is_playing=False,
            progress_ms=12000,
            duration_ms=180000,
        ),
        staleness=StalenessState(is_stale=False),
        updated_at=now,
    )


def _first_boot_empty() -> AppSnapshot:
    snap = _base_snapshot()
    snap.app_phase = AppPhase.SETUP
    snap.setup = SetupState(blocking_step=SetupStepId.WIFI, steps=_setup_steps(SetupStepId.WIFI))
    snap.readiness = ReadinessState(
        network_configured=False,
        spotify_authorized=False,
        primary_speaker_saved=False,
        playback_test_passed=False,
        minimum_ready=False,
    )
    snap.health.network = NetworkHealth(
        status=NetworkStatus.OFFLINE,
        reason=NetworkReason.NO_KNOWN_NETWORK,
        internet_reachable=False,
    )
    snap.health.spotify_auth = SpotifyAuthHealth(status=SpotifyAuthStatus.NONE, reason=SpotifyAuthReason.NO_SESSION)
    snap.health.speaker = SpeakerHealth(status=SpeakerStatus.NONE_SAVED, reason=SpeakerReason.PRIMARY_MISSING)
    snap.health.playback_device = PlaybackDeviceHealth(
        status=PlaybackDeviceStatus.UNAVAILABLE,
        reason=PlaybackDeviceReason.AUTH_REQUIRED,
    )
    snap.health.volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.BLUETOOTH_SINK_MISSING)
    snap.surfaces = SurfaceState(current=SurfaceId.SETUP, route="/setup/wifi", idle_mode=IdleMode.CLOCK)
    snap.capabilities = CapabilityState(
        can_browse=False,
        can_search=False,
        can_start_playback=False,
        can_control_playback=False,
        can_control_volume=False,
        can_use_sleep_timer=False,
        can_run_diagnostics=True,
    )
    snap.now_playing = None
    snap.recovery_actions = [
        RecoveryAction(
            id="connect-wifi",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=RecoveryActionState.AVAILABLE,
            reason=NetworkReason.NO_KNOWN_NETWORK,
            requires_confirmation=False,
        )
    ]
    return snap


def _degraded_recovery() -> AppSnapshot:
    snap = _base_snapshot()
    snap.app_phase = AppPhase.DEGRADED
    snap.health.network = NetworkHealth(status=NetworkStatus.OFFLINE, reason=NetworkReason.INTERNET_PROBE_FAILED)
    snap.health.playback_device = PlaybackDeviceHealth(
        status=PlaybackDeviceStatus.UNAVAILABLE,
        reason=PlaybackDeviceReason.NETWORK_UNAVAILABLE,
    )
    snap.surfaces = SurfaceState(current=SurfaceId.SETTINGS, route="/settings/recovery", return_surface=SurfaceId.HOME, idle_mode=IdleMode.CLOCK)
    snap.warnings = [
        Warning(code=WarningCode.NETWORK_OFFLINE, reason=NetworkReason.INTERNET_PROBE_FAILED, surface=SurfaceId.SETTINGS),
        Warning(code=WarningCode.PLAYBACK_DEVICE_UNAVAILABLE, reason=PlaybackDeviceReason.NETWORK_UNAVAILABLE),
    ]
    snap.capabilities.can_browse = False
    snap.capabilities.can_search = False
    snap.capabilities.can_start_playback = False
    snap.capabilities.can_control_playback = False
    snap.recovery_actions = [
        RecoveryAction(
            id="retry-internet-probe",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=RecoveryActionState.AVAILABLE,
            reason=NetworkReason.INTERNET_PROBE_FAILED,
            requires_confirmation=False,
        )
    ]
    snap.staleness = StalenessState(is_stale=True, stale_since=utc_now(), reason="network_offline")
    return snap


def _offline_settings_mode() -> AppSnapshot:
    snap = _degraded_recovery()
    snap.surfaces = SurfaceState(current=SurfaceId.SETTINGS, route="/settings/network", return_surface=SurfaceId.HOME, idle_mode=IdleMode.CLOCK)
    snap.warnings = [
        Warning(code=WarningCode.NETWORK_OFFLINE, reason=NetworkReason.NO_KNOWN_NETWORK, surface=SurfaceId.SETTINGS, action="connect_wifi"),
        Warning(code=WarningCode.STALE_CONTENT, reason=PlaybackDeviceReason.NETWORK_UNAVAILABLE, surface=SurfaceId.HOME),
        Warning(code=WarningCode.PLAYBACK_DEVICE_UNAVAILABLE, reason=PlaybackDeviceReason.NETWORK_UNAVAILABLE, surface=SurfaceId.NOW_PLAYING),
    ]
    snap.recovery_actions = [
        RecoveryAction(
            id="connect-wifi",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=RecoveryActionState.AVAILABLE,
            reason=NetworkReason.NO_KNOWN_NETWORK,
            requires_confirmation=False,
        ),
        RecoveryAction(
            id="reconnect-speaker",
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=RecoveryActionState.AVAILABLE,
            requires_confirmation=False,
        ),
        RecoveryAction(
            id="reset-app",
            kind=RecoveryActionKind.RESET_APP,
            state=RecoveryActionState.CONFIRM_REQUIRED,
            requires_confirmation=True,
        ),
    ]
    return snap


def _spotify_auth_unavailable() -> AppSnapshot:
    snap = _base_snapshot()
    snap.app_phase = AppPhase.DEGRADED
    snap.health.spotify_auth = SpotifyAuthHealth(
        status=SpotifyAuthStatus.RECONNECT_REQUIRED,
        reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED,
    )
    snap.health.playback_device = PlaybackDeviceHealth(
        status=PlaybackDeviceStatus.UNAVAILABLE,
        reason=PlaybackDeviceReason.AUTH_REQUIRED,
    )
    snap.surfaces = SurfaceState(current=SurfaceId.SETTINGS, route="/settings/spotify", return_surface=SurfaceId.HOME, idle_mode=IdleMode.CLOCK)
    snap.readiness.spotify_authorized = False
    snap.readiness.minimum_ready = False
    snap.warnings = [
        Warning(code=WarningCode.SPOTIFY_RECONNECT_REQUIRED, reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED, surface=SurfaceId.SETTINGS, action="spotify_reconnect"),
        Warning(code=WarningCode.PLAYBACK_DEVICE_UNAVAILABLE, reason=PlaybackDeviceReason.AUTH_REQUIRED, surface=SurfaceId.NOW_PLAYING),
    ]
    snap.capabilities.can_browse = False
    snap.capabilities.can_search = False
    snap.capabilities.can_start_playback = False
    snap.capabilities.can_control_playback = False
    snap.recovery_actions = [
        RecoveryAction(
            id="start-spotify-auth",
            kind=RecoveryActionKind.START_SPOTIFY_AUTH,
            state=RecoveryActionState.AVAILABLE,
            reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED,
            requires_confirmation=False,
        ),
        RecoveryAction(
            id="reset-app",
            kind=RecoveryActionKind.RESET_APP,
            state=RecoveryActionState.CONFIRM_REQUIRED,
            requires_confirmation=True,
        ),
    ]
    snap.staleness = StalenessState(is_stale=True, stale_since=utc_now(), reason="spotify_reconnect_required")
    return snap


def _device_connectivity_degraded() -> AppSnapshot:
    snap = _speaker_saved_disconnected()
    snap.app_phase = AppPhase.DEGRADED
    snap.surfaces = SurfaceState(current=SurfaceId.SETTINGS, route="/settings/speaker", return_surface=SurfaceId.NOW_PLAYING, idle_mode=IdleMode.CLOCK)
    snap.capabilities.can_browse = True
    snap.capabilities.can_search = True
    snap.capabilities.can_control_volume = False
    snap.warnings = [
        Warning(code=WarningCode.SPEAKER_DISCONNECTED, reason=SpeakerReason.DEVICE_OUT_OF_RANGE, surface=SurfaceId.SETTINGS, action="reconnect_speaker"),
        Warning(code=WarningCode.PLAYBACK_DEVICE_UNAVAILABLE, reason=PlaybackDeviceReason.SPEAKER_UNAVAILABLE, surface=SurfaceId.NOW_PLAYING),
    ]
    snap.recovery_actions = [
        RecoveryAction(
            id="reconnect-speaker",
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=RecoveryActionState.AVAILABLE,
            reason=SpeakerReason.DEVICE_OUT_OF_RANGE,
            requires_confirmation=False,
        ),
        RecoveryAction(
            id="forget-speaker",
            kind=RecoveryActionKind.FORGET_SPEAKER,
            state=RecoveryActionState.CONFIRM_REQUIRED,
            reason=SpeakerReason.DEVICE_OUT_OF_RANGE,
            requires_confirmation=True,
        ),
        RecoveryAction(
            id="reset-app",
            kind=RecoveryActionKind.RESET_APP,
            state=RecoveryActionState.CONFIRM_REQUIRED,
            requires_confirmation=True,
        ),
    ]
    return snap


def _speaker_saved_disconnected() -> AppSnapshot:
    snap = _base_snapshot()
    assert snap.health.speaker.primary is not None
    snap.health.speaker.primary.connected = False
    snap.health.speaker.status = SpeakerStatus.SAVED_DISCONNECTED
    snap.health.speaker.reason = SpeakerReason.DEVICE_OUT_OF_RANGE
    snap.health.playback_device = PlaybackDeviceHealth(
        status=PlaybackDeviceStatus.UNAVAILABLE,
        reason=PlaybackDeviceReason.SPEAKER_UNAVAILABLE,
    )
    snap.warnings = [Warning(code=WarningCode.SPEAKER_DISCONNECTED, reason=SpeakerReason.DEVICE_OUT_OF_RANGE)]
    snap.capabilities.can_start_playback = False
    snap.capabilities.can_control_playback = False
    snap.recovery_actions = [
        RecoveryAction(
            id="reconnect-speaker",
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=RecoveryActionState.AVAILABLE,
            reason=SpeakerReason.DEVICE_OUT_OF_RANGE,
            requires_confirmation=False,
        )
    ]
    return snap


def _wifi_local_only() -> AppSnapshot:
    snap = _base_snapshot()
    snap.app_phase = AppPhase.DEGRADED
    snap.health.network = NetworkHealth(
        status=NetworkStatus.LOCAL_ONLY,
        reason=NetworkReason.INTERNET_PROBE_FAILED,
        ssid="PipzoNet",
        internet_reachable=False,
    )
    snap.warnings = [Warning(code=WarningCode.NETWORK_LOCAL_ONLY, reason=NetworkReason.INTERNET_PROBE_FAILED)]
    snap.capabilities.can_browse = False
    snap.capabilities.can_search = False
    snap.capabilities.can_start_playback = False
    return snap


def _volume_out_of_sync() -> AppSnapshot:
    snap = _base_snapshot()
    snap.health.volume = VolumeHealth(status=VolumeStatus.OUT_OF_SYNC, reason=VolumeReason.READBACK_MISMATCH, value=42, muted=False)
    snap.warnings = [Warning(code=WarningCode.VOLUME_OUT_OF_SYNC, reason=VolumeReason.READBACK_MISMATCH)]
    return snap


def _boot_probe_delayed() -> AppSnapshot:
    snap = _first_boot_empty()
    snap.app_phase = AppPhase.STARTING
    snap.setup = SetupState(blocking_step=SetupStepId.NONE, steps=_setup_steps(SetupStepId.COMPLETE))
    snap.health.network = NetworkHealth(status=NetworkStatus.STARTING, reason=NetworkReason.BOOT_PROBE_PENDING)
    snap.health.spotify_auth = SpotifyAuthHealth(status=SpotifyAuthStatus.STARTING, reason=SpotifyAuthReason.BOOT_PROBE_PENDING)
    snap.health.speaker = SpeakerHealth(status=SpeakerStatus.STARTING, reason=SpeakerReason.BOOT_PROBE_PENDING)
    snap.health.playback_device = PlaybackDeviceHealth(status=PlaybackDeviceStatus.STARTING, reason=PlaybackDeviceReason.SDK_NOT_READY)
    snap.health.volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.BOOT_PROBE_PENDING)
    snap.health.display = DisplayHealth(status=DisplayStatus.UNAVAILABLE, reason=DisplayReason.BOOT_PROBE_PENDING, brightness=0)
    snap.health.kiosk = KioskHealth(phase=KioskBootPhase.ADAPTERS_PROBING)
    snap.surfaces = SurfaceState(current=SurfaceId.SETUP, route="/starting", idle_mode=IdleMode.CLOCK)
    snap.warnings = []
    snap.recovery_actions = []
    return snap


def _idle_clock() -> AppSnapshot:
    snap = _base_snapshot()
    snap.surfaces = SurfaceState(current=SurfaceId.IDLE, route="/idle", idle_mode=IdleMode.CLOCK)
    snap.settings = AppSettings(
        idle_mode=IdleMode.CLOCK,
        artwork_in_idle=False,
        default_sleep_timer_minutes=30,
        brightness=45,
    )
    snap.health.display = DisplayHealth(status=DisplayStatus.DIMMED, reason=DisplayReason.IDLE, brightness=45)
    return snap


def _idle_with_artwork() -> AppSnapshot:
    snap = _idle_clock()
    snap.surfaces.idle_mode = IdleMode.CLOCK_WITH_ARTWORK
    snap.settings.idle_mode = IdleMode.CLOCK_WITH_ARTWORK
    snap.settings.artwork_in_idle = True
    snap.settings.brightness = 65
    if snap.now_playing is not None:
        snap.now_playing.is_playing = True
    snap.health.display = DisplayHealth(status=DisplayStatus.NORMAL, reason=DisplayReason.IDLE, brightness=65)
    return snap


def _dimmed_bedtime() -> AppSnapshot:
    snap = _idle_clock()
    snap.settings.bedtime_brightness = 12
    snap.health.display = DisplayHealth(
        status=DisplayStatus.DIMMED,
        reason=DisplayReason.BEDTIME,
        brightness=snap.settings.bedtime_brightness,
    )
    return snap


SCENARIO_FACTORIES: Dict[str, Callable[[], AppSnapshot]] = {
    "first_boot_empty": _first_boot_empty,
    "ready_healthy": _base_snapshot,
    "degraded_recovery": _degraded_recovery,
    "offline_settings_mode": _offline_settings_mode,
    "spotify_auth_unavailable": _spotify_auth_unavailable,
    "device_connectivity_degraded": _device_connectivity_degraded,
    "speaker_saved_disconnected": _speaker_saved_disconnected,
    "wifi_local_only": _wifi_local_only,
    "volume_out_of_sync": _volume_out_of_sync,
    "boot_probe_delayed": _boot_probe_delayed,
    "idle_clock": _idle_clock,
    "idle_with_artwork": _idle_with_artwork,
    "dimmed_bedtime": _dimmed_bedtime,
}


SCENARIO_LABELS: Dict[str, str] = {
    "first_boot_empty": "First boot empty",
    "ready_healthy": "Ready and healthy",
    "degraded_recovery": "Degraded recovery",
    "offline_settings_mode": "Offline settings mode",
    "spotify_auth_unavailable": "Spotify auth unavailable",
    "device_connectivity_degraded": "Device connectivity degraded",
    "speaker_saved_disconnected": "Saved speaker disconnected",
    "wifi_local_only": "Wi-Fi local only",
    "volume_out_of_sync": "Volume out of sync",
    "boot_probe_delayed": "Boot probe delayed",
    "idle_clock": "Idle clock",
    "idle_with_artwork": "Idle with artwork",
    "dimmed_bedtime": "Dimmed bedtime",
}


SCENARIO_DESCRIPTIONS: Dict[str, str] = {
    "first_boot_empty": "No Wi-Fi, Spotify session, speaker, or playback test readiness exists yet.",
    "ready_healthy": "Setup is complete and all core adapters are healthy.",
    "degraded_recovery": "Setup was completed earlier, but network loss blocks playback and browse.",
    "offline_settings_mode": "Internet is unavailable, but Settings, Wi-Fi, Bluetooth, and reset recovery stay reachable.",
    "spotify_auth_unavailable": "Spotify auth needs reconnect while local device settings remain usable.",
    "device_connectivity_degraded": "The network and Spotify are available, but the saved Bluetooth speaker is disconnected.",
    "speaker_saved_disconnected": "A primary speaker is saved but currently not connected.",
    "wifi_local_only": "The Pi is connected to Wi-Fi without internet reachability.",
    "volume_out_of_sync": "Spotify and OS/Bluetooth volume readback disagree.",
    "boot_probe_delayed": "Backend is up while adapters are still in the boot probing window.",
    "idle_clock": "Clock-first bedside idle mode with artwork disabled.",
    "idle_with_artwork": "Optional richer idle mode when artwork is enabled in settings.",
    "dimmed_bedtime": "Bedtime display state with a lower mock brightness level.",
}


class MockScenarioStore:
    def __init__(self, initial_scenario: str = "first_boot_empty") -> None:
        self._scenario_id = initial_scenario
        self._snapshot = SCENARIO_FACTORIES[initial_scenario]()

    @property
    def scenario_id(self) -> str:
        return self._scenario_id

    def list_scenarios(self) -> List[ScenarioSummary]:
        return [
            ScenarioSummary(id=scenario_id, label=SCENARIO_LABELS[scenario_id], description=SCENARIO_DESCRIPTIONS[scenario_id])
            for scenario_id in SCENARIO_FACTORIES
        ]

    def get_snapshot(self) -> AppSnapshot:
        snap = deepcopy(self._snapshot)
        now = utc_now()
        snap.updated_at = now
        snap.diagnostics.generated_at = now
        return snap

    def activate(self, scenario_id: str) -> AppSnapshot:
        if scenario_id not in SCENARIO_FACTORIES:
            raise KeyError(scenario_id)
        self._scenario_id = scenario_id
        self._snapshot = SCENARIO_FACTORIES[scenario_id]()
        return self.get_snapshot()

    def start_setup(self) -> SetupState:
        self._snapshot.app_phase = AppPhase.SETUP
        self._snapshot.surfaces = SurfaceState(current=SurfaceId.SETUP, route="/setup/wifi", idle_mode=self._snapshot.settings.idle_mode)
        return self.get_snapshot().setup

    def complete_setup(self) -> AppSnapshot:
        if not self._snapshot.readiness.minimum_ready:
            raise ValueError("Setup cannot complete until minimum readiness is true")
        now = utc_now()
        self._snapshot.app_phase = AppPhase.READY
        self._snapshot.setup = SetupState(blocking_step=SetupStepId.NONE, steps=_ready_steps())
        self._snapshot.readiness.setup_completed_at = now
        self._snapshot.surfaces.current = SurfaceId.HOME
        self._snapshot.surfaces.route = "/"
        self._snapshot.updated_at = now
        return self.get_snapshot()

    def get_settings(self) -> AppSettings:
        return self.get_snapshot().settings

    def apply_settings(self, settings: AppSettings) -> None:
        self._snapshot.settings = settings
        self._snapshot.surfaces.idle_mode = settings.idle_mode
        self._snapshot.health.display.brightness = settings.brightness
        self._snapshot.updated_at = utc_now()

    def patch_settings(self, patch: AppSettingsPatch) -> AppSettings:
        current = self._snapshot.settings.model_dump()
        updates = patch.model_dump(exclude_unset=True)
        current.update(updates)
        self._snapshot.settings = AppSettings.model_validate(current)
        self._snapshot.surfaces.idle_mode = self._snapshot.settings.idle_mode
        if "brightness" in updates:
            self._snapshot.health.display.brightness = self._snapshot.settings.brightness
            self._snapshot.health.display.reason = DisplayReason.USER_SETTING
        self._snapshot.updated_at = utc_now()
        return self.get_snapshot().settings

    def patch_display(self, patch: DisplayPatch) -> DisplayHealth:
        if patch.brightness is not None:
            self._snapshot.health.display.brightness = patch.brightness
            self._snapshot.settings.brightness = patch.brightness
        if patch.status is not None:
            self._snapshot.health.display.status = patch.status
        self._snapshot.health.display.reason = DisplayReason.USER_SETTING
        self._snapshot.updated_at = utc_now()
        return self.get_snapshot().health.display

    def network_status(self) -> NetworkHealth:
        return self.get_snapshot().health.network

    def scan_network(self) -> RecoveryAction:
        now = utc_now()
        return RecoveryAction(
            id="network-scan",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def network_scan_results(self) -> WifiScanResults:
        networks = [
            WifiNetwork(ssid="PipzoNet", signal=92, security=WifiSecurity.WPA2, known=self._snapshot.readiness.network_configured),
            WifiNetwork(ssid="Grandma WiFi", signal=68, security=WifiSecurity.WPA2, known=False),
            WifiNetwork(ssid="Open Setup Lab", signal=41, security=WifiSecurity.OPEN, known=False),
        ]
        if self._snapshot.health.network.reason == NetworkReason.SCAN_EMPTY:
            networks = []
        return WifiScanResults(networks=networks, scanned_at=utc_now())

    def connect_network(self, ssid: str, password: Optional[str], hidden: bool = False) -> RecoveryAction:
        now = utc_now()
        if ssid == "Bad Password" or password == "wrong":
            self._snapshot.health.network = NetworkHealth(
                status=NetworkStatus.OFFLINE,
                reason=NetworkReason.BAD_CREDENTIALS,
                internet_reachable=False,
            )
            return RecoveryAction(
                id="network-connect",
                kind=RecoveryActionKind.CONNECT_WIFI,
                state=RecoveryActionState.FAILED,
                reason=NetworkReason.BAD_CREDENTIALS,
                requires_confirmation=False,
                started_at=now,
                completed_at=now,
            )
        self._snapshot.health.network = NetworkHealth(status=NetworkStatus.ONLINE, ssid=ssid, internet_reachable=True)
        self._snapshot.readiness.network_configured = True
        if self._snapshot.setup.blocking_step == SetupStepId.WIFI:
            self._snapshot.setup = SetupState(blocking_step=SetupStepId.SPOTIFY_AUTH, steps=_setup_steps(SetupStepId.SPOTIFY_AUTH))
        self._snapshot.updated_at = now
        return RecoveryAction(
            id="network-connect",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def forget_network(self, ssid: str) -> RecoveryAction:
        now = utc_now()
        self._snapshot.health.network = NetworkHealth(
            status=NetworkStatus.OFFLINE,
            reason=NetworkReason.NO_KNOWN_NETWORK,
            internet_reachable=False,
        )
        self._snapshot.readiness.network_configured = False
        self._snapshot.setup = SetupState(blocking_step=SetupStepId.WIFI, steps=_setup_steps(SetupStepId.WIFI))
        self._snapshot.updated_at = now
        return RecoveryAction(
            id="network-forget",
            kind=RecoveryActionKind.FORGET_WIFI,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def retry_internet_probe(self) -> RecoveryAction:
        now = utc_now()
        if self._snapshot.health.network.status in {NetworkStatus.ONLINE, NetworkStatus.LOCAL_ONLY} and self._snapshot.health.network.ssid:
            self._snapshot.health.network = NetworkHealth(
                status=NetworkStatus.ONLINE,
                ssid=self._snapshot.health.network.ssid,
                internet_reachable=True,
            )
            self._snapshot.updated_at = now
            state = RecoveryActionState.SUCCEEDED
            reason = None
        else:
            state = RecoveryActionState.FAILED
            reason = self._snapshot.health.network.reason or NetworkReason.NO_KNOWN_NETWORK
        return RecoveryAction(
            id="network-internet-probe",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=state,
            reason=reason,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def speaker_status(self) -> SpeakerHealth:
        return self.get_snapshot().health.speaker

    def scan_speakers(self) -> RecoveryAction:
        now = utc_now()
        return RecoveryAction(
            id="speaker-scan",
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def speaker_scan_results(self) -> SpeakerScanResults:
        primary = self._snapshot.health.speaker.primary
        return SpeakerScanResults(
            devices=[
                SpeakerDevice(
                    address="AA:BB:CC:DD:EE:FF",
                    display_name="Pipzo Speaker",
                    alias="Bedroom speaker",
                    paired=bool(primary),
                    connected=self._snapshot.health.speaker.status == SpeakerStatus.CONNECTED,
                    signal=88,
                ),
                SpeakerDevice(
                    address="11:22:33:44:55:66",
                    display_name="Kitchen Speaker",
                    paired=False,
                    connected=False,
                    signal=62,
                ),
            ],
            scanned_at=utc_now(),
        )

    def pair_speaker(self, address: str, display_name: Optional[str]) -> RecoveryAction:
        now = utc_now()
        if address.upper() == "00:00:00:00:00:00":
            return RecoveryAction(
                id="speaker-pair",
                kind=RecoveryActionKind.RECONNECT_SPEAKER,
                state=RecoveryActionState.FAILED,
                reason=SpeakerReason.PAIR_REJECTED,
                requires_confirmation=False,
                started_at=now,
                completed_at=now,
            )
        speaker = SpeakerSummary(
            address=address.upper(),
            display_name=display_name or "Pipzo Speaker",
            alias=display_name,
            connected=True,
        )
        self._snapshot.health.speaker = SpeakerHealth(status=SpeakerStatus.CONNECTED, primary=speaker)
        self._snapshot.health.volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.UNKNOWN)
        self._snapshot.readiness.primary_speaker_saved = True
        self._recompute_setup_progress()
        self._snapshot.updated_at = now
        return RecoveryAction(
            id="speaker-pair",
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def reconnect_speaker(self) -> RecoveryAction:
        now = utc_now()
        primary = self._snapshot.health.speaker.primary or SpeakerSummary(
            address="AA:BB:CC:DD:EE:FF",
            display_name="Pipzo Speaker",
            alias="Bedroom speaker",
            connected=True,
        )
        primary.connected = True
        self._snapshot.health.speaker = SpeakerHealth(status=SpeakerStatus.CONNECTED, primary=primary)
        self._snapshot.readiness.primary_speaker_saved = True
        self._recompute_setup_progress()
        self._snapshot.updated_at = now
        return RecoveryAction(
            id="speaker-reconnect",
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def forget_speaker(self, address: str) -> RecoveryAction:
        now = utc_now()
        self._snapshot.health.speaker = SpeakerHealth(status=SpeakerStatus.NONE_SAVED, reason=SpeakerReason.USER_FORGOT)
        self._snapshot.health.playback_device = PlaybackDeviceHealth(
            status=PlaybackDeviceStatus.UNAVAILABLE,
            reason=PlaybackDeviceReason.SPEAKER_UNAVAILABLE,
        )
        self._snapshot.health.volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.BLUETOOTH_SINK_MISSING)
        self._snapshot.readiness.primary_speaker_saved = False
        self._snapshot.readiness.minimum_ready = False
        self._recompute_setup_progress()
        self._snapshot.updated_at = now
        return RecoveryAction(
            id="speaker-forget",
            kind=RecoveryActionKind.FORGET_SPEAKER,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def run_playback_test(self, action: str) -> RecoveryAction:
        now = utc_now()
        can_run = (
            self._snapshot.health.speaker.status == SpeakerStatus.CONNECTED
            and self._snapshot.health.spotify_auth.status == SpotifyAuthStatus.CONNECTED
        )
        state = RecoveryActionState.SUCCEEDED if can_run else RecoveryActionState.BLOCKED
        reason = None if can_run else self._snapshot.health.playback_device.reason
        if can_run and action == "start":
            self._snapshot.readiness.playback_test_passed = True
            self._recompute_setup_progress()
        return RecoveryAction(
            id="setup-playback-test",
            kind=RecoveryActionKind.RUN_PLAYBACK_TEST,
            state=state,
            reason=reason,
            requires_confirmation=False,
            started_at=now,
            completed_at=now,
        )

    def control_playback(self, action: str) -> ActionResult:
        now = utc_now()
        can_control = self._snapshot.capabilities.can_control_playback and self._snapshot.health.playback_device.status == PlaybackDeviceStatus.AVAILABLE
        if not can_control:
            return ActionResult(
                id=f"playback-{action}",
                domain="playback",
                action=action,
                state=RecoveryActionState.BLOCKED,
                reason=self._snapshot.health.playback_device.reason or PlaybackDeviceReason.UNKNOWN,
                mock=True,
                started_at=now,
                completed_at=now,
            )
        if self._snapshot.now_playing is not None:
            if action == "play":
                self._snapshot.now_playing.is_playing = True
            elif action in {"pause", "stop"}:
                self._snapshot.now_playing.is_playing = False
            elif action in {"next", "previous"}:
                self._snapshot.now_playing.progress_ms = 0
        self._snapshot.updated_at = now
        return ActionResult(
            id=f"playback-{action}",
            domain="playback",
            action=action,
            state=RecoveryActionState.SUCCEEDED,
            mock=True,
            started_at=now,
            completed_at=now,
        )

    def set_volume(self, value: int, muted: bool = False) -> VolumeHealth:
        bounded = max(0, min(100, value))
        status = VolumeStatus.UNIFIED if self._snapshot.capabilities.can_control_volume else VolumeStatus.UNAVAILABLE
        reason = None if status == VolumeStatus.UNIFIED else self._snapshot.health.volume.reason or VolumeReason.UNKNOWN
        updated = VolumeHealth(
            status=status,
            reason=reason,
            value=bounded if status != VolumeStatus.UNAVAILABLE else self._snapshot.health.volume.value,
            muted=muted if status != VolumeStatus.UNAVAILABLE else self._snapshot.health.volume.muted,
        )
        self._snapshot.health.volume = updated
        self._snapshot.updated_at = utc_now()
        return updated

    def list_recovery_actions(self) -> List[RecoveryAction]:
        return self.get_snapshot().recovery_actions

    def run_recovery_action(self, action_id: str, confirm: bool) -> RecoveryAction:
        action = next((item for item in self._snapshot.recovery_actions if item.id == action_id), None)
        if action is None:
            raise KeyError(action_id)
        if action.requires_confirmation and not confirm:
            return action.model_copy(update={"state": RecoveryActionState.CONFIRM_REQUIRED})

        now = utc_now()
        completed = action.model_copy(update={"state": RecoveryActionState.SUCCEEDED, "started_at": now, "completed_at": now})
        if action_id == "reset-app":
            self._scenario_id = "first_boot_empty"
            self._snapshot = _first_boot_empty()
        elif action_id in {"reconnect-speaker", "retry-internet-probe", "connect-wifi"}:
            self._scenario_id = "ready_healthy"
            self._snapshot = _base_snapshot()
        return completed

    def _recompute_setup_progress(self) -> None:
        speaker_ready = self._snapshot.health.speaker.status == SpeakerStatus.CONNECTED
        self._snapshot.readiness.minimum_ready = (
            self._snapshot.readiness.network_configured
            and self._snapshot.readiness.spotify_authorized
            and speaker_ready
            and self._snapshot.readiness.playback_test_passed
        )
        if not self._snapshot.readiness.network_configured:
            blocking = SetupStepId.WIFI
        elif not self._snapshot.readiness.spotify_authorized:
            blocking = SetupStepId.SPOTIFY_AUTH
        elif not speaker_ready:
            blocking = SetupStepId.SPEAKER
        elif not self._snapshot.readiness.playback_test_passed:
            blocking = SetupStepId.PLAYBACK_TEST
        else:
            blocking = SetupStepId.NONE
        self._snapshot.setup = SetupState(blocking_step=blocking, steps=_ready_steps() if blocking == SetupStepId.NONE else _setup_steps(blocking))
        if blocking != SetupStepId.NONE:
            self._snapshot.app_phase = AppPhase.SETUP
            self._snapshot.surfaces = SurfaceState(current=SurfaceId.SETUP, route=f"/setup/{blocking.value.replace('_auth', '')}", idle_mode=self._snapshot.settings.idle_mode)
