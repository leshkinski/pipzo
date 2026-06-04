from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    AUDIO_SESSION_UNAVAILABLE = "audio_session_unavailable"
    BLUETOOTH_SINK_MISSING = "bluetooth_sink_missing"
    READBACK_MISMATCH = "readback_mismatch"
    RECONNECT_RESYNC_NEEDED = "reconnect_resync_needed"
    PERMISSION_DENIED = "permission_denied"
    UNKNOWN = "unknown"


class DisplayStatus(str, Enum):
    NORMAL = "normal"
    DIMMED = "dimmed"
    OFF = "off"
    UNAVAILABLE = "unavailable"


class DisplayReason(str, Enum):
    IDLE = "idle"
    BEDTIME = "bedtime"
    USER_SETTING = "user_setting"
    BOOT_PROBE_PENDING = "boot_probe_pending"
    HARDWARE_UNAVAILABLE = "hardware_unavailable"
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


class SpotifyAuthSessionStatus(str, Enum):
    WAITING = "waiting"
    CALLBACK_RECEIVED = "callback_received"
    CONNECTED = "connected"
    EXPIRED = "expired"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SpotifyAuthSessionFailureReason(str, Enum):
    SPOTIFY_ERROR = "spotify_error"
    MISSING_STATE = "missing_state"
    UNKNOWN_STATE = "unknown_state"
    STATE_MISMATCH = "state_mismatch"
    EXPIRED_STATE = "expired_state"
    CANCELLED = "cancelled"
    MISSING_CODE = "missing_code"


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


Reason = Union[NetworkReason, SpeakerReason, SpotifyAuthReason, PlaybackDeviceReason, VolumeReason, DisplayReason]


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
    ip_address: Optional[str] = None
    internet_reachable: Optional[bool] = None


class WifiSecurity(str, Enum):
    OPEN = "open"
    WPA = "wpa"
    WPA2 = "wpa2"
    WPA3 = "wpa3"
    UNKNOWN = "unknown"


class WifiNetwork(ContractModel):
    ssid: str
    signal: int = Field(ge=0, le=100)
    security: WifiSecurity
    known: bool


class WifiScanResults(ContractModel):
    networks: List[WifiNetwork]
    scanned_at: datetime


class NetworkConnectRequest(ContractModel):
    ssid: str
    password: Optional[str] = None
    hidden: bool = False


class NetworkForgetRequest(ContractModel):
    ssid: str
    confirm: Literal[True]


class SpotifyAuthHealth(ContractModel):
    status: SpotifyAuthStatus
    reason: Optional[SpotifyAuthReason] = None
    account_display_name: Optional[str] = None


class SpeakerHealth(ContractModel):
    status: SpeakerStatus
    reason: Optional[SpeakerReason] = None
    primary: Optional[SpeakerSummary] = None


class SpeakerDevice(ContractModel):
    address: str
    display_name: str
    alias: Optional[str] = None
    paired: bool
    connected: bool
    signal: Optional[int] = Field(default=None, ge=0, le=100)


class SpeakerScanResults(ContractModel):
    devices: List[SpeakerDevice]
    scanned_at: datetime


class SpeakerPairRequest(ContractModel):
    address: str
    display_name: Optional[str] = None


class SpeakerForgetRequest(ContractModel):
    address: str
    confirm: Literal[True]


class PlaybackDeviceHealth(ContractModel):
    status: PlaybackDeviceStatus
    reason: Optional[PlaybackDeviceReason] = None
    device_id: Optional[str] = None


class VolumeHealth(ContractModel):
    status: VolumeStatus
    reason: Optional[VolumeReason] = None
    value: Optional[int] = Field(default=None, ge=0, le=100)
    muted: Optional[bool] = None


class DisplayHealth(ContractModel):
    status: DisplayStatus
    reason: Optional[DisplayReason] = None
    brightness: int = Field(default=80, ge=0, le=100)


class KioskHealth(ContractModel):
    phase: KioskBootPhase
    last_restart_at: Optional[datetime] = None


class HealthState(ContractModel):
    network: NetworkHealth
    spotify_auth: SpotifyAuthHealth
    speaker: SpeakerHealth
    playback_device: PlaybackDeviceHealth
    volume: VolumeHealth
    display: DisplayHealth
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


class ActionResult(ContractModel):
    id: str
    domain: Literal["setup", "settings", "playback", "recovery", "library"]
    action: str
    state: RecoveryActionState
    reason: Optional[Reason] = None
    mock: bool
    started_at: datetime
    completed_at: Optional[datetime] = None


class SpotifyPlaybackToken(ContractModel):
    access_token: str
    token_type: str = "Bearer"
    expires_at: datetime
    scope: str


class SetupPlaybackTestRequest(ContractModel):
    action: Literal["start", "stop"]
    device_id: Optional[str] = None


class PlaybackControlRequest(ContractModel):
    action: Literal["play", "pause", "next", "previous", "stop", "seek_start", "shuffle_on", "shuffle_off", "repeat_context", "repeat_off"]
    device_id: Optional[str] = None


class VolumePatch(ContractModel):
    value: int = Field(ge=0, le=100)
    muted: bool = False
    device_id: Optional[str] = None


class SpotifyPlaybackTransferRequest(ContractModel):
    device_id: str
    play: bool = False


class LibraryCategoryId(str, Enum):
    HOME = "home"
    PLAYLISTS = "playlists"
    ALBUMS = "albums"
    ARTISTS = "artists"
    LIKED_SONGS = "liked_songs"
    RECENTLY_PLAYED = "recently_played"


class LibraryItemType(str, Enum):
    PLAYLIST = "playlist"
    ALBUM = "album"
    ARTIST = "artist"
    TRACK = "track"


class LibraryPlaybackKind(str, Enum):
    CONTEXT = "context"
    TRACK = "track"
    UNAVAILABLE = "unavailable"


class LibraryItem(ContractModel):
    id: str
    type: LibraryItemType
    uri: str
    title: str
    subtitle: Optional[str] = None
    artwork_url: Optional[str] = None
    source: LibraryCategoryId
    playback_kind: LibraryPlaybackKind
    playable: bool = True


class LibrarySection(ContractModel):
    id: LibraryCategoryId
    title: str
    description: str
    items: List[LibraryItem]


class LibraryCategoryResponse(ContractModel):
    category: LibraryCategoryId
    title: str
    description: str
    items: List[LibraryItem]
    generated_at: datetime


class LibraryHomeResponse(ContractModel):
    sections: List[LibrarySection]
    generated_at: datetime
    constrained: Literal[True] = True


class LibrarySearchResponse(ContractModel):
    query: str
    sections: List[LibrarySection]
    generated_at: datetime
    constrained: Literal[True] = True


class PlaybackQueueResponse(ContractModel):
    current: Optional[LibraryItem] = None
    items: List[LibraryItem]
    generated_at: datetime


class QueuePlayRequest(ContractModel):
    selected_uri: str
    continuation_uris: List[str] = Field(default_factory=list)
    device_id: Optional[str] = None

    @model_validator(mode="after")
    def validate_track_uris(self) -> "QueuePlayRequest":
        if not self.selected_uri.startswith("spotify:track:"):
            raise ValueError("queue selection requires a Spotify track URI")
        for uri in self.continuation_uris:
            if not uri.startswith("spotify:track:"):
                raise ValueError("queue continuation requires Spotify track URIs")
        return self


class CurrentTrackLikeStatus(ContractModel):
    track_id: Optional[str] = None
    liked: bool = False
    generated_at: datetime


class LibraryPlayRequest(ContractModel):
    uri: str
    playback_kind: LibraryPlaybackKind
    device_id: Optional[str] = None

    @model_validator(mode="after")
    def validate_playable_spotify_uri(self) -> "LibraryPlayRequest":
        playback_kind = self.playback_kind.value if isinstance(self.playback_kind, LibraryPlaybackKind) else str(self.playback_kind)
        if playback_kind == LibraryPlaybackKind.TRACK.value and not self.uri.startswith("spotify:track:"):
            raise ValueError("track playback requires a Spotify track URI")
        if playback_kind == LibraryPlaybackKind.CONTEXT.value and not (
            self.uri.startswith("spotify:playlist:")
            or self.uri.startswith("spotify:album:")
            or self.uri.startswith("spotify:artist:")
        ):
            raise ValueError("context playback requires a Spotify context URI")
        return self


class RunRecoveryActionRequest(ContractModel):
    confirm: bool = False


class AppSettings(ContractModel):
    idle_mode: IdleMode = IdleMode.CLOCK
    idle_timeout_seconds: int = Field(default=300, ge=30, le=3600)
    artwork_in_idle: bool = False
    default_sleep_timer_minutes: Optional[int] = Field(default=None, ge=0, le=120)
    brightness: int = Field(default=80, ge=0, le=100)
    bedtime_brightness: int = Field(default=20, ge=0, le=100)


class AppSettingsPatch(ContractModel):
    idle_mode: Optional[IdleMode] = None
    idle_timeout_seconds: Optional[int] = Field(default=None, ge=30, le=3600)
    artwork_in_idle: Optional[bool] = None
    default_sleep_timer_minutes: Optional[int] = Field(default=None, ge=0, le=120)
    brightness: Optional[int] = Field(default=None, ge=0, le=100)
    bedtime_brightness: Optional[int] = Field(default=None, ge=0, le=100)


class DisplayPatch(ContractModel):
    brightness: Optional[int] = Field(default=None, ge=0, le=100)
    status: Optional[DisplayStatus] = None


class NowPlayingSummary(ContractModel):
    title: str
    artist: str
    album: Optional[str] = None
    artwork_url: Optional[str] = None
    is_playing: bool
    progress_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    captured_at: Optional[datetime] = None


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


class SpotifyAuthSession(ContractModel):
    session_id: str
    status: SpotifyAuthSessionStatus
    created_at: datetime
    expires_at: datetime
    start_url: str
    failure_reason: Optional[SpotifyAuthSessionFailureReason] = None
    account_display_name: Optional[str] = None


class AppEvent(ContractModel):
    type: str
    payload: Dict[str, Any]
    emitted_at: datetime = Field(default_factory=lambda: utc_now())
    schema_version: Literal["v1"] = "v1"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
