from typing import Optional, Protocol

from pipzo_api.config import Settings
from pipzo_api.contract import (
    AppPhase,
    AppSettings,
    AppSnapshot,
    CapabilityState,
    DiagnosticsSummary,
    DisplayHealth,
    HealthState,
    IdleMode,
    KioskBootPhase,
    KioskHealth,
    NetworkReason,
    NetworkStatus,
    PlaybackDeviceHealth,
    PlaybackDeviceReason,
    PlaybackDeviceStatus,
    ReadinessState,
    RecoveryAction,
    RecoveryActionKind,
    RecoveryActionState,
    SetupState,
    SetupStep,
    SetupStepId,
    SetupStepStatus,
    SpeakerHealth,
    SpeakerReason,
    SpeakerStatus,
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
    utc_now,
)
from pipzo_api.mock_scenarios import MockScenarioStore

from .production import ProductionAdapters, ProductionAdapterNotImplemented


class AppStateAdapter(Protocol):
    def get_snapshot(self) -> AppSnapshot:
        raise NotImplementedError


class MockAppStateAdapter:
    def __init__(self, mock_store: MockScenarioStore) -> None:
        self._mock_store = mock_store

    def get_snapshot(self) -> AppSnapshot:
        return self._mock_store.get_snapshot()


class ProductionAppStateAdapter:
    def __init__(self, adapters: ProductionAdapters) -> None:
        self._adapters = adapters

    def get_snapshot(self) -> AppSnapshot:
        try:
            network = self._adapters.network.status()
        except ProductionAdapterNotImplemented:
            raise
        except Exception:
            network = self._network_error()

        network_ready = network.status in {NetworkStatus.ONLINE, NetworkStatus.LOCAL_ONLY}
        minimum_ready = False
        now = utc_now()
        return AppSnapshot(
            app_phase=AppPhase.SETUP,
            setup=SetupState(blocking_step=SetupStepId.SPOTIFY_AUTH if network_ready else SetupStepId.WIFI, steps=self._setup_steps(network_ready)),
            readiness=ReadinessState(
                network_configured=network_ready,
                spotify_authorized=False,
                primary_speaker_saved=False,
                playback_test_passed=False,
                minimum_ready=minimum_ready,
            ),
            health=HealthState(
                network=network,
                spotify_auth=SpotifyAuthHealth(status=SpotifyAuthStatus.NONE, reason=SpotifyAuthReason.NO_SESSION),
                speaker=SpeakerHealth(status=SpeakerStatus.NONE_SAVED, reason=SpeakerReason.PRIMARY_MISSING),
                playback_device=PlaybackDeviceHealth(status=PlaybackDeviceStatus.UNAVAILABLE, reason=PlaybackDeviceReason.AUTH_REQUIRED),
                volume=VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.BLUETOOTH_SINK_MISSING),
                display=DisplayHealth(status="normal", brightness=80),
                kiosk=KioskHealth(phase=KioskBootPhase.APP_READY),
            ),
            surfaces=SurfaceState(
                current=SurfaceId.SETUP,
                route="/setup/spotify" if network_ready else "/setup/wifi",
                idle_mode=IdleMode.CLOCK,
            ),
            warnings=[] if network.status == NetworkStatus.ONLINE else [self._network_warning(network)],
            capabilities=CapabilityState(
                can_browse=False,
                can_search=False,
                can_start_playback=False,
                can_control_playback=False,
                can_control_volume=False,
                can_use_sleep_timer=False,
                can_run_diagnostics=True,
            ),
            diagnostics=DiagnosticsSummary(generated_at=now),
            recovery_actions=[
                RecoveryAction(
                    id="retry-internet-probe" if network_ready else "connect-wifi",
                    kind=RecoveryActionKind.CONNECT_WIFI,
                    state=RecoveryActionState.AVAILABLE,
                    reason=network.reason,
                    requires_confirmation=False,
                )
            ],
            settings=AppSettings(),
            staleness=StalenessState(is_stale=network.status != NetworkStatus.ONLINE, stale_since=now if network.status != NetworkStatus.ONLINE else None),
            updated_at=now,
        )

    def _setup_steps(self, network_ready: bool) -> list[SetupStep]:
        blocking = SetupStepId.SPOTIFY_AUTH if network_ready else SetupStepId.WIFI
        order = [
            SetupStepId.WELCOME,
            SetupStepId.WIFI,
            SetupStepId.SPOTIFY_AUTH,
            SetupStepId.SPEAKER,
            SetupStepId.PLAYBACK_TEST,
            SetupStepId.COMPLETE,
        ]
        blocked = False
        steps: list[SetupStep] = []
        for step_id in order:
            if step_id == blocking:
                blocked = True
                step_status = SetupStepStatus.ACTION_REQUIRED
            elif blocked:
                step_status = SetupStepStatus.BLOCKED
            else:
                step_status = SetupStepStatus.READY
            steps.append(SetupStep(id=step_id, status=step_status, required=step_id != SetupStepId.WELCOME))
        return steps

    def _network_warning(self, network) -> Warning:
        code = WarningCode.NETWORK_LOCAL_ONLY if network.status == NetworkStatus.LOCAL_ONLY else WarningCode.NETWORK_OFFLINE
        return Warning(code=code, reason=network.reason, surface=SurfaceId.SETUP, action="connect_wifi")

    def _network_error(self):
        from pipzo_api.contract import NetworkHealth

        return NetworkHealth(status=NetworkStatus.ERROR, reason=NetworkReason.UNKNOWN, internet_reachable=False)


def create_app_state_adapter(settings: Settings, mock_store: MockScenarioStore, production_adapters: Optional[ProductionAdapters] = None) -> AppStateAdapter:
    if settings.app_mode == "mock":
        return MockAppStateAdapter(mock_store)
    return ProductionAppStateAdapter(production_adapters or ProductionAdapters())
