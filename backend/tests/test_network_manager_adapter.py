from pipzo_api.adapters.network_manager import (
    CommandResult,
    NetworkCommandError,
    NmcliNetworkAdapter,
    map_nmcli_failure,
    parse_nmcli_ipv4_address,
    parse_nmcli_terse_line,
    parse_wifi_scan,
)
from pipzo_api.contract import NetworkReason


def test_parse_nmcli_terse_line_unescapes_colons_and_backslashes():
    assert parse_nmcli_terse_line(r"yes:Kitchen\:WiFi:82:WPA2") == ["yes", "Kitchen:WiFi", "82", "WPA2"]
    assert parse_nmcli_terse_line(r"no:Back\\Room:41:") == ["no", "Back\\Room", "41", ""]


def test_parse_wifi_scan_deduplicates_by_best_signal_and_marks_known():
    stdout = "\n".join(
        [
            "no:PipzoNet:55:WPA2",
            "yes:PipzoNet:93:WPA2 WPA3",
            "no:Guest:40:",
            "no::80:WPA2",
        ]
    )

    networks = parse_wifi_scan(stdout, known_ssids=["PipzoNet"])

    assert [network.ssid for network in networks] == ["PipzoNet", "Guest"]
    assert networks[0].signal == 93
    assert networks[0].security == "wpa3"
    assert networks[0].known is True
    assert networks[1].security == "open"


def test_parse_nmcli_ipv4_address_returns_first_routable_ipv4():
    stdout = "\n".join(
        [
            "IP4.ADDRESS[1]:169.254.10.20/16",
            "IP4.ADDRESS[2]:192.168.1.42/24",
            "IP6.ADDRESS[1]:fe80::1/64",
        ]
    )

    assert parse_nmcli_ipv4_address(stdout) == "192.168.1.42"
    assert parse_nmcli_ipv4_address("IP4.ADDRESS[1]:not-an-address\n") is None


def test_nmcli_failure_mapping_keeps_reasons_coarse():
    assert map_nmcli_failure("Secrets were required, but not provided") == NetworkReason.BAD_CREDENTIALS
    assert map_nmcli_failure("IP configuration could not be reserved") == NetworkReason.DHCP_FAILED
    assert map_nmcli_failure("No network with SSID 'x' found") == NetworkReason.SCAN_EMPTY


def test_adapter_scan_uses_safe_argument_vector_and_parses_results():
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append((list(argv), timeout_seconds))
        if argv[-1] == "radio":
            return CommandResult(0, "enabled\n", "")
        if argv[1:5] == ["-t", "-f", "NAME,UUID,TYPE", "connection"]:
            return CommandResult(0, "PipzoNet:uuid-1:802-11-wireless\n", "")
        return CommandResult(0, "yes:PipzoNet:88:WPA2\n", "")

    adapter = NmcliNetworkAdapter(runner=runner, nmcli_path="/usr/bin/nmcli")

    results = adapter.scan_results(rescan=True)

    assert results.networks[0].ssid == "PipzoNet"
    assert results.networks[0].known is True
    assert calls[0][0] == ["/usr/bin/nmcli", "-t", "-f", "WIFI", "radio"]
    assert any(call[0][-2:] == ["--rescan", "yes"] for call in calls)


def test_adapter_connect_does_not_return_password_on_failure():
    def runner(argv, timeout_seconds, input_text=None):
        if argv[-1] == "radio":
            return CommandResult(0, "enabled\n", "")
        assert "secret-passphrase" not in argv
        assert input_text == "secret-passphrase\n"
        return CommandResult(4, "", "Secrets were required, but not provided")

    adapter = NmcliNetworkAdapter(runner=runner, nmcli_path="/usr/bin/nmcli")

    action = adapter.connect("PipzoNet", "secret-passphrase")

    assert action.state == "failed"
    assert action.reason == NetworkReason.BAD_CREDENTIALS
    assert "secret-passphrase" not in action.model_dump_json()


def test_adapter_forget_deletes_matching_wifi_profile_uuid():
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append(list(argv))
        if argv[1:5] == ["-t", "-f", "NAME,UUID,TYPE", "connection"]:
            return CommandResult(0, "PipzoNet:uuid-1:802-11-wireless\nEthernet:uuid-2:802-3-ethernet\n", "")
        return CommandResult(0, "deleted\n", "")

    adapter = NmcliNetworkAdapter(runner=runner, nmcli_path="/usr/bin/nmcli")

    action = adapter.forget("PipzoNet")

    assert action.state == "succeeded"
    assert ["/usr/bin/nmcli", "connection", "delete", "uuid", "uuid-1"] in calls


def test_adapter_scan_command_error_maps_to_contract_reason():
    def runner(argv, timeout_seconds, input_text=None):
        if argv[-1] == "radio":
            return CommandResult(0, "enabled\n", "")
        return CommandResult(10, "", "No network with SSID found")

    adapter = NmcliNetworkAdapter(runner=runner, nmcli_path="/usr/bin/nmcli")

    try:
        adapter.scan_results()
    except NetworkCommandError as exc:
        assert exc.reason == NetworkReason.SCAN_EMPTY
    else:
        raise AssertionError("expected NetworkCommandError")


def test_adapter_status_includes_active_wifi_ipv4_address():
    calls = []

    def runner(argv, timeout_seconds, input_text=None):
        calls.append(list(argv))
        if argv[-1] == "radio":
            return CommandResult(0, "enabled\n", "")
        if argv[-2:] == ["--rescan", "no"]:
            return CommandResult(0, "yes:PipzoNet:92:WPA2\n", "")
        if argv[1:5] == ["-t", "-f", "DEVICE,TYPE,STATE", "device"]:
            return CommandResult(0, "wlan0:wifi:connected\neth0:ethernet:connected\n", "")
        if argv[1:5] == ["-t", "-f", "IP4.ADDRESS", "device"]:
            return CommandResult(0, "IP4.ADDRESS[1]:192.168.1.42/24\n", "")
        return CommandResult(0, "", "")

    adapter = NmcliNetworkAdapter(runner=runner, nmcli_path="/usr/bin/nmcli")
    adapter._internet_reachable = lambda: True  # type: ignore[method-assign]

    health = adapter.status()

    assert health.status == "online"
    assert health.ssid == "PipzoNet"
    assert health.ip_address == "192.168.1.42"
    assert ["/usr/bin/nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "wlan0"] in calls
