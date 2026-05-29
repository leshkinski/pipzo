import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Sequence

from pipzo_api.bluetooth_store import BluetoothSpeakerStore
from pipzo_api.contract import (
    RecoveryAction,
    RecoveryActionKind,
    RecoveryActionState,
    SpeakerDevice,
    SpeakerHealth,
    SpeakerReason,
    SpeakerScanResults,
    SpeakerStatus,
    SpeakerSummary,
    utc_now,
)


class BlueZUnavailable(RuntimeError):
    def __init__(self, message: str = "bluetoothctl is unavailable") -> None:
        super().__init__(message)


class BlueZCommandError(RuntimeError):
    def __init__(self, reason: SpeakerReason, detail: str = "") -> None:
        super().__init__(detail or reason.value)
        self.reason = reason


@dataclass(frozen=True)
class BluetoothCommandResult:
    returncode: int
    stdout: str
    stderr: str


BluetoothCommandRunner = Callable[[Sequence[str], int, Optional[str]], BluetoothCommandResult]

MAC_RE = re.compile(r"(?P<address>(?:[0-9A-F]{2}:){5}[0-9A-F]{2})", re.IGNORECASE)
AUDIO_UUID_MARKERS = ("audio sink", "advanced audio distribution", "a/v remote control", "headset", "handsfree")


def subprocess_runner(argv: Sequence[str], timeout_seconds: int, input_text: Optional[str] = None) -> BluetoothCommandResult:
    completed = subprocess.run(
        list(argv),
        check=False,
        capture_output=True,
        input=input_text,
        text=True,
        timeout=timeout_seconds,
    )
    return BluetoothCommandResult(returncode=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)


def parse_device_lines(stdout: str) -> List[SpeakerDevice]:
    devices: dict[str, SpeakerDevice] = {}
    for line in stdout.splitlines():
        match = MAC_RE.search(line)
        if not match:
            continue
        address = match.group("address").upper()
        name = line[match.end() :].strip() or address
        devices[address] = SpeakerDevice(address=address, display_name=name, paired=False, connected=False)
    return list(devices.values())


def parse_info(stdout: str, fallback_address: str, fallback_name: Optional[str] = None) -> SpeakerDevice:
    name = fallback_name or fallback_address
    alias: Optional[str] = None
    paired = False
    connected = False
    has_audio_profile = False
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if line.startswith("Name:"):
            name = line.split(":", 1)[1].strip() or name
        elif line.startswith("Alias:"):
            alias = line.split(":", 1)[1].strip() or None
        elif line.startswith("Paired:"):
            paired = _yes_value(line)
        elif line.startswith("Connected:"):
            connected = _yes_value(line)
        elif line.startswith("UUID:") and any(marker in line.lower() for marker in AUDIO_UUID_MARKERS):
            has_audio_profile = True
    return SpeakerDevice(
        address=fallback_address.upper(),
        display_name=name,
        alias=alias,
        paired=paired,
        connected=connected,
        signal=None if has_audio_profile else None,
    )


def info_has_audio_profile(stdout: str) -> bool:
    return any(line.strip().startswith("UUID:") and any(marker in line.lower() for marker in AUDIO_UUID_MARKERS) for line in stdout.splitlines())


def map_bluetoothctl_failure(stderr: str, stdout: str = "") -> SpeakerReason:
    text = f"{stderr}\n{stdout}".lower()
    if "no default controller" in text or "not available" in text or "no controller" in text:
        return SpeakerReason.ADAPTER_UNAVAILABLE
    if "not powered" in text or "powered off" in text or "bluetooth is disabled" in text:
        return SpeakerReason.BLUETOOTH_DISABLED
    if "authentication" in text or "rejected" in text or "not authorized" in text:
        return SpeakerReason.PAIR_REJECTED
    if "timeout" in text or "timed out" in text:
        return SpeakerReason.PAIR_TIMEOUT
    if "br-connection" in text or "failed to connect" in text or "connection failed" in text:
        return SpeakerReason.CONNECT_FAILED
    if "not available" in text or "not found" in text or "does not exist" in text:
        return SpeakerReason.DEVICE_OUT_OF_RANGE
    if "profile" in text or "a2dp" in text:
        return SpeakerReason.AUDIO_PROFILE_UNAVAILABLE
    return SpeakerReason.UNKNOWN


class BluetoothctlAdapter:
    def __init__(
        self,
        store: BluetoothSpeakerStore,
        runner: BluetoothCommandRunner = subprocess_runner,
        bluetoothctl_path: Optional[str] = None,
        command_timeout_seconds: int = 30,
        scan_timeout_seconds: int = 12,
    ) -> None:
        self._store = store
        self._runner = runner
        self._bluetoothctl_path = bluetoothctl_path
        self._command_timeout_seconds = command_timeout_seconds
        self._scan_timeout_seconds = scan_timeout_seconds
        self._last_scan: List[SpeakerDevice] = []

    def probe(self) -> None:
        self._bluetoothctl()

    def status(self) -> SpeakerHealth:
        self._ensure_powered()
        primary = self._store.get_primary()
        if primary is None:
            return SpeakerHealth(status=SpeakerStatus.NONE_SAVED, reason=SpeakerReason.PRIMARY_MISSING)
        try:
            device = self._device_info(primary.address, primary.display_name)
        except BlueZCommandError as exc:
            saved = primary.model_copy(update={"connected": False})
            return SpeakerHealth(status=SpeakerStatus.SAVED_DISCONNECTED, reason=exc.reason, primary=saved)
        saved = SpeakerSummary(
            address=primary.address,
            display_name=device.display_name or primary.display_name,
            alias=device.alias or primary.alias,
            connected=device.connected,
        )
        if device.connected:
            return SpeakerHealth(status=SpeakerStatus.CONNECTED, primary=saved)
        return SpeakerHealth(status=SpeakerStatus.SAVED_DISCONNECTED, reason=SpeakerReason.DEVICE_OUT_OF_RANGE, primary=saved)

    def scan(self) -> RecoveryAction:
        started_at = utc_now()
        self._ensure_powered()
        result = self._runner(
            [self._bluetoothctl(), "--timeout", str(self._scan_timeout_seconds), "scan", "on"],
            self._scan_timeout_seconds + 2,
            None,
        )
        if result.returncode != 0:
            return self._action("speaker-scan", RecoveryActionState.FAILED, started_at, map_bluetoothctl_failure(result.stderr, result.stdout))
        self._last_scan = self._scan_devices()
        state = RecoveryActionState.SUCCEEDED if self._last_scan else RecoveryActionState.FAILED
        reason = None if self._last_scan else SpeakerReason.SCAN_EMPTY
        return self._action("speaker-scan", state, started_at, reason)

    def scan_results(self) -> SpeakerScanResults:
        if not self._last_scan:
            self._ensure_powered()
            self._last_scan = self._scan_devices()
        return SpeakerScanResults(devices=self._last_scan, scanned_at=utc_now())

    def pair(self, address: str, display_name: Optional[str] = None) -> RecoveryAction:
        started_at = utc_now()
        self._ensure_powered()
        address = address.upper()
        result = self._run_script(
            [
                "agent NoInputNoOutput",
                "default-agent",
                f"pair {address}",
                f"trust {address}",
                f"connect {address}",
            ],
            timeout_seconds=self._command_timeout_seconds,
        )
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, map_bluetoothctl_failure(result.stderr, result.stdout))
        try:
            device = self._device_info(address, display_name)
        except BlueZCommandError as exc:
            return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, exc.reason)
        if not device.connected:
            return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.CONNECT_FAILED)
        self._store.save_primary(SpeakerSummary(address=address, display_name=device.display_name, alias=device.alias, connected=True))
        return self._action("speaker-pair", RecoveryActionState.SUCCEEDED, started_at)

    def reconnect(self) -> RecoveryAction:
        started_at = utc_now()
        self._ensure_powered()
        primary = self._store.get_primary()
        if primary is None:
            return self._action("speaker-reconnect", RecoveryActionState.FAILED, started_at, SpeakerReason.PRIMARY_MISSING)
        result = self._run_script([f"trust {primary.address}", f"connect {primary.address}"], timeout_seconds=self._command_timeout_seconds)
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            return self._action("speaker-reconnect", RecoveryActionState.FAILED, started_at, map_bluetoothctl_failure(result.stderr, result.stdout))
        return self._action("speaker-reconnect", RecoveryActionState.SUCCEEDED, started_at)

    def forget(self, address: str) -> RecoveryAction:
        started_at = utc_now()
        self._ensure_powered()
        result = self._run_script([f"remove {address.upper()}"], timeout_seconds=self._command_timeout_seconds)
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            return self._action("speaker-forget", RecoveryActionState.FAILED, started_at, map_bluetoothctl_failure(result.stderr, result.stdout))
        primary = self._store.get_primary()
        if primary is not None and primary.address.upper() == address.upper():
            self._store.delete_primary()
        return self._action("speaker-forget", RecoveryActionState.SUCCEEDED, started_at)

    def _scan_devices(self) -> List[SpeakerDevice]:
        result = self._run_script(["devices"], timeout_seconds=10)
        if result.returncode != 0:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        devices: List[SpeakerDevice] = []
        for device in parse_device_lines(result.stdout):
            try:
                info = self._device_info(device.address, device.display_name)
            except BlueZCommandError:
                info = device
            if info_has_audio_profile(self._run_script([f"info {device.address}"], timeout_seconds=10).stdout) or info.paired or info.connected:
                devices.append(info)
        return _dedupe_devices(devices)

    def _device_info(self, address: str, fallback_name: Optional[str] = None) -> SpeakerDevice:
        result = self._run_script([f"info {address.upper()}"], timeout_seconds=10)
        if result.returncode != 0 or "Device " in result.stderr and "not available" in result.stderr:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        return parse_info(result.stdout, address, fallback_name)

    def _ensure_powered(self) -> None:
        result = self._run_script(["show"], timeout_seconds=10)
        if result.returncode != 0:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        for line in result.stdout.splitlines():
            if line.strip().startswith("Powered:") and not _yes_value(line):
                raise BlueZCommandError(SpeakerReason.BLUETOOTH_DISABLED, result.stdout)

    def _run_script(self, commands: Iterable[str], timeout_seconds: int) -> BluetoothCommandResult:
        input_text = "\n".join(commands) + "\n"
        return self._runner([self._bluetoothctl()], timeout_seconds, input_text)

    def _bluetoothctl(self) -> str:
        path = self._bluetoothctl_path or shutil.which("bluetoothctl")
        if not path:
            raise BlueZUnavailable()
        return path

    def _action(
        self,
        action_id: str,
        state: RecoveryActionState,
        started_at,
        reason: Optional[SpeakerReason] = None,
    ) -> RecoveryAction:
        kind = RecoveryActionKind.RECONNECT_SPEAKER
        if action_id == "speaker-forget":
            kind = RecoveryActionKind.FORGET_SPEAKER
        return RecoveryAction(
            id=action_id,
            kind=kind,
            state=state,
            reason=reason,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )


def _yes_value(line: str) -> bool:
    return line.split(":", 1)[1].strip().lower() in {"yes", "true", "on"}


def _has_failed_output(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    return "failed" in text or "not available" in text or "not authorized" in text


def _dedupe_devices(devices: Iterable[SpeakerDevice]) -> List[SpeakerDevice]:
    by_address: dict[str, SpeakerDevice] = {}
    for device in devices:
        by_address[device.address.upper()] = device
    return sorted(by_address.values(), key=lambda item: item.display_name.lower())
