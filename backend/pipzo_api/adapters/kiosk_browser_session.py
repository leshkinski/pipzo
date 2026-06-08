import shutil
import subprocess
from typing import Sequence

from pipzo_api.contract import ActionResult, RecoveryActionState, utc_now


class KioskBrowserSessionResetUnavailable(RuntimeError):
    pass


class KioskBrowserSessionResetError(RuntimeError):
    pass


class KioskBrowserSessionResetAdapter:
    def __init__(self, reset_command_path: str = "/usr/local/bin/pipzo-reset-kiosk-browser-session") -> None:
        self._reset_command_path = reset_command_path

    def reset(self) -> ActionResult:
        now = utc_now()
        argv = [self._reset_command()]
        self._spawn_argv(argv)
        return ActionResult(
            id="spotify-browser-session-reset",
            domain="settings",
            action="reset_spotify_browser_session",
            state=RecoveryActionState.SUCCEEDED,
            mock=False,
            started_at=now,
            completed_at=utc_now(),
        )

    def _reset_command(self) -> str:
        resolved = shutil.which(self._reset_command_path)
        if resolved is None:
            raise KioskBrowserSessionResetUnavailable("kiosk browser-session reset helper is not installed")
        return resolved

    def _spawn_argv(self, argv: Sequence[str]) -> None:
        try:
            subprocess.Popen(
                list(argv),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as exc:
            raise KioskBrowserSessionResetError("kiosk browser-session reset helper could not be started") from exc
