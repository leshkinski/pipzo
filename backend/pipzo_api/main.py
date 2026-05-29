from contextlib import asynccontextmanager
from pathlib import Path
from time import perf_counter
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .adapters import create_app_state_adapter
from .adapters.production import ProductionAdapterNotImplemented
from .config import Settings, get_settings
from .contract import (
    ActionResult,
    AppSettings,
    AppSettingsPatch,
    AppSnapshot,
    DisplayHealth,
    DisplayPatch,
    HealthResponse,
    NetworkConnectRequest,
    NetworkForgetRequest,
    NetworkHealth,
    PlaybackControlRequest,
    RecoveryAction,
    RunRecoveryActionRequest,
    ScenarioSummary,
    SpeakerForgetRequest,
    SpeakerHealth,
    SpeakerPairRequest,
    SpeakerScanResults,
    SetupPlaybackTestRequest,
    SetupState,
    SpotifyAuthSession,
    SpotifyAuthHealth,
    SpotifyAuthReason,
    SpotifyAuthStatus,
    Warning,
    WifiScanResults,
    utc_now,
)
from .database import initialize_database
from .events import EventHub
from .logging import configure_logging, get_logger
from .mock_scenarios import MockScenarioStore
from .settings_store import AppSettingsStore
from .spotify_auth import (
    SpotifyAuthCallbackError,
    SpotifyAuthSessionService,
    SpotifyClient,
    SpotifyTokenExchangeError,
    UrlLibSpotifyClient,
    exchange_and_persist_spotify_callback,
    spotify_auth_health_from_record,
)
from .spotify_store import SpotifyAuthStore, SpotifyAuthTokenStorageError


def create_app(
    settings_override: Optional[Settings] = None,
    spotify_auth_sessions_override: Optional[SpotifyAuthSessionService] = None,
    spotify_client_override: Optional[SpotifyClient] = None,
) -> FastAPI:
    mock_store = MockScenarioStore()
    event_hub = EventHub()
    spotify_auth_sessions = spotify_auth_sessions_override or SpotifyAuthSessionService()
    spotify_client = spotify_client_override or UrlLibSpotifyClient()

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
        return read_snapshot(settings, mock_store, settings_store())

    @app.websocket("/api/v1/events/ws")
    async def events_ws(websocket: WebSocket, settings: Settings = Depends(get_settings)) -> None:
        try:
            initial_snapshot = read_snapshot(settings, mock_store, settings_store())
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
        require_action_mock_mode(settings)
        action = mock_store.run_playback_test(body.action)
        event_hub.publish("setup.playback_test_changed", action.model_dump(mode="json", by_alias=True))
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
            event_hub.publish("app.snapshot", read_snapshot(settings, mock_store, settings_store()).model_dump(mode="json", by_alias=True))
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
        require_action_mock_mode(settings)
        result = mock_store.control_playback(body.action)
        event_hub.publish("playback.control_changed", result.model_dump(mode="json", by_alias=True))
        return result

    @app.get("/api/v1/network/status", response_model=NetworkHealth)
    def network_status(settings: Settings = Depends(get_settings)) -> NetworkHealth:
        return read_snapshot(settings, mock_store, settings_store()).health.network

    @app.post("/api/v1/network/scan", response_model=RecoveryAction)
    def network_scan(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Wi-Fi scan")

    @app.get("/api/v1/network/scan-results", response_model=WifiScanResults)
    def network_scan_results(settings: Settings = Depends(get_settings)) -> WifiScanResults:
        raise_device_adapter_unavailable("Wi-Fi scan results")

    @app.post("/api/v1/network/connect", response_model=RecoveryAction)
    def network_connect(body: NetworkConnectRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Wi-Fi connect")

    @app.post("/api/v1/network/forget", response_model=RecoveryAction)
    def network_forget(body: NetworkForgetRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Wi-Fi forget")

    @app.post("/api/v1/network/retry-internet-probe", response_model=RecoveryAction)
    def network_retry_internet_probe(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("internet probe retry")

    @app.get("/api/v1/speaker/status", response_model=SpeakerHealth)
    def speaker_status(settings: Settings = Depends(get_settings)) -> SpeakerHealth:
        return read_snapshot(settings, mock_store, settings_store()).health.speaker

    @app.post("/api/v1/speaker/scan", response_model=RecoveryAction)
    def speaker_scan(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Bluetooth speaker scan")

    @app.get("/api/v1/speaker/scan-results", response_model=SpeakerScanResults)
    def speaker_scan_results(settings: Settings = Depends(get_settings)) -> SpeakerScanResults:
        raise_device_adapter_unavailable("Bluetooth speaker scan results")

    @app.post("/api/v1/speaker/pair", response_model=RecoveryAction)
    def speaker_pair(body: SpeakerPairRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Bluetooth speaker pair")

    @app.post("/api/v1/speaker/reconnect", response_model=RecoveryAction)
    def speaker_reconnect(settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Bluetooth speaker reconnect")

    @app.post("/api/v1/speaker/forget", response_model=RecoveryAction)
    def speaker_forget(body: SpeakerForgetRequest, settings: Settings = Depends(get_settings)) -> RecoveryAction:
        raise_device_adapter_unavailable("Bluetooth speaker forget")

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
            return HTMLResponse(
                "<!doctype html><title>Pipzo Spotify setup</title><p>Spotify setup could not be completed. Return to Pipzo and start again.</p>",
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
        return HTMLResponse(
            "<!doctype html><title>Pipzo Spotify setup</title><p>Spotify setup is complete. Return to Pipzo to continue.</p>",
            status_code=status.HTTP_200_OK,
        )

    @app.post("/api/v1/spotify/auth/logout", response_model=SpotifyAuthHealth)
    def spotify_auth_logout(settings: Settings = Depends(get_settings)) -> SpotifyAuthHealth:
        return clear_spotify_auth_state(settings, spotify_auth_sessions, event_hub, mock_store)

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


def require_spotify_oauth_config(settings: Settings) -> None:
    if not settings.spotify_client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Spotify client ID is not configured",
        )


def read_snapshot(settings: Settings, mock_store: MockScenarioStore, app_settings_store: AppSettingsStore) -> AppSnapshot:
    adapter = create_app_state_adapter(settings, mock_store)
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
    try:
        auth_record = SpotifyAuthStore.from_settings(settings).get_auth_record()
    except SpotifyAuthTokenStorageError:
        snapshot.health.spotify_auth = SpotifyAuthHealth(
            status=SpotifyAuthStatus.RECONNECT_REQUIRED,
            reason=SpotifyAuthReason.TOKEN_REFRESH_FAILED,
        )
        snapshot.readiness.spotify_authorized = False
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
        if snapshot.health.spotify_auth.status == SpotifyAuthStatus.RECONNECT_REQUIRED:
            snapshot.warnings.append(
                Warning(
                    code="spotify_reconnect_required",
                    reason=snapshot.health.spotify_auth.reason,
                    surface=snapshot.surfaces.current,
                    action="spotify_reconnect",
                )
            )
    return snapshot


def clear_spotify_auth_state(
    settings: Settings,
    spotify_auth_sessions: SpotifyAuthSessionService,
    event_hub: EventHub,
    mock_store: MockScenarioStore,
) -> SpotifyAuthHealth:
    SpotifyAuthStore.from_settings(settings).delete_auth_record()
    spotify_auth_sessions.clear_sessions()
    health = SpotifyAuthHealth(status=SpotifyAuthStatus.NONE, reason=SpotifyAuthReason.NO_SESSION)
    event_hub.publish("spotify.auth_changed", health.model_dump(mode="json", by_alias=True))
    event_hub.publish("app.snapshot", read_snapshot(settings, mock_store, AppSettingsStore(settings.db_path)).model_dump(mode="json", by_alias=True))
    return health


app = create_app()
