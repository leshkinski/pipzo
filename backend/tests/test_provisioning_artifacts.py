from pathlib import Path
import json


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


def test_installer_installs_bounded_power_polkit_rule():
    installer = (REPO_ROOT / "provisioning/scripts/install-app.sh").read_text()
    rule = (REPO_ROOT / "provisioning/polkit/50-pipzo-power.rules").read_text()

    assert "50-pipzo-power.rules" in installer
    assert 'subject.user !== "__PIPZO_SERVICE_USER__"' in rule
    assert "org.freedesktop.login1.reboot" in rule
    assert "org.freedesktop.login1.reboot-multiple-sessions" in rule
    assert "org.freedesktop.login1.power-off" in rule
    assert "org.freedesktop.login1.power-off-multiple-sessions" in rule
    assert "ignore-inhibit" not in rule
    assert "suspend" not in rule


def test_installer_embeds_source_commit_in_frontend_build():
    installer = (REPO_ROOT / "provisioning/scripts/install-app.sh").read_text()
    app_source = (REPO_ROOT / "frontend/src/App.tsx").read_text()

    assert 'BUILD_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf \'unknown\')"' in installer
    assert 'VITE_PIPZO_BUILD_COMMIT="$BUILD_COMMIT" npm --prefix "$APP_DIR/frontend" run build' in installer
    assert "VITE_PIPZO_BUILD_COMMIT" in app_source
    assert "data-build-commit={pipzoBuildCommit}" in app_source


def test_backend_unit_keeps_state_directory_permissions_explicit():
    unit = (REPO_ROOT / "provisioning/systemd/pipzo-backend.service").read_text()

    assert "StateDirectory=pipzo" in unit
    assert "StateDirectoryMode=0700" in unit
    assert "LogsDirectory=pipzo" in unit
    assert "LogsDirectoryMode=0750" in unit


def test_kiosk_runtime_defaults_to_true_fullscreen_with_diagnostic_app_mode():
    launcher = (REPO_ROOT / "provisioning/scripts/kiosk-launcher.sh").read_text()
    kiosk_env = (REPO_ROOT / "provisioning/env/pipzo-kiosk.env.example").read_text()
    installer = (REPO_ROOT / "provisioning/scripts/install-app.sh").read_text()
    docs = (REPO_ROOT / "docs/provisioning.md").read_text()

    assert 'CHROMIUM_MODE="${PIPZO_CHROMIUM_MODE:-kiosk}"' in launcher
    assert 'PIPZO_CHROMIUM_MODE=kiosk' in kiosk_env
    assert '--kiosk "$KIOSK_URL"' in launcher
    assert "--app=\"$KIOSK_URL\"" in launcher
    assert "V1 product default" in docs
    assert "PIPZO_CHROMIUM_MODE=app-maximized" in docs
    assert "Existing $ENV_DIR/kiosk.env keeps diagnostic PIPZO_CHROMIUM_MODE=app-maximized." in installer
    assert "Squeekboard" in docs


def test_kiosk_launcher_supports_opt_in_chromium_diagnostic_flags():
    launcher = (REPO_ROOT / "provisioning/scripts/kiosk-launcher.sh").read_text()
    kiosk_env = (REPO_ROOT / "provisioning/env/pipzo-kiosk.env.example").read_text()
    docs = (REPO_ROOT / "docs/provisioning.md").read_text()
    probe = (REPO_ROOT / "provisioning/touch-event-probe.html").read_text()

    assert 'CHROMIUM_EXTRA_FLAGS="${PIPZO_CHROMIUM_EXTRA_FLAGS:-}"' in launcher
    assert 'EXTRA_FLAGS=($CHROMIUM_EXTRA_FLAGS)' in launcher
    assert '"${EXTRA_FLAGS[@]}"' in launcher
    assert "PIPZO_CHROMIUM_EXTRA_FLAGS=" in kiosk_env
    assert "--touch-events=enabled" in docs
    assert "pointermove" in probe
    assert "touchmove" in probe


def test_kiosk_launcher_loads_first_party_keyboard_extension_without_changing_true_kiosk():
    launcher = (REPO_ROOT / "provisioning/scripts/kiosk-launcher.sh").read_text()
    kiosk_env = (REPO_ROOT / "provisioning/env/pipzo-kiosk.env.example").read_text()
    installer = (REPO_ROOT / "provisioning/scripts/install-app.sh").read_text()

    assert 'CHROMIUM_MODE="${PIPZO_CHROMIUM_MODE:-kiosk}"' in launcher
    assert 'CHROMIUM_EXTENSION_DIR="${PIPZO_CHROMIUM_EXTENSION_DIR:-}"' in launcher
    assert 'EXTENSION_FLAGS=(--load-extension="$CHROMIUM_EXTENSION_DIR")' in launcher
    assert '"${EXTENSION_FLAGS[@]}"' in launcher
    assert "PIPZO_CHROMIUM_MODE=kiosk" in kiosk_env
    assert "PIPZO_CHROMIUM_EXTENSION_DIR=/opt/pipzo/app/provisioning/chromium-extension/virtual-keyboard" in kiosk_env
    assert "PIPZO_CHROMIUM_EXTRA_FLAGS=" in kiosk_env
    assert "PIPZO_CHROMIUM_EXTENSION_DIR=$APP_DIR/provisioning/chromium-extension/virtual-keyboard" in installer
    assert 'chown -R root:root "$APP_DIR"' in installer


def test_keyboard_extension_manifest_is_narrow_and_static():
    extension_dir = REPO_ROOT / "provisioning/chromium-extension/virtual-keyboard"
    manifest = json.loads((extension_dir / "manifest.json").read_text())
    content_script = (extension_dir / "pipzo-keyboard.js").read_text()
    stylesheet = (extension_dir / "pipzo-keyboard.css").read_text()

    assert manifest["manifest_version"] == 3
    assert set(manifest) == {"manifest_version", "name", "version", "description", "content_scripts"}
    assert "permissions" not in manifest
    assert "host_permissions" not in manifest
    assert "background" not in manifest
    assert "externally_connectable" not in manifest

    scripts = manifest["content_scripts"]
    assert len(scripts) == 1
    script = scripts[0]
    assert script["matches"] == [
        "http://127.0.0.1:8000/*",
        "http://localhost:8000/*",
        "https://accounts.spotify.com/*",
    ]
    assert script["js"] == ["pipzo-keyboard.js"]
    assert script["css"] == ["pipzo-keyboard.css"]
    assert script["run_at"] == "document_start"
    assert script["all_frames"] is True

    forbidden_tokens = ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "chrome.runtime", "sendMessage", "analytics"]
    for token in forbidden_tokens:
        assert token not in content_script
    assert "pointerdown" in content_script
    assert "touchstart" in content_script
    assert "dataset.pipzoKeyboardExtension" in content_script
    assert "https://accounts.spotify.com/*" not in content_script
    assert "#pipzo-extension-keyboard" in stylesheet
