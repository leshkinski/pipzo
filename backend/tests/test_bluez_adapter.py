import subprocess

from pipzo_api.adapters.bluez import (
    BluetoothCommandResult,
    BluetoothctlAdapter,
    logger as bluez_logger,
    info_services_resolved,
    info_looks_like_audio_device,
    map_bluetoothctl_failure,
    parse_device_lines,
    parse_info,
)
from pipzo_api.bluetooth_store import BluetoothSpeakerStore
from pipzo_api.contract import SpeakerReason, SpeakerSummary


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


def test_parse_device_lines_ignores_controller_state_changes():
    devices = parse_device_lines(
        "\n".join(
            [
                "[CHG] Controller 88:A2:9E:E0:36:F4 Discovering: yes",
                "Controller 88:A2:9E:E0:36:F4 raspberrypi",
                "[NEW] Device AA:BB:CC:DD:EE:FF Bedroom Speaker",
            ]
        )
    )

    assert [device.address for device in devices] == ["AA:BB:CC:DD:EE:FF"]
    assert devices[0].display_name == "Bedroom Speaker"


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


def test_info_looks_like_audio_device_accepts_bluez_audio_icon_before_a2dp_uuid():
    assert info_looks_like_audio_device(
        "\n".join(
            [
                "Device 20:64:DE:30:D6:F2",
                "\tName: SRS-XE300",
                "\tAlias: SRS-XE300",
                "\tIcon: audio-card",
                "\tUUID: Vendor specific           (fa349b5f-8050-0030-0010-00001bbb231d)",
            ]
        )
    )


def test_info_services_resolved_maps_bluez_settle_state():
    assert info_services_resolved("Device AA:BB:CC:DD:EE:FF\n\tServicesResolved: yes\n") is True
    assert info_services_resolved("Device AA:BB:CC:DD:EE:FF\n\tServicesResolved: no\n") is False
    assert info_services_resolved("Device AA:BB:CC:DD:EE:FF\n\tConnected: yes\n") is None


def test_bluetoothctl_failure_mapping_keeps_reasons_coarse():
    assert map_bluetoothctl_failure("No default controller available") == SpeakerReason.ADAPTER_UNAVAILABLE
    assert map_bluetoothctl_failure("Authentication Failed") == SpeakerReason.PAIR_REJECTED
    assert map_bluetoothctl_failure("Failed to connect: org.bluez.Error.Failed") == SpeakerReason.CONNECT_FAILED
    assert map_bluetoothctl_failure("Failed to connect: org.bluez.Error.Failed br-connection-profile-unavailable") == SpeakerReason.AUDIO_PROFILE_UNAVAILABLE
    assert map_bluetoothctl_failure("Failed to pair: org.bluez.Error.AlreadyExists") == SpeakerReason.CONNECT_FAILED
    assert map_bluetoothctl_failure("Failed to pair: org.bluez.Error.NotAvailable") == SpeakerReason.DEVICE_OUT_OF_RANGE
    assert map_bluetoothctl_failure("Failed to connect: org.bluez.Error.NotReady") == SpeakerReason.BLUETOOTH_DISABLED
    assert map_bluetoothctl_failure("Failed to start discovery: org.bluez.Error.InProgress") == SpeakerReason.PAIR_TIMEOUT
    assert map_bluetoothctl_failure("org.bluez.Error.NotPermitted") == SpeakerReason.ADAPTER_UNAVAILABLE
    assert map_bluetoothctl_failure("connect error: Host is down") == SpeakerReason.DEVICE_OUT_OF_RANGE
    assert map_bluetoothctl_failure("connect error: Input/output error") == SpeakerReason.CONNECT_FAILED
    assert map_bluetoothctl_failure("Failed to pair: org.bluez.Error.Failed") == SpeakerReason.PAIR_REJECTED
    assert map_bluetoothctl_failure("Failed to connect: org.bluez.Error.Failed") == SpeakerReason.CONNECT_FAILED
    assert map_bluetoothctl_failure("Failed to pair: org.bluez.Error.ConnectionAttemptFailed") == SpeakerReason.CONNECT_FAILED
    assert map_bluetoothctl_failure("Failed to pair: org.bluez.Error.AuthenticationTimeout") == SpeakerReason.PAIR_TIMEOUT
    assert map_bluetoothctl_failure("", "Attempting to pair with AA:BB:CC:DD:EE:FF") == SpeakerReason.PAIR_TIMEOUT
    assert map_bluetoothctl_failure("Failed to register agent object\nNo agent is registered") == SpeakerReason.ADAPTER_UNAVAILABLE


def test_adapter_scan_stops_discovery_and_uses_short_bounded_scan(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device AA:BB:CC:DD:EE:FF Bedroom Speaker\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device AA:BB:CC:DD:EE:FF Bedroom Speaker\n", "")
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device AA:BB:CC:DD:EE:FF",
                        "\tName: Bedroom Speaker",
                        "\tAlias: Bedroom Speaker",
                        "\tPaired: no",
                        "\tConnected: no",
                        "\tIcon: audio-card",
                        "\tUUID: Vendor specific",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.scan()

    assert action.state == "succeeded"
    assert (["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None) in calls
    assert (["/usr/bin/bluetoothctl"], 1, "scan off\n") in calls
    assert calls.count((["/usr/bin/bluetoothctl"], 2, "info AA:BB:CC:DD:EE:FF\n")) == 1


def test_adapter_scan_does_not_crash_when_cleanup_times_out(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            raise subprocess.TimeoutExpired(cmd=list(argv), timeout=timeout_seconds)
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device AA:BB:CC:DD:EE:FF Bedroom Speaker\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device AA:BB:CC:DD:EE:FF Bedroom Speaker\n", "")
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device AA:BB:CC:DD:EE:FF",
                        "\tName: Bedroom Speaker",
                        "\tIcon: audio-card",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan-cleanup-timeout.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.scan()
    results = adapter.scan_results()

    assert action.state == "succeeded"
    assert action.reason is None
    assert results.devices[0].address == "AA:BB:CC:DD:EE:FF"
    assert calls.count((["/usr/bin/bluetoothctl"], 1, "scan off\n")) == 2


def test_adapter_scan_returns_scan_empty_when_only_controller_state_changes_are_seen(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 88:A2:9E:E0:36:F4\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[CHG] Controller 88:A2:9E:E0:36:F4 Discovering: yes\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Controller 88:A2:9E:E0:36:F4 raspberrypi\n", "")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan-controller-only.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.scan()
    results = adapter.scan_results()

    assert action.state == "failed"
    assert action.reason == SpeakerReason.SCAN_EMPTY
    assert results.devices == []
    assert not any(call[2] == "info 88:A2:9E:E0:36:F4\n" for call in calls)


def test_adapter_scan_keeps_devices_seen_only_in_discovery_output(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(
                1,
                "",
                "Device 20:64:DE:30:D6:F2 not available\n",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan-discovery-output.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.scan()
    results = adapter.scan_results()

    assert action.state == "succeeded"
    assert results.devices[0].address == "20:64:DE:30:D6:F2"
    assert results.devices[0].display_name == "SRS-XE300"
    assert calls.count((["/usr/bin/bluetoothctl"], 2, "info 20:64:DE:30:D6:F2\n")) == 1


def test_adapter_scan_results_does_not_crash_when_device_inspection_times_out(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device AA:BB:CC:DD:EE:FF Bedroom Speaker\n", "")
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            raise subprocess.TimeoutExpired(cmd=list(argv), timeout=timeout_seconds)
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan-results-info-timeout.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    results = adapter.scan_results()

    assert results.devices[0].address == "AA:BB:CC:DD:EE:FF"
    assert results.devices[0].display_name == "Bedroom Speaker"
    assert (["/usr/bin/bluetoothctl"], 2, "info AA:BB:CC:DD:EE:FF\n") in calls


def test_adapter_scan_prefers_classic_identity_over_matching_le_advertisement(tmp_path):
    def runner(argv, timeout_seconds, input_text=None):
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "[NEW] Device C8:0A:B8:D7:4F:2C LE_SRS-XE300",
                        "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300",
                    ]
                ),
                "",
            )
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "", "")
        if input_text and input_text.startswith("info "):
            return BluetoothCommandResult(1, "", "Device not available\n")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan-le-classic.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.scan()
    results = adapter.scan_results()

    assert action.state == "succeeded"
    assert [device.address for device in results.devices] == ["20:64:DE:30:D6:F2"]
    assert results.devices[0].display_name == "SRS-XE300"


def test_adapter_scan_drops_stale_known_device_not_seen_in_active_discovery(tmp_path):
    def runner(argv, timeout_seconds, input_text=None):
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device CC:98:8B:94:B5:1C WH-1000XM3\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2 SRS-XE300",
                        "Device CC:98:8B:94:B5:1C WH-1000XM3",
                    ]
                ),
                "",
            )
        if input_text == "info 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(1, "", "Device 20:64:DE:30:D6:F2 not available\n")
        if input_text == "info CC:98:8B:94:B5:1C\n":
            return BluetoothCommandResult(
                0,
                "Device CC:98:8B:94:B5:1C\n\tName: WH-1000XM3\n\tIcon: audio-headphones\n",
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-scan-stale-known-device.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.scan()
    results = adapter.scan_results()

    assert action.state == "succeeded"
    assert [device.address for device in results.devices] == ["CC:98:8B:94:B5:1C"]
    assert results.devices[0].display_name == "WH-1000XM3"


def test_adapter_pair_runs_pair_trust_connect_sequentially_and_persists_primary(tmp_path):
    calls = []
    device_state = {"paired": False, "trusted": False, "connected": False}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device AA:BB:CC:DD:EE:FF Pipzo Speaker\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device AA:BB:CC:DD:EE:FF Pipzo Speaker\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair AA:BB:CC:DD:EE:FF\n":
            device_state["paired"] = True
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\nPairing successful\n", "")
        if input_text == "trust AA:BB:CC:DD:EE:FF\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing AA:BB:CC:DD:EE:FF trust succeeded\n", "")
        if input_text == "connect AA:BB:CC:DD:EE:FF\n":
            device_state["connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            if not device_state["paired"]:
                return BluetoothCommandResult(1, "", "Device AA:BB:CC:DD:EE:FF not available\n")
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device AA:BB:CC:DD:EE:FF",
                        "\tName: Pipzo Speaker",
                        "\tAlias: Bedroom speaker",
                        f"\tPaired: {'yes' if device_state['paired'] else 'no'}",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['connected'] else 'no'}",
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
    assert (["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None) in calls
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair AA:BB:CC:DD:EE:FF\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "trust AA:BB:CC:DD:EE:FF\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "connect AA:BB:CC:DD:EE:FF\n") in calls
    assert (["/usr/bin/bluetoothctl"], 1, "scan off\n") in calls
    scan_on_call_index = calls.index((["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None))
    pair_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair AA:BB:CC:DD:EE:FF\n"))
    trust_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "trust AA:BB:CC:DD:EE:FF\n"))
    connect_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "connect AA:BB:CC:DD:EE:FF\n"))
    assert scan_on_call_index < pair_call_index
    assert pair_call_index < trust_call_index < connect_call_index


def test_adapter_pair_waits_for_async_pairing_success_before_strict_info(tmp_path):
    calls = []
    device_state = {"paired": False, "trusted": False, "connected": False}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            device_state["paired"] = True
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Agent registered",
                        "Default agent request successful",
                        "Attempting to pair with 20:64:DE:30:D6:F2",
                        "[CHG] Device 20:64:DE:30:D6:F2 Connected: yes",
                        "[CHG] Device 20:64:DE:30:D6:F2 Bonded: yes",
                        "[CHG] Device 20:64:DE:30:D6:F2 Paired: yes",
                        "Pairing successful",
                    ]
                ),
                "",
            )
        if input_text == "pair 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(0, "Attempting to pair with 20:64:DE:30:D6:F2\n", "")
        if input_text == "trust 20:64:DE:30:D6:F2\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing 20:64:DE:30:D6:F2 trust succeeded\n", "")
        if input_text == "connect 20:64:DE:30:D6:F2\n":
            device_state["connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            if not device_state["paired"]:
                return BluetoothCommandResult(1, "", "Device 20:64:DE:30:D6:F2 not available\n")
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2",
                        "\tName: SRS-XE300",
                        "\tAlias: SRS-XE300",
                        "\tPaired: yes",
                        "\tBonded: yes",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['connected'] else 'no'}",
                        "\tIcon: audio-card",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-async-pair.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "20:64:DE:30:D6:F2"
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "pair 20:64:DE:30:D6:F2\n") not in calls
    pair_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n"))
    strict_info_call_indices = [index for index, call in enumerate(calls) if call == (["/usr/bin/bluetoothctl"], 10, "info 20:64:DE:30:D6:F2\n")]
    assert pair_call_index < strict_info_call_indices[-1]


def test_adapter_pair_retries_connect_until_services_resolve_before_saving_primary(tmp_path):
    calls = []
    device_state = {"paired": False, "trusted": False, "connect_attempts": 0}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            device_state["paired"] = True
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\nPairing successful\n", "")
        if input_text == "trust 20:64:DE:30:D6:F2\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing 20:64:DE:30:D6:F2 trust succeeded\n", "")
        if input_text == "connect 20:64:DE:30:D6:F2\n":
            device_state["connect_attempts"] += 1
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            if not device_state["paired"]:
                return BluetoothCommandResult(1, "", "Device 20:64:DE:30:D6:F2 not available\n")
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2",
                        "\tName: SRS-XE300",
                        "\tAlias: SRS-XE300",
                        "\tPaired: yes",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        "\tConnected: yes",
                        f"\tServicesResolved: {'yes' if device_state['connect_attempts'] >= 2 else 'no'}",
                        "\tIcon: audio-card",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-pair-settle-retry.sqlite3")
    adapter = BluetoothctlAdapter(
        store=store,
        runner=runner,
        bluetoothctl_path="/usr/bin/bluetoothctl",
        connect_settle_timeout_seconds=0,
        connect_settle_interval_seconds=0,
        connect_retry_count=2,
    )

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert calls.count((["/usr/bin/bluetoothctl"], 30, "connect 20:64:DE:30:D6:F2\n")) == 2


def test_adapter_pair_adopts_already_connected_audio_device(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device AA:BB:CC:DD:EE:FF",
                        "\tName: Pipzo Speaker",
                        "\tAlias: Bedroom speaker",
                        "\tPaired: yes",
                        "\tBonded: yes",
                        "\tTrusted: yes",
                        "\tConnected: yes",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-adopt.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("aa:bb:cc:dd:ee:ff")

    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "AA:BB:CC:DD:EE:FF"
    assert not any(call[2] == "pair AA:BB:CC:DD:EE:FF\n" for call in calls)


def test_adapter_pair_connects_already_paired_replacement_device(tmp_path):
    calls = []
    device_state = {"paired": True, "trusted": False, "connected": False}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\n", "")
        if input_text == "trust 11:22:33:44:55:66\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing 11:22:33:44:55:66 trust succeeded\n", "")
        if input_text == "connect 11:22:33:44:55:66\n":
            device_state["connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 11:22:33:44:55:66\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 11:22:33:44:55:66",
                        "\tName: Replacement Speaker",
                        "\tAlias: Replacement Speaker",
                        f"\tPaired: {'yes' if device_state['paired'] else 'no'}",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['connected'] else 'no'}",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-replacement.sqlite3")
    store.save_primary(
        speaker=SpeakerSummary(
            address="AA:BB:CC:DD:EE:FF",
            display_name="Old Headphones",
            connected=False,
        )
    )
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("11:22:33:44:55:66")

    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "11:22:33:44:55:66"
    assert not any(call[2] == "pair 11:22:33:44:55:66\n" for call in calls)
    assert (["/usr/bin/bluetoothctl"], 30, "trust 11:22:33:44:55:66\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "connect 11:22:33:44:55:66\n") in calls


def test_adapter_pair_disconnects_saved_primary_before_replacement_connect(tmp_path):
    calls = []
    device_state = {"new_paired": True, "new_trusted": False, "new_connected": False, "old_connected": True}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if input_text == "disconnect AA:BB:CC:DD:EE:FF\n":
            device_state["old_connected"] = False
            return BluetoothCommandResult(0, "Successful disconnected\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\n", "")
        if input_text == "trust 11:22:33:44:55:66\n":
            device_state["new_trusted"] = True
            return BluetoothCommandResult(0, "Changing 11:22:33:44:55:66 trust succeeded\n", "")
        if input_text == "connect 11:22:33:44:55:66\n":
            assert device_state["old_connected"] is False
            device_state["new_connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 11:22:33:44:55:66\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 11:22:33:44:55:66",
                        "\tName: Replacement Headset",
                        "\tAlias: Replacement Headset",
                        "\tPaired: yes",
                        f"\tTrusted: {'yes' if device_state['new_trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['new_connected'] else 'no'}",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-replacement-disconnect.sqlite3")
    store.save_primary(
        speaker=SpeakerSummary(
            address="AA:BB:CC:DD:EE:FF",
            display_name="Old Headphones",
            connected=True,
        )
    )
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("11:22:33:44:55:66", "Replacement Headset")

    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "11:22:33:44:55:66"
    disconnect_call = (["/usr/bin/bluetoothctl"], 30, "disconnect AA:BB:CC:DD:EE:FF\n")
    connect_call = (["/usr/bin/bluetoothctl"], 30, "connect 11:22:33:44:55:66\n")
    assert disconnect_call in calls
    assert calls.index(disconnect_call) < calls.index(connect_call)


def test_adapter_pair_attempts_audio_icon_device_without_prepair_audio_uuid_and_logs_failure(tmp_path, monkeypatch):
    calls = []
    logs = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2 (public)",
                        "\tName: SRS-XE300",
                        "\tAlias: SRS-XE300",
                        "\tIcon: audio-card",
                        "\tPaired: no",
                        "\tBonded: no",
                        "\tTrusted: no",
                        "\tConnected: no",
                        "\tUUID: Vendor specific           (fa349b5f-8050-0030-0010-00001bbb231d)",
                    ]
                ),
                "",
            )
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(
                0,
                "Agent registered\nDefault agent request successful\nAttempting to pair with 20:64:DE:30:D6:F2\nFailed to pair: org.bluez.Error.ConnectionAttemptFailed\n",
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-srs-pair-failure.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")
    monkeypatch.setattr(bluez_logger, "warning", lambda message, extra=None: logs.append((message, extra or {})))

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "failed"
    assert action.reason == SpeakerReason.CONNECT_FAILED
    assert store.get_primary() is None
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n") in calls
    assert any(
        message == "bluetoothctl command failed"
        and extra["details"]["commands"] == ["agent NoInputNoOutput", "default-agent", "pair 20:64:DE:30:D6:F2"]
        and extra["details"]["reason"] == SpeakerReason.CONNECT_FAILED.value
        and "ConnectionAttemptFailed" in extra["details"]["stdout"]
        for message, extra in logs
    )


def test_adapter_pair_continues_when_agent_registration_stdout_eventually_succeeds(tmp_path):
    calls = []
    device_state = {"paired": False, "trusted": False, "connected": False}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            device_state["paired"] = True
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Waiting to connect to bluetoothd...",
                        "[bluetooth]# agent NoInputNoOutput",
                        "Failed to register agent object",
                        "[bluetooth]# default-agent",
                        "No agent is registered",
                        "[bluetooth]#",
                        "Agent registered",
                        "Default agent request successful",
                        "Pairing successful",
                    ]
                ),
                "",
            )
        if input_text == "trust 20:64:DE:30:D6:F2\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing 20:64:DE:30:D6:F2 trust succeeded\n", "")
        if input_text == "connect 20:64:DE:30:D6:F2\n":
            device_state["connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            if not device_state["paired"]:
                return BluetoothCommandResult(1, "", "Device 20:64:DE:30:D6:F2 not available\n")
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2",
                        "\tName: SRS-XE300",
                        "\tAlias: SRS-XE300",
                        f"\tPaired: {'yes' if device_state['paired'] else 'no'}",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['connected'] else 'no'}",
                        "\tIcon: audio-card",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-agent-eventual-success.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "20:64:DE:30:D6:F2"
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "trust 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "connect 20:64:DE:30:D6:F2\n") in calls


def test_adapter_pair_fails_before_agent_when_refresh_does_not_see_target_address(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device C8:0A:B8:D7:4F:2C LE_SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device C8:0A:B8:D7:4F:2C LE_SRS-XE300\n", "")
        if input_text and input_text.startswith("info "):
            return BluetoothCommandResult(1, "", "Device not available\n")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-pair-refresh-miss.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "failed"
    assert action.reason == SpeakerReason.DEVICE_OUT_OF_RANGE
    assert store.get_primary() is None
    assert (["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None) in calls
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\n") not in calls
    assert (["/usr/bin/bluetoothctl"], 30, "pair 20:64:DE:30:D6:F2\n") not in calls


def test_adapter_pair_uses_cached_scan_candidate_when_pair_refresh_info_stays_unavailable(tmp_path):
    calls = []
    device_state = {"paired": False, "trusted": False, "connected": False}
    scan_count = 0

    def runner(argv, timeout_seconds, input_text=None):
        nonlocal scan_count
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            scan_count += 1
            if scan_count == 1:
                return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
            return BluetoothCommandResult(0, "[NEW] Device C8:0A:B8:D7:4F:2C LE_SRS-XE300\n", "")
        if input_text == "devices\n":
            if scan_count == 1:
                return BluetoothCommandResult(0, "Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
            return BluetoothCommandResult(0, "Device C8:0A:B8:D7:4F:2C LE_SRS-XE300\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            device_state["paired"] = True
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\nPairing successful\n", "")
        if input_text == "trust 20:64:DE:30:D6:F2\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing 20:64:DE:30:D6:F2 trust succeeded\n", "")
        if input_text == "connect 20:64:DE:30:D6:F2\n":
            device_state["connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            if not device_state["paired"]:
                return BluetoothCommandResult(
                    0,
                    "Device 20:64:DE:30:D6:F2 not available\nDeviceSet 20:64:DE:30:D6:F2 not available\n",
                    "",
                )
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2",
                        "\tName: SRS-XE300",
                        "\tAlias: SRS-XE300",
                        f"\tPaired: {'yes' if device_state['paired'] else 'no'}",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['connected'] else 'no'}",
                        "\tIcon: audio-card",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        if input_text == "info C8:0A:B8:D7:4F:2C\n":
            return BluetoothCommandResult(1, "", "Device C8:0A:B8:D7:4F:2C not available\n")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-pair-cached-scan.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    scan_action = adapter.scan()
    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert scan_action.state == "succeeded"
    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "20:64:DE:30:D6:F2"
    assert calls.count((["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None)) == 2
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "trust 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "connect 20:64:DE:30:D6:F2\n") in calls


def test_adapter_pair_uses_cached_scan_candidate_when_stale_info_claims_already_paired(tmp_path):
    calls = []
    device_state = {"pair_attempted": False, "trusted": False, "connected": False}

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\n", "")
        if input_text == "trust 20:64:DE:30:D6:F2\n":
            device_state["trusted"] = True
            return BluetoothCommandResult(0, "Changing 20:64:DE:30:D6:F2 trust succeeded\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            device_state["pair_attempted"] = True
            return BluetoothCommandResult(0, "Agent registered\nDefault agent request successful\nPairing successful\n", "")
        if input_text == "connect 20:64:DE:30:D6:F2\n":
            device_state["connected"] = True
            return BluetoothCommandResult(0, "Connection successful\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            if not device_state["trusted"]:
                return BluetoothCommandResult(
                    0,
                    "\n".join(
                        [
                            "Device 20:64:DE:30:D6:F2",
                            "\tName: SRS-XE300",
                            "\tAlias: SRS-XE300",
                            "\tPaired: yes",
                            "\tTrusted: no",
                            "\tConnected: no",
                            "\tIcon: audio-card",
                        ]
                    ),
                    "",
                )
            if not device_state["pair_attempted"]:
                return BluetoothCommandResult(1, "", "Device 20:64:DE:30:D6:F2 not available\n")
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device 20:64:DE:30:D6:F2",
                        "\tName: SRS-XE300",
                        "\tAlias: SRS-XE300",
                        "\tPaired: yes",
                        f"\tTrusted: {'yes' if device_state['trusted'] else 'no'}",
                        f"\tConnected: {'yes' if device_state['connected'] else 'no'}",
                        "\tIcon: audio-card",
                        "\tUUID: Audio Sink",
                    ]
                ),
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-pair-stale-paired-cache.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    scan_action = adapter.scan()
    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert scan_action.state == "succeeded"
    assert action.state == "succeeded"
    assert store.get_primary() is not None
    assert store.get_primary().address == "20:64:DE:30:D6:F2"
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "connect 20:64:DE:30:D6:F2\n") in calls


def test_adapter_pair_refreshes_when_info_not_available_is_stdout_with_success_returncode(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(
                0,
                "Device 20:64:DE:30:D6:F2 not available\nDeviceSet 20:64:DE:30:D6:F2 not available\n",
                "",
            )
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device C8:0A:B8:D7:4F:2C LE_SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device C8:0A:B8:D7:4F:2C LE_SRS-XE300\n", "")
        if input_text == "info C8:0A:B8:D7:4F:2C\n":
            return BluetoothCommandResult(1, "", "Device C8:0A:B8:D7:4F:2C not available\n")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-pair-info-stdout-missing.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "failed"
    assert action.reason == SpeakerReason.DEVICE_OUT_OF_RANGE
    assert store.get_primary() is None
    assert (["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None) in calls
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\n") not in calls
    assert (["/usr/bin/bluetoothctl"], 30, "pair 20:64:DE:30:D6:F2\n") not in calls


def test_adapter_pair_stops_when_agent_registration_has_no_success_signal(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(0, "[NEW] Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "devices\n":
            return BluetoothCommandResult(0, "Device 20:64:DE:30:D6:F2 SRS-XE300\n", "")
        if input_text == "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(0, "Failed to register agent object\nNo agent is registered\n", "")
        if input_text == "info 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(1, "", "Device 20:64:DE:30:D6:F2 not available\n")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-agent-failed.sqlite3")
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.pair("20:64:DE:30:D6:F2", "SRS-XE300")

    assert action.state == "failed"
    assert action.reason == SpeakerReason.ADAPTER_UNAVAILABLE
    assert store.get_primary() is None
    assert (["/usr/bin/bluetoothctl"], 30, "agent NoInputNoOutput\ndefault-agent\npair 20:64:DE:30:D6:F2\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "pair 20:64:DE:30:D6:F2\n") not in calls


def test_adapter_forget_clears_saved_primary_when_bluez_already_removed_device(tmp_path):
    def runner(argv, timeout_seconds, input_text=None):
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "remove AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(1, "", "Device AA:BB:CC:DD:EE:FF not available\n")
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-stale-forget.sqlite3")
    store.save_primary(
        speaker=SpeakerSummary(
            address="AA:BB:CC:DD:EE:FF",
            display_name="Old Headphones",
            connected=False,
        )
    )
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    action = adapter.forget("AA:BB:CC:DD:EE:FF")

    assert action.state == "succeeded"
    assert action.reason is None
    assert store.get_primary() is None


def test_adapter_forget_disconnects_before_remove_and_drops_scan_cache_entry(tmp_path):
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds, input_text))
        if input_text == "show\n":
            return BluetoothCommandResult(0, "Controller 00:11:22:33:44:55\n\tPowered: yes\n", "")
        if input_text == "scan off\n":
            return BluetoothCommandResult(0, "Discovery stopped\n", "")
        if input_text == "disconnect AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(0, "Successful disconnected\n", "")
        if input_text == "remove AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(0, "Device has been removed\n", "")
        if list(argv) == ["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"]:
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "[NEW] Device AA:BB:CC:DD:EE:FF Old Headphones",
                        "[NEW] Device 11:22:33:44:55:66 Replacement Headset",
                    ]
                ),
                "",
            )
        if input_text == "devices\n":
            return BluetoothCommandResult(
                0,
                "\n".join(
                    [
                        "Device AA:BB:CC:DD:EE:FF Old Headphones",
                        "Device 11:22:33:44:55:66 Replacement Headset",
                    ]
                ),
                "",
            )
        if input_text == "info AA:BB:CC:DD:EE:FF\n":
            return BluetoothCommandResult(
                0,
                "Device AA:BB:CC:DD:EE:FF\n\tName: Old Headphones\n\tIcon: audio-headphones\n",
                "",
            )
        if input_text == "info 11:22:33:44:55:66\n":
            return BluetoothCommandResult(
                0,
                "Device 11:22:33:44:55:66\n\tName: Replacement Headset\n\tIcon: audio-headset\n",
                "",
            )
        return BluetoothCommandResult(0, "", "")

    store = BluetoothSpeakerStore(tmp_path / "bluetooth-forget-disconnect.sqlite3")
    store.save_primary(
        speaker=SpeakerSummary(
            address="AA:BB:CC:DD:EE:FF",
            display_name="Old Headphones",
            connected=True,
        )
    )
    adapter = BluetoothctlAdapter(store=store, runner=runner, bluetoothctl_path="/usr/bin/bluetoothctl")

    scan_action = adapter.scan()
    action = adapter.forget("AA:BB:CC:DD:EE:FF")
    results = adapter.scan_results()

    assert scan_action.state == "succeeded"
    assert action.state == "succeeded"
    assert store.get_primary() is None
    disconnect_call = (["/usr/bin/bluetoothctl"], 30, "disconnect AA:BB:CC:DD:EE:FF\n")
    remove_call = (["/usr/bin/bluetoothctl"], 30, "remove AA:BB:CC:DD:EE:FF\n")
    assert disconnect_call in calls
    assert remove_call in calls
    assert calls.index(disconnect_call) < calls.index(remove_call)
    assert [device.address for device in results.devices] == ["11:22:33:44:55:66"]


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
