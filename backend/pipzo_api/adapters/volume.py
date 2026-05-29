import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

from pipzo_api.contract import VolumeHealth, VolumeReason, VolumeStatus


class VolumeUnavailable(Exception):
    def __init__(self, reason: VolumeReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


class VolumeCommandError(Exception):
    def __init__(self, reason: VolumeReason) -> None:
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[Sequence[str]], CommandResult]


class PipeWireVolumeAdapter:
    """Controls the default desktop audio sink through WirePlumber or PipeWire Pulse."""

    def __init__(self, runner: Optional[CommandRunner] = None) -> None:
        self._runner = runner or self._run

    def probe(self) -> None:
        self._backend()

    def status(self) -> VolumeHealth:
        backend = self._backend()
        if backend == "wpctl":
            return self._wpctl_status()
        return self._pactl_status()

    def set_volume(self, value: int, muted: bool = False) -> VolumeHealth:
        bounded = max(0, min(100, value))
        backend = self._backend()
        if backend == "wpctl":
            self._checked(["wpctl", "set-volume", "-l", "1.0", "@DEFAULT_SINK@", f"{bounded}%"])
            self._checked(["wpctl", "set-mute", "@DEFAULT_SINK@", "1" if muted else "0"])
        else:
            self._checked(["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{bounded}%"])
            self._checked(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "1" if muted else "0"])

        readback = self.status()
        if readback.value is not None and abs(readback.value - bounded) > 2:
            return VolumeHealth(
                status=VolumeStatus.OUT_OF_SYNC,
                reason=VolumeReason.READBACK_MISMATCH,
                value=readback.value,
                muted=readback.muted,
            )
        return VolumeHealth(
            status=VolumeStatus.OS_ONLY,
            value=readback.value if readback.value is not None else bounded,
            muted=readback.muted if readback.muted is not None else muted,
        )

    def _backend(self) -> str:
        if shutil.which("wpctl"):
            return "wpctl"
        if shutil.which("pactl"):
            return "pactl"
        raise VolumeUnavailable(VolumeReason.OS_SINK_MISSING)

    def _wpctl_status(self) -> VolumeHealth:
        result = self._checked(["wpctl", "get-volume", "@DEFAULT_SINK@"])
        value, muted = parse_wpctl_get_volume(result.stdout)
        return VolumeHealth(status=VolumeStatus.OS_ONLY, value=value, muted=muted)

    def _pactl_status(self) -> VolumeHealth:
        volume = self._checked(["pactl", "get-sink-volume", "@DEFAULT_SINK@"])
        mute = self._checked(["pactl", "get-sink-mute", "@DEFAULT_SINK@"])
        value = parse_pactl_get_sink_volume(volume.stdout)
        muted = parse_pactl_get_sink_mute(mute.stdout)
        return VolumeHealth(status=VolumeStatus.OS_ONLY, value=value, muted=muted)

    def _checked(self, command: Sequence[str]) -> CommandResult:
        result = self._runner(command)
        if result.returncode == 0:
            return result
        reason = classify_volume_error(result.stderr or result.stdout)
        if reason == VolumeReason.OS_SINK_MISSING:
            raise VolumeUnavailable(reason)
        raise VolumeCommandError(reason)

    def _run(self, command: Sequence[str]) -> CommandResult:
        completed = subprocess.run(command, capture_output=True, check=False, text=True, timeout=5)
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)


def parse_wpctl_get_volume(output: str) -> tuple[int, bool]:
    match = re.search(r"Volume:\s*([0-9]+(?:\.[0-9]+)?)", output)
    if not match:
        raise VolumeCommandError(VolumeReason.UNKNOWN)
    value = round(float(match.group(1)) * 100)
    muted = "[MUTED]" in output.upper()
    return max(0, min(100, value)), muted


def parse_pactl_get_sink_volume(output: str) -> int:
    percentages = [int(value) for value in re.findall(r"(\d+)%", output)]
    if not percentages:
        raise VolumeCommandError(VolumeReason.UNKNOWN)
    return max(0, min(100, round(sum(percentages) / len(percentages))))


def parse_pactl_get_sink_mute(output: str) -> bool:
    normalized = output.lower()
    if "yes" in normalized:
        return True
    if "no" in normalized:
        return False
    raise VolumeCommandError(VolumeReason.UNKNOWN)


def classify_volume_error(output: str) -> VolumeReason:
    normalized = output.lower()
    if "permission" in normalized or "access denied" in normalized or "not authorized" in normalized:
        return VolumeReason.PERMISSION_DENIED
    if (
        "no such entity" in normalized
        or "not found" in normalized
        or "failed to connect" in normalized
        or "connection refused" in normalized
    ):
        return VolumeReason.OS_SINK_MISSING
    return VolumeReason.UNKNOWN
