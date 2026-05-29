from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from pipzo_api.config import Settings
from pipzo_api.main import create_app
from pipzo_api.spotify_auth import SpotifyAuthSessionService


def make_settings(tmp_path, **overrides) -> Settings:
    values = {
        "db_path": str(tmp_path / "spotify-auth.sqlite3"),
        "spotify_client_id": "spotify-client-id",
    }
    values.update(overrides)
    return Settings(**values)


def make_client(settings: Settings, service: Optional[SpotifyAuthSessionService] = None) -> TestClient:
    app = create_app(settings_override=settings, spotify_auth_sessions_override=service)
    return TestClient(app)


def create_session(client: TestClient) -> dict:
    response = client.post("/api/v1/spotify/auth/session")
    assert response.status_code == 200
    return response.json()


def test_session_api_returns_safe_metadata_without_verifier_state_or_challenge(tmp_path):
    settings = make_settings(tmp_path)
    service = SpotifyAuthSessionService()

    with make_client(settings, service) as client:
        body = create_session(client)

    assert body["status"] == "waiting"
    assert body["sessionId"]
    assert body["startUrl"].endswith(f"/api/v1/spotify/auth/start/{body['sessionId']}")
    assert set(body) == {"sessionId", "status", "createdAt", "expiresAt", "startUrl", "failureReason"}
    assert body["failureReason"] is None

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
    now = datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)
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

    with make_client(settings, service) as client:
        session = create_session(client)
        state = service._sessions[session["sessionId"]].state
        response = client.get(f"/api/v1/spotify/auth/callback?state={state}&code=auth-code")
        status_response = client.get(f"/api/v1/spotify/auth/session/{session['sessionId']}")

    assert response.status_code == 200
    body = status_response.json()
    assert body["status"] == "callback_received"
    assert body["failureReason"] is None
    assert "auth-code" not in str(body)
    assert service._sessions[session["sessionId"]].code_verifier is None


def test_cancel_and_expiry_are_reported_safely(tmp_path):
    now = datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)
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
