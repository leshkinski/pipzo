import logging
import sqlite3
from typing import Optional

from fastapi.testclient import TestClient

from pipzo_api.config import Settings, get_settings
from pipzo_api.database import initialize_database
from pipzo_api.main import create_app


def make_client(settings: Optional[Settings] = None) -> TestClient:
    app = create_app(settings_override=settings)
    return TestClient(app)


def test_health_reports_mock_mode_by_default(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "health.sqlite3"))) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] == "mock"
    assert body["schemaVersion"] == "v1"


def test_app_state_returns_first_boot_snapshot_contract(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "app-state.sqlite3"))) as client:
        client.post("/api/v1/mock/scenarios/first_boot_empty/activate")

        response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    body = response.json()
    assert body["schemaVersion"] == "v1"
    assert body["appPhase"] == "setup"
    assert body["setup"]["blockingStep"] == "wifi"
    assert body["readiness"]["minimumReady"] is False
    assert body["health"]["speaker"]["status"] == "none_saved"
    assert body["capabilities"]["canOpenSettings"] is True


def test_mock_scenarios_include_required_initial_set(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "scenarios.sqlite3"))) as client:
        response = client.get("/api/v1/mock/scenarios")

    assert response.status_code == 200
    scenario_ids = {scenario["id"] for scenario in response.json()}
    assert {
        "first_boot_empty",
        "ready_healthy",
        "degraded_recovery",
        "speaker_saved_disconnected",
        "wifi_local_only",
        "volume_out_of_sync",
        "boot_probe_delayed",
    }.issubset(scenario_ids)


def test_activating_mock_scenario_updates_app_state(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "activate.sqlite3"))) as client:
        response = client.post("/api/v1/mock/scenarios/speaker_saved_disconnected/activate")

        assert response.status_code == 200
        body = response.json()
        assert body["health"]["speaker"]["status"] == "saved_disconnected"
        assert body["warnings"][0]["code"] == "speaker_disconnected"

        state = client.get("/api/v1/app/state").json()
    assert state["health"]["speaker"]["status"] == "saved_disconnected"


def test_unknown_mock_scenario_returns_404(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "unknown.sqlite3"))) as client:
        response = client.post("/api/v1/mock/scenarios/not_real/activate")

    assert response.status_code == 404


def test_mock_endpoints_are_disabled_in_hardware_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("PIPZO_MODE", "hardware")
    get_settings.cache_clear()

    try:
        settings = Settings(db_path=str(tmp_path / "hardware.sqlite3"))
        with make_client(settings) as client:
            mock_response = client.get("/api/v1/mock/scenarios")
            state_response = client.get("/api/v1/app/state")
    finally:
        get_settings.cache_clear()

    assert mock_response.status_code == 404
    assert state_response.status_code == 501


def test_database_initialization_creates_schema_marker_and_is_idempotent(tmp_path):
    db_path = tmp_path / "pipzo.sqlite3"

    first_result = initialize_database(db_path)
    second_result = initialize_database(db_path)

    assert first_result.db_path == db_path
    assert second_result.db_path == db_path

    with sqlite3.connect(db_path) as connection:
        rows = connection.execute("select key, value from schema_metadata").fetchall()

    assert rows == [("schema_version", "1")]


def test_app_startup_initializes_configured_database(tmp_path):
    db_path = tmp_path / "startup.sqlite3"
    settings = Settings(db_path=str(db_path))

    with make_client(settings) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert db_path.exists()


def test_config_drives_structured_logging_level(tmp_path):
    db_path = tmp_path / "logging.sqlite3"
    settings = Settings(db_path=str(db_path), log_level="DEBUG")

    with make_client(settings) as client:
        client.get("/api/v1/health")

    assert logging.getLogger("pipzo").getEffectiveLevel() == logging.DEBUG
