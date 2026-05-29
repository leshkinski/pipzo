from pipzo_api.adapters.bluez import (
    BluetoothCommandResult,
    BluetoothctlAdapter,
    map_bluetoothctl_failure,
    parse_device_lines,
    parse_info,
)
from pipzo_api.bluetooth_store import BluetoothSpeakerStore
from pipzo_api.contract import SpeakerReason


def test_parse_device_lines_extracts_addresses_and_names():
    devices = parse_device_lines(
        "\n".join(
            [
                "[NEW] Device AA:BB:CC:DD:EE:FF Bedroom Speaker",
                "Device 11:22:33:44:55:66",
            ]
        )
    )

    assert devices[0].address == "AA:BB:CC:DD:EE:FF"
    assert devices[0].display_name == "Bedroom Speaker"
    assert devices[1].display_name == "11:22:33:44:55:66"


def test_parse_info_maps_safe_device_fields():
    info = parse_info(
        "\n".join(
            [
                "Device AA:BB:CC:DD:EE:FF (public)",
                "\tName: Pipzo Speaker",
                "\tAlias: Bedroom speaker",
                "\tPaired: yes",
                "\tTrusted: yes",
                "\tConnected: yes",
                "\tUUID: Audio Sink                (0000110b-0000-1000-8000-00805f9b34fb)",
            ]
        ),
        "AA:BB:CC:DD:EE:FF",
    )

    assert info.display_name == "Pipzo Speaker"
    assert info.alias == "Bedroom speaker"
    assert info.paired is True
    assert info.connected is True


def test_bluetoothctl_failure_mapping_keeps_reasons_coarse():
    assert map_bluetoothctl_failure("No default controller available") == SpeakerReason.ADAPTER_UNAVAILABLE
    assert map_bluetoothctl_failure("Authentication Failed") == SpeakerReason.PAIR_REJECTED
    assert map_bluetoothctl_failure("Failed to connect: org.bluez.Error.Failed") == SpeakerReason.CONNECT_FAILED


def test_adapter_pair_uses_safe_script_and_persists_primary(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text and "pair AA:BB:CC:DD:EE:FF" in input_text:
            return BluetoothCommandResult(0, "Pairing successful\nConnection successful\n", "")
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device AA:BB:CC:DD:EE:FF",
                        "\tName: Pipzo Speaker",
                        "\tAlias: Bedroom speaker",
                        "\tPaired: yes",
                        "\tTrusted: yes",
                        "\tConnected: yes",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("AA:BB:CC:DD:EE:FF")
    status = adapter.status()

    assert action.state == "succeeded"
    assert status.status == "connected"
    assert status.primary is not None
    assert status.primary.display_name == "Pipzo Speaker"
    pair_call = next(call for call in calls if call[2] and "pair AA:BB:CC:DD:EE:FF" in call[2])
    assert pair_call[0] == ["/usr/bin/bluetoothctl"]
    assert "trust AA:BB:CC:DD:EE:FF" in pair_call[2]


def test_adapter_reports_pair_failure_without_saving_primary(tmp_path):
    def runner(argv, timeout_seconds, input_text=None):
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        return BluetoothCommandResult(0, "Failed to pair: org.bluez.Error.AuthenticationFailed\n", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-failure.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("AA:BB:CC:DD:EE:FF")

    assert action.state == "failed"
    assert action.reason == SpeakerReason.PAIR_REJECTED
    assert store.get_primary() is None
