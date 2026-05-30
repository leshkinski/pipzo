import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi.testclient import TestClient

from pipzo_api.config import Settings, get_settings
from pipzo_api.contract import (
    NetworkHealth,
    RecoveryAction,
    RecoveryActionKind,
    RecoveryActionState,
    SpeakerDevice,
    SpeakerHealth,
    SpeakerScanResults,
    SpeakerSummary,
    VolumeHealth,
    VolumeReason,
    WifiNetwork,
    WifiScanResults,
    utc_now,
)
from pipzo_api.database import initialize_database
from pipzo_api.adapters.volume import VolumeUnavailable
from pipzo_api.main import create_app
from pipzo_api.spotify_store import StoredSpotifyAccount, StoredSpotifyAuthRecord, SpotifyAuthStore


def make_client(settings: Optional[Settings] = None, **overrides) -> TestClient:
    app = create_app(settings_override=settings, **overrides)
    return TestClient(app)


class FakeNetworkAdapter:
    def __init__(self) -> None:
        self.connected_ssid = "PipzoNet"

    def probe(self) -> None:
        return None

    def status(self) -> NetworkHealth:
        return NetworkHealth(status="online", ssid=self.connected_ssid, ip_address="192.168.1.42", internet_reachable=True)

    def scan(self) -> RecoveryAction:
        return self._action("network-scan", "succeeded")

    def scan_results(self, rescan: bool = False) -> WifiScanResults:
        return WifiScanResults(
            networks=[WifiNetwork(ssid="PipzoNet", signal=91, security="wpa2", known=True)],
            scanned_at=utc_now(),
        )

    def connect(self, ssid: str, password: Optional[str], hidden: bool = False) -> RecoveryAction:
        self.connected_ssid = ssid
        return self._action("network-connect", "succeeded")

    def forget(self, ssid: str) -> RecoveryAction:
        self.connected_ssid = ""
        return RecoveryAction(
            id="network-forget",
            kind=RecoveryActionKind.FORGET_WIFI,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=utc_now(),
            completed_at=utc_now(),
        )

    def retry_internet_probe(self) -> RecoveryAction:
        return self._action("network-internet-probe", "succeeded")

    def _action(self, action_id: str, state: str) -> RecoveryAction:
        return RecoveryAction(
            id=action_id,
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=state,
            requires_confirmation=False,
            started_at=utc_now(),
            completed_at=utc_now(),
        )


class FakeBluetoothAdapter:
    def __init__(self) -> None:
        self.primary = SpeakerSummary(
            address="AA:BB:CC:DD:EE:FF",
            display_name="Pipzo Speaker",
            alias="Bedroom speaker",
            connected=True,
        )
        self.connected = True

    def probe(self) -> None:
        return None

    def status(self) -> SpeakerHealth:
        primary = self.primary.model_copy(update={"connected": self.connected})
        return SpeakerHealth(status="connected" if self.connected else "saved_disconnected", reason=None if self.connected else "device_out_of_range", primary=primary)

    def scan(self) -> RecoveryAction:
        return self._action("speaker-scan", "succeeded")

    def scan_results(self) -> SpeakerScanResults:
        return SpeakerScanResults(
            devices=[
                SpeakerDevice(
                    address=self.primary.address,
                    display_name=self.primary.display_name,
                    alias=self.primary.alias,
                    paired=True,
                    connected=self.connected,
                    signal=88,
                )
            ],
            scanned_at=utc_now(),
        )

    def pair(self, address: str, display_name: Optional[str] = None) -> RecoveryAction:
        self.primary = SpeakerSummary(address=address, display_name=display_name or "Selected Speaker", connected=True)
        self.connected = True
        return self._action("speaker-pair", "succeeded")

    def reconnect(self) -> RecoveryAction:
        self.connected = True
        return self._action("speaker-reconnect", "succeeded")

    def forget(self, address: str) -> RecoveryAction:
        self.connected = False
        return RecoveryAction(
            id="speaker-forget",
            kind=RecoveryActionKind.FORGET_SPEAKER,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=utc_now(),
            completed_at=utc_now(),
        )

    def _action(self, action_id: str, state: str) -> RecoveryAction:
        return RecoveryAction(
            id=action_id,
            kind=RecoveryActionKind.RECONNECT_SPEAKER,
            state=state,
            requires_confirmation=False,
            started_at=utc_now(),
            completed_at=utc_now(),
        )


class FakeVolumeAdapter:
    def __init__(self, status: Optional[VolumeHealth] = None, unavailable_reason: Optional[VolumeReason] = None) -> None:
        self.health = status or VolumeHealth(status="os_only", value=38, muted=False)
        self.unavailable_reason = unavailable_reason
        self.set_calls: list[tuple[int, bool]] = []

    def probe(self) -> None:
        return None

    def status(self) -> VolumeHealth:
        if self.unavailable_reason is not None:
            raise VolumeUnavailable(self.unavailable_reason)
        return self.health

    def set_volume(self, value: int, muted: bool = False) -> VolumeHealth:
        self.set_calls.append((value, muted))
        self.health = VolumeHealth(status="os_only", value=value, muted=muted)
        return self.health


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
        "offline_settings_mode",
        "spotify_auth_unavailable",
        "device_connectivity_degraded",
        "speaker_saved_disconnected",
        "wifi_local_only",
        "volume_out_of_sync",
        "boot_probe_delayed",
        "idle_clock",
        "idle_with_artwork",
        "dimmed_bedtime",
    }.issubset(scenario_ids)


def test_degraded_mock_scenarios_keep_recovery_surfaces_available(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "degraded-scenarios.sqlite3"))) as client:
        offline = client.post("/api/v1/mock/scenarios/offline_settings_mode/activate").json()
        spotify = client.post("/api/v1/mock/scenarios/spotify_auth_unavailable/activate").json()
        device = client.post("/api/v1/mock/scenarios/device_connectivity_degraded/activate").json()

    for body in (offline, spotify, device):
        assert body["appPhase"] == "degraded"
        assert body["capabilities"]["canOpenSettings"] is True
        assert body["surfaces"]["current"] == "settings"
        assert any(action["kind"] == "reset_app" for action in body["recoveryActions"])
        assert body["capabilities"]["canStartPlayback"] is False

    assert any(action["kind"] == "connect_wifi" for action in offline["recoveryActions"])
    assert any(action["kind"] == "start_spotify_auth" for action in spotify["recoveryActions"])
    assert any(action["kind"] == "reconnect_speaker" for action in device["recoveryActions"])


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
    assert state_response.status_code == 200
    assert state_response.json()["health"]["network"]["status"] == "error"


def test_database_initialization_creates_schema_marker_and_is_idempotent(tmp_path):
    db_path = tmp_path / "pipzo.sqlite3"

    first_result = initialize_database(db_path)
    second_result = initialize_database(db_path)

    assert first_result.db_path == db_path
    assert second_result.db_path == db_path

    with sqlite3.connect(db_path) as connection:
        rows = connection.execute("select key, value from schema_metadata").fetchall()

    assert rows == [("schema_version", "5")]


def persist_connected_spotify(settings: Settings) -> None:
    now = datetime.now(timezone.utc)
    SpotifyAuthStore.from_settings(settings).upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token="stored-access-token",
            refresh_token="stored-refresh-token",
            token_type="Bearer",
            scope="streaming user-read-private user-modify-playback-state",
            expires_at=now + timedelta(seconds=3600),
            issued_at=now,
            connected_at=now,
            updated_at=now,
            account=StoredSpotifyAccount(
                account_id="spotify-user-id",
                display_name="Pipzo Account",
                product="premium",
                country="GB",
                is_premium=True,
            ),
        )
    )


class FakeSpotifyPlaybackClient:
    def __init__(self, current_playback: Optional[dict] = None) -> None:
        self.transfer_calls: list[dict] = []
        self.start_playback_calls: list[dict] = []
        self.current_playback = current_playback
        self.current_playback_calls: list[dict] = []

    def transfer_playback(self, *, api_base_url: str, access_token: str, device_id: str, play: bool) -> None:
        self.transfer_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
                "device_id": device_id,
                "play": play,
            }
        )

    def fetch_current_playback(self, *, api_base_url: str, access_token: str) -> Optional[dict]:
        self.current_playback_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
            }
        )
        return self.current_playback

    def start_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
        playback_kind: str,
        uri: str,
        device_id: Optional[str],
    ) -> None:
        self.start_playback_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
                "playback_kind": playback_kind,
                "uri": uri,
                "device_id": device_id,
            }
        )


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


def test_configured_frontend_dist_serves_built_index(tmp_path):
    frontend_dist = tmp_path / "frontend-dist"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text("<!doctype html><title>Pipzo kiosk</title>", encoding="utf-8")
    settings = Settings(db_path=str(tmp_path / "frontend.sqlite3"), pipzo_frontend_dist=str(frontend_dist))

    with make_client(settings) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "Pipzo kiosk" in response.text


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


def test_mock_volume_patch_updates_projected_app_state(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "volume-mock.sqlite3"))) as client:
        client.post("/api/v1/mock/scenarios/ready_healthy/activate")

        response = client.patch("/api/v1/volume", json={"value": 27, "muted": True})
        state_response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    assert response.json() == {"status": "unified", "reason": None, "value": 27, "muted": True}
    assert state_response.json()["health"]["volume"] == response.json()


def test_hardware_app_state_projects_volume_adapter_status(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-volume.sqlite3"))
    volume = FakeVolumeAdapter(VolumeHealth(status="os_only", value=38, muted=False))

    with make_client(
        settings,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=volume,
    ) as client:
        response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    assert response.json()["health"]["volume"] == {
        "status": "os_only",
        "reason": None,
        "value": 38,
        "muted": False,
    }
    assert response.json()["capabilities"]["canControlVolume"] is True


def test_hardware_app_state_preserves_volume_adapter_unavailable_reason(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-volume-unavailable.sqlite3"))
    volume = FakeVolumeAdapter(unavailable_reason=VolumeReason.AUDIO_SESSION_UNAVAILABLE)

    with make_client(
        settings,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=volume,
    ) as client:
        response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    assert response.json()["health"]["volume"] == {
        "status": "unavailable",
        "reason": "audio_session_unavailable",
        "value": None,
        "muted": None,
    }
    assert response.json()["capabilities"]["canControlVolume"] is False


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


def test_network_mock_scan_connect_retry_and_forget_update_state(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "network-mock.sqlite3"))) as client:
        scan_response = client.post("/api/v1/network/scan")
        scan_results_response = client.get("/api/v1/network/scan-results")
        connect_response = client.post("/api/v1/network/connect", json={"ssid": "PipzoNet", "password": "secret"})
        connected_state = client.get("/api/v1/app/state").json()
        forget_response = client.post("/api/v1/network/forget", json={"ssid": "PipzoNet", "confirm": True})
        forgotten_state = client.get("/api/v1/app/state").json()

    assert scan_response.status_code == 200
    assert scan_response.json()["state"] == "succeeded"
    assert scan_results_response.status_code == 200
    assert scan_results_response.json()["networks"][0]["ssid"] == "PipzoNet"
    assert connect_response.status_code == 200
    assert connect_response.json()["state"] == "succeeded"
    assert connected_state["health"]["network"]["status"] == "online"
    assert connected_state["health"]["network"]["ipAddress"] == "192.168.1.42"
    assert connected_state["setup"]["blockingStep"] == "spotify_auth"
    assert forget_response.status_code == 200
    assert forgotten_state["health"]["network"]["status"] == "offline"
    assert forgotten_state["setup"]["blockingStep"] == "wifi"


def test_speaker_mock_scan_pair_reconnect_and_forget_update_state(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "speaker-mock.sqlite3"))) as client:
        scan_response = client.post("/api/v1/speaker/scan")
        scan_results_response = client.get("/api/v1/speaker/scan-results")
        pair_response = client.post(
            "/api/v1/speaker/pair",
            json={"address": "AA:BB:CC:DD:EE:FF", "displayName": "Bedroom speaker"},
        )
        paired_state = client.get("/api/v1/app/state").json()
        reconnect_response = client.post("/api/v1/speaker/reconnect")
        forget_response = client.post("/api/v1/speaker/forget", json={"address": "AA:BB:CC:DD:EE:FF", "confirm": True})
        forgotten_state = client.get("/api/v1/app/state").json()

    assert scan_response.status_code == 200
    assert scan_response.json()["state"] == "succeeded"
    assert scan_results_response.status_code == 200
    assert scan_results_response.json()["devices"][0]["displayName"] == "Pipzo Speaker"
    assert pair_response.status_code == 200
    assert pair_response.json()["state"] == "succeeded"
    assert paired_state["health"]["speaker"]["status"] == "connected"
    assert paired_state["readiness"]["primarySpeakerSaved"] is True
    assert reconnect_response.json()["state"] == "succeeded"
    assert forget_response.json()["state"] == "succeeded"
    assert forgotten_state["health"]["speaker"]["status"] == "none_saved"
    assert forgotten_state["readiness"]["minimumReady"] is False


def test_network_mock_maps_bad_password_without_echoing_secret(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "network-bad-password.sqlite3"))) as client:
        response = client.post("/api/v1/network/connect", json={"ssid": "Bad Password", "password": "wrong"})

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "failed"
    assert body["reason"] == "bad_credentials"
    assert "wrong" not in str(body)


def test_hardware_mode_does_not_fake_state_changing_actions(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-actions.sqlite3"))

    with make_client(settings) as client:
        responses = [
            client.post("/api/v1/setup/start"),
            client.post("/api/v1/setup/complete"),
            client.post("/api/v1/setup/playback-test", json={"action": "start"}),
            client.patch("/api/v1/display", json={"brightness": 10}),
            client.post("/api/v1/playback/control", json={"action": "pause"}),
            client.post("/api/v1/recovery/actions/reset-app/run", json={"confirm": True}),
        ]

    assert responses[4].status_code == 200
    assert responses[4].json()["state"] == "blocked"
    assert responses[4].json()["reason"] == "auth_required"
    assert responses[2].status_code == 200
    assert responses[2].json()["state"] == "blocked"
    assert responses[2].json()["reason"] in {"auth_required", "network_unavailable", "speaker_unavailable"}
    assert all(response.status_code == 501 for index, response in enumerate(responses) if index not in {2, 4})


def test_hardware_network_missing_nmcli_reports_unavailable_without_fake_success(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-network.sqlite3"))

    with make_client(settings) as client:
        responses = [
            client.post("/api/v1/network/scan"),
            client.get("/api/v1/network/scan-results"),
            client.post("/api/v1/network/connect", json={"ssid": "PipzoNet", "password": "secret"}),
            client.post("/api/v1/network/forget", json={"ssid": "PipzoNet", "confirm": True}),
            client.post("/api/v1/network/retry-internet-probe"),
        ]

    assert all(response.status_code == 501 for response in responses)
    assert "secret" not in " ".join(response.text for response in responses)


def test_hardware_network_adapter_success_path_projects_readiness(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-network-success.sqlite3"))
    app = create_app(settings_override=settings, network_adapter_override=FakeNetworkAdapter())

    with TestClient(app) as client:
        state_response = client.get("/api/v1/app/state")
        scan_response = client.post("/api/v1/network/scan")
        scan_results_response = client.get("/api/v1/network/scan-results")
        connect_response = client.post("/api/v1/network/connect", json={"ssid": "BedroomNet", "password": "secret"})
        status_response = client.get("/api/v1/network/status")
        retry_response = client.post("/api/v1/network/retry-internet-probe")

    assert state_response.status_code == 200
    assert state_response.json()["readiness"]["networkConfigured"] is True
    assert state_response.json()["setup"]["blockingStep"] == "spotify_auth"
    assert scan_response.json()["state"] == "succeeded"
    assert scan_results_response.json()["networks"][0]["ssid"] == "PipzoNet"
    assert connect_response.json()["state"] == "succeeded"
    assert status_response.json()["ssid"] == "BedroomNet"
    assert status_response.json()["ipAddress"] == "192.168.1.42"
    assert retry_response.json()["state"] == "succeeded"
    assert "secret" not in str(connect_response.json())


def test_hardware_bluetooth_adapter_success_path_projects_speaker_readiness(tmp_path):
    settings = Settings(app_mode="hardware", db_path=str(tmp_path / "hardware-bluetooth-success.sqlite3"))
    bluetooth = FakeBluetoothAdapter()
    app = create_app(
        settings_override=settings,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=bluetooth,
    )

    with TestClient(app) as client:
        state_response = client.get("/api/v1/app/state")
        scan_response = client.post("/api/v1/speaker/scan")
        scan_results_response = client.get("/api/v1/speaker/scan-results")
        pair_response = client.post("/api/v1/speaker/pair", json={"address": "11:22:33:44:55:66", "displayName": "New Speaker"})
        status_response = client.get("/api/v1/speaker/status")
        reconnect_response = client.post("/api/v1/speaker/reconnect")
        forget_response = client.post("/api/v1/speaker/forget", json={"address": "11:22:33:44:55:66", "confirm": True})

    assert state_response.status_code == 200
    assert state_response.json()["readiness"]["primarySpeakerSaved"] is True
    assert state_response.json()["setup"]["blockingStep"] == "spotify_auth"
    assert scan_response.json()["state"] == "succeeded"
    assert scan_results_response.json()["devices"][0]["displayName"] == "Pipzo Speaker"
    assert pair_response.json()["state"] == "succeeded"
    assert status_response.json()["status"] == "connected"
    assert reconnect_response.json()["state"] == "succeeded"
    assert forget_response.json()["state"] == "succeeded"


def test_hardware_state_projects_playback_transfer_required_after_prerequisites(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-playback-ready.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)

    with make_client(
        settings,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        response = client.get("/api/v1/app/state")

    body = response.json()
    assert response.status_code == 200
    assert body["setup"]["blockingStep"] == "playback_test"
    assert body["readiness"]["spotifyAuthorized"] is True
    assert body["readiness"]["primarySpeakerSaved"] is True
    assert body["health"]["playbackDevice"]["status"] == "transfer_required"
    assert body["health"]["playbackDevice"]["reason"] == "device_not_registered"
    assert body["health"]["playbackDevice"]["reason"] != "speaker_unavailable"
    assert body["capabilities"]["canBrowse"] is True
    assert body["capabilities"]["canStartPlayback"] is False


def test_hardware_playback_test_requires_sdk_device_then_persists_passed_state(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-playback-test.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    spotify_client = FakeSpotifyPlaybackClient()

    with make_client(
        settings,
        spotify_client_override=spotify_client,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        missing_device = client.post("/api/v1/setup/playback-test", json={"action": "start"})
        passed = client.post("/api/v1/setup/playback-test", json={"action": "start", "deviceId": "pipzo-sdk-device"})
        state_response = client.get("/api/v1/app/state")

    assert missing_device.status_code == 200
    assert missing_device.json()["state"] == "blocked"
    assert missing_device.json()["reason"] == "device_not_registered"
    assert passed.status_code == 200
    assert passed.json()["state"] == "succeeded"
    assert spotify_client.transfer_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "stored-access-token",
            "device_id": "pipzo-sdk-device",
            "play": False,
        }
    ]
    state = state_response.json()
    assert state["readiness"]["playbackTestPassed"] is True
    assert state["readiness"]["minimumReady"] is True
    assert state["appPhase"] == "ready"
    assert state["capabilities"]["canBrowse"] is True
    assert state["capabilities"]["canStartPlayback"] is True
    assert state["capabilities"]["canControlPlayback"] is True
    assert state["health"]["playbackDevice"] == {
        "status": "available",
        "reason": None,
        "deviceId": "pipzo-sdk-device",
    }


def test_hardware_restart_after_completed_setup_defaults_to_home(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-completed-setup-restart.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    from pipzo_api.setup_store import SetupStateStore

    SetupStateStore(settings.db_path).mark_playback_test_passed("pipzo-sdk-device")

    with make_client(
        settings,
        spotify_client_override=FakeSpotifyPlaybackClient(),
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        first_state = client.get("/api/v1/app/state").json()

    with make_client(
        settings,
        spotify_client_override=FakeSpotifyPlaybackClient(),
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as restarted_client:
        restarted_state = restarted_client.get("/api/v1/app/state").json()

    for state in (first_state, restarted_state):
        assert state["appPhase"] == "ready"
        assert state["setup"]["blockingStep"] == "none"
        assert state["readiness"]["minimumReady"] is True
        assert state["surfaces"]["current"] == "home"
        assert state["surfaces"]["route"] == "/"


def test_hardware_state_projects_current_pipzo_playback_metadata(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-now-playing.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    from pipzo_api.setup_store import SetupStateStore

    SetupStateStore(settings.db_path).mark_playback_test_passed("pipzo-sdk-device")
    spotify_client = FakeSpotifyPlaybackClient(
        current_playback={
            "device": {"id": "pipzo-sdk-device", "name": "Pipzo"},
            "is_playing": True,
            "progress_ms": 65000,
            "currently_playing_type": "track",
            "item": {
                "name": "A Real Song",
                "duration_ms": 185000,
                "artists": [{"name": "A Real Artist"}],
                "album": {
                    "name": "A Real Album",
                    "images": [{"url": "https://i.scdn.co/image/album-art"}],
                },
            },
        }
    )

    with make_client(
        settings,
        spotify_client_override=spotify_client,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        response = client.get("/api/v1/app/state")

    body = response.json()
    assert response.status_code == 200
    assert body["nowPlaying"] == {
        "title": "A Real Song",
        "artist": "A Real Artist",
        "album": "A Real Album",
        "artworkUrl": "https://i.scdn.co/image/album-art",
        "isPlaying": True,
        "progressMs": 65000,
        "durationMs": 185000,
        "capturedAt": body["nowPlaying"]["capturedAt"],
    }
    assert body["nowPlaying"]["capturedAt"] is not None
    assert spotify_client.transfer_calls == []
    assert spotify_client.current_playback_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "stored-access-token",
        }
    ]
    assert body["diagnostics"]["lastCommand"] == "spotify.current_playback"
    assert body["diagnostics"]["rawAdapterCode"] == "ok:device=pipzo-sdk-device"


def test_hardware_transfer_updates_stored_playback_device_for_current_metadata(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-now-playing-device-refresh.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    from pipzo_api.setup_store import SetupStateStore

    SetupStateStore(settings.db_path).mark_playback_test_passed("stale-sdk-device")
    spotify_client = FakeSpotifyPlaybackClient(
        current_playback={
            "device": {"id": "fresh-sdk-device", "name": "Pipzo"},
            "is_playing": True,
            "progress_ms": 1000,
            "currently_playing_type": "track",
            "item": {
                "name": "Fresh Device Song",
                "duration_ms": 120000,
                "artists": [{"name": "Fresh Artist"}],
                "album": {"name": "Fresh Album", "images": [{"url": "https://i.scdn.co/image/fresh"}]},
            },
        }
    )

    with make_client(
        settings,
        spotify_client_override=spotify_client,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        transfer = client.post("/api/v1/spotify/playback/transfer", json={"deviceId": "fresh-sdk-device", "play": False})
        state_response = client.get("/api/v1/app/state")

    assert transfer.status_code == 200
    assert transfer.json()["state"] == "succeeded"
    state = state_response.json()
    assert state["health"]["playbackDevice"]["deviceId"] == "fresh-sdk-device"
    assert state["nowPlaying"]["title"] == "Fresh Device Song"
    assert spotify_client.transfer_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "stored-access-token",
            "device_id": "fresh-sdk-device",
            "play": False,
        }
    ]


def test_hardware_state_exposes_current_playback_device_mismatch_diagnostic(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-now-playing-mismatch.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    from pipzo_api.setup_store import SetupStateStore

    SetupStateStore(settings.db_path).mark_playback_test_passed("stored-sdk-device")
    spotify_client = FakeSpotifyPlaybackClient(
        current_playback={
            "device": {"id": "other-device", "name": "Phone"},
            "is_playing": True,
            "currently_playing_type": "track",
            "item": {"name": "Phone Song", "artists": [], "album": {}},
        }
    )

    with make_client(
        settings,
        spotify_client_override=spotify_client,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        response = client.get("/api/v1/app/state")

    body = response.json()
    assert response.status_code == 200
    assert body["nowPlaying"]["title"] == "Phone Song"
    assert body["nowPlaying"]["isPlaying"] is True
    assert body["diagnostics"]["lastCommand"] == "spotify.current_playback"
    assert body["diagnostics"]["rawAdapterCode"] == "device_mismatch:stored=stored-sdk-device:active=other-device"


def test_hardware_state_keeps_last_known_track_paused_on_empty_current_playback(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-now-playing-last-known.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    from pipzo_api.setup_store import SetupStateStore

    SetupStateStore(settings.db_path).mark_playback_test_passed("pipzo-sdk-device")
    spotify_client = FakeSpotifyPlaybackClient(
        current_playback={
            "device": {"id": "pipzo-sdk-device", "name": "Pipzo"},
            "is_playing": True,
            "progress_ms": 30000,
            "currently_playing_type": "track",
            "item": {
                "name": "Remembered Song",
                "duration_ms": 180000,
                "artists": [{"name": "Remembered Artist"}],
                "album": {"name": "Remembered Album", "images": []},
            },
        }
    )

    with make_client(
        settings,
        spotify_client_override=spotify_client,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        first = client.get("/api/v1/app/state")
        spotify_client.current_playback = None
        second = client.get("/api/v1/app/state")

    assert first.status_code == 200
    body = second.json()
    assert body["nowPlaying"]["title"] == "Remembered Song"
    assert body["nowPlaying"]["artist"] == "Remembered Artist"
    assert body["nowPlaying"]["isPlaying"] is False
    assert body["diagnostics"]["rawAdapterCode"] == "empty_response"


def test_hardware_library_play_success_marks_playback_test_passed_with_real_device(tmp_path):
    settings = Settings(
        app_mode="hardware",
        db_path=str(tmp_path / "hardware-library-play-setup.sqlite3"),
        pipzo_token_key_path=str(tmp_path / "spotify-token.key"),
        spotify_client_id="spotify-client-id",
    )
    persist_connected_spotify(settings)
    spotify_client = FakeSpotifyPlaybackClient()

    with make_client(
        settings,
        spotify_client_override=spotify_client,
        network_adapter_override=FakeNetworkAdapter(),
        bluetooth_adapter_override=FakeBluetoothAdapter(),
        volume_adapter_override=FakeVolumeAdapter(),
    ) as client:
        play_response = client.post(
            "/api/v1/library/play",
            json={"uri": "spotify:track:real-track", "playbackKind": "track", "deviceId": "pipzo-sdk-device"},
        )
        state_response = client.get("/api/v1/app/state")

    assert play_response.status_code == 200
    assert play_response.json()["state"] == "succeeded"
    assert play_response.json()["mock"] is False
    assert spotify_client.start_playback_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "stored-access-token",
            "playback_kind": "track",
            "uri": "spotify:track:real-track",
            "device_id": "pipzo-sdk-device",
        }
    ]
    state = state_response.json()
    assert state["readiness"]["playbackTestPassed"] is True
    assert state["readiness"]["minimumReady"] is True
    assert state["appPhase"] == "ready"
    assert state["health"]["playbackDevice"] == {
        "status": "available",
        "reason": None,
        "deviceId": "pipzo-sdk-device",
    }
    assert "stored-refresh-token" not in str(play_response.json())


def test_mock_library_play_does_not_mark_playback_test_passed(tmp_path):
    with make_client(Settings(db_path=str(tmp_path / "mock-library-play-setup.sqlite3"))) as client:
        client.post("/api/v1/mock/scenarios/first_boot_empty/activate")
        play_response = client.post(
            "/api/v1/library/play",
            json={"uri": "spotify:track:mock-track", "playbackKind": "track", "deviceId": "mock-device"},
        )
        state_response = client.get("/api/v1/app/state")

    assert play_response.status_code == 200
    assert play_response.json()["state"] == "succeeded"
    assert play_response.json()["mock"] is True
    state = state_response.json()
    assert state["readiness"]["playbackTestPassed"] is False
    assert state["readiness"]["minimumReady"] is False
    assert state["appPhase"] == "setup"
