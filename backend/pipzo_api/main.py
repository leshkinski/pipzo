from fastapi import Depends, FastAPI, HTTPException, status

from .config import Settings, get_settings
from .contract import AppSnapshot, HealthResponse, ScenarioSummary, utc_now
from .mock_scenarios import MockScenarioStore


mock_store = MockScenarioStore()


def create_app() -> FastAPI:
    app = FastAPI(title="Pipzo API", version="0.1.0")

    @app.get("/api/v1/health", response_model=HealthResponse)
    def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
        return HealthResponse(mode=settings.app_mode, checked_at=utc_now())

    @app.get("/api/v1/app/state", response_model=AppSnapshot)
    def app_state(settings: Settings = Depends(get_settings)) -> AppSnapshot:
        if settings.app_mode == "mock":
            return mock_store.get_snapshot()
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Hardware adapters are not implemented yet; run with PIPZO_MODE=mock for desktop scenarios.",
        )

    @app.get("/api/v1/mock/scenarios", response_model=list[ScenarioSummary])
    def list_mock_scenarios(settings: Settings = Depends(get_settings)) -> list[ScenarioSummary]:
        require_mock_mode(settings)
        return mock_store.list_scenarios()

    @app.post("/api/v1/mock/scenarios/{scenario_id}/activate", response_model=AppSnapshot)
    def activate_mock_scenario(scenario_id: str, settings: Settings = Depends(get_settings)) -> AppSnapshot:
        require_mock_mode(settings)
        try:
            return mock_store.activate(scenario_id)
        except KeyError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown mock scenario") from exc

    return app


def require_mock_mode(settings: Settings) -> None:
    if settings.app_mode != "mock":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mock endpoints are disabled outside mock mode")


app = create_app()
