import { describe, expect, it } from "vitest";

// @ts-expect-error Node types are intentionally not part of the browser app tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node types are intentionally not part of the browser app tsconfig.
import { runInNewContext } from "node:vm";

type KeyboardTestApi = {
  applyCommandValue: (
    value: string,
    selectionStart: number,
    selectionEnd: number,
    command: { kind: string; value?: string },
    state: { mode: string; shift: boolean; caps: boolean },
  ) => { value: string; caret: number };
  displayKey: (key: string, state: { mode: string; shift: boolean; caps: boolean }) => string;
  isEditableInputType: (type: string) => boolean;
  nextState: (
    state: { mode: string; shift: boolean; caps: boolean },
    command: { kind: string },
  ) => { mode: string; shift: boolean; caps: boolean };
};

function loadKeyboardApi(): KeyboardTestApi {
  const source = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
  const context: { __pipzoKeyboardTestApi?: KeyboardTestApi; globalThis?: unknown } = {};
  runInNewContext(source, context);
  if (!context.__pipzoKeyboardTestApi) {
    throw new Error("keyboard test API was not exposed");
  }
  return context.__pipzoKeyboardTestApi;
}

describe("Chromium extension keyboard", () => {
  it("applies text, space, backspace, and clear commands around the focused input selection", () => {
    const keyboard = loadKeyboardApi();
    const state = { mode: "letters", shift: true, caps: false };

    expect(keyboard.applyCommandValue("pzo", 1, 1, { kind: "text", value: "i" }, state)).toEqual({ value: "pIzo", caret: 2 });
    expect(keyboard.applyCommandValue("Pi", 2, 2, { kind: "space" }, state)).toEqual({ value: "Pi ", caret: 3 });
    expect(keyboard.applyCommandValue("secret", 2, 5, { kind: "backspace" }, state)).toEqual({ value: "set", caret: 2 });
    expect(keyboard.applyCommandValue("secret", 3, 3, { kind: "clear" }, state)).toEqual({ value: "", caret: 0 });
  });

  it("models shift, caps, symbols mode, and allowed input types without host-specific selectors", () => {
    const keyboard = loadKeyboardApi();

    expect(keyboard.displayKey("a", { mode: "letters", shift: true, caps: false })).toBe("A");
    expect(keyboard.displayKey("a", { mode: "letters", shift: false, caps: true })).toBe("A");
    expect(keyboard.displayKey("!", { mode: "symbols", shift: true, caps: true })).toBe("!");
    expect(keyboard.nextState({ mode: "letters", shift: true, caps: false }, { kind: "text" })).toEqual({
      mode: "letters",
      shift: false,
      caps: false,
    });
    expect(keyboard.nextState({ mode: "letters", shift: false, caps: false }, { kind: "mode" })).toEqual({
      mode: "symbols",
      shift: false,
      caps: false,
    });
    expect(["text", "password", "email", "search"].every((type) => keyboard.isEditableInputType(type))).toBe(true);
    expect(keyboard.isEditableInputType("checkbox")).toBe(false);
    expect(keyboard.isEditableInputType("number")).toBe(false);
  });
});
