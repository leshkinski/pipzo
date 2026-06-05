import { describe, expect, it } from "vitest";
import {
  applyVirtualKeyboardCommand,
  initialVirtualKeyboardState,
  virtualKeyboardDisplayKey,
  wifiPasswordKeyboardEnabled,
} from "./virtualKeyboard";
import { localScenarios } from "./localScenarios";
import type { WifiNetwork } from "./contracts";
import { wifiSetupViewModel } from "./viewModel";

describe("virtual keyboard", () => {
  it("types Wi-Fi password characters including shifted letters, digits, symbols, and spaces", () => {
    let value = "";
    let state = initialVirtualKeyboardState;

    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "shift" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "text", value: "p" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "text", value: "i" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "text", value: "5" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "mode", mode: "symbols" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "text", value: "!" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "mode", mode: "letters" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "space" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "caps" }));
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "text", value: "z" }));

    expect(value).toBe("Pi5! Z");
    expect(state.shift).toBe("caps");
  });

  it("supports backspace, clear, one-shot shift, and caps display behavior", () => {
    let value = "abc";
    let state = initialVirtualKeyboardState;

    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "backspace" }));
    expect(value).toBe("ab");

    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "shift" }));
    expect(virtualKeyboardDisplayKey("x", state)).toBe("X");
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "text", value: "x" }));
    expect(value).toBe("abX");
    expect(state.shift).toBe("off");

    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "caps" }));
    expect(virtualKeyboardDisplayKey("y", state)).toBe("Y");
    ({ value, state } = applyVirtualKeyboardCommand(value, state, { kind: "clear" }));
    expect(value).toBe("");
    expect(state.shift).toBe("caps");
  });

  it("enables the Wi-Fi password keyboard only when the selected network requires a password", () => {
    expect(wifiPasswordKeyboardEnabled(true)).toBe(true);
    expect(wifiPasswordKeyboardEnabled(false)).toBe(false);
  });

  it("integrates with Wi-Fi setup choices without changing the existing connect action model", () => {
    const snapshot = localScenarios.first_boot_empty.snapshot;
    const securedNetwork: WifiNetwork = { ssid: "PipzoNet", signal: 92, security: "wpa2", known: false };
    const openNetwork: WifiNetwork = { ssid: "Open Setup Lab", signal: 41, security: "open", known: false };

    expect(wifiSetupViewModel(snapshot, [securedNetwork]).actions).toEqual(["scan", "connect"]);
    expect(wifiPasswordKeyboardEnabled(securedNetwork.security !== "open")).toBe(true);
    expect(wifiPasswordKeyboardEnabled(openNetwork.security !== "open")).toBe(false);
  });
});
