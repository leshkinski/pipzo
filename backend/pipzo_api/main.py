from contextlib import asynccontextmanager
from time import perf_counter
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status

from .adapters import create_app_state_adapter
from .adapters.production import ProductionAdapterNotImplemented
from .config import Settings, get_settings
from .contract import AppSnapshot, HealthResponse, ScenarioSummary, utc_now
from .database import initialize_database
from .logging import configure_logging, get_logger
from .mock_scenarios import MockScenarioStore


def create_app(settings_override: Optional[Settings] = None) -> FastAPI:
    mock_store = MockScenarioStore()

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
        adapter = create_app_state_adapter(settings, mock_store)
        try:
            return adapter.get_snapshot()
        except ProductionAdapterNotImplemented as exc:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Hardware adapters are not implemented yet; run with PIPZO_MODE=mock for desktop scenarios.",
            ) from exc

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
            return mock_store.activate(scenario_id)
        except KeyError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown mock scenario") from exc

    return app


def require_mock_mode(settings: Settings) -> None:
    if settings.app_mode != "mock":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mock endpoints are disabled outside mock mode")


app = create_app()
