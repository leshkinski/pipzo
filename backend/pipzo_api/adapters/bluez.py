import logging
import re
import select
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Sequence

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
    services_resolved: Optional[bool]


@dataclass
class ScanDiagnostics:
    discovery_devices: List[SpeakerDevice]
    known_devices: List[SpeakerDevice]
    accepted_devices: List[SpeakerDevice]
    dropped_devices: List[Dict[str, str]]
    forgotten_addresses: List[str]
    discovery_stdout: str = ""


BluetoothCommandRunner = Callable[[Sequence[str], int, Optional[str]], BluetoothCommandResult]

logger = logging.getLogger("pipzo.bluez")

MAC_EXACT_RE = re.compile(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", re.IGNORECASE)
ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
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
        normalized_line = ANSI_ESCAPE_RE.sub("", line).replace("\r", "").strip()
        match = DEVICE_LINE_RE.match(normalized_line)
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


def info_services_resolved(stdout: str) -> Optional[bool]:
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if line.startswith("ServicesResolved:"):
            return _yes_value(line)
    return None


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
    if "attempting to pair" in text:
        return SpeakerReason.PAIR_TIMEOUT
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
        post_forget_scan_timeout_seconds: int = 12,
        scan_device_info_timeout_seconds: int = 2,
        discovery_cleanup_timeout_seconds: int = 1,
        connect_settle_timeout_seconds: float = 6,
        connect_settle_interval_seconds: float = 0.5,
        connect_retry_count: int = 2,
    ) -> None:
        self._store = store
        self._runner = runner
        self._bluetoothctl_path = bluetoothctl_path
        self._command_timeout_seconds = command_timeout_seconds
        self._scan_timeout_seconds = scan_timeout_seconds
        self._post_forget_scan_timeout_seconds = post_forget_scan_timeout_seconds
        self._scan_device_info_timeout_seconds = scan_device_info_timeout_seconds
        self._discovery_cleanup_timeout_seconds = discovery_cleanup_timeout_seconds
        self._connect_settle_timeout_seconds = connect_settle_timeout_seconds
        self._connect_settle_interval_seconds = connect_settle_interval_seconds
        self._connect_retry_count = max(1, connect_retry_count)
        self._last_scan: List[SpeakerDevice] = []
        self._forgotten_scan_addresses: set[str] = set()

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
        self._last_scan = []
        self._stop_discovery()
        scan_timeout_seconds = self._active_scan_timeout_seconds()
        try:
            result = self._run_bluetoothctl(
                [self._bluetoothctl(), "--timeout", str(scan_timeout_seconds), "scan", "on"],
                scan_timeout_seconds + 2,
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
            self._disconnect_saved_primary_if_replacing(address)
            inspection = self._inspect_device(address, display_name, allow_missing=True)
            if inspection is None:
                discovery_active_for_pair, inspection = self._refresh_pair_candidate(address, display_name)
                if not discovery_active_for_pair and not scan_candidate_seen:
                    return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.DEVICE_OUT_OF_RANGE)
            if inspection is not None and _audio_sink_connected(inspection):
                self._save_primary(address, inspection.device, connected=True)
                return self._action("speaker-pair", RecoveryActionState.SUCCEEDED, started_at)

            pair_attempted = False
            if inspection is None or not inspection.device.paired:
                pair_result = self._run_pair_command(address)
                pair_attempted = True
                if not _pair_command_succeeded(pair_result):
                    reason = map_bluetoothctl_failure(pair_result.stderr, pair_result.stdout)
                    if not _already_paired_output(pair_result.stdout, pair_result.stderr):
                        return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, reason)
            else:
                agent_result = self._run_script(["agent NoInputNoOutput", "default-agent"], timeout_seconds=self._command_timeout_seconds)
                if not _agent_setup_usable(agent_result):
                    return self._action(
                        "speaker-pair",
                        RecoveryActionState.FAILED,
                        started_at,
                        map_bluetoothctl_failure(agent_result.stderr, agent_result.stdout),
                    )

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

            inspection = self._inspect_device(address, display_name, allow_missing=scan_candidate_seen and not pair_attempted)
            if inspection is None and scan_candidate_seen and not pair_attempted:
                pair_result = self._run_pair_command(address)
                pair_attempted = True
                if not _pair_command_succeeded(pair_result):
                    reason = map_bluetoothctl_failure(pair_result.stderr, pair_result.stdout)
                    if not _already_paired_output(pair_result.stdout, pair_result.stderr):
                        return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, reason)
                inspection = self._inspect_device(address, display_name, allow_missing=False)

            inspection, failure_reason = self._connect_until_audio_sink_connected(address, display_name)
            if inspection is None:
                return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, failure_reason or SpeakerReason.CONNECT_FAILED)
            if not inspection.has_audio_profile:
                return self._action("speaker-pair", RecoveryActionState.FAILED, started_at, SpeakerReason.AUDIO_PROFILE_UNAVAILABLE)
            if not _audio_sink_connected(inspection):
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
        inspection, failure_reason = self._connect_until_audio_sink_connected(primary.address, primary.display_name, trust=True)
        if inspection is None:
            return self._action("speaker-reconnect", RecoveryActionState.FAILED, started_at, failure_reason or SpeakerReason.CONNECT_FAILED)
        self._save_primary(primary.address, inspection.device, connected=True)
        return self._action("speaker-reconnect", RecoveryActionState.SUCCEEDED, started_at)

    def forget(self, address: str) -> RecoveryAction:
        started_at = utc_now()
        self._ensure_powered()
        address = _normalize_address(address)
        self._stop_discovery()
        primary = self._store.get_primary()
        self._disconnect_device(address)
        result = self._run_script([f"remove {address}"], timeout_seconds=self._command_timeout_seconds)
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            reason = map_bluetoothctl_failure(result.stderr, result.stdout)
            if reason != SpeakerReason.DEVICE_OUT_OF_RANGE:
                return self._action("speaker-forget", RecoveryActionState.FAILED, started_at, reason)
        if primary is not None and primary.address.upper() == address:
            self._store.delete_primary()
        self._last_scan = []
        self._forgotten_scan_addresses.add(address)
        self._stop_discovery()
        return self._action("speaker-forget", RecoveryActionState.SUCCEEDED, started_at)

    def _scan_devices(self, discovery_stdout: str = "") -> List[SpeakerDevice]:
        result = self._run_script(["devices"], timeout_seconds=10)
        if result.returncode != 0:
            raise BlueZCommandError(map_bluetoothctl_failure(result.stderr, result.stdout), result.stderr)
        devices: List[SpeakerDevice] = []
        discovery_candidates = parse_device_lines(discovery_stdout)
        known_candidates = parse_device_lines(result.stdout)
        dropped_devices: List[Dict[str, str]] = []
        discovery_addresses = {device.address.upper() for device in discovery_candidates}
        discovery_identity_keys = {_speaker_identity_key(device.display_name) for device in discovery_candidates}
        scan_candidates = [*discovery_candidates, *known_candidates]
        for device in _dedupe_devices(scan_candidates):
            fresh_discovery_match = device.address.upper() in discovery_addresses or _speaker_identity_key(device.display_name) in discovery_identity_keys
            if device.address.upper() in self._forgotten_scan_addresses and not fresh_discovery_match:
                dropped_devices.append(_scan_drop(device, "forgotten_address_without_fresh_discovery"))
                continue
            try:
                inspection = self._device_inspection(
                    device.address,
                    device.display_name,
                    timeout_seconds=self._scan_device_info_timeout_seconds,
                )
            except BlueZCommandError:
                if not discovery_addresses or fresh_discovery_match:
                    devices.append(device)
                else:
                    dropped_devices.append(_scan_drop(device, "info_unavailable_without_fresh_discovery"))
                continue
            if inspection.looks_like_audio_device or inspection.device.paired or inspection.device.connected:
                devices.append(inspection.device)
            else:
                dropped_devices.append(_scan_drop(device, "info_not_audio_candidate"))
        deduped = _dedupe_devices(devices)
        for device in deduped:
            if device.address.upper() in discovery_addresses or _speaker_identity_key(device.display_name) in discovery_identity_keys:
                self._forgotten_scan_addresses.discard(device.address.upper())
        self._log_scan_diagnostics(
            ScanDiagnostics(
                discovery_devices=discovery_candidates,
                known_devices=known_candidates,
                accepted_devices=deduped,
                dropped_devices=dropped_devices,
                forgotten_addresses=sorted(self._forgotten_scan_addresses),
                discovery_stdout=discovery_stdout,
            )
        )
        return deduped

    def _log_scan_diagnostics(self, diagnostics: ScanDiagnostics) -> None:
        logger.info(
            "bluetooth scan diagnostics",
            extra={
                "event": "bluetooth.scan.diagnostics",
                "details": {
                    "raw_discovery_device_count": len(diagnostics.discovery_devices),
                    "known_device_count": len(diagnostics.known_devices),
                    "accepted_device_count": len(diagnostics.accepted_devices),
                    "dropped_device_count": len(diagnostics.dropped_devices),
                    "raw_discovery_devices": [_device_log_details(device) for device in diagnostics.discovery_devices],
                    "known_devices": [_device_log_details(device) for device in diagnostics.known_devices],
                    "accepted_devices": [_device_log_details(device) for device in diagnostics.accepted_devices],
                    "dropped_devices": diagnostics.dropped_devices,
                    "forgotten_addresses": diagnostics.forgotten_addresses,
                    "raw_discovery_stdout": _truncate_log_text(diagnostics.discovery_stdout, limit=1200),
                },
            },
        )

    def _refresh_pair_candidate(self, address: str, display_name: Optional[str]) -> tuple[bool, Optional[DeviceInspection]]:
        scan_timeout_seconds = self._active_scan_timeout_seconds()
        result = self._run_bluetoothctl(
            [self._bluetoothctl(), "--timeout", str(scan_timeout_seconds), "scan", "on"],
            scan_timeout_seconds + 2,
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

    def _disconnect_saved_primary_if_replacing(self, replacement_address: str) -> None:
        primary = self._store.get_primary()
        if primary is None or primary.address.upper() == replacement_address:
            return
        self._disconnect_device(primary.address)

    def _disconnect_device(self, address: str) -> None:
        # Disconnection is a best-effort cleanup before remove/replacement; remove/pair/connect still decide success.
        self._run_script([f"disconnect {_normalize_address(address)}"], timeout_seconds=self._command_timeout_seconds)

    def _connect_until_audio_sink_connected(
        self,
        address: str,
        fallback_name: Optional[str],
        trust: bool = False,
    ) -> tuple[Optional[DeviceInspection], Optional[SpeakerReason]]:
        commands = [f"connect {address}"]
        if trust:
            commands.insert(0, f"trust {address}")
        last_inspection: Optional[DeviceInspection] = None
        last_reason: Optional[SpeakerReason] = None
        for _ in range(self._connect_retry_count):
            result = self._run_script(commands, timeout_seconds=self._command_timeout_seconds)
            if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
                return None, map_bluetoothctl_failure(result.stderr, result.stdout)
            last_inspection, last_reason = self._wait_for_audio_sink_connected(address, fallback_name)
            if last_inspection is not None and _audio_sink_connected(last_inspection):
                return last_inspection, None
        if last_inspection is not None and not last_inspection.has_audio_profile:
            return None, SpeakerReason.AUDIO_PROFILE_UNAVAILABLE
        return None, last_reason or SpeakerReason.CONNECT_FAILED

    def _wait_for_audio_sink_connected(self, address: str, fallback_name: Optional[str]) -> tuple[Optional[DeviceInspection], Optional[SpeakerReason]]:
        deadline = time.monotonic() + self._connect_settle_timeout_seconds
        last_inspection: Optional[DeviceInspection] = None
        last_reason: Optional[SpeakerReason] = None
        while True:
            try:
                inspection = self._device_inspection(address, fallback_name)
            except BlueZCommandError as exc:
                last_reason = exc.reason
            else:
                last_inspection = inspection
                if _audio_sink_connected(inspection):
                    return inspection, None
                if not inspection.has_audio_profile:
                    last_reason = SpeakerReason.AUDIO_PROFILE_UNAVAILABLE
                elif not inspection.device.connected or inspection.services_resolved is False:
                    last_reason = SpeakerReason.CONNECT_FAILED
            if time.monotonic() >= deadline:
                return last_inspection, last_reason
            if self._connect_settle_interval_seconds > 0:
                time.sleep(self._connect_settle_interval_seconds)

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
            services_resolved=info_services_resolved(result.stdout),
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

    def _run_script(self, commands: Iterable[str], timeout_seconds: int, log_failures: bool = True) -> BluetoothCommandResult:
        command_list = list(commands)
        input_text = "\n".join(command_list) + "\n"
        result = self._run_bluetoothctl([self._bluetoothctl()], timeout_seconds, input_text)
        if log_failures and (result.returncode != 0 or _has_failed_output(result.stdout, result.stderr)):
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

    def _run_pair_command(self, address: str) -> BluetoothCommandResult:
        commands = ["agent NoInputNoOutput", "default-agent", f"pair {address}"]
        if self._runner is not subprocess_runner:
            input_text = "\n".join(commands) + "\n"
            result = self._run_bluetoothctl([self._bluetoothctl()], self._command_timeout_seconds, input_text)
            self._log_pair_failure(commands, result)
            return result

        try:
            result = self._run_interactive_pair_command(commands)
        except subprocess.TimeoutExpired as exc:
            result = _timeout_result(exc, self._command_timeout_seconds)
        self._log_pair_failure(commands, result)
        return result

    def _log_pair_failure(self, commands: Sequence[str], result: BluetoothCommandResult) -> None:
        if _pair_command_succeeded(result):
            return
        logger.warning(
            "bluetoothctl command failed",
            extra={
                "details": {
                    "commands": list(commands),
                    "returncode": result.returncode,
                    "reason": map_bluetoothctl_failure(result.stderr, result.stdout).value,
                    "stdout": _truncate_log_text(result.stdout),
                    "stderr": _truncate_log_text(result.stderr),
                }
            },
        )

    def _run_interactive_pair_command(self, commands: Sequence[str]) -> BluetoothCommandResult:
        process = subprocess.Popen(
            [self._bluetoothctl()],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        deadline = time.monotonic() + self._command_timeout_seconds
        try:
            assert process.stdin is not None
            process.stdin.write("\n".join(commands) + "\n")
            process.stdin.flush()
            terminal_seen = False
            while time.monotonic() < deadline and not terminal_seen:
                readable = []
                streams = [stream for stream in (process.stdout, process.stderr) if stream is not None]
                if streams:
                    readable, _, _ = select.select(streams, [], [], 0.2)
                if not readable and process.poll() is not None:
                    break
                for stream in readable:
                    line = stream.readline()
                    if not line:
                        continue
                    if stream is process.stderr:
                        stderr_parts.append(line)
                    else:
                        stdout_parts.append(line)
                    terminal_seen = _pair_terminal_output("".join(stdout_parts), "".join(stderr_parts))
            if not terminal_seen and process.poll() is None and time.monotonic() >= deadline:
                process.kill()
                raise subprocess.TimeoutExpired([self._bluetoothctl()], self._command_timeout_seconds)
            if process.poll() is None:
                process.stdin.write("quit\n")
                process.stdin.flush()
            try:
                stdout_tail, stderr_tail = process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout_tail, stderr_tail = process.communicate()
            stdout_parts.append(stdout_tail or "")
            stderr_parts.append(stderr_tail or "")
            returncode = process.returncode if process.returncode is not None else 0
            return BluetoothCommandResult(returncode=returncode, stdout="".join(stdout_parts), stderr="".join(stderr_parts))
        finally:
            if process.poll() is None:
                process.kill()

    def _run_bluetoothctl(self, argv: Sequence[str], timeout_seconds: int, input_text: Optional[str]) -> BluetoothCommandResult:
        try:
            return self._runner(argv, timeout_seconds, input_text)
        except subprocess.TimeoutExpired as exc:
            return _timeout_result(exc, timeout_seconds)

    def _stop_discovery(self) -> None:
        result = self._run_script(["scan off"], timeout_seconds=self._discovery_cleanup_timeout_seconds, log_failures=False)
        if result.returncode != 0 or _has_failed_output(result.stdout, result.stderr):
            logger.info(
                "bluetooth discovery cleanup ignored",
                extra={
                    "event": "bluetooth.discovery_cleanup.ignored",
                    "details": {
                        "returncode": result.returncode,
                        "reason": map_bluetoothctl_failure(result.stderr, result.stdout).value,
                        "stdout": _truncate_log_text(result.stdout),
                        "stderr": _truncate_log_text(result.stderr),
                    },
                },
            )

    def _active_scan_timeout_seconds(self) -> int:
        if self._forgotten_scan_addresses:
            return self._post_forget_scan_timeout_seconds
        return self._scan_timeout_seconds

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


def _pair_command_succeeded(result: BluetoothCommandResult) -> bool:
    if result.returncode != 0:
        return False
    if _pair_success_output(result.stdout, result.stderr):
        return True
    text = f"{result.stdout}\n{result.stderr}".lower()
    if "attempting to pair" in text:
        return False
    return not _has_failed_output(result.stdout, result.stderr)


def _pair_terminal_output(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    return _pair_success_output(stdout, stderr) or "failed to pair" in text or "authentication" in text or "rejected" in text or "cancel" in text


def _pair_success_output(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    return _already_paired_output(stdout, stderr) or "pairing successful" in text or "paired: yes" in text or "bonded: yes" in text


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


def _audio_sink_connected(inspection: DeviceInspection) -> bool:
    return inspection.device.connected and inspection.has_audio_profile and inspection.services_resolved is not False


def _already_paired_output(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}".lower()
    return "alreadyexists" in text or "already exists" in text or "already paired" in text or "device already exists" in text


def _truncate_log_text(value: str, limit: int = 600) -> str:
    compact = value.strip()
    if len(compact) <= limit:
        return compact
    return f"{compact[:limit]}..."


def _device_log_details(device: SpeakerDevice) -> Dict[str, object]:
    return {
        "address": device.address,
        "display_name": device.display_name,
        "paired": device.paired,
        "connected": device.connected,
    }


def _scan_drop(device: SpeakerDevice, reason: str) -> Dict[str, str]:
    return {"address": device.address, "display_name": device.display_name, "reason": reason}


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
