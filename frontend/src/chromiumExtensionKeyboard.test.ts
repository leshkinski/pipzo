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
  editableTargetFromEvent: (event: { target?: unknown; composedPath?: () => unknown[] }) => unknown | null;
  isEditableTarget: (element: unknown) => boolean;
  isEditableInputType: (type: string) => boolean;
  nextState: (
    state: { mode: string; shift: boolean; caps: boolean },
    command: { kind: string },
  ) => { mode: string; shift: boolean; caps: boolean };
  rowLabels: (state: { mode: string; shift: boolean; caps: boolean }) => string[][];
};

class FakeInput {
  disabled = false;
  readOnly = false;
  type = "text";
}

class FakeTextArea {
  disabled = false;
  readOnly = false;
}

function loadKeyboardApi(): KeyboardTestApi {
  const source = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
  const context: {
    HTMLInputElement: typeof FakeInput;
    HTMLTextAreaElement: typeof FakeTextArea;
    __pipzoKeyboardTestApi?: KeyboardTestApi;
    globalThis?: unknown;
  } = {
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
  };
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
    expect(keyboard.nextState({ mode: "letters", shift: false, caps: false }, { kind: "shift" })).toEqual({
      mode: "letters",
      shift: true,
      caps: false,
    });
    expect(keyboard.nextState({ mode: "letters", shift: true, caps: false }, { kind: "shift" })).toEqual({
      mode: "letters",
      shift: false,
      caps: true,
    });
    expect(keyboard.nextState({ mode: "letters", shift: false, caps: true }, { kind: "shift" })).toEqual({
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

  it("lays out ergonomic letter rows with inline shift, backspace, and symbols near clear", () => {
    const keyboard = loadKeyboardApi();
    const rows = keyboard.rowLabels({ mode: "letters", shift: false, caps: false });

    expect(rows).toEqual([
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["Shift", "a", "s", "d", "f", "g", "h", "j", "k", "l", "Backspace"],
      ["z", "x", "c", "v", "b", "n", "m"],
      ["Clear", "Symbols", "Space", "Cancel", "Done"],
    ]);
  });

  it("labels locked shift as CAPS in the letter layout", () => {
    const keyboard = loadKeyboardApi();
    const rows = keyboard.rowLabels({ mode: "letters", shift: false, caps: true });

    expect(rows[2][0]).toBe("CAPS");
    expect(rows[2].slice(1, 10)).toEqual(["A", "S", "D", "F", "G", "H", "J", "K", "L"]);
  });

  it("recognizes the actual Wi-Fi password field shape from touch/pointer events", () => {
    const keyboard = loadKeyboardApi();
    const passwordField = new FakeInput();
    passwordField.type = "password";

    expect(keyboard.isEditableTarget(passwordField)).toBe(true);
    expect(keyboard.editableTargetFromEvent({ target: passwordField })).toBe(passwordField);
    expect(keyboard.editableTargetFromEvent({ composedPath: () => [{}, passwordField], target: {} })).toBe(passwordField);

    passwordField.disabled = true;
    expect(keyboard.isEditableTarget(passwordField)).toBe(false);
  });

  it("uses data-driven key row columns so every letter row stays horizontal", () => {
    const script = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
    const stylesheet = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.css", "utf8");

    expect(script).toContain('row.style.setProperty("--pipzo-keyboard-columns", String(keys.length))');
    expect(stylesheet).toContain("grid-template-columns: repeat(var(--pipzo-keyboard-columns), minmax(0, 1fr))");
    expect(stylesheet).not.toContain('.pipzo-keyboard-row[data-columns="10"]');
  });

  it("reports its overlay height through the app keyboard inset variable", () => {
    const script = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");

    expect(script).toContain('style.setProperty("--pipzo-keyboard-inset", `${height}px`)');
    expect(script).toContain('style.setProperty("--pipzo-keyboard-inset", "0px")');
  });
});
