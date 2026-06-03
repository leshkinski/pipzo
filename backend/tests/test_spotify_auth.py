from datetime import datetime, timedelta, timezone
import sqlite3
from typing import Optional
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from pipzo_api.config import Settings
from pipzo_api.main import create_app
from pipzo_api.spotify_auth import (
    SpotifyAccountProfile,
    SpotifyAuthSessionService,
    SpotifyCatalogApiError,
    SpotifyCatalogApiFailure,
    SpotifyPlaybackApiError,
    SpotifyPlaybackApiFailure,
    SpotifyTokenRefreshError,
    SpotifyTokenRefreshFailure,
    SpotifyTokenExchangeError,
    SpotifyTokenResponse,
    refresh_spotify_access_token,
    should_refresh_spotify_access_token,
)
from pipzo_api.spotify_store import StoredSpotifyAccount, StoredSpotifyAuthRecord, SpotifyAuthStore
from pipzo_api.contract import VolumeHealth, VolumeReason
from pipzo_api.adapters.volume import VolumeUnavailable


def make_settings(tmp_path, **overrides) -> Settings:
    values = {
        "db_path": str(tmp_path / "spotify-auth.sqlite3"),
        "pipzo_token_key_path": str(tmp_path / "spotify-token.key"),
        "spotify_client_id": "spotify-client-id",
    }
    values.update(overrides)
    return Settings(**values)


class FakeSpotifyClient:
    def __init__(
        self,
        *,
        token_response: Optional[SpotifyTokenResponse] = None,
        profile_response: Optional[SpotifyAccountProfile] = None,
        fail_exchange: bool = False,
        fail_profile: bool = False,
        refresh_response: Optional[SpotifyTokenResponse] = None,
        refresh_failure: Optional[SpotifyTokenRefreshFailure] = None,
        playback_failure: Optional[SpotifyPlaybackApiFailure] = None,
        catalog_payloads: Optional[dict[str, dict]] = None,
        catalog_failure: Optional[SpotifyCatalogApiFailure] = None,
    ) -> None:
        self.token_response = token_response or SpotifyTokenResponse(
            access_token="backend-access-token",
            refresh_token="backend-refresh-token",
            token_type="Bearer",
            scope="streaming user-read-private",
            expires_in=3600,
        )
        self.profile_response = profile_response or SpotifyAccountProfile(
            account_id="spotify-user-id",
            display_name="Pipzo Account",
            product="premium",
            country="GB",
        )
        self.fail_exchange = fail_exchange
        self.fail_profile = fail_profile
        self.refresh_response = refresh_response or SpotifyTokenResponse(
            access_token="refreshed-access-token",
            refresh_token="refreshed-refresh-token",
            token_type="Bearer",
            scope="streaming user-read-private",
            expires_in=3600,
        )
        self.refresh_failure = refresh_failure
        self.playback_failure = playback_failure
        self.catalog_payloads = catalog_payloads or {}
        self.catalog_failure = catalog_failure
        self.exchange_calls: list[dict] = []
        self.profile_tokens: list[str] = []
        self.refresh_calls: list[dict] = []
        self.transfer_calls: list[dict] = []
        self.playback_calls: list[dict] = []
        self.volume_calls: list[dict] = []
        self.catalog_calls: list[dict] = []
        self.start_playback_calls: list[dict] = []
        self.current_playback_calls: list[dict] = []

    def exchange_authorization_code(
        self,
        *,
        token_url: str,
        client_id: str,
        redirect_uri: str,
        code: str,
        code_verifier: str,
    ) -> SpotifyTokenResponse:
        self.exchange_calls.append(
            {
                "token_url": token_url,
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code": code,
                "code_verifier": code_verifier,
            }
        )
        if self.fail_exchange:
            raise SpotifyTokenExchangeError("spotify_token_exchange_failed")
        return self.token_response

    def fetch_current_user_profile(self, *, access_token: str) -> SpotifyAccountProfile:
        self.profile_tokens.append(access_token)
        if self.fail_profile:
            raise SpotifyTokenExchangeError("spotify_profile_fetch_failed")
        return self.profile_response

    def refresh_access_token(
        self,
        *,
        token_url: str,
        client_id: str,
        refresh_token: str,
    ) -> SpotifyTokenResponse:
        self.refresh_calls.append(
            {
                "token_url": token_url,
                "client_id": client_id,
                "refresh_token": refresh_token,
            }
        )
        if self.refresh_failure is not None:
            raise SpotifyTokenRefreshError(self.refresh_failure)
        return self.refresh_response

    def transfer_playback(
        self,
        *,
        api_base_url: str,
        access_token: str,
        device_id: str,
        play: bool,
    ) -> None:
        self.transfer_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
                "device_id": device_id,
                "play": play,
            }
        )
        if self.playback_failure is not None:
            raise SpotifyPlaybackApiError(self.playback_failure)

    def fetch_library_json(
        self,
        *,
        api_base_url: str,
        access_token: str,
        path: str,
        params: Optional[dict[str, object]] = None,
    ) -> dict:
        self.catalog_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
                "path": path,
                "params": params or {},
            }
        )
        if self.catalog_failure is not None:
            raise SpotifyCatalogApiError(self.catalog_failure)
        return self.catalog_payloads.get(path, {"items": []})

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
        if self.playback_failure is not None:
            raise SpotifyPlaybackApiError(self.playback_failure)

    def send_playback_control(
        self,
        *,
        api_base_url: str,
        access_token: str,
        action: str,
        device_id: Optional[str],
    ) -> None:
        self.playback_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
                "action": action,
                "device_id": device_id,
            }
        )
        if self.playback_failure is not None:
            raise SpotifyPlaybackApiError(self.playback_failure)

    def set_playback_volume(
        self,
        *,
        api_base_url: str,
        access_token: str,
        volume_percent: int,
        device_id: Optional[str],
    ) -> None:
        self.volume_calls.append(
            {
                "api_base_url": api_base_url,
                "access_token": access_token,
                "volume_percent": volume_percent,
                "device_id": device_id,
            }
        )
        if self.playback_failure is not None:
            raise SpotifyPlaybackApiError(self.playback_failure)

    def fetch_current_playback(self, *, api_base_url: str, access_token: str) -> Optional[dict]:
        self.current_playback_calls.append({"api_base_url": api_base_url, "access_token": access_token})
        if self.playback_failure is not None:
            raise SpotifyPlaybackApiError(self.playback_failure)
        return None


class FakeVolumeAdapter:
    def __init__(self, health: Optional[VolumeHealth] = None, unavailable_reason: Optional[VolumeReason] = None) -> None:
        self.health = health or VolumeHealth(status="os_only", value=40, muted=False)
        self.unavailable_reason = unavailable_reason
        self.set_calls: list[tuple[int, bool]] = []

    def probe(self) -> None:
        return None

    def status(self) -> VolumeHealth:
        return self.health

    def set_volume(self, value: int, muted: bool = False) -> VolumeHealth:
        self.set_calls.append((value, muted))
        if self.unavailable_reason is not None:
            raise VolumeUnavailable(self.unavailable_reason)
        self.health = VolumeHealth(status="os_only", value=value, muted=muted)
        return self.health


def make_client(
    settings: Settings,
    service: Optional[SpotifyAuthSessionService] = None,
    spotify_client: Optional[FakeSpotifyClient] = None,
    **overrides,
) -> TestClient:
    app = create_app(
        settings_override=settings,
        spotify_auth_sessions_override=service,
        spotify_client_override=spotify_client,
        **overrides,
    )
    return TestClient(app)


def create_session(client: TestClient) -> dict:
    response = client.post("/api/v1/spotify/auth/session")
    assert response.status_code == 200
    return response.json()


def persist_auth_record(
    settings: Settings,
    *,
    access_token: str = "stored-access-token",
    refresh_token: str = "stored-refresh-token",
    scope: str = "streaming user-read-private",
    expires_at: Optional[datetime] = None,
    issued_at: Optional[datetime] = None,
) -> StoredSpotifyAuthRecord:
    timestamp = issued_at or datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)
    record = StoredSpotifyAuthRecord(
        access_token=access_token,
        refresh_token=refresh_token,
        token_type="Bearer",
        scope=scope,
        expires_at=expires_at or timestamp + timedelta(seconds=60),
        issued_at=timestamp,
        connected_at=timestamp,
        updated_at=timestamp,
        account=StoredSpotifyAccount(
            account_id="spotify-user-id",
            display_name="Pipzo Account",
            product="premium",
            country="GB",
            is_premium=True,
        ),
    )
    SpotifyAuthStore(settings.db_path).upsert_auth_record(record)
    return record


def test_session_api_returns_safe_metadata_without_verifier_state_or_challenge(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()

    with make_client(settings, service) as client:
        body = create_session(client)

    assert body["status"] == "waiting"
    assert body["sessionId"]
    assert body["startUrl"].endswith(f"/api/v1/spotify/auth/start/{body['sessionId']}")
    assert set(body) == {
        "sessionId",
        "status",
        "createdAt",
        "expiresAt",
        "startUrl",
        "failureReason",
        "accountDisplayName",
    }
    assert body["failureReason"] is None
    assert body["accountDisplayName"] is None

    stored = service._sessions[body["sessionId"]]
    assert 43 <= len(stored.code_verifier or "") <= 128
    assert stored.state
    assert stored.state not in str(body)
    assert stored.code_verifier not in str(body)
    assert stored.code_challenge not in str(body)


def test_authorize_redirect_contains_pkce_challenge_client_redirect_and_scopes(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()

    with make_client(settings, service) as client:
        session = create_session(client)
        response = client.get(f"/api/v1/spotify/auth/start/{session['sessionId']}", follow_redirects=False)

    assert response.status_code == 307
    location = response.headers["location"]
    parsed = urlparse(location)
    params = parse_qs(parsed.query)
    stored = service._sessions[session["sessionId"]]

    assert parsed.scheme == "https"
    assert parsed.netloc == "accounts.spotify.com"
    assert parsed.path == "/authorize"
    assert params["client_id"] == ["spotify-client-id"]
    assert params["response_type"] == ["code"]
    assert params["redirect_uri"] == ["http://127.0.0.1:8000/api/v1/spotify/auth/callback"]
    assert params["code_challenge_method"] == ["S256"]
    assert params["code_challenge"] == [stored.code_challenge]
    assert params["state"] == [stored.state]
    assert params["scope"] == [settings.spotify_scopes]


def test_callback_rejects_missing_unknown_mismatched_and_expired_state(tmp_path):
    now = datetime.now(timezone.utc)
    service = SpotifyAuthSessionService(now=lambda: now)
    settings = make_settings(tmp_path, spotify_auth_session_ttl_seconds=60)

    with make_client(settings, service) as client:
        missing = client.get("/api/v1/spotify/auth/callback?code=abc")
        unknown = client.get("/api/v1/spotify/auth/callback?state=not-a-session.secret&code=abc")

        session = create_session(client)
        stored_state = service._sessions[session["sessionId"]].state
        mismatched_state = f"{session['sessionId']}.wrong"
        mismatched = client.get(f"/api/v1/spotify/auth/callback?state={mismatched_state}&code=abc")

        expired_session = create_session(client)
        expired_state = service._sessions[expired_session["sessionId"]].state
        now = now + timedelta(seconds=61)
        expired = client.get(f"/api/v1/spotify/auth/callback?state={expired_state}&code=abc")

    assert missing.status_code == 400
    assert missing.json()["detail"] == "missing_state"
    assert unknown.status_code == 400
    assert unknown.json()["detail"] == "unknown_state"
    assert mismatched.status_code == 400
    assert mismatched.json()["detail"] == "state_mismatch"
    assert service._sessions[session["sessionId"]].state == stored_state
    assert expired.status_code == 400
    assert expired.json()["detail"] == "expired_state"


def test_callback_records_safe_status_and_drops_verifier(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient()

    with make_client(settings, service, spotify_client) as client:
        session = create_session(client)
        verifier = service._sessions[session["sessionId"]].code_verifier
        state = service._sessions[session["sessionId"]].state
        response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=auth-code")
        status_response = client.get(f"/api/v1/spotify/auth/session/{session['sessionId']}")

    assert response.status_code == 200
    body = status_response.json()
    assert body["status"] == "connected"
    assert body["failureReason"] is None
    assert body["accountDisplayName"] == "Pipzo Account"
    assert "auth-code" not in str(body)
    assert "backend-access-token" not in str(body)
    assert "backend-refresh-token" not in str(body)
    assert service._sessions[session["sessionId"]].code_verifier is None
    assert spotify_client.exchange_calls == [
        {
            "token_url": "https://accounts.spotify.com/api/token",
            "client_id": "spotify-client-id",
            "redirect_uri": "http://127.0.0.1:8000/api/v1/spotify/auth/callback",
            "code": "auth-code",
            "code_verifier": verifier,
        }
    ]
    assert spotify_client.profile_tokens == ["backend-access-token"]

    stored = SpotifyAuthStore(settings.db_path).get_auth_record()
    assert stored is not None
    assert stored.account.account_id == "spotify-user-id"
    assert stored.account.display_name == "Pipzo Account"
    assert stored.account.product == "premium"
    assert stored.account.is_premium is True
    assert stored.access_token == "backend-access-token"
    assert stored.refresh_token == "backend-refresh-token"


def test_successful_callback_page_is_kiosk_safe_and_sanitized(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient()

    with make_client(settings, service, spotify_client) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=sensitive-auth-code")

    assert response.status_code == 200
    assert 'http-equiv="refresh"' in response.text
    assert "window.location.replace('/')" in response.text
    assert 'href="/">Return to Pipzo</a>' in response.text
    assert "Spotify setup is complete" in response.text
    assert "sensitive-auth-code" not in response.text
    assert "backend-access-token" not in response.text
    assert "backend-refresh-token" not in response.text


def test_stored_spotify_token_columns_are_encrypted_not_plaintext(tmp_path):
    settings = make_settings(tmp_path)
    persist_auth_record(settings, access_token="plain-access-token", refresh_token="plain-refresh-token")

    with sqlite3.connect(settings.db_path) as connection:
        row = connection.execute("select access_token, refresh_token from spotify_auth where id = 1").fetchone()

    assert row is not None
    stored_access_token, stored_refresh_token = row
    assert stored_access_token != "plain-access-token"
    assert stored_refresh_token != "plain-refresh-token"
    assert stored_access_token.startswith("fernet:v1:")
    assert stored_refresh_token.startswith("fernet:v1:")
    assert "plain-access-token" not in stored_access_token
    assert "plain-refresh-token" not in stored_refresh_token


def test_generated_token_key_file_uses_restrictive_permissions(tmp_path):
    settings = make_settings(tmp_path)
    persist_auth_record(settings)

    key_path = tmp_path / "spotify-token.key"
    key_mode = key_path.stat().st_mode & 0o777

    assert key_mode == 0o600
    assert key_path.read_text(encoding="utf-8").strip()


def test_wrong_token_key_fails_safe_as_reconnect_required(tmp_path):
    settings = make_settings(tmp_path)
    persist_auth_record(settings)
    wrong_key_settings = make_settings(
        tmp_path,
        pipzo_token_key_path=str(tmp_path / "wrong-spotify-token.key"),
    )
    SpotifyAuthStore(
        wrong_key_settings.db_path,
        token_key_path=wrong_key_settings.pipzo_token_key_path,
    ).upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token="other-access-token",
            refresh_token="other-refresh-token",
            token_type="Bearer",
            scope="streaming",
            expires_at=datetime(2026, 5, 29, 13, 0, tzinfo=timezone.utc),
            issued_at=datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc),
            connected_at=datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc),
            account=StoredSpotifyAccount(
                account_id="other-user",
                display_name="Other Account",
                product="premium",
                country="GB",
                is_premium=True,
            ),
        )
    )

    health = refresh_spotify_access_token(
        settings=settings,
        spotify_client=FakeSpotifyClient(),
        store=SpotifyAuthStore(settings.db_path, token_key_path=settings.pipzo_token_key_path),
        force=True,
    )

    assert health.status == "reconnect_required"
    assert health.reason == "token_refresh_failed"
    assert "stored-access-token" not in str(health.model_dump(mode="json", by_alias=True))
    assert "stored-refresh-token" not in str(health.model_dump(mode="json", by_alias=True))


def test_missing_token_key_when_auto_create_disabled_fails_safe(tmp_path):
    settings = make_settings(tmp_path)
    persist_auth_record(settings)
    key_path = tmp_path / "spotify-token.key"
    key_path.unlink()

    with make_client(make_settings(tmp_path, pipzo_token_key_auto_create=False)) as client:
        response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    body = response.json()
    assert body["health"]["spotifyAuth"]["status"] == "reconnect_required"
    assert body["health"]["spotifyAuth"]["reason"] == "token_refresh_failed"
    assert body["readiness"]["spotifyAuthorized"] is False
    assert "stored-access-token" not in str(body)
    assert "stored-refresh-token" not in str(body)


def test_successful_callback_emits_safe_auth_events_and_updates_snapshot(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient()

    with make_client(settings, service, spotify_client) as client:
        with client.websocket_connect("/api/v1/events/ws") as websocket:
            websocket.receive_json()
            session = create_session(client)
            session_event = websocket.receive_json()
            state = service._sessions[session["sessionId"]].state
            response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=auth-code")
            connected_session_event = websocket.receive_json()
            auth_event = websocket.receive_json()
            snapshot = client.get("/api/v1/app/state").json()

    assert response.status_code == 200
    assert session_event["type"] == "spotify.auth_session_changed"
    assert connected_session_event["type"] == "spotify.auth_session_changed"
    assert connected_session_event["payload"]["status"] == "connected"
    assert auth_event["type"] == "spotify.auth_changed"
    assert auth_event["payload"] == {"status": "connected", "reason": None, "accountDisplayName": "Pipzo Account"}
    event_text = str([session_event, connected_session_event, auth_event])
    assert "auth-code" not in event_text
    assert "backend-access-token" not in event_text
    assert "backend-refresh-token" not in event_text
    assert state not in event_text
    assert snapshot["health"]["spotifyAuth"]["status"] == "connected"
    assert snapshot["health"]["spotifyAuth"]["accountDisplayName"] == "Pipzo Account"


def test_callback_reuse_is_rejected_after_successful_exchange(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient()

    with make_client(settings, service, spotify_client) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        first = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=first-code")
        second = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=second-code")

    assert first.status_code == 200
    assert second.status_code == 400
    assert second.json()["detail"] == "unknown_state"
    assert len(spotify_client.exchange_calls) == 1


def test_token_exchange_failure_returns_sanitized_error_and_does_not_persist_tokens(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient(fail_exchange=True)

    with make_client(settings, service, spotify_client) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=sensitive-auth-code")
        status_response = client.get(f"/api/v1/spotify/auth/session/{session['sessionId']}")

    assert response.status_code == 400
    assert "sensitive-auth-code" not in response.text
    assert status_response.json()["status"] == "failed"
    assert status_response.json()["failureReason"] == "spotify_error"
    assert SpotifyAuthStore(settings.db_path).get_auth_record() is None


def test_profile_validation_failure_does_not_persist_tokens(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient(fail_profile=True)

    with make_client(settings, service, spotify_client) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=auth-code")

    assert response.status_code == 400
    assert SpotifyAuthStore(settings.db_path).get_auth_record() is None


def test_callback_storage_key_failure_returns_sanitized_reauth_error(tmp_path):
    settings = make_settings(tmp_path, pipzo_token_key_auto_create=False)
    service = SpotifyAuthSessionService()
    spotify_client = FakeSpotifyClient()

    with make_client(settings, service, spotify_client) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=sensitive-auth-code")
        status_response = client.get(f"/api/v1/spotify/auth/session/{session['sessionId']}")

    assert response.status_code == 400
    assert "sensitive-auth-code" not in response.text
    assert "backend-access-token" not in response.text
    assert "backend-refresh-token" not in response.text
    assert status_response.json()["status"] == "failed"
    assert status_response.json()["failureReason"] == "spotify_error"
    assert SpotifyAuthStore(settings.db_path).get_auth_record() is None


def test_refresh_helper_updates_access_token_expiry_scope_and_metadata(tmp_path):
    now = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)
    settings = make_settings(tmp_path)
    store = SpotifyAuthStore(settings.db_path)
    persist_auth_record(settings, expires_at=now + timedelta(seconds=30))
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="new-access-token",
            refresh_token="new-refresh-token",
            token_type="Bearer",
            scope="streaming playlist-read-private",
            expires_in=7200,
        )
    )

    health = refresh_spotify_access_token(
        settings=settings,
        spotify_client=spotify_client,
        store=store,
        now=lambda: now,
    )
    stored = store.get_auth_record()

    assert health.status == "connected"
    assert spotify_client.refresh_calls == [
        {
            "token_url": "https://accounts.spotify.com/api/token",
            "client_id": "spotify-client-id",
            "refresh_token": "stored-refresh-token",
        }
    ]
    assert stored is not None
    assert stored.access_token == "new-access-token"
    assert stored.refresh_token == "new-refresh-token"
    assert stored.scope == "streaming playlist-read-private"
    assert stored.issued_at == now
    assert stored.expires_at == now + timedelta(seconds=7200)
    assert stored.last_refresh_at == now
    assert stored.last_refresh_error_code is None
    assert stored.revoked_at is None


def test_refresh_helper_retains_existing_refresh_token_when_spotify_omits_replacement(tmp_path):
    now = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)
    settings = make_settings(tmp_path)
    store = SpotifyAuthStore(settings.db_path)
    persist_auth_record(settings, expires_at=now + timedelta(seconds=10))
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="new-access-token",
            refresh_token=None,
            token_type="Bearer",
            scope="streaming",
            expires_in=3600,
        )
    )

    refresh_spotify_access_token(settings=settings, spotify_client=spotify_client, store=store, now=lambda: now)
    stored = store.get_auth_record()

    assert stored is not None
    assert stored.access_token == "new-access-token"
    assert stored.refresh_token == "stored-refresh-token"


def test_refresh_helper_marks_revoked_refresh_token_as_reconnect_required(tmp_path):
    now = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)
    settings = make_settings(tmp_path)
    store = SpotifyAuthStore(settings.db_path)
    persist_auth_record(settings, expires_at=now - timedelta(seconds=1))
    spotify_client = FakeSpotifyClient(refresh_failure=SpotifyTokenRefreshFailure.REVOKED)

    health = refresh_spotify_access_token(
        settings=settings,
        spotify_client=spotify_client,
        store=store,
        now=lambda: now,
    )
    stored = store.get_auth_record()

    assert health.status == "reconnect_required"
    assert health.reason == "revoked"
    assert stored is not None
    assert stored.access_token == ""
    assert stored.refresh_token == "stored-refresh-token"
    assert stored.last_refresh_error_code == "revoked"
    assert stored.revoked_at == now


def test_refresh_helper_sanitizes_network_failure_and_keeps_valid_token_connected(tmp_path):
    now = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)
    settings = make_settings(tmp_path)
    store = SpotifyAuthStore(settings.db_path)
    persist_auth_record(settings, expires_at=now + timedelta(seconds=30))
    spotify_client = FakeSpotifyClient(refresh_failure=SpotifyTokenRefreshFailure.NETWORK)

    health = refresh_spotify_access_token(
        settings=settings,
        spotify_client=spotify_client,
        store=store,
        now=lambda: now,
        force=True,
    )
    stored = store.get_auth_record()

    assert health.status == "connected"
    assert health.account_display_name == "Pipzo Account"
    assert "stored-access-token" not in str(health.model_dump(mode="json", by_alias=True))
    assert "stored-refresh-token" not in str(health.model_dump(mode="json", by_alias=True))
    assert stored is not None
    assert stored.access_token == "stored-access-token"
    assert stored.last_refresh_error_code == "network"
    assert stored.revoked_at is None


def test_near_expiry_detection_is_conservative(tmp_path):
    now = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)
    settings = make_settings(tmp_path)
    near = persist_auth_record(settings, expires_at=now + timedelta(minutes=4, seconds=59))
    far = persist_auth_record(settings, expires_at=now + timedelta(minutes=5, seconds=1))

    assert should_refresh_spotify_access_token(near, now=now) is True
    assert should_refresh_spotify_access_token(far, now=now) is False


def test_cancel_and_expiry_are_reported_safely(tmp_path):
    now = datetime.now(timezone.utc)
    service = SpotifyAuthSessionService(now=lambda: now)
    settings = make_settings(tmp_path, spotify_auth_session_ttl_seconds=10)

    with make_client(settings, service) as client:
        cancelled = create_session(client)
        cancel_response = client.post(f"/api/v1/spotify/auth/session/{cancelled['sessionId']}/cancel")
        start_after_cancel = client.get(
            f"/api/v1/spotify/auth/start/{cancelled['sessionId']}",
            follow_redirects=False,
        )

        expiring = create_session(client)
        now = now + timedelta(seconds=11)
        expired_response = client.get(f"/api/v1/spotify/auth/session/{expiring['sessionId']}")
        start_after_expiry = client.get(
            f"/api/v1/spotify/auth/start/{expiring['sessionId']}",
            follow_redirects=False,
        )

    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "cancelled"
    assert service._sessions[cancelled["sessionId"]].code_verifier is None
    assert start_after_cancel.status_code == 404
    assert expired_response.status_code == 200
    assert expired_response.json()["status"] == "expired"
    assert expired_response.json()["failureReason"] == "expired_state"
    assert service._sessions[expiring["sessionId"]].code_verifier is None
    assert start_after_expiry.status_code == 404


def test_spotify_logout_deletes_tokens_clears_pending_sessions_and_emits_safe_state(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    persist_auth_record(settings)

    with make_client(settings, service) as client:
        with client.websocket_connect("/api/v1/events/ws") as websocket:
            websocket.receive_json()
            session = create_session(client)
            websocket.receive_json()
            response = client.post("/api/v1/spotify/auth/logout")
            auth_event = websocket.receive_json()
            snapshot_event = websocket.receive_json()
            state_response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    assert response.json() == {"status": "none", "reason": "no_session", "accountDisplayName": None}
    assert SpotifyAuthStore(settings.db_path).get_auth_record() is None
    assert service._sessions == {}
    assert auth_event["type"] == "spotify.auth_changed"
    assert auth_event["payload"] == {"status": "none", "reason": "no_session", "accountDisplayName": None}
    assert snapshot_event["type"] == "app.snapshot"
    assert snapshot_event["payload"]["health"]["spotifyAuth"]["status"] == "none"
    assert snapshot_event["payload"]["readiness"]["spotifyAuthorized"] is False
    assert state_response.json()["health"]["spotifyAuth"]["status"] == "none"
    assert state_response.json()["readiness"]["spotifyAuthorized"] is False
    event_text = str([auth_event, snapshot_event])
    assert "stored-access-token" not in event_text
    assert "stored-refresh-token" not in event_text
    assert session["sessionId"] not in service._sessions


def test_playback_token_endpoint_returns_short_lived_access_token_only_for_authenticated_premium(tmp_path):
    settings = make_settings(tmp_path)
    persist_auth_record(settings)
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="sdk-access-token",
            refresh_token=None,
            token_type="Bearer",
            scope="streaming user-modify-playback-state",
            expires_in=3600,
        )
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.get("/api/v1/spotify/playback/token")

    assert response.status_code == 200
    body = response.json()
    assert body["accessToken"] == "sdk-access-token"
    assert body["tokenType"] == "Bearer"
    assert body["scope"] == "streaming user-modify-playback-state"
    assert set(body) == {"accessToken", "tokenType", "expiresAt", "scope"}
    assert "stored-refresh-token" not in str(body)
    assert spotify_client.refresh_calls[0]["refresh_token"] == "stored-refresh-token"


def test_playback_token_endpoint_blocks_missing_auth_and_non_premium_without_exposing_tokens(tmp_path):
    no_auth_settings = make_settings(tmp_path / "no-auth")
    free_settings = make_settings(tmp_path / "free")
    now = datetime.now(timezone.utc)
    SpotifyAuthStore(free_settings.db_path).upsert_auth_record(
        StoredSpotifyAuthRecord(
            access_token="free-access-token",
            refresh_token="free-refresh-token",
            token_type="Bearer",
            scope="streaming",
            expires_at=now + timedelta(seconds=3600),
            issued_at=now,
            connected_at=now,
            updated_at=now,
            account=StoredSpotifyAccount(
                account_id="free-user",
                display_name="Free Account",
                product="free",
                country="GB",
                is_premium=False,
            ),
        )
    )

    with make_client(no_auth_settings) as client:
        missing = client.get("/api/v1/spotify/playback/token")
    with make_client(free_settings) as client:
        free = client.get("/api/v1/spotify/playback/token")

    assert missing.status_code == 401
    assert missing.json()["detail"] == "no_session"
    assert free.status_code == 403
    assert free.json()["detail"] == "premium_required"
    assert "free-access-token" not in str(free.json())
    assert "free-refresh-token" not in str(free.json())


def test_hardware_playback_transfer_and_control_use_backend_token_boundary(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings, access_token="stored-access-token")
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="fresh-access-token",
            refresh_token=None,
            token_type="Bearer",
            scope="streaming user-modify-playback-state",
            expires_in=3600,
        )
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        transfer = client.post(
            "/api/v1/spotify/playback/transfer",
            json={"deviceId": "pipzo-device-id", "play": False},
        )
        pause = client.post(
            "/api/v1/playback/control",
            json={"action": "pause", "deviceId": "pipzo-device-id"},
        )
        restart = client.post(
            "/api/v1/playback/control",
            json={"action": "seek_start", "deviceId": "pipzo-device-id"},
        )

    assert transfer.status_code == 200
    assert transfer.json()["state"] == "succeeded"
    assert transfer.json()["mock"] is False
    assert pause.status_code == 200
    assert pause.json()["state"] == "succeeded"
    assert restart.status_code == 200
    assert restart.json()["state"] == "succeeded"
    assert spotify_client.transfer_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "fresh-access-token",
            "device_id": "pipzo-device-id",
            "play": False,
        }
    ]
    assert spotify_client.playback_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "fresh-access-token",
            "action": "pause",
            "device_id": "pipzo-device-id",
        },
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "fresh-access-token",
            "action": "seek_start",
            "device_id": "pipzo-device-id",
        },
    ]
    assert "stored-refresh-token" not in str([transfer.json(), pause.json(), restart.json()])


def test_hardware_sleep_timer_stop_uses_playback_pause_control(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings, access_token="stored-access-token")
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="fresh-access-token",
            refresh_token=None,
            token_type="Bearer",
            scope="streaming user-modify-playback-state",
            expires_in=3600,
        )
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.post(
            "/api/v1/playback/control",
            json={"action": "stop", "deviceId": "pipzo-device-id"},
        )

    assert response.status_code == 200
    assert response.json()["state"] == "succeeded"
    assert response.json()["action"] == "stop"
    assert spotify_client.playback_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "fresh-access-token",
            "action": "pause",
            "device_id": "pipzo-device-id",
        }
    ]


def test_hardware_playback_control_maps_spotify_errors_to_honest_blocked_state(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings)
    spotify_client = FakeSpotifyClient(playback_failure=SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND)

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.post("/api/v1/playback/control", json={"action": "play", "deviceId": "missing-device"})

    assert response.status_code == 200
    assert response.json()["state"] == "blocked"
    assert response.json()["reason"] == "device_not_registered"


def test_hardware_volume_patch_coordinates_spotify_and_os_volume(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings)
    spotify_client = FakeSpotifyClient()
    volume_adapter = FakeVolumeAdapter()

    with make_client(settings, spotify_client=spotify_client, volume_adapter_override=volume_adapter) as client:
        response = client.patch("/api/v1/volume", json={"value": 64, "muted": False, "deviceId": "pipzo-device-id"})

    assert response.status_code == 200
    assert response.json() == {"status": "unified", "reason": None, "value": 64, "muted": False}
    assert spotify_client.volume_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "refreshed-access-token",
            "volume_percent": 64,
            "device_id": "pipzo-device-id",
        }
    ]
    assert volume_adapter.set_calls == [(64, False)]


def test_hardware_volume_patch_reports_partial_os_only_when_spotify_volume_fails(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings)
    spotify_client = FakeSpotifyClient(playback_failure=SpotifyPlaybackApiFailure.DEVICE_NOT_FOUND)
    volume_adapter = FakeVolumeAdapter()

    with make_client(settings, spotify_client=spotify_client, volume_adapter_override=volume_adapter) as client:
        response = client.patch("/api/v1/volume", json={"value": 31, "muted": True})

    assert response.status_code == 200
    assert response.json() == {
        "status": "os_only",
        "reason": "spotify_volume_unsupported",
        "value": 31,
        "muted": True,
    }


def test_hardware_volume_patch_reports_spotify_only_when_os_audio_session_unavailable(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings)
    spotify_client = FakeSpotifyClient()
    volume_adapter = FakeVolumeAdapter(unavailable_reason=VolumeReason.AUDIO_SESSION_UNAVAILABLE)

    with make_client(settings, spotify_client=spotify_client, volume_adapter_override=volume_adapter) as client:
        response = client.patch("/api/v1/volume", json={"value": 45, "muted": False})

    assert response.status_code == 200
    assert response.json() == {
        "status": "spotify_only",
        "reason": "audio_session_unavailable",
        "value": 45,
        "muted": False,
    }


def test_mock_library_browse_and_constrained_search_work_without_spotify_auth(tmp_path):
    settings = make_settings(tmp_path)

    with make_client(settings) as client:
        home = client.get("/api/v1/library/home")
        playlists = client.get("/api/v1/library/playlists")
        search = client.get("/api/v1/library/search?q=bedtime")
        play = client.post(
            "/api/v1/library/play",
            json={"uri": "spotify:playlist:pipzo-bedtime", "playbackKind": "context"},
        )

    assert home.status_code == 200
    assert home.json()["constrained"] is True
    assert {section["id"] for section in home.json()["sections"]} >= {"playlists", "albums", "artists", "liked_songs", "recently_played"}
    assert playlists.status_code == 200
    assert playlists.json()["items"][0]["title"] == "Bedtime Favorites"
    assert search.status_code == 200
    assert search.json()["constrained"] is True
    assert search.json()["sections"][0]["items"][0]["title"] == "Bedtime Favorites"
    assert play.status_code == 200
    assert play.json()["state"] == "succeeded"
    assert play.json()["mock"] is True


def test_hardware_library_uses_existing_scopes_and_maps_spotify_payloads(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings, access_token="stored-access-token")
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="fresh-catalog-token",
            refresh_token=None,
            token_type="Bearer",
            scope="playlist-read-private user-library-read user-read-recently-played",
            expires_in=3600,
        ),
        catalog_payloads={
            "/v1/me/playlists": {
                "items": [
                    {
                        "id": "playlist-id",
                        "uri": "spotify:playlist:playlist-id",
                        "name": "Bedtime Favorites",
                        "tracks": {"total": 12},
                        "owner": {"display_name": "Pipzo"},
                        "images": [{"url": "https://example.test/playlist.jpg"}],
                    }
                ]
            },
            "/v1/me/albums": {
                "items": [
                    {
                        "album": {
                            "id": "album-id",
                            "uri": "spotify:album:album-id",
                            "name": "Quiet Album",
                            "artists": [{"name": "Quiet Artist"}],
                            "images": [{"url": "https://example.test/album.jpg"}],
                        }
                    }
                ]
            },
            "/v1/me/tracks": {
                "items": [
                    {
                        "track": {
                            "id": "track-id",
                            "uri": "spotify:track:track-id",
                            "name": "Quiet Favorite",
                            "artists": [{"name": "Quiet Artist"}],
                            "album": {"name": "Quiet Album", "images": [{"url": "https://example.test/track.jpg"}]},
                        }
                    }
                ]
            },
            "/v1/me/player/recently-played": {"items": []},
        },
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.get("/api/v1/library/home?limit=8")

    assert response.status_code == 200
    body = response.json()
    playlists = next(section for section in body["sections"] if section["id"] == "playlists")
    albums = next(section for section in body["sections"] if section["id"] == "albums")
    artists = next(section for section in body["sections"] if section["id"] == "artists")
    liked = next(section for section in body["sections"] if section["id"] == "liked_songs")

    assert playlists["items"][0]["uri"] == "spotify:playlist:playlist-id"
    assert playlists["items"][0]["playbackKind"] == "context"
    assert albums["items"][0]["title"] == "Quiet Album"
    assert liked["items"][0]["playbackKind"] == "track"
    assert artists["items"][0]["title"] == "Quiet Artist"
    assert body["constrained"] is True
    assert {call["path"] for call in spotify_client.catalog_calls} == {
        "/v1/me/playlists",
        "/v1/me/albums",
        "/v1/me/tracks",
        "/v1/me/player/recently-played",
    }
    assert all(call["access_token"] == "fresh-catalog-token" for call in spotify_client.catalog_calls)


def test_hardware_library_home_includes_recent_saved_playlist_contexts(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings, access_token="stored-access-token")
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="fresh-catalog-token",
            refresh_token=None,
            token_type="Bearer",
            scope="playlist-read-private user-library-read user-read-recently-played",
            expires_in=3600,
        ),
        catalog_payloads={
            "/v1/me/playlists": {
                "items": [
                    {
                        "id": "playlist-id",
                        "uri": "spotify:playlist:playlist-id",
                        "name": "Bedtime Favorites",
                        "tracks": {"total": 12},
                        "owner": {"display_name": "Pipzo"},
                    }
                ]
            },
            "/v1/me/albums": {"items": []},
            "/v1/me/tracks": {"items": []},
            "/v1/me/player/recently-played": {
                "items": [
                    {
                        "context": {"type": "playlist", "uri": "spotify:playlist:playlist-id"},
                        "track": {
                            "id": "track-id",
                            "uri": "spotify:track:track-id",
                            "name": "Quiet Track",
                            "artists": [{"name": "Quiet Artist"}],
                            "album": {"name": "Quiet Album"},
                        },
                    }
                ]
            },
        },
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.get("/api/v1/library/home?limit=8")

    assert response.status_code == 200
    recent = next(section for section in response.json()["sections"] if section["id"] == "recently_played")
    assert [(item["type"], item["title"], item["playbackKind"]) for item in recent["items"]] == [
        ("playlist", "Bedtime Favorites", "context"),
        ("track", "Quiet Track", "track"),
    ]


def test_hardware_library_search_filters_only_library_results(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings)
    spotify_client = FakeSpotifyClient(
        catalog_payloads={
            "/v1/me/playlists": {"items": [{"id": "sleep", "uri": "spotify:playlist:sleep", "name": "Sleep Songs"}]},
            "/v1/me/albums": {"items": [{"album": {"id": "dance", "uri": "spotify:album:dance", "name": "Dance Album", "artists": [{"name": "Dance Artist"}]}}]},
            "/v1/me/tracks": {"items": [{"track": {"id": "quiet", "uri": "spotify:track:quiet", "name": "Quiet Song", "artists": [{"name": "Quiet Artist"}]}}]},
            "/v1/me/player/recently-played": {"items": []},
        }
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.get("/api/v1/library/search?q=quiet")

    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "quiet"
    assert body["constrained"] is True
    assert [(section["id"], [item["title"] for item in section["items"]]) for section in body["sections"]] == [
        ("liked_songs", ["Quiet Song"]),
        ("artists", ["Quiet Artist"]),
    ]


def test_hardware_library_play_starts_context_or_track_without_exposing_tokens(tmp_path):
    settings = make_settings(tmp_path, app_mode="hardware")
    persist_auth_record(settings, access_token="stored-access-token")
    spotify_client = FakeSpotifyClient(
        refresh_response=SpotifyTokenResponse(
            access_token="fresh-play-token",
            refresh_token=None,
            token_type="Bearer",
            scope="streaming user-modify-playback-state user-library-read",
            expires_in=3600,
        )
    )

    with make_client(settings, spotify_client=spotify_client) as client:
        response = client.post(
            "/api/v1/library/play",
            json={"uri": "spotify:album:album-id", "playbackKind": "context", "deviceId": "pipzo-device-id"},
        )

    assert response.status_code == 200
    assert response.json()["state"] == "succeeded"
    assert response.json()["mock"] is False
    assert spotify_client.start_playback_calls == [
        {
            "api_base_url": "https://api.spotify.com",
            "access_token": "fresh-play-token",
            "playback_kind": "context",
            "uri": "spotify:album:album-id",
            "device_id": "pipzo-device-id",
        }
    ]
    assert "stored-refresh-token" not in str(response.json())


def test_library_play_rejects_non_spotify_playable_uris(tmp_path):
    settings = make_settings(tmp_path)

    with make_client(settings) as client:
        response = client.post(
            "/api/v1/library/play",
            json={"uri": "https://example.test/not-spotify", "playbackKind": "context"},
        )

    assert response.status_code == 422
    assert "Spotify context URI" in str(response.json())


def test_hardware_library_gets_report_auth_and_network_failures_honestly(tmp_path):
    auth_settings = make_settings(tmp_path / "auth", app_mode="hardware")
    network_settings = make_settings(tmp_path / "network", app_mode="hardware")
    persist_auth_record(network_settings)
    spotify_client = FakeSpotifyClient(catalog_failure=SpotifyCatalogApiFailure.NETWORK)

    with make_client(auth_settings, spotify_client=FakeSpotifyClient()) as client:
        auth_response = client.get("/api/v1/library/home")
    with make_client(network_settings, spotify_client=spotify_client) as client:
        network_response = client.get("/api/v1/library/home")

    assert auth_response.status_code == 401
    assert auth_response.json()["detail"] == "auth"
    assert network_response.status_code == 503
    assert network_response.json()["detail"] == "network"


def test_reset_app_clears_spotify_auth_state(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()
    persist_auth_record(settings)

    with make_client(settings, service) as client:
        client.post("/api/v1/mock/scenarios/ready_healthy/activate")
        session = create_session(client)
        response = client.post("/api/v1/recovery/actions/reset-app/run", json={"confirm": True})
        state_response = client.get("/api/v1/app/state")

    assert response.status_code == 200
    assert response.json()["state"] == "succeeded"
    assert SpotifyAuthStore(settings.db_path).get_auth_record() is None
    assert service._sessions == {}
    assert state_response.json()["appPhase"] == "setup"
    assert state_response.json()["health"]["spotifyAuth"]["status"] == "none"
    assert state_response.json()["readiness"]["spotifyAuthorized"] is False
    assert session["sessionId"] not in service._sessions


def test_request_logging_omits_oauth_query_string_and_body(capsys, tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()

    with make_client(settings, service) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        client.get(f"/api/v1/spotify/auth/callback?state={state}&code=sensitive-auth-code")

    logs = capsys.readouterr().out
    assert "/api/v1/spotify/auth/callback" in logs
    assert "sensitive-auth-code" not in logs
    assert state not in logs
    assert "?" not in logs
