from dataclasses import dataclass
from typing import Protocol


class ProductionAdapterNotImplemented(NotImplementedError):
    pass


class NetworkManagerAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")


class BlueZAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")


class VolumeAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Volume adapter is not implemented")


class PlaybackAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Playback adapter is not implemented")


class KioskAdapter(Protocol):
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Kiosk adapter is not implemented")


class MissingNetworkManagerAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("NetworkManager adapter is not implemented")


class MissingBlueZAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("BlueZ adapter is not implemented")


class MissingVolumeAdapter:
    def probe(self) -> None:
        raise ProductionAdapterNotImplemented("Volume adapter is not implemented")


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
    playback: PlaybackAdapter = MissingPlaybackAdapter()
    kiosk: KioskAdapter = MissingKioskAdapter()

    def assert_implemented(self) -> None:
        self.network.probe()
        self.bluetooth.probe()
        self.volume.probe()
        self.playback.probe()
        self.kiosk.probe()
