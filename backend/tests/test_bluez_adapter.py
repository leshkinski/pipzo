from pipzo_api.adapters.bluez import (
    BluetoothCommandResult,
    BluetoothctlAdapter,
    logger as bluez_logger,
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
        if input_text == "pair AA:BB:CC:DD:EE:FF\n":
            device_state["paired"] = True
            return BluetoothCommandResult(0, "Pairing successful\n", "")
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
    assert (["/usr/bin/bluetoothctl"], 30, "pair AA:BB:CC:DD:EE:FF\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "trust AA:BB:CC:DD:EE:FF\n") in calls
    assert (["/usr/bin/bluetoothctl"], 30, "connect AA:BB:CC:DD:EE:FF\n") in calls
    assert (["/usr/bin/bluetoothctl"], 1, "scan off\n") in calls
    scan_on_call_index = calls.index((["/usr/bin/bluetoothctl", "--timeout", "6", "scan", "on"], 8, None))
    pair_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "pair AA:BB:CC:DD:EE:FF\n"))
    trust_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "trust AA:BB:CC:DD:EE:FF\n"))
    connect_call_index = calls.index((["/usr/bin/bluetoothctl"], 30, "connect AA:BB:CC:DD:EE:FF\n"))
    assert scan_on_call_index < pair_call_index
    assert pair_call_index < trust_call_index < connect_call_index


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
        if input_text == "pair 20:64:DE:30:D6:F2\n":
            return BluetoothCommandResult(
                0,
                "Attempting to pair with 20:64:DE:30:D6:F2\nFailed to pair: org.bluez.Error.ConnectionAttemptFailed\n",
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
    assert (["/usr/bin/bluetoothctl"], 30, "pair 20:64:DE:30:D6:F2\n") in calls
    assert any(
        message == "bluetoothctl command failed"
        and extra["details"]["commands"] == ["pair 20:64:DE:30:D6:F2"]
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
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
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
                    ]
                ),
                "",
            )
        if input_text == "pair 20:64:DE:30:D6:F2\n":
            device_state["paired"] = True
            return BluetoothCommandResult(0, "Pairing successful\n", "")
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
    assert (["/usr/bin/bluetoothctl"], 30, "pair 20:64:DE:30:D6:F2\n") in calls
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
        if input_text == "agent NoInputNoOutput\ndefault-agent\n":
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
