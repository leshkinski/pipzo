from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, use_enum_values=True)


class AppPhase(str, Enum):
    STARTING = "starting"
    SETUP = "setup"
    READY = "ready"
    DEGRADED = "degraded"


class SetupStepId(str, Enum):
    WELCOME = "welcome"
    WIFI = "wifi"
    SPOTIFY_AUTH = "spotify_auth"
    SPEAKER = "speaker"
    PLAYBACK_TEST = "playback_test"
    COMPLETE = "complete"
    NONE = "none"


class SetupStepStatus(str, Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    ACTION_REQUIRED = "action_required"
    READY = "ready"
    BLOCKED = "blocked"


class SurfaceId(str, Enum):
    SETUP = "setup"
    HOME = "home"
    BROWSE = "browse"
    NOW_PLAYING = "now_playing"
    SETTINGS = "settings"
    IDLE = "idle"


class IdleMode(str, Enum):
    OFF = "off"
    CLOCK = "clock"
    CLOCK_WITH_ARTWORK = "clock_with_artwork"


class RecoveryActionState(str, Enum):
    AVAILABLE = "available"
    CONFIRM_REQUIRED = "confirm_required"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"


class NetworkStatus(str, Enum):
    STARTING = "starting"
    ONLINE = "online"
    LOCAL_ONLY = "local_only"
    OFFLINE = "offline"
    DISABLED = "disabled"
    ERROR = "error"


class NetworkReason(str, Enum):
    BOOT_PROBE_PENDING = "boot_probe_pending"
    NO_WIFI_DEVICE = "no_wifi_device"
    WIFI_RADIO_DISABLED = "wifi_radio_disabled"
    NO_KNOWN_NETWORK = "no_known_network"
    SCAN_EMPTY = "scan_empty"
    BAD_CREDENTIALS = "bad_credentials"
    ASSOCIATION_FAILED = "association_failed"
    DHCP_FAILED = "dhcp_failed"
    DNS_FAILED = "dns_failed"
    INTERNET_PROBE_FAILED = "internet_probe_failed"
    CAPTIVE_PORTAL_SUSPECTED = "captive_portal_suspected"
    USER_SWITCHING_NETWORK = "user_switching_network"
    UNKNOWN = "unknown"


class SpeakerStatus(str, Enum):
    STARTING = "starting"
    NONE_SAVED = "none_saved"
    SCANNING = "scanning"
    PAIRING = "pairing"
    CONNECTED = "connected"
    SAVED_DISCONNECTED = "saved_disconnected"
    RECONNECTING = "reconnecting"
    FORGETTING = "forgetting"
    ERROR = "error"


class SpeakerReason(str, Enum):
    BOOT_PROBE_PENDING = "boot_probe_pending"
    BLUETOOTH_DISABLED = "bluetooth_disabled"
    ADAPTER_UNAVAILABLE = "adapter_unavailable"
    SCAN_EMPTY = "scan_empty"
    DEVICE_OUT_OF_RANGE = "device_out_of_range"
    PAIR_REJECTED = "pair_rejected"
    PAIR_TIMEOUT = "pair_timeout"
    CONNECT_FAILED = "connect_failed"
    AUDIO_PROFILE_UNAVAILABLE = "audio_profile_unavailable"
    PRIMARY_MISSING = "primary_missing"
    USER_FORGOT = "user_forgot"
    UNKNOWN = "unknown"


class PlaybackDeviceStatus(str, Enum):
    STARTING = "starting"
    AVAILABLE = "available"
    REGISTERING = "registering"
    TRANSFER_REQUIRED = "transfer_required"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


class PlaybackDeviceReason(str, Enum):
    CHROMIUM_NOT_READY = "chromium_not_ready"
    SDK_NOT_READY = "sdk_not_ready"
    PREMIUM_REQUIRED = "premium_required"
    AUTH_REQUIRED = "auth_required"
    DEVICE_NOT_REGISTERED = "device_not_registered"
    TRANSFER_FAILED = "transfer_failed"
    SPOTIFY_API_ERROR = "spotify_api_error"
    NETWORK_UNAVAILABLE = "network_unavailable"
    SPEAKER_UNAVAILABLE = "speaker_unavailable"
    UNKNOWN = "unknown"


class VolumeStatus(str, Enum):
    UNIFIED = "unified"
    SPOTIFY_ONLY = "spotify_only"
    OS_ONLY = "os_only"
    WRITE_ONLY = "write_only"
    OUT_OF_SYNC = "out_of_sync"
    UNAVAILABLE = "unavailable"


class VolumeReason(str, Enum):
    BOOT_PROBE_PENDING = "boot_probe_pending"
    SPOTIFY_VOLUME_UNSUPPORTED = "spotify_volume_unsupported"
    OS_SINK_MISSING = "os_sink_missing"
    BLUETOOTH_SINK_MISSING = "bluetooth_sink_missing"
    READBACK_MISMATCH = "readback_mismatch"
    RECONNECT_RESYNC_NEEDED = "reconnect_resync_needed"
    PERMISSION_DENIED = "permission_denied"
    UNKNOWN = "unknown"


class SpotifyAuthStatus(str, Enum):
    STARTING = "starting"
    NONE = "none"
    WAITING = "waiting"
    CONNECTED = "connected"
    EXPIRED = "expired"
    RECONNECT_REQUIRED = "reconnect_required"
    ERROR = "error"


class SpotifyAuthReason(str, Enum):
    BOOT_PROBE_PENDING = "boot_probe_pending"
    NO_SESSION = "no_session"
    OAUTH_PENDING = "oauth_pending"
    OAUTH_EXPIRED = "oauth_expired"
    TOKEN_REFRESH_FAILED = "token_refresh_failed"
    REVOKED = "revoked"
    PREMIUM_REQUIRED = "premium_required"
    NETWORK_UNAVAILABLE = "network_unavailable"
    UNKNOWN = "unknown"


class KioskBootPhase(str, Enum):
    SYSTEM_BOOTING = "system_booting"
    BACKEND_STARTING = "backend_starting"
    FRONTEND_LOADING = "frontend_loading"
    ADAPTERS_PROBING = "adapters_probing"
    APP_READY = "app_ready"


class WarningCode(str, Enum):
    NETWORK_OFFLINE = "network_offline"
    NETWORK_LOCAL_ONLY = "network_local_only"
    SPOTIFY_RECONNECT_REQUIRED = "spotify_reconnect_required"
    SPEAKER_DISCONNECTED = "speaker_disconnected"
    SPEAKER_PAIR_FAILED = "speaker_pair_failed"
    PLAYBACK_DEVICE_UNAVAILABLE = "playback_device_unavailable"
    VOLUME_LIMITED = "volume_limited"
    VOLUME_OUT_OF_SYNC = "volume_out_of_sync"
    STALE_CONTENT = "stale_content"
    KIOSK_RECOVERED = "kiosk_recovered"
    DIAGNOSTICS_LIMITED = "diagnostics_limited"


Reason = Union[NetworkReason, SpeakerReason, SpotifyAuthReason, PlaybackDeviceReason, VolumeReason]


class SetupStep(ContractModel):
    id: SetupStepId
    status: SetupStepStatus
    reason: Optional[Reason] = None
    required: bool


class SetupState(ContractModel):
    blocking_step: SetupStepId
    steps: List[SetupStep]


class ReadinessState(ContractModel):
    network_configured: bool
    spotify_authorized: bool
    primary_speaker_saved: bool
    playback_test_passed: bool
    setup_completed_at: Optional[datetime] = None
    minimum_ready: bool


class SpeakerSummary(ContractModel):
    address: str
    display_name: str
    alias: Optional[str] = None
    connected: bool


class NetworkHealth(ContractModel):
    status: NetworkStatus
    reason: Optional[NetworkReason] = None
    ssid: Optional[str] = None
    internet_reachable: Optional[bool] = None


class SpotifyAuthHealth(ContractModel):
    status: SpotifyAuthStatus
    reason: Optional[SpotifyAuthReason] = None
    account_display_name: Optional[str] = None


class SpeakerHealth(ContractModel):
    status: SpeakerStatus
    reason: Optional[SpeakerReason] = None
    primary: Optional[SpeakerSummary] = None


class PlaybackDeviceHealth(ContractModel):
    status: PlaybackDeviceStatus
    reason: Optional[PlaybackDeviceReason] = None
    device_id: Optional[str] = None


class VolumeHealth(ContractModel):
    status: VolumeStatus
    reason: Optional[VolumeReason] = None
    value: Optional[int] = Field(default=None, ge=0, le=100)
    muted: Optional[bool] = None


class KioskHealth(ContractModel):
    phase: KioskBootPhase
    last_restart_at: Optional[datetime] = None


class HealthState(ContractModel):
    network: NetworkHealth
    spotify_auth: SpotifyAuthHealth
    speaker: SpeakerHealth
    playback_device: PlaybackDeviceHealth
    volume: VolumeHealth
    kiosk: KioskHealth


class SurfaceState(ContractModel):
    current: SurfaceId
    route: Optional[str] = None
    return_surface: Optional[SurfaceId] = None
    idle_mode: IdleMode


class Warning(ContractModel):
    code: WarningCode
    reason: Optional[Reason] = None
    surface: Optional[SurfaceId] = None
    action: Optional[str] = None


class CapabilityState(ContractModel):
    can_browse: bool
    can_search: bool
    can_start_playback: bool
    can_control_playback: bool
    can_control_volume: bool
    can_use_sleep_timer: bool
    can_open_settings: Literal[True] = True
    can_run_diagnostics: bool


class DiagnosticsSummary(ContractModel):
    safe_mode: bool = True
    raw_adapter_code: Optional[str] = None
    last_command: Optional[str] = None
    last_log_ref: Optional[str] = None
    generated_at: datetime


class RecoveryActionKind(str, Enum):
    CONNECT_WIFI = "connect_wifi"
    FORGET_WIFI = "forget_wifi"
    START_SPOTIFY_AUTH = "start_spotify_auth"
    RECONNECT_SPEAKER = "reconnect_speaker"
    FORGET_SPEAKER = "forget_speaker"
    RUN_PLAYBACK_TEST = "run_playback_test"
    RETRY_PLAYBACK_DEVICE = "retry_playback_device"
    RESET_APP = "reset_app"


class RecoveryAction(ContractModel):
    id: str
    kind: RecoveryActionKind
    state: RecoveryActionState
    reason: Optional[Reason] = None
    requires_confirmation: bool
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class AppSettings(ContractModel):
    idle_mode: IdleMode = IdleMode.CLOCK
    idle_timeout_seconds: int = 300
    artwork_in_idle: bool = False
    default_sleep_timer_minutes: Optional[int] = None


class NowPlayingSummary(ContractModel):
    title: str
    artist: str
    album: Optional[str] = None
    artwork_url: Optional[str] = None
    is_playing: bool
    progress_ms: Optional[int] = None
    duration_ms: Optional[int] = None


class StalenessState(ContractModel):
    is_stale: bool
    stale_since: Optional[datetime] = None
    reason: Optional[str] = None


class AppSnapshot(ContractModel):
    app_phase: AppPhase
    setup: SetupState
    readiness: ReadinessState
    health: HealthState
    surfaces: SurfaceState
    warnings: List[Warning]
    capabilities: CapabilityState
    diagnostics: DiagnosticsSummary
    recovery_actions: List[RecoveryAction]
    settings: AppSettings
    now_playing: Optional[NowPlayingSummary] = None
    staleness: StalenessState
    updated_at: datetime
    schema_version: Literal["v1"] = "v1"


class ScenarioSummary(ContractModel):
    id: str
    label: str
    description: str


class HealthResponse(ContractModel):
    status: Literal["ok"] = "ok"
    service: Literal["pipzo-api"] = "pipzo-api"
    mode: str
    schema_version: Literal["v1"] = "v1"
    checked_at: datetime


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
