from pipzo_api.adapters.device_power import SystemdDevicePowerAdapter


class RecordingPowerAdapter(SystemdDevicePowerAdapter):
    def __init__(self) -> None:
        super().__init__(systemctl_path="systemctl")
        self.argv_calls: list[list[str]] = []

    def _systemctl(self) -> str:
        return "/usr/bin/systemctl"

    def _run_argv(self, argv):
        self.argv_calls.append(list(argv))


def test_systemd_power_adapter_uses_fixed_reboot_argv():
    adapter = RecordingPowerAdapter()

    result = adapter.reboot()

    assert adapter.argv_calls == [["/usr/bin/systemctl", "reboot"]]
    assert result.action == "reboot"
    assert result.domain == "settings"
    assert result.mock is False


def test_systemd_power_adapter_uses_fixed_poweroff_argv():
    adapter = RecordingPowerAdapter()

    result = adapter.poweroff()

    assert adapter.argv_calls == [["/usr/bin/systemctl", "poweroff"]]
    assert result.action == "poweroff"
    assert result.domain == "settings"
    assert result.mock is False
