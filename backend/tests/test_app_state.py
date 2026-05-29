import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi.testclient import TestClient

from pipzo_api.config import Settings, get_settings
from pipzo_api.database import initialize_database
from pipzo_api.main import create_app
from pipzo_api.spotify_store import StoredSpotifyAccount, StoredSpotifyAuthRecord, SpotifyAuthStore


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
    assert body["health"]["display"]["status"] == "normal"
    assert body["health"]["display"]["brightness"] == 80
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
        "idle_clock",
        "idle_with_artwork",
        "dimmed_bedtime",
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

    assert rows == [("schema_version", "3")]


def test_spotify_auth_store_upserts_reads_and_deletes_single_account_record(tmp_path):
    db_path = tmp_path / "spotify-store.sqlite3"
    store = SpotifyAuthStore(db_path)
    issued_at = datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)

    store.upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token="stored-access-token",
            refresh_token="stored-refresh-token",
            token_type="Bearer",
            scope="streaming user-read-private",
            expires_at=issued_at + timedelta(seconds=3600),
            issued_at=issued_at,
            connected_at=issued_at,
            updated_at=issued_at,
            account=StoredSpotifyAccount(
                account_id="spotify-user-id",
                display_name="Pipzo Account",
                product="premium",
                country="GB",
                is_premium=True,
            ),
        )
    )
    first = store.get_auth_record()

    store.upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token="new-access-token",
            refresh_token="new-refresh-token",
            token_type="Bearer",
            scope="streaming",
            expires_at=issued_at + timedelta(seconds=7200),
            issued_at=issued_at,
            connected_at=issued_at,
            updated_at=issued_at,
            account=StoredSpotifyAccount(
                account_id="spotify-user-id",
                display_name="Updated Account",
                product="free",
                country="GB",
                is_premium=False,
            ),
        )
    )
    updated = store.get_auth_record()
    store.delete_auth_record()

    assert first is not None
    assert first.account.display_name == "Pipzo Account"
    assert updated is not None
    assert updated.access_token == "new-access-token"
    assert updated.refresh_token == "new-refresh-token"
    assert updated.account.display_name == "Updated Account"
    assert updated.account.is_premium is False
    assert store.get_auth_record() is None


def test_app_state_maps_revoked_spotify_auth_to_safe_reconnect_warning(tmp_path):
    db_path = tmp_path / "spotify-revoked.sqlite3"
    settings = Settings(db_path=str(db_path), pipzo_token_key_path=str(tmp_path / "spotify-token.key"))
    now = datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)
    SpotifyAuthStore.from_settings(settings).upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token="",
            refresh_token="stored-refresh-token",
            token_type="Bearer",
            scope="streaming",
            expires_at=now - timedelta(seconds=1),
            issued_at=now - timedelta(hours=1),
            connected_at=now - timedelta(hours=1),
            updated_at=now,
            account=StoredSpotifyAccount(
                account_id="spotify-user-id",
                display_name="Pipzo Account",
                product="premium",
                country="GB",
                is_premium=True,
            ),
            last_refresh_error_code="revoked",
            revoked_at=now,
        )
    )

    with make_client(settings) as client:
        response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    body = response.json()
    assert body["health"]["spotifyAuth"] == {
        "status": "reconnect_required",
        "reason": "revoked",
        "accountDisplayName": None,
    }
    assert body["readiness"]["spotifyAuthorized"] is False
    assert any(warning["code"] == "spotify_reconnect_required" for warning in body["warnings"])
    assert "stored-refresh-token" not in str(body)


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


def test_events_websocket_sends_initial_snapshot_and_action_event(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "events.sqlite3"))) as client:
        with client.websocket_connect("/api/v1/events/ws") as websocket:
            initial = websocket.receive_json()

            assert initial["type"] == "app.snapshot"
            assert initial["payload"]["schemaVersion"] == "v1"

            response = client.patch("/api/v1/settings", json={"idleMode": "clock_with_artwork", "artworkInIdle": True})
            assert response.status_code == 200

            event = websocket.receive_json()

    assert event["type"] == "settings.changed"
    assert event["payload"]["idleMode"] == "clock_with_artwork"


def test_setup_start_and_complete_validate_mock_readiness(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "setup.sqlite3"))) as client:
        start_response = client.post("/api/v1/setup/start")
        complete_response = client.post("/api/v1/setup/complete")

        client.post("/api/v1/mock/scenarios/ready_healthy/activate")
        ready_complete_response = client.post("/api/v1/setup/complete")

    assert start_response.status_code == 200
    assert start_response.json()["blockingStep"] == "wifi"
    assert complete_response.status_code == 409
    assert ready_complete_response.status_code == 200
    assert ready_complete_response.json()["readiness"]["minimumReady"] is True


def test_settings_get_and_patch_existing_fields(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "settings.sqlite3"))) as client:
        get_response = client.get("/api/v1/settings")
        patch_response = client.patch(
            "/api/v1/settings",
            json={"idleTimeoutSeconds": 120, "defaultSleepTimerMinutes": 30},
        )
        state_response = client.get("/api/v1/app/state")

    assert get_response.status_code == 200
    assert get_response.json()["idleMode"] == "clock"
    assert patch_response.status_code == 200
    assert patch_response.json()["idleTimeoutSeconds"] == 120
    assert patch_response.json()["defaultSleepTimerMinutes"] == 30
    assert state_response.json()["settings"]["idleTimeoutSeconds"] == 120


def test_settings_persist_in_sqlite_across_app_instances(tmp_path):
    settings = Settings(db_path=str(tmp_path / "durable-settings.sqlite3"))

    with make_client(settings) as client:
        patch_response = client.patch(
            "/api/v1/settings",
            json={"idleMode": "clock_with_artwork", "brightness": 33, "artworkInIdle": True},
        )

    with make_client(settings) as client:
        get_response = client.get("/api/v1/settings")
        state_response = client.get("/api/v1/app/state")

    assert patch_response.status_code == 200
    assert get_response.status_code == 200
    assert get_response.json()["idleMode"] == "clock_with_artwork"
    assert get_response.json()["brightness"] == 33
    assert state_response.json()["settings"]["artworkInIdle"] is True
    assert state_response.json()["surfaces"]["idleMode"] == "clock_with_artwork"
    assert state_response.json()["health"]["display"]["brightness"] == 33


def test_settings_are_available_in_hardware_mode_without_faking_device_actions(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-settings.sqlite3"))

    with make_client(settings) as client:
        get_response = client.get("/api/v1/settings")
        patch_response = client.patch("/api/v1/settings", json={"idleTimeoutSeconds": 180})
        display_response = client.patch("/api/v1/display", json={"brightness": 10})

    assert get_response.status_code == 200
    assert patch_response.status_code == 200
    assert patch_response.json()["idleTimeoutSeconds"] == 180
    assert display_response.status_code == 501


def test_display_mock_state_can_be_adjusted(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "display.sqlite3"))) as client:
        client.post("/api/v1/mock/scenarios/ready_healthy/activate")

        response = client.patch("/api/v1/display", json={"brightness": 25, "status": "dimmed"})
        state_response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    assert response.json()["brightness"] == 25
    assert response.json()["status"] == "dimmed"
    assert response.json()["reason"] == "user_setting"
    assert state_response.json()["health"]["display"]["brightness"] == 25
    assert state_response.json()["settings"]["brightness"] == 25


def test_display_scenarios_cover_idle_and_bedtime_state(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "display-scenarios.sqlite3"))) as client:
        idle_clock = client.post("/api/v1/mock/scenarios/idle_clock/activate").json()
        idle_artwork = client.post("/api/v1/mock/scenarios/idle_with_artwork/activate").json()
        bedtime = client.post("/api/v1/mock/scenarios/dimmed_bedtime/activate").json()

    assert idle_clock["surfaces"]["current"] == "idle"
    assert idle_clock["health"]["display"]["status"] == "dimmed"
    assert idle_clock["settings"]["artworkInIdle"] is False
    assert idle_artwork["surfaces"]["idleMode"] == "clock_with_artwork"
    assert idle_artwork["settings"]["artworkInIdle"] is True
    assert bedtime["health"]["display"]["brightness"] == bedtime["settings"]["bedtimeBrightness"]
    assert bedtime["health"]["display"]["reason"] == "bedtime"


def test_playback_control_reports_mock_success_and_unavailable_state(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "playback.sqlite3"))) as client:
        client.post("/api/v1/mock/scenarios/ready_healthy/activate")
        ready_response = client.post("/api/v1/playback/control", json={"action": "play"})

        client.post("/api/v1/mock/scenarios/speaker_saved_disconnected/activate")
        unavailable_response = client.post("/api/v1/playback/control", json={"action": "play"})

    assert ready_response.status_code == 200
    assert ready_response.json()["state"] == "succeeded"
    assert ready_response.json()["mock"] is True
    assert unavailable_response.status_code == 200
    assert unavailable_response.json()["state"] == "blocked"
    assert unavailable_response.json()["reason"] == "speaker_unavailable"


def test_playback_test_and_recovery_actions_are_mockable(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "recovery.sqlite3"))) as client:
        client.post("/api/v1/mock/scenarios/ready_healthy/activate")

        playback_test_response = client.post("/api/v1/setup/playback-test", json={"action": "start"})
        actions_response = client.get("/api/v1/recovery/actions")
        reset_without_confirm = client.post("/api/v1/recovery/actions/reset-app/run", json={"confirm": False})
        reset_with_confirm = client.post("/api/v1/recovery/actions/reset-app/run", json={"confirm": True})
        state_response = client.get("/api/v1/app/state")

    assert playback_test_response.status_code == 200
    assert playback_test_response.json()["kind"] == "run_playback_test"
    assert playback_test_response.json()["state"] == "succeeded"
    assert actions_response.status_code == 200
    assert any(action["id"] == "reset-app" for action in actions_response.json())
    assert reset_without_confirm.json()["state"] == "confirm_required"
    assert reset_with_confirm.json()["state"] == "succeeded"
    assert state_response.json()["appPhase"] == "setup"


def test_hardware_mode_does_not_fake_state_changing_actions(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-actions.sqlite3"))

    with make_client(settings) as client:
        responses = [
            client.post("/api/v1/setup/start"),
            client.post("/api/v1/setup/complete"),
            client.post("/api/v1/setup/playback-test", json={"action": "start"}),
            client.patch("/api/v1/display", json={"brightness": 10}),
            client.post("/api/v1/playback/control", json={"action": "pause"}),
            client.post("/api/v1/network/scan"),
            client.get("/api/v1/network/scan-results"),
            client.post("/api/v1/network/connect", json={"ssid": "PipzoNet", "password": "secret"}),
            client.post("/api/v1/network/forget", json={"ssid": "PipzoNet", "confirm": True}),
            client.post("/api/v1/network/retry-internet-probe"),
            client.post("/api/v1/speaker/scan"),
            client.get("/api/v1/speaker/scan-results"),
            client.post("/api/v1/speaker/pair", json={"address": "AA:BB:CC:DD:EE:FF"}),
            client.post("/api/v1/speaker/reconnect"),
            client.post("/api/v1/speaker/forget", json={"address": "AA:BB:CC:DD:EE:FF", "confirm": True}),
            client.post("/api/v1/recovery/actions/reset-app/run", json={"confirm": True}),
        ]

    assert all(response.status_code == 501 for response in responses)
