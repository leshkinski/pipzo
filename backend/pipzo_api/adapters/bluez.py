import logging
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


@dataclass(frozen=True)
class DeviceInspection:
    device: SpeakerDevice
    has_audio_profile: bool
    looks_like_audio_device: bool


BluetoothCommandRunner = Callable[[Sequence[str], int, Optional[str]], BluetoothCommandResult]

logger = logging.getLogger("pipzo.bluez")

MAC_EXACT_RE = re.compile(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", re.IGNORECASE)
DEVICE_LINE_RE = re.compile(
    r"^(?:\[(?:NEW|CHG)\]\s+)?Device\s+(?P<address>(?:[0-9A-F]{2}:){5}[0-9A-F]{2})(?:\s+(?P<name>.*))?$",
    re.IGNORECASE,
)
AUDIO_UUID_MARKERS = ("audio sink", "advanced audio distribution", "a/v remote control", "headset", "handsfree")
AUDIO_ICON_MARKERS = ("audio-card", "audio-headphones", "audio-headset", "audio-speakers", "audio-speaker")
AUDIO_CLASS_MARKERS = ("audio/video", "rendering")


def subprocess_runner(argv: Sequence[str], timeout_seconds: int, input_text: Optional[str] = None) -> BluetoothCommandResult:
    try:
        completed = subprocess.run(
            list(argv),
            check=False,
            capture_output=True,
            input=input_text,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        return _timeout_result(exc, timeout_seconds)
    return BluetoothCommandResult(returncode=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)


def parse_device_lines(stdout: str) -> List[SpeakerDevice]:
    devices: dict[str, SpeakerDevice] = {}
    for line in stdout.splitlines():
        match = DEVICE_LINE_RE.match(line.strip())
        if not match:
            continue
        address = match.group("address").upper()
        name = (match.group("name") or "").strip() or address
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
        elif line.startswith("Bonded:") and _yes_value(line):
            paired = True
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


def info_looks_like_audio_device(stdout: str) -> bool:
    for raw_line in stdout.splitlines():
        line = raw_line.strip().lower()
        if line.startswith("uuid:") and any(marker in line for marker in AUDIO_UUID_MARKERS):
            return True
        if line.startswith("icon:") and any(marker in line for marker in AUDIO_ICON_MARKERS):
            return True
        if line.startswith("class:") and any(marker in line for marker in AUDIO_CLASS_MARKERS):
            return True
    return False


def map_bluetoothctl_failure(stderr: str, stdout: str = "") -> SpeakerReason:
    text = f"{stderr}\n{stdout}".lower()
    if "permission denied" in text or "not permitted" in text or "notpermitted" in text or "operation not permitted" in text:
        return SpeakerReason.ADAPTER_UNAVAILABLE
    if "failed to register agent" in text or "no agent is registered" in text:
        return SpeakerReason.ADAPTER_UNAVAILABLE
    if "no default controller" in text or "no controller" in text or ("controller" in text and "not available" in text):
        return SpeakerReason.ADAPTER_UNAVAILABLE
    if "not ready" in text or "notready" in text:
        return SpeakerReason.BLUETOOTH_DISABLED
    if "not powered" in text or "powered off" in text or "bluetooth is disabled" in text:
        return SpeakerReason.BLUETOOTH_DISABLED
    if "profile-unavailable" in text or "profile unavailable" in text or "a2dp" in text or "profile" in text:
        return SpeakerReason.AUDIO_PROFILE_UNAVAILABLE
    if "alreadyexists" in text or "already exists" in text or "already paired" in text or "device already exists" in text:
        return SpeakerReason.CONNECT_FAILED
    if "inprogress" in text or "in progress" in text or "operation already in progress" in text or "discovery" in text:
        return SpeakerReason.PAIR_TIMEOUT
    if "authenticationtimeout" in text:
        return SpeakerReason.PAIR_TIMEOUT
    if "authentication" in text or "authenticationfailed" in text or "rejected" in text or "not authorized" in text or "cancel" in text:
        return SpeakerReason.PAIR_REJECTED
    if "timeout" in text or "timed out" in text:
        return SpeakerReason.PAIR_TIMEOUT
    if (
        "br-connection" in text
        or "connectionattemptfailed" in text
        or "failed to connect" in text
        or "connection failed" in text
        or "input/output error" in text
        or "software caused connection abort" in text
    ):
        return SpeakerReason.CONNECT_FAILED
    if "host is down" in text or "not available" in text or "notavailable" in text or "not found" in text or "does not exist" in text:
        return SpeakerReason.DEVICE_OUT_OF_RANGE
    if "failed to pair" in text:
        return SpeakerReason.PAIR_REJECTED
    if "org.bluez.error.failed" in text:
        return SpeakerReason.CONNECT_FAILED
    return SpeakerReason.UNKNOWN


class BluetoothctlAdapter:
    def __init__(
        self,
        store: BluetoothSpeakerStore,
        runner: BluetoothCommandRunner = subprocess_runner,
        bluetoothctl_path: Optional[str] = None,
        command_timeout_seconds: int = 30,
        scan_timeout_seconds: int = 6,
        scan_device_info_timeout_seconds: int = 2,
        discovery_cleanup_timeout_seconds: int = 1,
    ) -> None:
        self._store = store
        self._runner = runner
        self._bluetoothctl_path = bluetoothctl_path
        self._command_timeout_seconds = command_timeout_seconds
        self._scan_timeout_seconds = scan_timeout_seconds
        self._scan_device_info_timeout_seconds = scan_device_info_timeout_seconds
        self._discovery_cleanup_timeout_seconds = discovery_cleanup_timeout_seconds
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
        self._stop_discovery()
        try:
            result = self._run_bluetoothctl(
                [self._bluetoothctl(), "--timeout", str(self._scan_timeout_seconds), "scan", "on"],
                self._scan_timeout_seconds + 2,
                None,
            )
            if result.returncode != 0:
                return self._action("speaker-scan", RecoveryActionState.FAILED, started_at, map_bluetoothctl_failure(result.stderr, result.stdout))
        finally:
            self._stop_discovery()
        self._last_scan = self._scan_devices(result.stdout)
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
        address = _normalize_address(address)
        self._stop_discovery()
        discovery_active_for_pair = False
        try:
            scan_candidate_seen = self._has_scan_candidate(address)
            inspection = self._inspect_device(address, display_name, allow_missing=True)
            if inspection is None:
                discovery_active_for_pair, inspection = self._refresh_pair_candidate(address, display_name)
                if not discovery_active_for_pair and not scan_candidate_seen:
                    return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.DEVICE_OUT_OF_RANGE)
            if inspection is not None and inspection.device.connected and inspection.has_audio_profile:
                self._save_primary(address, inspection.device, connected=True)
                return self._action("speaker-pair", RecoveryActionState.SUCCEEDED, started_at)

            agent_result = self._run_script(["agent NoInputNoOutput", "default-agent"], timeout_seconds=self._command_timeout_seconds)
            if not _agent_setup_usable(agent_result):
                return self._action(
                    "speaker-pair",
                    RecoveryActionState.FAILED,
                    started_at,
                    map_bluetoothctl_failure(agent_result.stderr, agent_result.stdout),
                )

            if inspection is None or not inspection.device.paired:
                pair_result = self._run_script([f"pair {address}"], timeout_seconds=self._command_timeout_seconds)
                if pair_result.returncode != 0 or _has_failed_output(pair_result.stdout, pair_result.stderr):
                    reason = map_bluetoothctl_failure(pair_result.stderr, pair_result.stdout)
                    if not _already_paired_output(pair_result.stdout, pair_result.stderr):
                        return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, reason)

            inspection = self._inspect_device(address, display_name, allow_missing=False)
            if inspection is None or not inspection.device.paired:
                return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.PAIR_REJECTED)

            trust_result = self._run_script([f"trust {address}"], timeout_seconds=self._command_timeout_seconds)
            if trust_result.returncode != 0 or _has_failed_output(trust_result.stdout, trust_result.stderr):
                return self._action(
                    "speaker-pair",
                    RecoveryActionState.FAILED,
                    started_at,
                    map_bluetoothctl_failure(trust_result.stderr, trust_result.stdout),
                )

            inspection = self._inspect_device(address, display_name, allow_missing=False)
            if inspection is not None and inspection.device.connected and inspection.has_audio_profile:
                self._save_primary(address, inspection.device, connected=True)
                return self._action("speaker-pair", RecoveryActionState.SUCCEEDED, started_at)

            connect_result = self._run_script([f"connect {address}"], timeout_seconds=self._command_timeout_seconds)
            if connect_result.returncode != 0 or _has_failed_output(connect_result.stdout, connect_result.stderr):
                return self._action(
                    "speaker-pair",
                    RecoveryActionState.FAILED,
                    started_at,
                    map_bluetoothctl_failure(connect_result.stderr, connect_result.stdout),
                )
            try:
                inspection = self._device_inspection(address, display_name)
            except BlueZCommandError as exc:
                return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, exc.reason)
            if not inspection.has_audio_profile:
                return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.AUDIO_PROFILE_UNAVAILABLE)
            if not inspection.device.connected:
                return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.CONNECT_FAILED)
            self._save_primary(address, inspection.device, connected=True)
            return self._action("speaker-pair", RecoveryActionState.SUCCEEDED, started_at)
        finally:
            if discovery_active_for_pair:
                self._stop_discovery()

    def reconnect(self) -> RecoveryAction:
        started_at = utc_now()
        self._ensure_powered()
        self._stop_discovery()
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
        address = _normalize_address(address)
        self._stop_discovery()
        primary = self._store.get_primary()
        result = self._run_script([f"remove {address}"], timeout_seconds=self._command_timeout_seconds)
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            reason = map_bluetoothctl_failure(result.stderr, result.stdout)
            if reason != SpeakerReason.DEVICE_OUT_OF_RANGE:
                return self._action("speaker-forget", RecoveryActionState.FAILED, started_at, reason)
        if primary is not None and primary.address.upper() == address:
            self._store.delete_primary()
        return self._action("speaker-forget", RecoveryActionState.SUCCEEDED, started_at)

    def _scan_devices(self, discovery_stdout: str = "") -> List[SpeakerDevice]:
        result = self._run_script(["devices"], timeout_seconds=10)
        if result.returncode != 0:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        devices: List[SpeakerDevice] = []
        scan_candidates = [*parse_device_lines(discovery_stdout), *parse_device_lines(result.stdout)]
        for device in _dedupe_devices(scan_candidates):
            try:
                inspection = self._device_inspection(
                    device.address,
                    device.display_name,
                    timeout_seconds=self._scan_device_info_timeout_seconds,
                )
            except BlueZCommandError:
                devices.append(device)
                continue
            if inspection.looks_like_audio_device or inspection.device.paired or inspection.device.connected:
                devices.append(inspection.device)
        return _dedupe_devices(devices)

    def _refresh_pair_candidate(self, address: str, display_name: Optional[str]) -> tuple[bool, Optional[DeviceInspection]]:
        result = self._run_bluetoothctl(
            [self._bluetoothctl(), "--timeout", str(self._scan_timeout_seconds), "scan", "on"],
            self._scan_timeout_seconds + 2,
            None,
        )
        if result.returncode != 0:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        self._last_scan = self._scan_devices(result.stdout)
        if not any(device.address.upper() == address for device in self._last_scan):
            return False, None
        return True, self._inspect_device(address, display_name, allow_missing=True)

    def _has_scan_candidate(self, address: str) -> bool:
        return any(device.address.upper() == address for device in self._last_scan)

    def _device_info(self, address: str, fallback_name: Optional[str] = None) -> SpeakerDevice:
        return self._device_inspection(address, fallback_name).device

    def _device_inspection(
        self,
        address: str,
        fallback_name: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> DeviceInspection:
        address = _normalize_address(address)
        result = self._run_script([f"info {address}"], timeout_seconds=timeout_seconds or 10)
        if result.returncode != 0 or _info_lookup_failed(result.stdout, result.stderr):
            detail = result.stderr or result.stdout
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), detail)
        return DeviceInspection(
            device=parse_info(result.stdout, address, fallback_name),
            has_audio_profile=info_has_audio_profile(result.stdout),
            looks_like_audio_device=info_looks_like_audio_device(result.stdout),
        )

    def _inspect_device(self, address: str, fallback_name: Optional[str] = None, allow_missing: bool = False) -> Optional[DeviceInspection]:
        try:
            return self._device_inspection(address, fallback_name)
        except BlueZCommandError as exc:
            if allow_missing and exc.reason == SpeakerReason.DEVICE_OUT_OF_RANGE:
                return None
            raise

    def _ensure_powered(self) -> None:
        result = self._run_script(["show"], timeout_seconds=10)
        if result.returncode != 0:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        for line in result.stdout.splitlines():
            if line.strip().startswith("Powered:") and not _yes_value(line):
                raise BlueZCommandError(SpeakerReason.BLUETOOTH_DISABLED, result.stdout)

    def _run_script(self, commands: Iterable[str], timeout_seconds: int) -> BluetoothCommandResult:
        command_list = list(commands)
        input_text = "\n".join(command_list) + "\n"
        result = self._run_bluetoothctl([self._bluetoothctl()], timeout_seconds, input_text)
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            logger.warning(
                "bluetoothctl command failed",
                extra={
                    "details": {
                        "commands": command_list,
                        "returncode": result.returncode,
                        "reason": map_bluetoothctl_failure(result.stderr, result.stdout).value,
                        "stdout": _truncate_log_text(result.stdout),
                        "stderr": _truncate_log_text(result.stderr),
                    }
                },
            )
        return result

    def _run_bluetoothctl(self, argv: Sequence[str], timeout_seconds: int, input_text: Optional[str]) -> BluetoothCommandResult:
        try:
            return self._runner(argv, timeout_seconds, input_text)
        except subprocess.TimeoutExpired as exc:
            return _timeout_result(exc, timeout_seconds)

    def _stop_discovery(self) -> None:
        result = self._run_script(["scan off"], timeout_seconds=self._discovery_cleanup_timeout_seconds)
        if result.returncode != 0:
            return

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

    def _save_primary(self, address: str, device: SpeakerDevice, connected: bool) -> SpeakerSummary:
        return self._store.save_primary(
            SpeakerSummary(address=address, display_name=device.display_name, alias=device.alias, connected=connected)
        )


def _yes_value(line: str) -> bool:
    return line.split(":", 1)[1].strip().lower() in {"yes", "true", "on"}


def _has_failed_output(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    if _already_paired_output(stdout, stderr):
        return False
    return "failed" in text or "not available" in text or "not authorized" in text or "not ready" in text


def _info_lookup_failed(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    return (
        "not available" in text
        or "not ready" in text
        or "no default controller" in text
        or "no controller" in text
        or "not found" in text
        or "does not exist" in text
    )


def _agent_setup_usable(result: BluetoothCommandResult) -> bool:
    if result.returncode != 0:
        return False
    text = f"{result.stdout}\n{result.stderr}".lower()
    if "agent registered" in text or "default agent request successful" in text:
        return True
    return not _has_failed_output(result.stdout, result.stderr)


def _already_paired_output(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    return "alreadyexists" in text or "already exists" in text or "already paired" in text or "device already exists" in text


def _truncate_log_text(value: str, limit: int = 600) -> str:
    compact = value.strip()
    if len(compact) <= limit:
        return compact
    return f"{compact[:limit]}..."


def _timeout_result(exc: subprocess.TimeoutExpired, timeout_seconds: int) -> BluetoothCommandResult:
    stdout = _timeout_text(exc.output)
    stderr = _timeout_text(exc.stderr)
    timeout_message = f"bluetoothctl timed out after {timeout_seconds} seconds"
    if stderr:
        stderr = f"{stderr}\n{timeout_message}"
    else:
        stderr = timeout_message
    return BluetoothCommandResult(returncode=124, stdout=stdout, stderr=stderr)


def _timeout_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return str(value)


def _normalize_address(address: str) -> str:
    normalized = address.strip().upper()
    if not MAC_EXACT_RE.fullmatch(normalized):
        raise BlueZCommandError(SpeakerReason.DEVICE_OUT_OF_RANGE, "invalid bluetooth address")
    return normalized


def _dedupe_devices(devices: Iterable[SpeakerDevice]) -> List[SpeakerDevice]:
    by_address: dict[str, SpeakerDevice] = {}
    for device in devices:
        by_address[device.address.upper()] = device
    by_identity: dict[str, SpeakerDevice] = {}
    for device in by_address.values():
        key = _speaker_identity_key(device.display_name)
        existing = by_identity.get(key)
        if existing is None or (_is_le_advertising_name(existing.display_name) and not _is_le_advertising_name(device.display_name)):
            by_identity[key] = device
    return sorted(by_identity.values(), key=lambda item: item.display_name.lower())


def _speaker_identity_key(display_name: str) -> str:
    normalized = display_name.strip().lower()
    if _is_le_advertising_name(normalized):
        return normalized[3:]
    return normalized


def _is_le_advertising_name(display_name: str) -> bool:
    normalized = display_name.strip().lower()
    return normalized.startswith("le_") or normalized.startswith("le-")
