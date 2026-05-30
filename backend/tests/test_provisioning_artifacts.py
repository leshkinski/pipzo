from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_installer_defaults_backend_to_kiosk_user_and_migrates_state():
    installer = (REPO_ROOT / "provisioning/scripts/install-app.sh").read_text()

    assert 'SERVICE_USER=""' in installer
    assert 'if [[ -z "$SERVICE_USER" ]]; then\n  SERVICE_USER="$KIOSK_USER"\nfi' in installer
    assert 'SERVICE_GROUP="$(id -gn "$SERVICE_USER")"' in installer
    assert 'chown -R "$SERVICE_USER:$SERVICE_GROUP" "$STATE_DIR"' in installer
    assert 'install -m 0640 -o root -g "$SERVICE_GROUP" /tmp/pipzo.env "$ENV_DIR/pipzo.env"' in installer
    assert 'chown root:"$SERVICE_GROUP" "$ENV_DIR/pipzo.env"' in installer


def test_installer_preserves_explicit_legacy_service_user_override():
    installer = (REPO_ROOT / "provisioning/scripts/install-app.sh").read_text()

    assert "--service-user USER   Backend service user. Default: kiosk user" in installer
    assert '--service-user) SERVICE_USER="$2"; shift 2 ;;' in installer
    assert 'sed "s|__PIPZO_SERVICE_USER__|$SERVICE_USER|g"' in installer


def test_backend_unit_keeps_state_directory_permissions_explicit():
    unit = (REPO_ROOT / "provisioning/systemd/pipzo-backend.service").read_text()

    assert "StateDirectory=pipzo" in unit
    assert "StateDirectoryMode=0700" in unit
    assert "LogsDirectory=pipzo" in unit
    assert "LogsDirectoryMode=0750" in unit
