from pipzo_api.adapters.kiosk_browser_session import KioskBrowserSessionResetAdapter


class RecordingKioskBrowserSessionResetAdapter(KioskBrowserSessionResetAdapter):
    def __init__(self) -> None:
        super().__init__(reset_command_path="/usr/local/bin/pipzo-reset-kiosk-browser-session")
        self.argv_calls: list[list[str]] = []

    def _reset_command(self) -> str:
        return "/usr/local/bin/pipzo-reset-kiosk-browser-session"

    def _spawn_argv(self, argv):
        self.argv_calls.append(list(argv))


def test_kiosk_browser_session_reset_adapter_uses_fixed_helper_argv():
    adapter = RecordingKioskBrowserSessionResetAdapter()

    result = adapter.reset()

    assert adapter.argv_calls == [["/usr/local/bin/pipzo-reset-kiosk-browser-session"]]
    assert result.id == "spotify-browser-session-reset"
    assert result.action == "reset_spotify_browser_session"
    assert result.domain == "settings"
    assert result.mock is False
