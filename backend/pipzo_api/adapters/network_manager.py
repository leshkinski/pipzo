import shutil
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

from pipzo_api.contract import (
    NetworkHealth,
    NetworkReason,
    NetworkStatus,
    RecoveryAction,
    RecoveryActionKind,
    RecoveryActionState,
    WifiNetwork,
    WifiScanResults,
    WifiSecurity,
    utc_now,
)


class NetworkManagerUnavailable(RuntimeError):
    def __init__(self, message: str = "NetworkManager CLI is unavailable") -> None:
        super().__init__(message)


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[Sequence[str], int, Optional[str]], CommandResult]


def subprocess_runner(argv: Sequence[str], timeout_seconds: int, input_text: Optional[str] = None) -> CommandResult:
    completed = subprocess.run(
        list(argv),
        check=False,
        capture_output=True,
        input=input_text,
        text=True,
        timeout=timeout_seconds,
    )
    return CommandResult(returncode=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)


def parse_nmcli_terse_line(line: str) -> List[str]:
    fields: List[str] = []
    current: List[str] = []
    escaped = False
    for char in line.rstrip("\n"):
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
    if escaped:
        current.append("\\")
    fields.append("".join(current))
    return fields


def parse_wifi_security(raw: str) -> WifiSecurity:
    value = raw.upper()
    if not value or value == "--":
        return WifiSecurity.OPEN
    if "WPA3" in value:
        return WifiSecurity.WPA3
    if "WPA2" in value or "RSN" in value:
        return WifiSecurity.WPA2
    if "WPA" in value:
        return WifiSecurity.WPA
    return WifiSecurity.UNKNOWN


def parse_wifi_scan(stdout: str, known_ssids: Iterable[str]) -> List[WifiNetwork]:
    known = set(known_ssids)
    by_ssid: dict[str, WifiNetwork] = {}
    for line in stdout.splitlines():
        if not line.strip():
            continue
        fields = parse_nmcli_terse_line(line)
        if len(fields) < 4:
            continue
        _active, ssid, signal_raw, security_raw = fields[:4]
        if not ssid:
            continue
        try:
            signal = max(0, min(100, int(signal_raw)))
        except ValueError:
            signal = 0
        network = WifiNetwork(
            ssid=ssid,
            signal=signal,
            security=parse_wifi_security(security_raw),
            known=ssid in known,
        )
        existing = by_ssid.get(ssid)
        if existing is None or network.signal > existing.signal:
            by_ssid[ssid] = network
    return sorted(by_ssid.values(), key=lambda item: item.signal, reverse=True)


def map_nmcli_failure(stderr: str, stdout: str = "") -> NetworkReason:
    text = f"{stderr}\n{stdout}".lower()
    if "secrets were required" in text or "no secrets" in text or "password" in text:
        return NetworkReason.BAD_CREDENTIALS
    if "no wifi device" in text or "not a wi-fi device" in text or "wifi device" in text and "not found" in text:
        return NetworkReason.NO_WIFI_DEVICE
    if "disabled" in text or "radio" in text and "off" in text:
        return NetworkReason.WIFI_RADIO_DISABLED
    if "dhcp" in text or "ip configuration" in text:
        return NetworkReason.DHCP_FAILED
    if "not found" in text or "no network with ssid" in text:
        return NetworkReason.SCAN_EMPTY
    if "activation failed" in text or "association" in text or "802.11" in text:
        return NetworkReason.ASSOCIATION_FAILED
    return NetworkReason.UNKNOWN


class NmcliNetworkAdapter:
    def __init__(
        self,
        runner: CommandRunner = subprocess_runner,
        nmcli_path: Optional[str] = None,
        internet_probe_url: str = "https://www.google.com/generate_204",
        command_timeout_seconds: int = 30,
        probe_timeout_seconds: float = 3.0,
    ) -> None:
        self._runner = runner
        self._nmcli_path = nmcli_path
        self._internet_probe_url = internet_probe_url
        self._command_timeout_seconds = command_timeout_seconds
        self._probe_timeout_seconds = probe_timeout_seconds

    def probe(self) -> None:
        self._nmcli()

    def status(self) -> NetworkHealth:
        self._ensure_wifi_enabled()
        active_ssid = self._active_ssid()
        if active_ssid is None:
            return NetworkHealth(status=NetworkStatus.OFFLINE, reason=NetworkReason.NO_KNOWN_NETWORK, internet_reachable=False)
        internet_reachable = self._internet_reachable()
        if internet_reachable:
            return NetworkHealth(status=NetworkStatus.ONLINE, ssid=active_ssid, internet_reachable=True)
        return NetworkHealth(
            status=NetworkStatus.LOCAL_ONLY,
            reason=NetworkReason.INTERNET_PROBE_FAILED,
            ssid=active_ssid,
            internet_reachable=False,
        )

    def scan(self) -> RecoveryAction:
        started_at = utc_now()
        self.scan_results(rescan=True)
        return RecoveryAction(
            id="network-scan",
            kind=RecoveryActionKind.CONNECT_WIFI,
            state=RecoveryActionState.SUCCEEDED,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )

    def scan_results(self, rescan: bool = False) -> WifiScanResults:
        self._ensure_wifi_enabled()
        result = self._run(
            [
                "-t",
                "-f",
                "ACTIVE,SSID,SIGNAL,SECURITY",
                "device",
                "wifi",
                "list",
                "--rescan",
                "yes" if rescan else "auto",
            ],
            timeout_seconds=self._command_timeout_seconds,
        )
        if result.returncode != 0:
            raise NetworkCommandError(map_nmcli_failure(result.stderr, result.stdout), result.stderr)
        return WifiScanResults(networks=parse_wifi_scan(result.stdout, self._known_ssids()), scanned_at=utc_now())

    def connect(self, ssid: str, password: Optional[str], hidden: bool = False) -> RecoveryAction:
        started_at = utc_now()
        argv = ["device", "wifi", "connect", ssid]
        input_text = None
        if password:
            argv.insert(0, "--ask")
            input_text = f"{password}\n"
        if hidden:
            argv.extend(["hidden", "yes"])
        result = self._run(argv, timeout_seconds=self._command_timeout_seconds, input_text=input_text)
        if result.returncode != 0:
            reason = map_nmcli_failure(result.stderr, result.stdout)
            return self._action("network-connect", RecoveryActionState.FAILED, started_at, reason)
        health = self.status()
        if health.status == NetworkStatus.ONLINE:
            return self._action("network-connect", RecoveryActionState.SUCCEEDED, started_at)
        return self._action("network-connect", RecoveryActionState.FAILED, started_at, health.reason or NetworkReason.INTERNET_PROBE_FAILED)

    def forget(self, ssid: str) -> RecoveryAction:
        started_at = utc_now()
        profiles = [profile for profile in self._wifi_profiles() if profile[0] == ssid]
        if not profiles:
            return self._action("network-forget", RecoveryActionState.FAILED, started_at, NetworkReason.NO_KNOWN_NETWORK)
        failed_reason: Optional[NetworkReason] = None
        for _name, uuid in profiles:
            result = self._run(["connection", "delete", "uuid", uuid], timeout_seconds=self._command_timeout_seconds)
            if result.returncode != 0:
                failed_reason = map_nmcli_failure(result.stderr, result.stdout)
        if failed_reason is not None:
            return self._action("network-forget", RecoveryActionState.FAILED, started_at, failed_reason)
        return self._action("network-forget", RecoveryActionState.SUCCEEDED, started_at)

    def retry_internet_probe(self) -> RecoveryAction:
        started_at = utc_now()
        health = self.status()
        if health.status == NetworkStatus.ONLINE:
            return self._action("network-internet-probe", RecoveryActionState.SUCCEEDED, started_at)
        return self._action("network-internet-probe", RecoveryActionState.FAILED, started_at, health.reason or NetworkReason.UNKNOWN)

    def _ensure_wifi_enabled(self) -> None:
        result = self._run(["-t", "-f", "WIFI", "radio"], timeout_seconds=10)
        if result.returncode != 0:
            raise NetworkCommandError(map_nmcli_failure(result.stderr, result.stdout), result.stderr)
        if result.stdout.strip().lower() not in {"enabled", "yes"}:
            raise NetworkCommandError(NetworkReason.WIFI_RADIO_DISABLED, result.stderr)

    def _active_ssid(self) -> Optional[str]:
        result = self._run(["-t", "-f", "ACTIVE,SSID", "device", "wifi", "list", "--rescan", "no"], timeout_seconds=10)
        if result.returncode != 0:
            raise NetworkCommandError(map_nmcli_failure(result.stderr, result.stdout), result.stderr)
        for line in result.stdout.splitlines():
            fields = parse_nmcli_terse_line(line)
            if len(fields) >= 2 and fields[0].lower() == "yes" and fields[1]:
                return fields[1]
        return None

    def _known_ssids(self) -> List[str]:
        return [name for name, _uuid in self._wifi_profiles()]

    def _wifi_profiles(self) -> List[Tuple[str, str]]:
        result = self._run(["-t", "-f", "NAME,UUID,TYPE", "connection", "show"], timeout_seconds=10)
        if result.returncode != 0:
            return []
        profiles: List[Tuple[str, str]] = []
        for line in result.stdout.splitlines():
            fields = parse_nmcli_terse_line(line)
            if len(fields) >= 3 and fields[2] == "802-11-wireless":
                profiles.append((fields[0], fields[1]))
        return profiles

    def _internet_reachable(self) -> bool:
        try:
            request = urllib.request.Request(self._internet_probe_url, method="HEAD")
            with urllib.request.urlopen(request, timeout=self._probe_timeout_seconds) as response:
                return 200 <= response.status < 400
        except (OSError, urllib.error.URLError, TimeoutError):
            return False

    def _run(self, args: Sequence[str], timeout_seconds: int, input_text: Optional[str] = None) -> CommandResult:
        return self._runner([self._nmcli(), *args], timeout_seconds, input_text)

    def _nmcli(self) -> str:
        path = self._nmcli_path or shutil.which("nmcli")
        if not path:
            raise NetworkManagerUnavailable()
        return path

    def _action(
        self,
        action_id: str,
        state: RecoveryActionState,
        started_at,
        reason: Optional[NetworkReason] = None,
    ) -> RecoveryAction:
        return RecoveryAction(
            id=action_id,
            kind=RecoveryActionKind.CONNECT_WIFI if action_id != "network-forget" else RecoveryActionKind.FORGET_WIFI,
            state=state,
            reason=reason,
            requires_confirmation=False,
            started_at=started_at,
            completed_at=utc_now(),
        )


class NetworkCommandError(RuntimeError):
    def __init__(self, reason: NetworkReason, detail: str = "") -> None:
        super().__init__(detail or reason.value)
        self.reason = reason
