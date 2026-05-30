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
from .volume import VolumeCommandError, VolumeUnavailable


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
        try:
            speaker = self._adapters.bluetooth.status()
        except ProductionAdapterNotImplemented:
            speaker = SpeakerHealth(status=SpeakerStatus.ERROR, reason=SpeakerReason.ADAPTER_UNAVAILABLE)
        except Exception:
            speaker = SpeakerHealth(status=SpeakerStatus.ERROR, reason=SpeakerReason.UNKNOWN)
        try:
            volume = self._adapters.volume.status()
        except ProductionAdapterNotImplemented:
            volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.OS_SINK_MISSING)
        except VolumeUnavailable as exc:
            volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=exc.reason)
        except VolumeCommandError as exc:
            volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=exc.reason)
        except Exception:
            volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.UNKNOWN)

        network_ready = network.status in {NetworkStatus.ONLINE, NetworkStatus.LOCAL_ONLY}
        speaker_ready = speaker.status == SpeakerStatus.CONNECTED
        if not speaker_ready:
            volume = VolumeHealth(status=VolumeStatus.UNAVAILABLE, reason=VolumeReason.BLUETOOTH_SINK_MISSING)
        volume_ready = speaker_ready and volume.status != VolumeStatus.UNAVAILABLE
        minimum_ready = False
        now = utc_now()
        return AppSnapshot(
            app_phase=AppPhase.SETUP,
            setup=SetupState(blocking_step=self._blocking_step(network_ready, False, speaker_ready, False), steps=self._setup_steps(network_ready, False, speaker_ready, False)),
            readiness=ReadinessState(
                network_configured=network_ready,
                spotify_authorized=False,
                primary_speaker_saved=speaker_ready,
                playback_test_passed=False,
                minimum_ready=minimum_ready,
            ),
            health=HealthState(
                network=network,
                spotify_auth=SpotifyAuthHealth(status=SpotifyAuthStatus.NONE, reason=SpotifyAuthReason.NO_SESSION),
                speaker=speaker,
                playback_device=PlaybackDeviceHealth(
                    status=PlaybackDeviceStatus.UNAVAILABLE,
                    reason=PlaybackDeviceReason.AUTH_REQUIRED if not network_ready else PlaybackDeviceReason.SPEAKER_UNAVAILABLE,
                ),
                volume=volume,
                display=DisplayHealth(status="normal", brightness=80),
                kiosk=KioskHealth(phase=KioskBootPhase.APP_READY),
            ),
            surfaces=SurfaceState(
                current=SurfaceId.SETUP,
                route=self._route_for_blocking(self._blocking_step(network_ready, False, speaker_ready, False)),
                idle_mode=IdleMode.CLOCK,
            ),
            warnings=[] if network.status == NetworkStatus.ONLINE else [self._network_warning(network)],
            capabilities=CapabilityState(
                can_browse=False,
                can_search=False,
                can_start_playback=False,
                can_control_playback=False,
                can_control_volume=volume_ready,
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

    def _blocking_step(self, network_ready: bool, spotify_ready: bool, speaker_ready: bool, playback_ready: bool) -> SetupStepId:
        if not network_ready:
            return SetupStepId.WIFI
        if not spotify_ready:
            return SetupStepId.SPOTIFY_AUTH
        if not speaker_ready:
            return SetupStepId.SPEAKER
        if not playback_ready:
            return SetupStepId.PLAYBACK_TEST
        return SetupStepId.NONE

    def _route_for_blocking(self, blocking: SetupStepId) -> str:
        routes = {
            SetupStepId.WIFI: "/setup/wifi",
            SetupStepId.SPOTIFY_AUTH: "/setup/spotify",
            SetupStepId.SPEAKER: "/setup/speaker",
            SetupStepId.PLAYBACK_TEST: "/setup/playback-test",
            SetupStepId.NONE: "/",
        }
        return routes.get(blocking, "/setup")

    def _setup_steps(self, network_ready: bool, spotify_ready: bool, speaker_ready: bool, playback_ready: bool) -> list[SetupStep]:
        blocking = self._blocking_step(network_ready, spotify_ready, speaker_ready, playback_ready)
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
