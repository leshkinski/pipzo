import shutil
from typing import Optional, Sequence

import pytest

from pipzo_api.adapters.volume import (
    CommandResult,
    PipeWireVolumeAdapter,
    VolumeCommandError,
    VolumeUnavailable,
    classify_volume_error,
    parse_pactl_get_sink_mute,
    parse_pactl_get_sink_volume,
    parse_wpctl_get_volume,
)
from pipzo_api.contract import VolumeReason


def test_parse_wpctl_get_volume_handles_muted_readback():
    assert parse_wpctl_get_volume("Volume: 0.42 [MUTED]\n") == (42, True)
    assert parse_wpctl_get_volume("Volume: 1.20\n") == (100, False)


def test_parse_pactl_readback_averages_channels_and_mute():
    assert parse_pactl_get_sink_volume("front-left: 32768 / 50% / -18.00 dB, front-right: 34079 / 52% / -17.00 dB") == 51
    assert parse_pactl_get_sink_mute("Mute: yes\n") is True
    assert parse_pactl_get_sink_mute("Mute: no\n") is False


def test_classify_volume_errors_to_contract_reasons():
    assert classify_volume_error("Access denied by policy") == VolumeReason.PERMISSION_DENIED
    assert classify_volume_error("failed to connect: connection refused") == VolumeReason.OS_SINK_MISSING
    assert classify_volume_error("other failure") == VolumeReason.UNKNOWN


def test_wpctl_set_volume_returns_os_status(monkeypatch):
    commands: list[list[str]] = []

    def fake_which(name: str) -> Optional[str]:
        return f"/usr/bin/{name}" if name == "wpctl" else None

    def runner(command: Sequence[str]) -> CommandResult:
        commands.append(list(command))
        if list(command) == ["wpctl", "get-volume", "@DEFAULT_SINK@"]:
            return CommandResult(0, "Volume: 0.55\n", "")
        return CommandResult(0, "", "")

    monkeypatch.setattr(shutil, "which", fake_which)
    adapter = PipeWireVolumeAdapter(runner)

    health = adapter.set_volume(55, muted=False)

    assert health.status == "os_only"
    assert health.value == 55
    assert health.muted is False
    assert commands[:2] == [
        ["wpctl", "set-volume", "-l", "1.0", "@DEFAULT_SINK@", "55%"],
        ["wpctl", "set-mute", "@DEFAULT_SINK@", "0"],
    ]


def test_volume_adapter_reports_missing_audio_tool(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    adapter = PipeWireVolumeAdapter(lambda command: CommandResult(0, "", ""))

    with pytest.raises(VolumeUnavailable) as exc:
        adapter.status()

    assert exc.value.reason == VolumeReason.OS_SINK_MISSING


def test_volume_adapter_maps_command_permission_failure(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/wpctl" if name == "wpctl" else None)
    adapter = PipeWireVolumeAdapter(lambda command: CommandResult(1, "", "permission denied"))

    with pytest.raises(VolumeCommandError) as exc:
        adapter.status()

    assert exc.value.reason == VolumeReason.PERMISSION_DENIED
