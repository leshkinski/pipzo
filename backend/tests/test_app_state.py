from fastapi.testclient import TestClient

from pipzo_api.config import get_settings
from pipzo_api.main import app


client = TestClient(app)


def test_health_reports_mock_mode_by_default():
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] == "mock"
    assert body["schemaVersion"] == "v1"


def test_app_state_returns_first_boot_snapshot_contract():
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


def test_mock_scenarios_include_required_initial_set():
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


def test_activating_mock_scenario_updates_app_state():
    response = client.post("/api/v1/mock/scenarios/speaker_saved_disconnected/activate")

    assert response.status_code == 200
    body = response.json()
    assert body["health"]["speaker"]["status"] == "saved_disconnected"
    assert body["warnings"][0]["code"] == "speaker_disconnected"

    state = client.get("/api/v1/app/state").json()
    assert state["health"]["speaker"]["status"] == "saved_disconnected"


def test_unknown_mock_scenario_returns_404():
    response = client.post("/api/v1/mock/scenarios/not_real/activate")

    assert response.status_code == 404


def test_mock_endpoints_are_disabled_in_hardware_mode(monkeypatch):
    monkeypatch.setenv("PIPZO_MODE", "hardware")
    get_settings.cache_clear()

    try:
        mock_response = client.get("/api/v1/mock/scenarios")
        state_response = client.get("/api/v1/app/state")
    finally:
        get_settings.cache_clear()

    assert mock_response.status_code == 404
    assert state_response.status_code == 501
