from contextlib import asynccontextmanager
from html import escape
from pathlib import Path
from time import perf_counter
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .adapters import create_app_state_adapter
from .adapters.bluez import BlueZCommandError, BlueZUnavailable, BluetoothctlAdapter
from .adapters.network_manager import NetworkCommandError, NetworkManagerUnavailable, NmcliNetworkAdapter
from .adapters.production import (
    BlueZAdapter,
    NetworkManagerAdapter,
    ProductionAdapterNotImplemented,
    ProductionAdapters,
    VolumeAdapter,
)
from .adapters.volume import PipeWireVolumeAdapter, VolumeCommandError, VolumeUnavailable
from .bluetooth_store import BluetoothSpeakerStore
from .config import Settings, get_settings
from .contract import (
    ActionResult,
    AppPhase,
    AppSettings,
    AppSettingsPatch,
    AppSnapshot,
    DisplayHealth,
    DisplayPatch,
    HealthResponse,
    LibraryCategoryId,
    LibraryCategoryResponse,
    LibraryHomeResponse,
    LibraryItem,
    LibraryItemType,
    LibraryPlayRequest,
    LibraryPlaybackKind,
    LibrarySearchResponse,
    NetworkConnectRequest,
    NetworkForgetRequest,
    NetworkHealth,
    NetworkReason,
    NetworkStatus,
    NowPlayingSummary,
    PlaybackControlRequest,
    PlaybackQueueResponse,
    PlaybackDeviceReason,
    PlaybackDeviceStatus,
    RecoveryAction,
    RecoveryActionKind,
    RecoveryActionState,
    RunRecoveryActionRequest,
    ScenarioSummary,
    SpeakerForgetRequest,
    SpeakerHealth,
    SpeakerPairRequest,
    SpeakerReason,
    SpeakerScanResults,
    SpeakerStatus,
    SetupPlaybackTestRequest,
    SetupState,
    SetupStep,
    SetupStepId,
    SetupStepStatus,
    SpotifyAuthSession,
    SpotifyAuthHealth,
    SpotifyAuthReason,
    SpotifyAuthStatus,
    SpotifyPlaybackToken,
    SpotifyPlaybackTransferRequest,
    SurfaceId,
    VolumeHealth,
    VolumePatch,
    VolumeReason,
    VolumeStatus,
    Warning,
    WifiScanResults,
    utc_now,
)
from .database import initialize_database
from .events import EventHub
from .logging import configure_logging, get_logger
from .mock_scenarios import MockScenarioStore
from .settings_store import AppSettingsStore
from .setup_store import SetupStateStore
from .spotify_auth import (
    SpotifyAuthCallbackError,
    SpotifyAuthSessionService,
    SpotifyCatalogApiError,
    SpotifyCatalogApiFailure,
    SpotifyClient,
    SpotifyPlaybackApiError,
    SpotifyPlaybackApiFailure,
    SpotifyTokenExchangeError,
    UrlLibSpotifyClient,
    exchange_and_persist_spotify_callback,
    refresh_spotify_access_token,
    spotify_auth_health_from_record,
)
from .spotify_catalog import (
    library_category,
    library_home,
    library_search,
    mock_library_category,
    mock_library_home,
    mock_library_search,
    start_library_playback,
)
from .spotify_store import SpotifyAuthStore, SpotifyAuthTokenStorageError

_LAST_KNOWN_NOW_PLAYING_BY_DB: dict[str, NowPlayingSummary] = {}


def create_app(
    settings_override: Optional[Settings] = None,
    spotify_auth_sessions_override: Optional[SpotifyAuthSessionService] = None,
    spotify_client_override: Optional[SpotifyClient] = None,
    network_adapter_override: Optional[NetworkManagerAdapter] = None,
    bluetooth_adapter_override: Optional[BlueZAdapter] = None,
    volume_adapter_override: Optional[VolumeAdapter] = None,
) -> FastAPI:
    mock_store = MockScenarioStore()
    event_hub = EventHub()
    spotify_auth_sessions = spotify_auth_sessions_override or SpotifyAuthSessionService()
    spotify_client = spotify_client_override or UrlLibSpotifyClient()

    def network_adapter(settings: Settings) -> NetworkManagerAdapter:
        return network_adapter_override or NmcliNetworkAdapter(internet_probe_url=settings.pipzo_internet_probe_url)

    bluetooth_adapter_by_db_path: dict[str, BlueZAdapter] = {}

    def bluetooth_adapter(settings: Settings) -> BlueZAdapter:
        if bluetooth_adapter_override is not None:
            return bluetooth_adapter_override
        adapter = bluetooth_adapter_by_db_path.get(settings.db_path)
        if adapter is None:
            adapter = BluetoothctlAdapter(BluetoothSpeakerStore(settings.db_path))
            bluetooth_adapter_by_db_path[settings.db_path] = adapter
        return adapter

    def volume_adapter(settings: Settings) -> VolumeAdapter:
        return volume_adapter_override or PipeWireVolumeAdapter(audio_user=settings.pipzo_audio_user or None)

    def settings_store() -> AppSettingsStore:
        return AppSettingsStore(resolve_settings().db_path)

    def resolve_settings() -> Settings:
        if settings_override is not None:
            return settings_override
        return get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings = resolve_settings()
        logger = configure_logging(settings)
        database_result = initialize_database(settings.db_path)
        logger.info(
            "service startup complete",
            extra={
                "event": "startup",
                "details": {
                    "app_env": settings.app_env,
                    "app_mode": settings.app_mode,
                    "db_path": str(database_result.db_path),
                    "schema_version": database_result.schema_version,
                },
            },
        )
        yield

    app = FastAPI(title="Pipzo API", version="0.1.0", lifespan=lifespan)
    app.dependency_overrides[get_settings] = resolve_settings

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        started_at = perf_counter()
        response = await call_next(request)
        duration_ms = round((perf_counter() - started_at) * 1000, 2)
        get_logger().info(
            "request complete",
            extra={
                "event": "request",
                "details": {
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": response.status_code,
                    "duration_ms": duration_ms,
                },
            },
        )
        return response

    @app.get("/api/v1/health", response_model=HealthResponse)
    def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
        return HealthResponse(mode=settings.app_mode, checked_at=utc_now())

    @app.get("/api/v1/app/state", response_model=AppSnapshot)
    def app_state(settings: Settings = Depends(get_settings)) -> AppSnapshot:
        return read_snapshot(
            settings,
            mock_store,
            settings_store(),
            network_adapter(settings),
            bluetooth_adapter(settings),
            volume_adapter(settings),
            spotify_client,
        )

    @app.websocket("/api/v1/events/ws")
    async def events_ws(websocket: WebSocket, settings: Settings = Depends(get_settings)) -> None:
        try:
            initial_snapshot = read_snapshot(
                settings,
                mock_store,
                settings_store(),
                network_adapter(settings),
                bluetooth_adapter(settings),
                volume_adapter(settings),
                spotify_client,
            )
        except HTTPException as exc:
            await websocket.close(code=1011, reason=str(exc.detail))
            return
        await event_hub.websocket_session(websocket, initial_snapshot)

    @app.post("/api/v1/setup/start", response_model=SetupState)
    def setup_start(settings: Settings = Depends(get_settings)) -> SetupState:
        require_action_mock_mode(settings)
        setup = mock_store.start_setup()
        event_hub.publish("setup.step_changed", setup.model_dump(mode="json", by_alias=True))
        event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        return setup

    @app.post("/api/v1/setup/complete", response_model=AppSnapshot)
    def setup_complete(settings: Settings = Depends(get_settings)) -> AppSnapshot:
        require_action_mock_mode(settings)
        try:
            snapshot = mock_store.complete_setup()
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        event_hub.publish("setup.completed", snapshot.model_dump(mode="json", by_alias=True))
        return snapshot

    @app.post("/api/v1/setup/playback-test", response_model=RecoveryAction)
    def setup_playback_test(body: SetupPlaybackTestRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.run_playback_test(body.action)
        else:
            action = run_hardware_playback_test(
                settings,
                spotify_client,
                body,
                mock_store,
                settings_store(),
                network_adapter(settings),
                bluetooth_adapter(settings),
                volume_adapter(settings),
            )
        event_hub.publish("setup.playback_test_changed", action.model_dump(mode="json", by_alias=True))
        if settings.app_mode != "mock":
            event_hub.publish(
                "app.snapshot",
                read_snapshot(
                    settings,
                    mock_store,
                    settings_store(),
                    network_adapter(settings),
                    bluetooth_adapter(settings),
                    volume_adapter(settings),
                    spotify_client,
                ).model_dump(mode="json", by_alias=True),
            )
        return action

    @app.get("/api/v1/settings", response_model=AppSettings)
    def settings_get(settings: Settings = Depends(get_settings)) -> AppSettings:
        return AppSettingsStore(settings.db_path).get_settings()

    @app.patch("/api/v1/settings", response_model=AppSettings)
    def settings_patch(body: AppSettingsPatch, settings: Settings = Depends(get_settings)) -> AppSettings:
        updated = AppSettingsStore(settings.db_path).patch_settings(body)
        mock_store.apply_settings(updated)
        event_hub.publish("settings.changed", updated.model_dump(mode="json", by_alias=True))
        if settings.app_mode == "mock":
            snapshot = read_snapshot(
                settings,
                mock_store,
                settings_store(),
                network_adapter(settings),
                bluetooth_adapter(settings),
                volume_adapter(settings),
                spotify_client,
            )
            event_hub.publish("app.snapshot", snapshot.model_dump(mode="json", by_alias=True))
        return updated

    @app.patch("/api/v1/display", response_model=DisplayHealth)
    def display_patch(body: DisplayPatch, settings: Settings = Depends(get_settings)) -> DisplayHealth:
        require_action_mock_mode(settings)
        updated = mock_store.patch_display(body)
        AppSettingsStore(settings.db_path).save_settings(mock_store.get_settings())
        event_hub.publish("display.changed", updated.model_dump(mode="json", by_alias=True))
        event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        return updated

    @app.post("/api/v1/playback/control", response_model=ActionResult)
    def playback_control(body: PlaybackControlRequest, settings: Settings = Depends(get_settings)) -> ActionResult:
        if settings.app_mode == "mock":
            result = mock_store.control_playback(body.action)
        else:
            result = run_spotify_playback_control(settings, spotify_client, body)
        event_hub.publish("playback.control_changed", result.model_dump(mode="json", by_alias=True))
        return result

    @app.patch("/api/v1/volume", response_model=VolumeHealth)
    def volume_patch(body: VolumePatch, settings: Settings = Depends(get_settings)) -> VolumeHealth:
        if settings.app_mode == "mock":
            updated = mock_store.set_volume(body.value, body.muted)
        else:
            updated = set_unified_volume(settings, spotify_client, volume_adapter(settings), body)
        event_hub.publish("volume.changed", updated.model_dump(mode="json", by_alias=True))
        if settings.app_mode == "mock":
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        return updated

    @app.get("/api/v1/network/status", response_model=NetworkHealth)
    def network_status(settings: Settings = Depends(get_settings)) -> NetworkHealth:
        if settings.app_mode == "mock":
            return mock_store.network_status()
        try:
            return network_adapter(settings).status()
        except NetworkManagerUnavailable as exc:
            raise_network_adapter_unavailable("Wi-Fi status", exc)
        except NetworkCommandError as exc:
            return NetworkHealth(status=NetworkStatus.ERROR, reason=exc.reason, internet_reachable=False)

    @app.post("/api/v1/network/scan", response_model=RecoveryAction)
    def network_scan(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.scan_network()
        else:
            try:
                action = network_adapter(settings).scan()
            except NetworkManagerUnavailable as exc:
                raise_network_adapter_unavailable("Wi-Fi scan", exc)
            except NetworkCommandError as exc:
                action = network_failed_action("network-scan", exc.reason)
        event_hub.publish("network.scan_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.get("/api/v1/network/scan-results", response_model=WifiScanResults)
    def network_scan_results(settings: Settings = Depends(get_settings)) -> WifiScanResults:
        if settings.app_mode == "mock":
            return mock_store.network_scan_results()
        try:
            return network_adapter(settings).scan_results()
        except NetworkManagerUnavailable as exc:
            raise_network_adapter_unavailable("Wi-Fi scan results", exc)
        except NetworkCommandError as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.reason.value) from exc

    @app.post("/api/v1/network/connect", response_model=RecoveryAction)
    def network_connect(body: NetworkConnectRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.connect_network(body.ssid, body.password, body.hidden)
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        else:
            try:
                action = network_adapter(settings).connect(body.ssid, body.password, body.hidden)
            except NetworkManagerUnavailable as exc:
                raise_network_adapter_unavailable("Wi-Fi connect", exc)
            except NetworkCommandError as exc:
                action = network_failed_action("network-connect", exc.reason)
        event_hub.publish("network.connect_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.post("/api/v1/network/forget", response_model=RecoveryAction)
    def network_forget(body: NetworkForgetRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.forget_network(body.ssid)
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        else:
            try:
                action = network_adapter(settings).forget(body.ssid)
            except NetworkManagerUnavailable as exc:
                raise_network_adapter_unavailable("Wi-Fi forget", exc)
            except NetworkCommandError as exc:
                action = network_failed_action("network-forget", exc.reason)
        event_hub.publish("network.forget_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.post("/api/v1/network/retry-internet-probe", response_model=RecoveryAction)
    def network_retry_internet_probe(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.retry_internet_probe()
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        else:
            try:
                action = network_adapter(settings).retry_internet_probe()
            except NetworkManagerUnavailable as exc:
                raise_network_adapter_unavailable("internet probe retry", exc)
            except NetworkCommandError as exc:
                action = network_failed_action("network-internet-probe", exc.reason)
        event_hub.publish("network.internet_probe_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.get("/api/v1/speaker/status", response_model=SpeakerHealth)
    def speaker_status(settings: Settings = Depends(get_settings)) -> SpeakerHealth:
        if settings.app_mode == "mock":
            return mock_store.speaker_status()
        try:
            return bluetooth_adapter(settings).status()
        except BlueZUnavailable as exc:
            raise_bluetooth_adapter_unavailable("Bluetooth speaker status", exc)
        except BlueZCommandError as exc:
            return SpeakerHealth(status=SpeakerStatus.ERROR, reason=exc.reason)

    @app.post("/api/v1/speaker/scan", response_model=RecoveryAction)
    def speaker_scan(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.scan_speakers()
        else:
            try:
                action = bluetooth_adapter(settings).scan()
            except BlueZUnavailable as exc:
                raise_bluetooth_adapter_unavailable("Bluetooth speaker scan", exc)
            except BlueZCommandError as exc:
                action = speaker_failed_action("speaker-scan", exc.reason)
        log_recovery_action("speaker.scan", action)
        event_hub.publish("speaker.scan_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.get("/api/v1/speaker/scan-results", response_model=SpeakerScanResults)
    def speaker_scan_results(settings: Settings = Depends(get_settings)) -> SpeakerScanResults:
        if settings.app_mode == "mock":
            return mock_store.speaker_scan_results()
        try:
            return bluetooth_adapter(settings).scan_results()
        except BlueZUnavailable as exc:
            raise_bluetooth_adapter_unavailable("Bluetooth speaker scan results", exc)
        except BlueZCommandError as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.reason.value) from exc

    @app.post("/api/v1/speaker/pair", response_model=RecoveryAction)
    def speaker_pair(body: SpeakerPairRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.pair_speaker(body.address, body.display_name)
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        else:
            try:
                action = bluetooth_adapter(settings).pair(body.address, body.display_name)
            except BlueZUnavailable as exc:
                raise_bluetooth_adapter_unavailable("Bluetooth speaker pair", exc)
            except BlueZCommandError as exc:
                action = speaker_failed_action("speaker-pair", exc.reason)
        log_recovery_action("speaker.pair", action)
        event_hub.publish("speaker.pair_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.post("/api/v1/speaker/reconnect", response_model=RecoveryAction)
    def speaker_reconnect(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.reconnect_speaker()
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        else:
            try:
                action = bluetooth_adapter(settings).reconnect()
            except BlueZUnavailable as exc:
                raise_bluetooth_adapter_unavailable("Bluetooth speaker reconnect", exc)
            except BlueZCommandError as exc:
                action = speaker_failed_action("speaker-reconnect", exc.reason)
        log_recovery_action("speaker.reconnect", action)
        event_hub.publish("speaker.reconnect_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.post("/api/v1/speaker/forget", response_model=RecoveryAction)
    def speaker_forget(body: SpeakerForgetRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        if settings.app_mode == "mock":
            action = mock_store.forget_speaker(body.address)
            event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        else:
            try:
                action = bluetooth_adapter(settings).forget(body.address)
            except BlueZUnavailable as exc:
                raise_bluetooth_adapter_unavailable("Bluetooth speaker forget", exc)
            except BlueZCommandError as exc:
                action = speaker_failed_action("speaker-forget", exc.reason)
        log_recovery_action("speaker.forget", action)
        event_hub.publish("speaker.forget_completed", action.model_dump(mode="json", by_alias=True))
        return action

    @app.post("/api/v1/spotify/auth/session", response_model=SpotifyAuthSession)
    def spotify_auth_session_create(settings: Settings = Depends(get_settings)) -> SpotifyAuthSession:
        require_spotify_oauth_config(settings)
        session = spotify_auth_sessions.create_session(settings)
        event_hub.publish("spotify.auth_session_changed", session.model_dump(mode="json", by_alias=True))
        return session

    @app.get("/api/v1/spotify/auth/session/{session_id}", response_model=SpotifyAuthSession)
    def spotify_auth_session_get(session_id: str) -> SpotifyAuthSession:
        session = spotify_auth_sessions.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown Spotify auth session")
        return session

    @app.post("/api/v1/spotify/auth/session/{session_id}/cancel", response_model=SpotifyAuthSession)
    def spotify_auth_session_cancel(session_id: str) -> SpotifyAuthSession:
        session = spotify_auth_sessions.cancel_session(session_id)
        if session is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown Spotify auth session")
        event_hub.publish("spotify.auth_session_changed", session.model_dump(mode="json", by_alias=True))
        return session

    @app.get("/api/v1/spotify/auth/start/{session_id}")
    def spotify_auth_start(session_id: str, settings: Settings = Depends(get_settings)) -> RedirectResponse:
        require_spotify_oauth_config(settings)
        authorize_url = spotify_auth_sessions.build_authorize_url(session_id, settings)
        if authorize_url is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spotify auth session is not active")
        return RedirectResponse(authorize_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)

    @app.get("/api/v1/spotify/auth/callback", response_class=HTMLResponse)
    def spotify_auth_callback(
        state: Optional[str] = None,
        code: Optional[str] = None,
        error: Optional[str] = None,
        settings: Settings = Depends(get_settings),
    ) -> HTMLResponse:
        try:
            callback_exchange = spotify_auth_sessions.consume_callback_for_exchange(state=state, code=code, error=error)
        except SpotifyAuthCallbackError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.reason.value) from exc

        try:
            profile = exchange_and_persist_spotify_callback(
                callback_exchange=callback_exchange,
                settings=settings,
                spotify_client=spotify_client,
                store=SpotifyAuthStore.from_settings(settings),
            )
        except (SpotifyTokenExchangeError, SpotifyAuthTokenStorageError):
            session = spotify_auth_sessions.mark_exchange_failed(callback_exchange.session_id)
            event_hub.publish("spotify.auth_session_changed", session.model_dump(mode="json", by_alias=True))
            event_hub.publish(
                "spotify.auth_changed",
                SpotifyAuthHealth(
                    status=SpotifyAuthStatus.ERROR,
                    reason=SpotifyAuthReason.UNKNOWN,
                ).model_dump(mode="json", by_alias=True),
            )
            return spotify_callback_html(
                title="Spotify setup could not be completed",
                detail="Return to Pipzo and start again.",
                auto_return=False,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        session = spotify_auth_sessions.mark_connected(callback_exchange.session_id, profile.display_name)
        event_hub.publish("spotify.auth_session_changed", session.model_dump(mode="json", by_alias=True))
        event_hub.publish(
            "spotify.auth_changed",
            SpotifyAuthHealth(
                status=SpotifyAuthStatus.CONNECTED,
                reason=SpotifyAuthReason.PREMIUM_REQUIRED if not profile.is_premium else None,
                account_display_name=profile.display_name,
            ).model_dump(mode="json", by_alias=True),
        )
        return spotify_callback_html(
            title="Spotify setup is complete",
            detail="Returning to Pipzo now.",
            auto_return=True,
            status_code=status.HTTP_200_OK,
        )

    @app.post("/api/v1/spotify/auth/logout", response_model=SpotifyAuthHealth)
    def spotify_auth_logout(settings: Settings = Depends(get_settings)) -> SpotifyAuthHealth:
        return clear_spotify_auth_state(settings, spotify_auth_sessions, event_hub, mock_store)

    @app.get("/api/v1/spotify/playback/token", response_model=SpotifyPlaybackToken)
    def spotify_playback_token(settings: Settings = Depends(get_settings)) -> SpotifyPlaybackToken:
        require_spotify_oauth_config(settings)
        return issue_spotify_playback_token(settings, spotify_client)

    @app.post("/api/v1/spotify/playback/transfer", response_model=ActionResult)
    def spotify_playback_transfer(
        body: SpotifyPlaybackTransferRequest,
        settings: Settings = Depends(get_settings),
    ) -> ActionResult:
        if settings.app_mode == "mock":
            result = ActionResult(
                id="spotify-transfer-mock",
                domain="playback",
                action="transfer",
                state="succeeded",
                mock=True,
                started_at=utc_now(),
                completed_at=utc_now(),
            )
        else:
            result = transfer_spotify_playback(settings, spotify_client, body)
            if result.state == RecoveryActionState.SUCCEEDED:
                SetupStateStore(settings.db_path).store_playback_device_id(body.device_id)
        event_hub.publish("playback.control_changed", result.model_dump(mode="json", by_alias=True))
        return result

    @app.get("/api/v1/library/home", response_model=LibraryHomeResponse)
    def spotify_library_home(limit: int = 8, settings: Settings = Depends(get_settings)) -> LibraryHomeResponse:
        if settings.app_mode == "mock":
            return mock_library_home(limit)
        try:
            return library_home(settings, spotify_client, limit)
        except SpotifyCatalogApiError as exc:
            raise_catalog_http_error(exc)

    @app.get("/api/v1/library/search", response_model=LibrarySearchResponse)
    def spotify_library_search(q: str = "", limit: int = 20, settings: Settings = Depends(get_settings)) -> LibrarySearchResponse:
        if settings.app_mode == "mock":
            return mock_library_search(q, limit)
        try:
            return library_search(settings, spotify_client, q, limit)
        except SpotifyCatalogApiError as exc:
            raise_catalog_http_error(exc)

    @app.get("/api/v1/library/{category}", response_model=LibraryCategoryResponse)
    def spotify_library_category(
        category: LibraryCategoryId,
        limit: int = 20,
        settings: Settings = Depends(get_settings),
    ) -> LibraryCategoryResponse:
        if category == LibraryCategoryId.HOME:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Use /api/v1/library/home for home sections")
        if settings.app_mode == "mock":
            return mock_library_category(category, limit)
        try:
            return library_category(settings, spotify_client, category, limit)
        except SpotifyCatalogApiError as exc:
            raise_catalog_http_error(exc)

    @app.post("/api/v1/library/play", response_model=ActionResult)
    def spotify_library_play(body: LibraryPlayRequest, settings: Settings = Depends(get_settings)) -> ActionResult:
        if settings.app_mode == "mock":
            result = ActionResult(
                id="library-start-mock",
                domain="library",
                action="start",
                state="succeeded",
                mock=True,
                started_at=utc_now(),
                completed_at=utc_now(),
            )
        else:
            result = start_library_playback(settings, spotify_client, body)
            if result.state == RecoveryActionState.SUCCEEDED:
                maybe_mark_playback_test_passed_from_library_start(
                    settings,
                    body,
                    mock_store,
                    settings_store(),
                    network_adapter(settings),
                    bluetooth_adapter(settings),
                    volume_adapter(settings),
                )
        event_hub.publish("playback.control_changed", result.model_dump(mode="json", by_alias=True))
        if settings.app_mode != "mock":
            event_hub.publish(
                "app.snapshot",
                read_snapshot(
                    settings,
                    mock_store,
                    settings_store(),
                    network_adapter(settings),
                    bluetooth_adapter(settings),
                    volume_adapter(settings),
                    spotify_client,
                ).model_dump(mode="json", by_alias=True),
            )
        return result

    @app.get("/api/v1/spotify/queue", response_model=PlaybackQueueResponse)
    def spotify_playback_queue(settings: Settings = Depends(get_settings)) -> PlaybackQueueResponse:
        if settings.app_mode == "mock":
            mock_home = mock_library_home(8)
            tracks = [
                item
                for section in mock_home.sections
                for item in section.items
                if item.playback_kind == LibraryPlaybackKind.TRACK
            ]
            return PlaybackQueueResponse(current=tracks[0] if tracks else None, items=tracks[1:12], generated_at=utc_now())
        try:
            return playback_queue(settings, spotify_client)
        except HTTPException:
            raise
        except SpotifyCatalogApiError as exc:
            raise_catalog_http_error(exc)

    @app.get("/api/v1/recovery/actions", response_model=list[RecoveryAction])
    def recovery_actions(settings: Settings = Depends(get_settings)) -> list[RecoveryAction]:
        require_action_mock_mode(settings)
        return mock_store.list_recovery_actions()

    @app.post("/api/v1/recovery/actions/{action_id}/run", response_model=RecoveryAction)
    def recovery_action_run(
        action_id: str,
        body: RunRecoveryActionRequest,
        settings: Settings = Depends(get_settings),
    ) -> RecoveryAction:
        require_action_mock_mode(settings)
        try:
            action = mock_store.run_recovery_action(action_id, confirm=body.confirm)
        except KeyError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown recovery action") from exc
        if action_id == "reset-app" and action.state == "succeeded":
            clear_spotify_auth_state(settings, spotify_auth_sessions, event_hub, mock_store)
        event_hub.publish("recovery.action_changed", action.model_dump(mode="json", by_alias=True))
        event_hub.publish("app.snapshot", mock_store.get_snapshot().model_dump(mode="json", by_alias=True))
        return action

    @app.get("/api/v1/mock/scenarios", response_model=list[ScenarioSummary])
    def list_mock_scenarios(settings: Settings = Depends(get_settings)) -> list[ScenarioSummary]:
        require_mock_mode(settings)
        return mock_store.list_scenarios()

    @app.post("/api/v1/mock/scenarios/{scenario_id}/activate", response_model=AppSnapshot)
    def activate_mock_scenario(scenario_id: str, settings: Settings = Depends(get_settings)) -> AppSnapshot:
        require_mock_mode(settings)
        get_logger().info(
            "mock scenario activation requested",
            extra={"event": "action", "details": {"action": "mock_scenario_activate", "scenario_id": scenario_id}},
        )
        try:
            snapshot = mock_store.activate(scenario_id)
        except KeyError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown mock scenario") from exc
        event_hub.publish("mock.scenario_activated", snapshot.model_dump(mode="json", by_alias=True))
        return snapshot

    mount_frontend_assets(app, resolve_settings().pipzo_frontend_dist)
    return app


def spotify_callback_html(*, title: str, detail: str, auto_return: bool, status_code: int) -> HTMLResponse:
    safe_title = escape(title)
    safe_detail = escape(detail)
    refresh_meta = '<meta http-equiv="refresh" content="2;url=/">' if auto_return else ""
    redirect_script = "<script>window.setTimeout(function(){window.location.replace('/');}, 1200);</script>" if auto_return else ""
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  {refresh_meta}
  <title>Pipzo Spotify setup</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f4f1ea;
      color: #17211c;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    main {{
      width: min(680px, calc(100% - 32px));
      display: grid;
      gap: 18px;
      text-align: center;
    }}
    h1 {{
      margin: 0;
      font-size: clamp(38px, 7vw, 64px);
      line-height: 1;
    }}
    p {{
      margin: 0;
      color: #526058;
      font-size: 22px;
      line-height: 1.35;
    }}
    a {{
      display: grid;
      place-items: center;
      min-height: 82px;
      border: 1px solid #2f6f73;
      border-radius: 8px;
      background: #d9eeee;
      color: #17211c;
      font-size: 24px;
      font-weight: 800;
      text-decoration: none;
    }}
  </style>
</head>
<body>
  <main>
    <h1>{safe_title}</h1>
    <p>{safe_detail}</p>
    <a href="/">Return to Pipzo</a>
  </main>
  {redirect_script}
</body>
</html>"""
    return HTMLResponse(html, status_code=status_code)


def mount_frontend_assets(app: FastAPI, frontend_dist: str) -> None:
    if not frontend_dist:
        return
    dist_path = Path(frontend_dist).expanduser()
    if not (dist_path / "index.html").is_file():
        return
    app.mount("/", StaticFiles(directory=dist_path, html=True), name="frontend")


def require_mock_mode(settings: Settings) -> None:
    if settings.app_mode != "mock":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mock endpoints are disabled outside mock mode")


def require_action_mock_mode(settings: Settings) -> None:
    if settings.app_mode != "mock":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="This action is not implemented for hardware mode yet; run with PIPZO_MODE=mock for simulated actions.",
        )


def raise_device_adapter_unavailable(action: str) -> None:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"{action} is not implemented until the platform adapter is available.",
    )


def raise_network_adapter_unavailable(action: str, exc: Exception) -> None:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"{action} is unavailable because NetworkManager/nmcli is not installed or not accessible.",
    ) from exc


def raise_bluetooth_adapter_unavailable(action: str, exc: Exception) -> None:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"{action} is unavailable because BlueZ/bluetoothctl is not installed or not accessible.",
    ) from exc


def network_failed_action(action_id: str, reason: NetworkReason) -> RecoveryAction:
    now = utc_now()
    return RecoveryAction(
        id=action_id,
        kind=RecoveryActionKind.FORGET_WIFI if action_id == "network-forget" else RecoveryActionKind.CONNECT_WIFI,
        state=RecoveryActionState.FAILED,
        reason=reason,
        requires_confirmation=False,
        started_at=now,
        completed_at=now,
    )


def speaker_failed_action(action_id: str, reason: SpeakerReason) -> RecoveryAction:
    now = utc_now()
    kind = RecoveryActionKind.RECONNECT_SPEAKER
    if action_id == "speaker-forget":
        kind = RecoveryActionKind.FORGET_SPEAKER
    return RecoveryAction(
        id=action_id,
        kind=kind,
        state=RecoveryActionState.FAILED,
        reason=reason,
        requires_confirmation=False,
        started_at=now,
        completed_at=now,
    )


def log_recovery_action(event: str, action: RecoveryAction) -> None:
    get_logger().info(
        "recovery action completed",
        extra={
            "event": event,
            "details": {
                "action": action.model_dump(mode="json", by_alias=True),
            },
        },
    )


def raise_catalog_http_error(exc: SpotifyCatalogApiError) -> None:
    status_by_failure = {
        SpotifyCatalogApiFailure.AUTH: status.HTTP_401_UNAUTHORIZED,
        SpotifyCatalogApiFailure.FORBIDDEN: status.HTTP_403_FORBIDDEN,
        SpotifyCatalogApiFailure.RATE_LIMITED: status.HTTP_429_TOO_MANY_REQUESTS,
        SpotifyCatalogApiFailure.NETWORK: status.HTTP_503_SERVICE_UNAVAILABLE,
        SpotifyCatalogApiFailure.INVALID_RESPONSE: status.HTTP_502_BAD_GATEWAY,
    }
    raise HTTPException(status_code=status_by_failure[exc.failure], detail=exc.failure.value) from exc


def require_spotify_oauth_config(settings: Settings) -> None:
    if not settings.spotify_client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Spotify client ID is not configured",
        )


def read_snapshot(
    settings: Settings,
    mock_store: MockScenarioStore,
    app_settings_store: AppSettingsStore,
    network_adapter: Optional[NetworkManagerAdapter] = None,
    bluetooth_adapter: Optional[BlueZAdapter] = None,
    volume_adapter: Optional[VolumeAdapter] = None,
    spotify_client: Optional[SpotifyClient] = None,
) -> AppSnapshot:
    if network_adapter is not None or bluetooth_adapter is not None or volume_adapter is not None:
        production_adapters = ProductionAdapters(
            network=network_adapter if network_adapter is not None else ProductionAdapters().network,
            bluetooth=bluetooth_adapter if bluetooth_adapter is not None else ProductionAdapters().bluetooth,
            volume=volume_adapter if volume_adapter is not None else ProductionAdapters().volume,
        )
    else:
        production_adapters = None
    adapter = create_app_state_adapter(settings, mock_store, production_adapters)
    try:
        snapshot = adapter.get_snapshot()
    except ProductionAdapterNotImplemented as exc:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Hardware adapters are not implemented yet; run with PIPZO_MODE=mock for desktop scenarios.",
        ) from exc
    snapshot.settings = app_settings_store.get_settings()
    snapshot.surfaces.idle_mode = snapshot.settings.idle_mode
    snapshot.health.display.brightness = snapshot.settings.brightness
    if settings.app_mode != "mock":
        setup_state = SetupStateStore(settings.db_path).get_state()
        snapshot.readiness.playback_test_passed = setup_state.playback_test_passed
        if setup_state.playback_device_id:
            snapshot.health.playback_device.device_id = setup_state.playback_device_id
    try:
        auth_record = SpotifyAuthStore.from_settings(settings).get_auth_record()
    except SpotifyAuthTokenStorageError:
        snapshot.health.spotify_auth = SpotifyAuthHealth(
            status=SpotifyAuthStatus.RECONNECT_REQUIRED,
            reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED,
        )
        snapshot.readiness.spotify_authorized = False
        project_setup_readiness(snapshot)
        snapshot.warnings.append(
            Warning(
                code="spotify_reconnect_required",
                reason=snapshot.health.spotify_auth.reason,
                surface=snapshot.surfaces.current,
                action="spotify_reconnect",
            )
        )
        return snapshot
    if auth_record is not None:
        snapshot.health.spotify_auth = spotify_auth_health_from_record(auth_record)
        snapshot.readiness.spotify_authorized = snapshot.health.spotify_auth.status == SpotifyAuthStatus.CONNECTED
        project_setup_readiness(snapshot)
        project_now_playing(settings, spotify_client, snapshot)
        if snapshot.health.spotify_auth.status == SpotifyAuthStatus.RECONNECT_REQUIRED:
            snapshot.warnings.append(
                Warning(
                    code="spotify_reconnect_required",
                    reason=snapshot.health.spotify_auth.reason,
                    surface=snapshot.surfaces.current,
                    action="spotify_reconnect",
                )
            )
    else:
        project_setup_readiness(snapshot)
    return snapshot


def project_now_playing(settings: Settings, spotify_client: Optional[SpotifyClient], snapshot: AppSnapshot) -> None:
    if settings.app_mode == "mock" or spotify_client is None:
        return
    if snapshot.health.spotify_auth.status != SpotifyAuthStatus.CONNECTED:
        return
    if snapshot.health.spotify_auth.reason == SpotifyAuthReason.PREMIUM_REQUIRED:
        return
    target_device_id = snapshot.health.playback_device.device_id
    if not target_device_id:
        return

    try:
        token = issue_spotify_playback_token(settings, spotify_client)
        payload = spotify_client.fetch_current_playback(
            api_base_url=settings.spotify_api_base_url,
            access_token=token.access_token,
        )
    except (HTTPException, SpotifyPlaybackApiError):
        snapshot.health.playback_device.reason = PlaybackDeviceReason.SPOTIFY_API_ERROR
        mark_current_playback_diagnostic(snapshot, "spotify_api_error")
        append_warning_once(
            snapshot,
            Warning(
                code="playback_device_unavailable",
                reason=PlaybackDeviceReason.SPOTIFY_API_ERROR,
                surface=SurfaceId.NOW_PLAYING,
                action="open_settings",
            ),
        )
        return

    if not payload:
        snapshot.now_playing = paused_last_known_now_playing(settings)
        mark_current_playback_diagnostic(snapshot, "empty_response")
        return

    device = payload.get("device") if isinstance(payload.get("device"), dict) else {}
    active_device_id = str(device.get("id") or "")
    if active_device_id and active_device_id != target_device_id:
        item = payload.get("item") if isinstance(payload.get("item"), dict) else None
        if item is not None and payload.get("currently_playing_type") in {None, "track"}:
            snapshot.now_playing = now_playing_from_spotify_payload(payload, item)
            remember_now_playing(settings, snapshot.now_playing)
        else:
            snapshot.now_playing = paused_last_known_now_playing(settings)
        mark_current_playback_diagnostic(
            snapshot,
            f"device_mismatch:stored={target_device_id}:active={active_device_id}",
        )
        return

    item = payload.get("item") if isinstance(payload.get("item"), dict) else None
    if item is None or payload.get("currently_playing_type") not in {None, "track"}:
        snapshot.now_playing = None
        playing_type = str(payload.get("currently_playing_type") or "missing_item")
        mark_current_playback_diagnostic(snapshot, f"unsupported_payload:{playing_type}")
        return

    snapshot.now_playing = now_playing_from_spotify_payload(payload, item)
    remember_now_playing(settings, snapshot.now_playing)
    mark_current_playback_diagnostic(snapshot, f"ok:device={active_device_id or 'unknown'}")


def remember_now_playing(settings: Settings, now_playing: NowPlayingSummary) -> None:
    _LAST_KNOWN_NOW_PLAYING_BY_DB[settings.db_path] = now_playing


def paused_last_known_now_playing(settings: Settings) -> Optional[NowPlayingSummary]:
    last = _LAST_KNOWN_NOW_PLAYING_BY_DB.get(settings.db_path)
    if last is None:
        return None
    return last.model_copy(update={"is_playing": False, "captured_at": utc_now()})


def mark_current_playback_diagnostic(snapshot: AppSnapshot, code: str) -> None:
    snapshot.diagnostics.last_command = "spotify.current_playback"
    snapshot.diagnostics.raw_adapter_code = code


def now_playing_from_spotify_payload(payload: dict, item: dict) -> NowPlayingSummary:
    album = item.get("album") if isinstance(item.get("album"), dict) else {}
    artists = item.get("artists") if isinstance(item.get("artists"), list) else []
    artist_names = [
        str(artist.get("name"))
        for artist in artists
        if isinstance(artist, dict) and artist.get("name")
    ]
    images = album.get("images") if isinstance(album.get("images"), list) else []
    artwork_url = None
    for image in images:
        if isinstance(image, dict) and image.get("url"):
            artwork_url = str(image["url"])
            break
    return NowPlayingSummary(
        title=str(item.get("name") or "Unknown track"),
        artist=", ".join(artist_names) or "Unknown artist",
        album=str(album.get("name")) if album.get("name") else None,
        artwork_url=artwork_url,
        is_playing=bool(payload.get("is_playing")),
        progress_ms=_optional_nonnegative_int(payload.get("progress_ms")),
        duration_ms=_optional_nonnegative_int(item.get("duration_ms")),
        captured_at=utc_now(),
    )


def _optional_nonnegative_int(value: object) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, parsed)


def project_setup_readiness(snapshot: AppSnapshot) -> None:
    network_ready = snapshot.readiness.network_configured
    spotify_ready = snapshot.readiness.spotify_authorized
    speaker_ready = snapshot.health.speaker.status == SpeakerStatus.CONNECTED and bool(snapshot.health.speaker.primary)
    snapshot.readiness.primary_speaker_saved = speaker_ready
    project_playback_device(snapshot, network_ready, spotify_ready, speaker_ready)
    playback_ready = snapshot.health.playback_device.status == PlaybackDeviceStatus.AVAILABLE
    snapshot.capabilities.can_browse = network_ready and spotify_ready
    snapshot.capabilities.can_search = network_ready and spotify_ready
    snapshot.capabilities.can_start_playback = playback_ready
    snapshot.capabilities.can_control_playback = playback_ready
    snapshot.capabilities.can_control_volume = speaker_ready and snapshot.health.volume.status != VolumeStatus.UNAVAILABLE
    snapshot.capabilities.can_use_sleep_timer = playback_ready
    snapshot.readiness.minimum_ready = (
        network_ready
        and spotify_ready
        and speaker_ready
        and snapshot.readiness.playback_test_passed
    )
    blocking = setup_blocking_step(
        network_ready,
        spotify_ready,
        speaker_ready,
        snapshot.readiness.playback_test_passed,
    )
    snapshot.setup.blocking_step = blocking
    snapshot.setup.steps = setup_steps_for_blocking(blocking)
    if snapshot.readiness.minimum_ready:
        snapshot.app_phase = AppPhase.READY
        snapshot.surfaces.current = SurfaceId.HOME
        snapshot.surfaces.route = "/"
        return
    if snapshot.app_phase == "starting":
        return
    if snapshot.readiness.setup_completed_at is not None or snapshot.app_phase == "degraded":
        project_degraded_runtime(snapshot)
        return
    if not snapshot.readiness.minimum_ready:
        snapshot.app_phase = "setup"
        snapshot.surfaces.current = "setup"
        snapshot.surfaces.route = route_for_blocking(blocking)


def project_playback_device(snapshot: AppSnapshot, network_ready: bool, spotify_ready: bool, speaker_ready: bool) -> None:
    if not network_ready:
        snapshot.health.playback_device.status = PlaybackDeviceStatus.UNAVAILABLE
        snapshot.health.playback_device.reason = PlaybackDeviceReason.NETWORK_UNAVAILABLE
        snapshot.health.playback_device.device_id = None
        return
    if not spotify_ready:
        snapshot.health.playback_device.status = PlaybackDeviceStatus.UNAVAILABLE
        snapshot.health.playback_device.reason = PlaybackDeviceReason.AUTH_REQUIRED
        snapshot.health.playback_device.device_id = None
        return
    if not speaker_ready:
        snapshot.health.playback_device.status = PlaybackDeviceStatus.UNAVAILABLE
        snapshot.health.playback_device.reason = PlaybackDeviceReason.SPEAKER_UNAVAILABLE
        snapshot.health.playback_device.device_id = None
        return
    if snapshot.readiness.playback_test_passed:
        snapshot.health.playback_device.status = PlaybackDeviceStatus.AVAILABLE
        snapshot.health.playback_device.reason = None
        return
    snapshot.health.playback_device.status = PlaybackDeviceStatus.TRANSFER_REQUIRED
    snapshot.health.playback_device.reason = PlaybackDeviceReason.DEVICE_NOT_REGISTERED


def project_degraded_runtime(snapshot: AppSnapshot) -> None:
    snapshot.app_phase = "degraded"
    if snapshot.surfaces.current not in {"settings", "home", "now_playing", "idle"}:
        snapshot.surfaces.current = "settings"
        snapshot.surfaces.route = "/settings/recovery"
    if snapshot.surfaces.return_surface is None and snapshot.surfaces.current != "settings":
        snapshot.surfaces.return_surface = snapshot.surfaces.current

    network_online = snapshot.health.network.status == NetworkStatus.ONLINE
    spotify_ready = snapshot.health.spotify_auth.status == SpotifyAuthStatus.CONNECTED and snapshot.readiness.spotify_authorized
    speaker_ready = snapshot.health.speaker.status == SpeakerStatus.CONNECTED and bool(snapshot.health.speaker.primary)
    playback_ready = (
        network_online
        and spotify_ready
        and speaker_ready
        and snapshot.health.playback_device.status in {PlaybackDeviceStatus.AVAILABLE, PlaybackDeviceStatus.TRANSFER_REQUIRED}
    )

    snapshot.capabilities.can_browse = network_online and spotify_ready
    snapshot.capabilities.can_search = network_online and spotify_ready
    snapshot.capabilities.can_start_playback = playback_ready
    snapshot.capabilities.can_control_playback = playback_ready
    snapshot.capabilities.can_control_volume = speaker_ready and snapshot.health.volume.status != "unavailable"
    snapshot.capabilities.can_use_sleep_timer = playback_ready

    if not network_online:
        snapshot.staleness.is_stale = True
        snapshot.staleness.stale_since = snapshot.staleness.stale_since or utc_now()
        snapshot.staleness.reason = "network_offline" if snapshot.health.network.status == NetworkStatus.OFFLINE else "network_local_only"
        append_warning_once(
            snapshot,
            Warning(
                code="network_local_only" if snapshot.health.network.status == NetworkStatus.LOCAL_ONLY else "network_offline",
                reason=snapshot.health.network.reason,
                surface="settings",
                action="connect_wifi",
            ),
        )
        snapshot.health.playback_device.status = PlaybackDeviceStatus.UNAVAILABLE
        snapshot.health.playback_device.reason = PlaybackDeviceReason.NETWORK_UNAVAILABLE
    if not spotify_ready:
        append_warning_once(
            snapshot,
            Warning(
                code="spotify_reconnect_required",
                reason=snapshot.health.spotify_auth.reason,
                surface="settings",
                action="spotify_reconnect",
            ),
        )
        snapshot.health.playback_device.status = PlaybackDeviceStatus.UNAVAILABLE
        snapshot.health.playback_device.reason = PlaybackDeviceReason.AUTH_REQUIRED
    if not speaker_ready:
        append_warning_once(
            snapshot,
            Warning(
                code="speaker_disconnected",
                reason=snapshot.health.speaker.reason,
                surface="settings",
                action="reconnect_speaker",
            ),
        )
        snapshot.health.playback_device.status = PlaybackDeviceStatus.UNAVAILABLE
        snapshot.health.playback_device.reason = PlaybackDeviceReason.SPEAKER_UNAVAILABLE
    if snapshot.health.playback_device.status != PlaybackDeviceStatus.AVAILABLE:
        append_warning_once(
            snapshot,
            Warning(
                code="playback_device_unavailable",
                reason=snapshot.health.playback_device.reason,
                surface="now_playing",
                action="open_settings",
            ),
        )


def append_warning_once(snapshot: AppSnapshot, warning: Warning) -> None:
    if not any(existing.code == warning.code for existing in snapshot.warnings):
        snapshot.warnings.append(warning)


def setup_blocking_step(network_ready: bool, spotify_ready: bool, speaker_ready: bool, playback_ready: bool) -> SetupStepId:
    if not network_ready:
        return SetupStepId.WIFI
    if not spotify_ready:
        return SetupStepId.SPOTIFY_AUTH
    if not speaker_ready:
        return SetupStepId.SPEAKER
    if not playback_ready:
        return SetupStepId.PLAYBACK_TEST
    return SetupStepId.NONE


def route_for_blocking(blocking: SetupStepId) -> str:
    return {
        SetupStepId.WIFI: "/setup/wifi",
        SetupStepId.SPOTIFY_AUTH: "/setup/spotify",
        SetupStepId.SPEAKER: "/setup/speaker",
        SetupStepId.PLAYBACK_TEST: "/setup/playback-test",
        SetupStepId.NONE: "/",
    }.get(blocking, "/setup")


def setup_steps_for_blocking(blocking: SetupStepId) -> list[SetupStep]:
    order = [
        SetupStepId.WELCOME,
        SetupStepId.WIFI,
        SetupStepId.SPOTIFY_AUTH,
        SetupStepId.SPEAKER,
        SetupStepId.PLAYBACK_TEST,
        SetupStepId.COMPLETE,
    ]
    steps: list[SetupStep] = []
    blocked = False
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


def clear_spotify_auth_state(
    settings: Settings,
    spotify_auth_sessions: SpotifyAuthSessionService,
    event_hub: EventHub,
    mock_store: MockScenarioStore,
) -> SpotifyAuthHealth:
    SpotifyAuthStore.from_settings(settings).delete_auth_record()
    SetupStateStore(settings.db_path).clear_playback_test()
    spotify_auth_sessions.clear_sessions()
    health = SpotifyAuthHealth(status=SpotifyAuthStatus.NONE, reason=SpotifyAuthReason.NO_SESSION)
    event_hub.publish("spotify.auth_changed", health.model_dump(mode="json", by_alias=True))
    event_hub.publish("app.snapshot", read_snapshot(settings, mock_store, AppSettingsStore(settings.db_path)).model_dump(mode="json", by_alias=True))
    return health


def run_hardware_playback_test(
    settings: Settings,
    spotify_client: SpotifyClient,
    body: SetupPlaybackTestRequest,
    mock_store: MockScenarioStore,
    app_settings_store: AppSettingsStore,
    network_adapter: NetworkManagerAdapter,
    bluetooth_adapter: BlueZAdapter,
    volume_adapter: VolumeAdapter,
) -> RecoveryAction:
    started_at = utc_now()
    snapshot = read_snapshot(settings, mock_store, app_settings_store, network_adapter, bluetooth_adapter, volume_adapter)
    reason = playback_test_blocking_reason(snapshot)
    if body.action == "stop":
        return RecoveryAction(
            id="setup-playback-test",
            kind=RecoveryActionKind.RUN_PLAYBACK_TEST,
            state=RecoveryActionState.AVAILABLE if reason is None else RecoveryActionState.BLOCKED,
            reason=reason,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )
    if reason is not None:
        return RecoveryAction(
            id="setup-playback-test",
            kind=RecoveryActionKind.RUN_PLAYBACK_TEST,
            state=RecoveryActionState.BLOCKED,
            reason=reason,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )
    device_id = (body.device_id or "").strip()
    if not device_id:
        return RecoveryAction(
            id="setup-playback-test",
            kind=RecoveryActionKind.RUN_PLAYBACK_TEST,
            state=RecoveryActionState.BLOCKED,
            reason=PlaybackDeviceReason.DEVICE_NOT_REGISTERED,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )

    transfer = transfer_spotify_playback(settings, spotify_client, SpotifyPlaybackTransferRequest(device_id=device_id, play=False))
    if transfer.state != RecoveryActionState.SUCCEEDED:
        return RecoveryAction(
            id="setup-playback-test",
            kind=RecoveryActionKind.RUN_PLAYBACK_TEST,
            state=RecoveryActionState.BLOCKED,
            reason=transfer.reason or PlaybackDeviceReason.TRANSFER_FAILED,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )

    SetupStateStore(settings.db_path).mark_playback_test_passed(device_id)
    return RecoveryAction(
        id="setup-playback-test",
        kind=RecoveryActionKind.RUN_PLAYBACK_TEST,
        state=RecoveryActionState.SUCCEEDED,
        requires_confirmation=False,
        started_at=started_at,
        completed_at=utc_now(),
    )


def maybe_mark_playback_test_passed_from_library_start(
    settings: Settings,
    body: LibraryPlayRequest,
    mock_store: MockScenarioStore,
    app_settings_store: AppSettingsStore,
    network_adapter: NetworkManagerAdapter,
    bluetooth_adapter: BlueZAdapter,
    volume_adapter: VolumeAdapter,
) -> None:
    device_id = (body.device_id or "").strip()
    if not device_id:
        return
    snapshot = read_snapshot(settings, mock_store, app_settings_store, network_adapter, bluetooth_adapter, volume_adapter)
    if playback_test_blocking_reason(snapshot) is not None:
        return
    SetupStateStore(settings.db_path).mark_playback_test_passed(device_id)


def playback_test_blocking_reason(snapshot: AppSnapshot) -> Optional[PlaybackDeviceReason]:
    if not snapshot.readiness.network_configured:
        return PlaybackDeviceReason.NETWORK_UNAVAILABLE
    if not snapshot.readiness.spotify_authorized:
        return PlaybackDeviceReason.AUTH_REQUIRED
    if not snapshot.readiness.primary_speaker_saved:
        return PlaybackDeviceReason.SPEAKER_UNAVAILABLE
    return None


def issue_spotify_playback_token(settings: Settings, spotify_client: SpotifyClient) -> SpotifyPlaybackToken:
    store = SpotifyAuthStore.from_settings(settings)
    health = refresh_spotify_access_token(settings=settings, spotify_client=spotify_client, store=store)
    if health.status != SpotifyAuthStatus.CONNECTED:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(health.reason) if health.reason else "spotify_auth_required",
        )
    if health.reason == SpotifyAuthReason.PREMIUM_REQUIRED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="premium_required")

    try:
        record = store.get_auth_record()
    except SpotifyAuthTokenStorageError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="token_refresh_failed") from exc
    if record is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no_session")
    if not record.account.is_premium:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="premium_required")
    if not record.access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="spotify_auth_required")

    return SpotifyPlaybackToken(
        access_token=record.access_token,
        token_type=record.token_type,
        expires_at=record.expires_at,
        scope=record.scope,
    )


def transfer_spotify_playback(
    settings: Settings,
    spotify_client: SpotifyClient,
    body: SpotifyPlaybackTransferRequest,
) -> ActionResult:
    started_at = utc_now()
    try:
        token = issue_spotify_playback_token(settings, spotify_client)
        spotify_client.transfer_playback(
            api_base_url=settings.spotify_api_base_url,
            access_token=token.access_token,
            device_id=body.device_id,
            play=body.play,
        )
    except HTTPException as exc:
        return _playback_action_result_from_http_error("transfer", started_at, exc)
    except SpotifyPlaybackApiError as exc:
        return _playback_action_result_from_api_error("transfer", started_at, exc)
    return ActionResult(
        id="spotify-transfer",
        domain="playback",
        action="transfer",
        state="succeeded",
        mock=False,
        started_at=started_at,
        completed_at=utc_now(),
    )


def run_spotify_playback_control(
    settings: Settings,
    spotify_client: SpotifyClient,
    body: PlaybackControlRequest,
) -> ActionResult:
    started_at = utc_now()
    try:
        token = issue_spotify_playback_token(settings, spotify_client)
        spotify_client.send_playback_control(
            api_base_url=settings.spotify_api_base_url,
            access_token=token.access_token,
            action="pause" if body.action == "stop" else body.action,
            device_id=body.device_id,
        )
    except HTTPException as exc:
        return _playback_action_result_from_http_error(body.action, started_at, exc)
    except SpotifyPlaybackApiError as exc:
        return _playback_action_result_from_api_error(body.action, started_at, exc)
    return ActionResult(
        id=f"playback-{body.action}",
        domain="playback",
        action=body.action,
        state="succeeded",
        mock=False,
        started_at=started_at,
        completed_at=utc_now(),
    )


def playback_queue(settings: Settings, spotify_client: SpotifyClient) -> PlaybackQueueResponse:
    try:
        token = issue_spotify_playback_token(settings, spotify_client)
        payload = spotify_client.fetch_library_json(
            api_base_url=settings.spotify_api_base_url,
            access_token=token.access_token,
            path="/v1/me/player/queue",
        )
    except HTTPException:
        raise
    except SpotifyCatalogApiError:
        raise
    except SpotifyPlaybackApiError as exc:
        raise SpotifyCatalogApiError(SpotifyCatalogApiFailure.NETWORK) from exc

    current = queue_track_item(payload.get("currently_playing"))
    raw_queue = payload.get("queue") if isinstance(payload.get("queue"), list) else []
    items = [item for item in (queue_track_item(raw_item) for raw_item in raw_queue) if item is not None]
    return PlaybackQueueResponse(current=current, items=items, generated_at=utc_now())


def queue_track_item(item: object) -> Optional[LibraryItem]:
    if not isinstance(item, dict) or item.get("type") != "track":
        return None
    uri = str(item.get("uri") or "")
    if not uri.startswith("spotify:track:"):
        return None
    artists = item.get("artists") if isinstance(item.get("artists"), list) else []
    artist_names = [
        str(artist.get("name"))
        for artist in artists
        if isinstance(artist, dict) and artist.get("name")
    ]
    album = item.get("album") if isinstance(item.get("album"), dict) else {}
    images = album.get("images") if isinstance(album.get("images"), list) else []
    artwork_url = next((str(image["url"]) for image in images if isinstance(image, dict) and image.get("url")), None)
    return LibraryItem(
        id=str(item.get("id") or uri),
        type=LibraryItemType.TRACK,
        uri=uri,
        title=str(item.get("name") or "Unknown track"),
        subtitle=", ".join(artist_names) or None,
        artwork_url=artwork_url,
        source=LibraryCategoryId.RECENTLY_PLAYED,
        playback_kind=LibraryPlaybackKind.TRACK,
        playable=True,
    )


def set_unified_volume(
    settings: Settings,
    spotify_client: SpotifyClient,
    volume_adapter: VolumeAdapter,
    body: VolumePatch,
) -> VolumeHealth:
    spotify_reason: Optional[VolumeReason] = None
    os_reason: Optional[VolumeReason] = None
    os_health: Optional[VolumeHealth] = None

    try:
        os_health = volume_adapter.set_volume(body.value, body.muted)
    except VolumeUnavailable as exc:
        os_reason = exc.reason
    except VolumeCommandError as exc:
        os_reason = exc.reason

    if os_health is not None:
        if os_health.status == VolumeStatus.OUT_OF_SYNC:
            return os_health
        return os_health.model_copy(update={"status": VolumeStatus.OS_ONLY, "reason": None})

    try:
        token = issue_spotify_playback_token(settings, spotify_client)
        spotify_client.set_playback_volume(
            api_base_url=settings.spotify_api_base_url,
            access_token=token.access_token,
            volume_percent=body.value,
            device_id=body.device_id,
        )
        return VolumeHealth(
            status=VolumeStatus.SPOTIFY_ONLY,
            reason=os_reason,
            value=body.value,
            muted=body.muted,
        )
    except HTTPException:
        spotify_reason = VolumeReason.SPOTIFY_VOLUME_UNSUPPORTED
    except SpotifyPlaybackApiError as exc:
        spotify_reason = spotify_volume_reason_from_api_error(exc)

    return VolumeHealth(
        status=VolumeStatus.UNAVAILABLE,
        reason=os_reason or spotify_reason or VolumeReason.UNKNOWN,
    )

def spotify_volume_reason_from_api_error(exc: SpotifyPlaybackApiError) -> VolumeReason:
    if exc.failure in {
        SpotifyPlaybackApiFailure.AUTH,
        SpotifyPlaybackApiFailure.PREMIUM_REQUIRED,
        SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND,
    }:
        return VolumeReason.SPOTIFY_VOLUME_UNSUPPORTED
    if exc.failure == SpotifyPlaybackApiFailure.NETWORK:
        return VolumeReason.RECONNECT_RESYNC_NEEDED
    return VolumeReason.UNKNOWN


def _playback_action_result_from_http_error(action: str, started_at, exc: HTTPException) -> ActionResult:
    reason = PlaybackDeviceReason.PREMIUM_REQUIRED if exc.status_code == status.HTTP_403_FORBIDDEN else PlaybackDeviceReason.AUTH_REQUIRED
    return ActionResult(
        id=f"playback-{action}",
        domain="playback",
        action=action,
        state="blocked",
        reason=reason,
        mock=False,
        started_at=started_at,
        completed_at=utc_now(),
    )


def _playback_action_result_from_api_error(action: str, started_at, exc: SpotifyPlaybackApiError) -> ActionResult:
    reason_by_failure = {
        SpotifyPlaybackApiFailure.AUTH: PlaybackDeviceReason.AUTH_REQUIRED,
        SpotifyPlaybackApiFailure.PREMIUM_REQUIRED: PlaybackDeviceReason.PREMIUM_REQUIRED,
        SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND: PlaybackDeviceReason.DEVICE_NOT_REGISTERED,
        SpotifyPlaybackApiFailure.RATE_LIMITED: PlaybackDeviceReason.SPOTIFY_API_ERROR,
        SpotifyPlaybackApiFailure.NETWORK: PlaybackDeviceReason.NETWORK_UNAVAILABLE,
        SpotifyPlaybackApiFailure.INVALID_RESPONSE: PlaybackDeviceReason.SPOTIFY_API_ERROR,
    }
    return ActionResult(
        id=f"playback-{action}",
        domain="playback",
        action=action,
        state="blocked",
        reason=reason_by_failure[exc.failure],
        mock=False,
        started_at=started_at,
        completed_at=utc_now(),
    )


app = create_app()
