from fastapi.testclient import TestClient

from pipzo_api.config import Settings
from pipzo_api.main import create_app


def make_settings(tmp_path, **overrides) -> Settings:
    values = {
        "db_path": str(tmp_path / "extension-diagnostics.sqlite3"),
        "pipzo_token_key_path": str(tmp_path / "spotify-token.key"),
        "spotify_client_id": "spotify-client-id",
    }
    values.update(overrides)
    return Settings(**values)


def test_extension_diagnostics_accepts_only_bounded_safe_shape(tmp_path):
    app = create_app(settings_override=make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/diagnostics/extension",
            json={
                "source": "content_script",
                "originClass": "spotify_accounts",
                "path": "/login?continue=secret#fragment",
                "topFrame": True,
                "manifestVersion": "0.1.4",
                "keyboardRootPresent": True,
                "keyboardVisible": False,
                "launcherPresent": True,
                "recoveryControlsPresent": True,
                "scrollControlsPresent": True,
                "editablePresent": True,
                "otpLikePresent": True,
            },
        )

        assert response.status_code == 200
        payload = response.json()
        assert len(payload["events"]) == 1
        assert payload["events"][0] == {
            "source": "content_script",
            "originClass": "spotify_accounts",
            "path": "/login",
            "topFrame": True,
            "manifestVersion": "0.1.4",
            "keyboardRootPresent": True,
            "keyboardVisible": False,
            "launcherPresent": True,
            "recoveryControlsPresent": True,
            "scrollControlsPresent": True,
            "editablePresent": True,
            "otpLikePresent": True,
            "tabStatus": None,
            "injectionAttempted": None,
            "generatedAt": payload["events"][0]["generatedAt"],
        }

        snapshot = client.get("/api/v1/diagnostics/extension")
        assert snapshot.status_code == 200
        assert snapshot.json()["events"][0]["path"] == "/login"


def test_extension_diagnostics_rejects_unknown_origin_class(tmp_path):
    app = create_app(settings_override=make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/diagnostics/extension",
            json={"source": "service_worker", "originClass": "https://accounts.spotify.com", "path": "/login"},
        )

    assert response.status_code == 422
