from dataclasses import dataclass
from typing import Optional, Protocol

from pipzo_api.contract import ActionResult, NetworkHealth, RecoveryAction, SpeakerHealth, SpeakerScanResults, VolumeHealth, WifiScanResults


class ProductionAdapterNotImplemented(NotImplementedError):
    pass


class NetworkManagerAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")

    def status(self) -> NetworkHealth:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")

    def scan(self) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")

    def scan_results(self, rescan: bool = False) -> WifiScanResults:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")

    def connect(self, ssid: str, password: Optional[str], hidden: bool = False) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")

    def forget(self, ssid: str) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")

    def retry_internet_probe(self) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")


class BlueZAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")

    def status(self) -> SpeakerHealth:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")

    def scan(self) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")

    def scan_results(self) -> SpeakerScanResults:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")

    def pair(self, address: str, display_name: Optional[str] = None) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")

    def reconnect(self) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")

    def forget(self, address: str) -> RecoveryAction:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")


class VolumeAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Volume adapter is not implemented")

    def status(self) -> VolumeHealth:
        raise ProductionAdapterNotImplemented("Volume adapter is not implemented")

    def set_volume(self, value: int, muted: bool = False) -> VolumeHealth:
        raise ProductionAdapterNotImplemented("Volume adapter is not implemented")


class DevicePowerAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Device power adapter is not implemented")

    def reboot(self) -> ActionResult:
        raise ProductionAdapterNotImplemented("Device power adapter is not implemented")

    def poweroff(self) -> ActionResult:
        raise ProductionAdapterNotImplemented("Device power adapter is not implemented")


class PlaybackAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Playback adapter is not implemented")


class KioskAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Kiosk adapter is not implemented")


class KioskBrowserSessionResetAdapter(Protocol):
    def reset(self) -> ActionResult:
        raise ProductionAdapterNotImplemented("Kiosk browser-session reset adapter is not implemented")


class MissingNetworkManagerAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")


class MissingBlueZAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")


class MissingVolumeAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Volume adapter is not implemented")


class MissingDevicePowerAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Device power adapter is not implemented")


class MissingPlaybackAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Playback adapter is not implemented")


class MissingKioskAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Kiosk adapter is not implemented")


@dataclass(frozen=True)
class ProductionAdapters:
    network: NetworkManagerAdapter = MissingNetworkManagerAdapter()
    bluetooth: BlueZAdapter = MissingBlueZAdapter()
    volume: VolumeAdapter = MissingVolumeAdapter()
    device_power: DevicePowerAdapter = MissingDevicePowerAdapter()
    playback: PlaybackAdapter = MissingPlaybackAdapter()
    kiosk: KioskAdapter = MissingKioskAdapter()

    def assert_implemented(self) -> None:
        self.network.probe()
        self.bluetooth.probe()
        self.volume.probe()
        self.device_power.probe()
        self.playback.probe()
        self.kiosk.probe()
