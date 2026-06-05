import shutil
import subprocess
from typing import Sequence

from pipzo_api.contract import ActionResult, RecoveryActionState, utc_now


class DevicePowerUnavailable(RuntimeError):
    pass


class DevicePowerCommandError(RuntimeError):
    pass


class SystemdDevicePowerAdapter:
    def __init__(self, systemctl_path: str = "systemctl") -> None:
        self._systemctl_path = systemctl_path

    def probe(self) -> None:
        self._systemctl()

    def reboot(self) -> ActionResult:
        return self._run("reboot")

    def poweroff(self) -> ActionResult:
        return self._run("poweroff")

    def _systemctl(self) -> str:
        resolved = shutil.which(self._systemctl_path)
        if resolved is None:
            raise DevicePowerUnavailable("systemctl is not installed")
        return resolved

    def _run(self, action: str) -> ActionResult:
        if action not in {"reboot", "poweroff"}:
            raise ValueError("unsupported device power action")
        now = utc_now()
        argv = [self._systemctl(), action]
        self._run_argv(argv)
        return ActionResult(
            id=f"device-{action}",
            domain="settings",
            action=action,
            state=RecoveryActionState.SUCCEEDED,
            mock=False,
            started_at=now,
            completed_at=utc_now(),
        )

    def _run_argv(self, argv: Sequence[str]) -> None:
        try:
            subprocess.run(
                list(argv),
                check=True,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except subprocess.TimeoutExpired as exc:
            raise DevicePowerCommandError("device power command timed out") from exc
        except subprocess.CalledProcessError as exc:
            raise DevicePowerCommandError((exc.stderr or exc.stdout or "device power command failed").strip()) from exc
