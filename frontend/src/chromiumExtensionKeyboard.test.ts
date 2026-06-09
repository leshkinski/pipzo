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
  commandTarget: (documentRef: { activeElement?: unknown } | null) => unknown | null;
  commandFromButton: (button: FakeButton) => { kind: string; value?: string } | null;
  dismissTargetFromEvent: (event: { target?: unknown; composedPath?: () => unknown[] }) => unknown | null;
  displayKey: (key: string, state: { mode: string; shift: boolean; caps: boolean }) => string;
  editableTargetFromEvent: (event: { target?: unknown; composedPath?: () => unknown[] }) => unknown | null;
  handleKeyboardActivation: (event: FakeDomEvent) => boolean;
  handlePageActivation: (documentRef: Record<string, unknown>, event: FakeDomEvent) => boolean;
  hideIfTargetLeftPage: (documentRef: unknown) => void;
  focusNextOtpTarget: (element: unknown) => unknown | null;
  isConnectedTarget: (element: unknown) => boolean;
  isEditableTarget: (element: unknown) => boolean;
  isEditableInputType: (type: string) => boolean;
  isOtpLikeTarget: (element: unknown) => boolean;
  isSpotifySixDigitChallengePage: (documentRef: unknown) => boolean;
  isPipzoAppPage: () => boolean;
  isSpotifyAuthPage: () => boolean;
  isSpotifyAccountsPage: () => boolean;
  keyboardModeForTarget: (element: unknown) => "letters" | "numeric";
  nextState: (
    state: { mode: string; shift: boolean; caps: boolean },
    command: { kind: string },
  ) => { mode: string; shift: boolean; caps: boolean };
  rowLabels: (state: { mode: string; shift: boolean; caps: boolean }) => string[][];
  setTargetValue: (target: FakeInput, command: { kind: string; value?: string }) => void;
  spotifyChallengeTarget: (documentRef: unknown) => unknown | null;
  spotifyFallbackTarget: (documentRef: unknown) => unknown | null;
  sendExtensionDiagnostic: (documentRef: unknown) => void;
};

type SessionResetTestApi = {
  KEYBOARD_ORIGIN_PATTERNS: string[];
  SPOTIFY_BROWSING_ORIGINS: string[];
  SPOTIFY_COOKIE_DOMAIN: string;
  TRUSTED_APP_ORIGINS: Set<string>;
  cookieUrl: (cookie: { domain?: string; path?: string; secure?: boolean }) => string;
  senderIsTrustedApp: (sender: { url?: string }) => boolean;
  urlIsKeyboardOrigin: (url: string) => boolean;
  originClass: (url: string) => string;
  redactedPath: (url: string) => string;
};

class FakeInput {
  autocomplete = "";
  disabled = false;
  events: Array<{ type: string; data?: string | null; inputType?: string; key?: string }> = [];
  inputMode = "";
  isConnected = true;
  maxLength = -1;
  name = "";
  nativeSetterCalls = 0;
  ownerDocument: { querySelectorAll: (selector: string) => FakeInput[] } | null = null;
  pattern = "";
  readOnly = false;
  selectionEnd: number | null = null;
  selectionStart: number | null = null;
  type = "text";
  value = "";
  nextElementSibling: FakeInput | null = null;

  focusCalls = 0;

  focus(): void {
    this.focusCalls += 1;
  }

  dispatchEvent(event: { type: string; data?: string | null; inputType?: string; key?: string }): boolean {
    this.events.push({
      type: event.type,
      data: event.data,
      inputType: event.inputType,
      key: event.key,
    });
    return true;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    return;
  }
}

class FakeTextArea {
  disabled = false;
  isConnected = true;
  readOnly = false;
}

class FakeButton {
  disabled = false;
  dataset: Record<string, string> = {};
  parent: FakeButton | null = null;
  textContent = "";

  closest(selector: string): FakeButton | null {
    if (selector !== "[data-pipzo-dismiss-keyboard='true']") return null;
    if (this.dataset.pipzoDismissKeyboard === "true") return this;
    return this.parent?.closest(selector) ?? null;
  }
}

class FakeEvent {
  type: string;
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
  data?: string | null;
  inputType?: string;
  key?: string;
  code?: string;
  keyCode?: number;
  which?: number;

  constructor(type: string, options: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, options);
  }
}

class FakeDomEvent {
  button?: number;
  defaultPrevented = false;
  immediatePropagationStopped = false;
  propagationStopped = false;
  target: unknown;
  type: string;
  private path: unknown[];

  constructor(type: string, target: unknown, path: unknown[] = [target], button?: number) {
    this.type = type;
    this.target = target;
    this.path = path;
    this.button = button;
  }

  composedPath(): unknown[] {
    return this.path;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
  }
}

function loadKeyboardApi(
  location?: { protocol: string; host: string; pathname?: string },
  documentRef?: Record<string, unknown>,
): KeyboardTestApi {
  const source = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
  const context: {
    HTMLInputElement: typeof FakeInput;
    HTMLButtonElement: typeof FakeButton;
    HTMLTextAreaElement: typeof FakeTextArea;
    Event: typeof FakeEvent;
    InputEvent: typeof FakeEvent;
    KeyboardEvent: typeof FakeEvent;
    CompositionEvent: typeof FakeEvent;
    __pipzoKeyboardTestApi?: KeyboardTestApi;
    document?: Record<string, unknown>;
    location?: { protocol: string; host: string; pathname?: string };
    performance: { now: () => number };
    PointerEvent?: unknown;
    setTimeout: () => number;
    globalThis?: unknown;
  } = {
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    CompositionEvent: FakeEvent,
    document: documentRef,
    location,
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
  };
  runInNewContext(source, context);
  if (!context.__pipzoKeyboardTestApi) {
    throw new Error("keyboard test API was not exposed");
  }
  return context.__pipzoKeyboardTestApi;
}

function loadSessionResetApi(): SessionResetTestApi {
  const source = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-session-reset.js", "utf8");
  const context: {
    URL: typeof URL;
    __pipzoSessionResetTestApi?: SessionResetTestApi;
    chrome: { runtime: Record<string, unknown> };
    globalThis?: unknown;
  } = {
    URL,
    chrome: { runtime: {} },
  };
  runInNewContext(source, context);
  if (!context.__pipzoSessionResetTestApi) {
    throw new Error("session reset test API was not exposed");
  }
  return context.__pipzoSessionResetTestApi;
}

function fakeLoadingDocument(activeElement: unknown): Record<string, unknown> {
  return {
    activeElement,
    addEventListener: () => undefined,
    getElementById: () => null,
    readyState: "loading",
  };
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
    expect(keyboard.displayKey("1", { mode: "letters", shift: true, caps: false })).toBe("!");
    expect(keyboard.displayKey("2", { mode: "letters", shift: true, caps: false })).toBe("@");
    expect(keyboard.displayKey("0", { mode: "letters", shift: true, caps: false })).toBe(")");
    expect(keyboard.displayKey("1", { mode: "letters", shift: false, caps: true })).toBe("1");
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
    expect(["text", "password", "email", "search", "number", "tel"].every((type) => keyboard.isEditableInputType(type))).toBe(true);
    expect(keyboard.isEditableInputType("checkbox")).toBe(false);
  });

  it("recognizes Spotify one-time-code and numeric verification fields", () => {
    const keyboard = loadKeyboardApi();
    const oneTimeCode = new FakeInput();
    oneTimeCode.autocomplete = "one-time-code";

    const inputModeNumeric = new FakeInput();
    inputModeNumeric.inputMode = "numeric";

    const telField = new FakeInput();
    telField.type = "tel";

    const numberField = new FakeInput();
    numberField.type = "number";

    const oneDigitField = new FakeInput();
    oneDigitField.inputMode = "numeric";
    oneDigitField.maxLength = 1;
    oneDigitField.name = "otp-0";

    expect(keyboard.isEditableTarget(oneTimeCode)).toBe(true);
    expect(keyboard.keyboardModeForTarget(oneTimeCode)).toBe("numeric");
    expect(keyboard.keyboardModeForTarget(inputModeNumeric)).toBe("numeric");
    expect(keyboard.keyboardModeForTarget(telField)).toBe("numeric");
    expect(keyboard.keyboardModeForTarget(numberField)).toBe("numeric");
    expect(keyboard.isOtpLikeTarget(oneDigitField)).toBe(true);
    expect(keyboard.isOtpLikeTarget(telField)).toBe(false);
  });

  it("lays out ergonomic letter rows with inline shift, backspace, and symbols near clear", () => {
    const keyboard = loadKeyboardApi();
    const rows = keyboard.rowLabels({ mode: "letters", shift: false, caps: false });

    expect(rows).toEqual([
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["Shift", "a", "s", "d", "f", "g", "h", "j", "k", "l", "Backspace"],
      ["z", "x", "c", "v", "b", "n", "m"],
      ["Clear", "Symbols", "Space", "Done"],
    ]);
  });

  it("uses a compact numeric keypad for code-entry fields", () => {
    const keyboard = loadKeyboardApi();
    const rows = keyboard.rowLabels({ mode: "numeric", shift: false, caps: false });

    expect(rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["7", "8", "9"],
      ["Clear", "0", "Backspace", "Done"],
    ]);
    expect(keyboard.nextState({ mode: "numeric", shift: false, caps: false }, { kind: "mode" })).toEqual({
      mode: "numeric",
      shift: false,
      caps: false,
    });
  });

  it("can advance across Spotify-style one-character OTP inputs", () => {
    const keyboard = loadKeyboardApi();
    const first = new FakeInput();
    const second = new FakeInput();
    first.inputMode = "numeric";
    first.maxLength = 1;
    first.name = "otp-0";
    second.inputMode = "numeric";
    second.maxLength = 1;
    second.name = "otp-1";
    first.nextElementSibling = second;

    expect(keyboard.focusNextOtpTarget(first)).toBe(second);
    expect(second.focusCalls).toBe(1);
    second.value = "7";
    expect(keyboard.focusNextOtpTarget(first)).toBeNull();
  });

  it("dispatches browser-like input events and advances after a Spotify OTP digit press", () => {
    const keyboard = loadKeyboardApi();
    const first = new FakeInput();
    const second = new FakeInput();
    first.inputMode = "numeric";
    first.maxLength = 1;
    first.name = "otp-0";
    second.inputMode = "numeric";
    second.maxLength = 1;
    second.name = "otp-1";
    first.ownerDocument = { querySelectorAll: (selector: string) => (selector === "input" || selector === "*" ? [first, second] : []) };

    keyboard.setTargetValue(first, { kind: "text", value: "4" });

    expect(first.value).toBe("4");
    expect(first.selectionStart).toBe(1);
    expect(first.selectionEnd).toBe(1);
    expect(second.focusCalls).toBe(1);
    expect(first.events.map((event) => event.type)).toEqual([
      "keydown",
      "beforeinput",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "input",
      "change",
      "keyup",
    ]);
    expect(first.events.find((event) => event.type === "keydown")).toMatchObject({ key: "4" });
    expect(first.events.find((event) => event.type === "beforeinput")).toMatchObject({
      data: "4",
      inputType: "insertText",
    });
    expect(first.events.find((event) => event.type === "input")).toMatchObject({
      data: "4",
      inputType: "insertText",
    });
  });

  it("runs keyboard commands from pointer, touch, and click activation paths", () => {
    (["pointerdown", "touchstart", "click"] as const).forEach((eventType) => {
      const input = new FakeInput();
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.name = "code-0";
      const documentRef = fakeLoadingDocument(input);
      const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" }, documentRef);
      const button = new FakeButton();
      button.textContent = "7";
      button.dataset.pipzoKeyboardCommandKind = "text";
      button.dataset.pipzoKeyboardCommandValue = "7";
      const event = new FakeDomEvent(eventType, button, [button], 0);

      expect(keyboard.handleKeyboardActivation(event)).toBe(true);

      expect(input.value).toBe("7");
      expect(input.events.map((record) => record.type)).toContain("input");
      expect(event.defaultPrevented).toBe(true);
      expect(event.propagationStopped).toBe(true);
      expect(event.immediatePropagationStopped).toBe(true);
    });
  });

  it("deduplicates fallback click after pointerdown without losing the first OTP digit", () => {
    let now = 1000;
    const input = new FakeInput();
    input.inputMode = "numeric";
    input.maxLength = 1;
    input.name = "code-0";
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" }, fakeLoadingDocument(input));
    const button = new FakeButton();
    button.textContent = "8";
    button.dataset.pipzoKeyboardCommandKind = "text";
    button.dataset.pipzoKeyboardCommandValue = "8";
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      expect(keyboard.handleKeyboardActivation(new FakeDomEvent("pointerdown", button, [button], 0))).toBe(true);
      now += 80;
      expect(keyboard.handleKeyboardActivation(new FakeDomEvent("click", button, [button], 0))).toBe(true);
    } finally {
      Date.now = originalNow;
    }

    expect(input.value).toBe("8");
    expect(input.events.filter((record) => record.type === "input")).toHaveLength(1);
  });

  it("does not suppress a second real tap on the same key", () => {
    let now = 2000;
    const input = new FakeInput();
    input.type = "text";
    input.selectionStart = 0;
    input.selectionEnd = 0;
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" }, fakeLoadingDocument(input));
    const button = new FakeButton();
    button.textContent = "9";
    button.dataset.pipzoKeyboardCommandKind = "text";
    button.dataset.pipzoKeyboardCommandValue = "9";
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      expect(keyboard.handleKeyboardActivation(new FakeDomEvent("pointerdown", button, [button], 0))).toBe(true);
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      now += 120;
      expect(keyboard.handleKeyboardActivation(new FakeDomEvent("pointerdown", button, [button], 0))).toBe(true);
    } finally {
      Date.now = originalNow;
    }

    expect(input.value).toBe("99");
    expect(input.events.filter((record) => record.type === "input")).toHaveLength(2);
  });

  it("uses the native input value setter so React-controlled OTP fields observe the change", () => {
    const keyboard = loadKeyboardApi();
    const originalValueDescriptor = Object.getOwnPropertyDescriptor(FakeInput.prototype, "value");
    Object.defineProperty(FakeInput.prototype, "value", {
      configurable: true,
      get(this: FakeInput) {
        return "";
      },
      set(this: FakeInput, value: string) {
        this.nativeSetterCalls += 1;
        Object.defineProperty(this, "value", {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
    });
    try {
      const input = new FakeInput();
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.name = "code-0";
      input.value = "1";

      keyboard.setTargetValue(input, { kind: "text", value: "5" });

      expect(input.nativeSetterCalls).toBe(1);
      expect(input.value).toBe("5");
      expect(input.events.find((event) => event.type === "input")).toMatchObject({
        data: "5",
        inputType: "insertText",
      });
    } finally {
      if (originalValueDescriptor) {
        Object.defineProperty(FakeInput.prototype, "value", originalValueDescriptor);
      } else {
        delete (FakeInput.prototype as { value?: string }).value;
      }
    }
  });

  it("recognizes the live Spotify six-digit challenge page and binds to the active code input", () => {
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" });
    const inputs = Array.from({ length: 6 }, (_, index) => {
      const input = new FakeInput();
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.name = `code-${index}`;
      return input;
    });
    const documentRef = {
      activeElement: inputs[0],
      body: { innerText: "Enter the 6-digit code sent to you" },
      querySelectorAll: (selector: string) => (selector === "input" ? inputs : inputs),
    };

    expect(keyboard.isSpotifyAccountsPage()).toBe(true);
    expect(keyboard.isSpotifySixDigitChallengePage(documentRef)).toBe(true);
    expect(keyboard.spotifyChallengeTarget(documentRef)).toBe(inputs[0]);
    expect(keyboard.keyboardModeForTarget(keyboard.spotifyChallengeTarget(documentRef))).toBe("numeric");
  });

  it("recognizes segmented Spotify code controls without relying on exact page copy", () => {
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" });
    const inputs = Array.from({ length: 6 }, (_, index) => {
      const input = new FakeInput();
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.name = `digit-${index}`;
      return input;
    });
    const documentRef = {
      activeElement: inputs[0],
      body: { innerText: "Check your email" },
      querySelectorAll: (selector: string) => (selector === "input" ? inputs : inputs),
    };

    expect(keyboard.isSpotifySixDigitChallengePage(documentRef)).toBe(true);
    expect(keyboard.spotifyChallengeTarget(documentRef)).toBe(inputs[0]);
  });

  it("falls back to active or first editable Spotify account fields without code-page assumptions", () => {
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" });
    const filled = new FakeInput();
    filled.type = "email";
    filled.value = "user@example.test";
    const empty = new FakeInput();
    empty.type = "text";
    const password = new FakeInput();
    password.type = "password";
    const documentRef = {
      activeElement: password,
      body: { innerText: "Log in to Spotify" },
      querySelectorAll: (selector: string) => (selector === "input,textarea" ? [filled, empty, password] : []),
    };

    expect(keyboard.isSpotifyAccountsPage()).toBe(true);
    expect(keyboard.spotifyFallbackTarget(documentRef)).toBe(password);

    const noActiveDocumentRef = { ...documentRef, activeElement: {} };
    expect(keyboard.spotifyFallbackTarget(noActiveDocumentRef)).toBe(empty);
  });

  it("finds Spotify OTP inputs inside open shadow roots", () => {
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" });
    const shadowedCodeInput = new FakeInput();
    shadowedCodeInput.inputMode = "numeric";
    shadowedCodeInput.maxLength = 1;
    shadowedCodeInput.name = "code-0";
    const host = {
      shadowRoot: {
        querySelectorAll: (selector: string) => (selector === "input" ? [shadowedCodeInput] : []),
      },
    };
    const documentRef = {
      activeElement: {},
      body: { innerText: "Enter the 6 digit code sent to you" },
      querySelectorAll: (selector: string) => (selector === "*" ? [host] : []),
    };

    expect(keyboard.spotifyChallengeTarget(documentRef)).toBe(shadowedCodeInput);
  });

  it("recognizes related-frame code challenges from their OTP shape", () => {
    const keyboard = loadKeyboardApi({ protocol: "about:", host: "" });
    const inputs = Array.from({ length: 6 }, (_, index) => {
      const input = new FakeInput();
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.name = `verification-${index}`;
      return input;
    });
    const documentRef = {
      activeElement: inputs[2],
      body: { innerText: "Enter the verification code" },
      querySelectorAll: (selector: string) => (selector === "input" ? inputs : inputs),
    };

    expect(keyboard.isSpotifyAccountsPage()).toBe(false);
    expect(keyboard.isSpotifySixDigitChallengePage(documentRef)).toBe(true);
    expect(keyboard.spotifyChallengeTarget(documentRef)).toBe(inputs[2]);
  });

  it("falls back to the first empty OTP input when a visual Spotify code box receives focus", () => {
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com" });
    const visualBoxes = Array.from({ length: 6 }, () => new FakeButton());
    const filled = new FakeInput();
    filled.inputMode = "numeric";
    filled.maxLength = 1;
    filled.name = "code-0";
    filled.value = "1";
    const empty = new FakeInput();
    empty.inputMode = "numeric";
    empty.maxLength = 1;
    empty.name = "code-1";
    const documentRef = {
      activeElement: visualBoxes[0],
      body: { innerText: "Enter the 6 digit code sent to you" },
      querySelectorAll: (selector: string) => (selector === "input" ? [filled, empty] : [...visualBoxes, filled, empty]),
    };

    expect(keyboard.isSpotifySixDigitChallengePage(documentRef)).toBe(true);
    expect(keyboard.spotifyChallengeTarget(documentRef)).toBe(empty);
  });

  it("labels locked shift as CAPS in the letter layout", () => {
    const keyboard = loadKeyboardApi();
    const rows = keyboard.rowLabels({ mode: "letters", shift: false, caps: true });

    expect(rows[2][0]).toBe("CAPS");
    expect(rows[2].slice(1, 10)).toEqual(["A", "S", "D", "F", "G", "H", "J", "K", "L"]);
    expect(rows[0]).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  });

  it("shows common symbols on the number row while temporary Shift is active", () => {
    const keyboard = loadKeyboardApi();
    const rows = keyboard.rowLabels({ mode: "letters", shift: true, caps: false });

    expect(rows[0]).toEqual(["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"]);
    expect(
      keyboard.applyCommandValue("pin", 3, 3, { kind: "text", value: "1" }, { mode: "letters", shift: true, caps: false }),
    ).toEqual({ value: "pin!", caret: 4 });
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

  it("does not auto-open or intercept the keyboard for non-editable Spotify consent controls", () => {
    const consentButton = new FakeButton();
    consentButton.textContent = "Agree";
    const keyboardRoot = { hidden: false };
    const documentRef = {
      activeElement: consentButton,
      addEventListener: () => undefined,
      body: { innerText: "Enter the 6-digit code sent to you" },
      documentElement: { dataset: {}, style: { setProperty: () => undefined } },
      getElementById: (id: string) => (id === "pipzo-extension-keyboard" ? keyboardRoot : null),
      querySelectorAll: (selector: string) => (selector === "input" ? [] : []),
      readyState: "loading",
    };
    const keyboard = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com", pathname: "/authorize" }, documentRef);
    const event = new FakeDomEvent("pointerdown", consentButton, [consentButton], 0);

    expect(keyboard.handlePageActivation(documentRef, event)).toBe(false);

    expect(keyboardRoot.hidden).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
    expect(event.immediatePropagationStopped).toBe(false);
  });

  it("keeps Spotify challenge auto-open out of non-editable pointer and focus handlers", () => {
    const script = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");

    expect(script).toContain("function handlePageActivation(documentRef, event)");
    expect(script).toContain("else if (isSpotifyAuthPage()) hideKeyboard();");
    expect(script).not.toContain("if (showSpotifyChallengeKeyboard(documentRef)) return;");
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

  it("keeps the extension keyboard hit targets large for the 1280x720 touchscreen", () => {
    const stylesheet = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.css", "utf8");

    expect(stylesheet).toContain("min-height: 48px");
    expect(stylesheet).toContain("max-height: 44vh");
  });

  it("keeps the keyboard persistent until explicit Done or page navigation", () => {
    const script = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
    const source = readFileSync("src/App.tsx", "utf8");

    expect(script).not.toContain('documentRef.addEventListener("focusout"');
    expect(script).toContain('if (command.kind === "done")');
    expect(script).not.toContain('command.kind === "cancel"');
    expect(script).toContain('addEventListener("pagehide", hideKeyboard)');
    expect(script).toContain('addEventListener("popstate", hideKeyboard)');
    expect(script).toContain('addEventListener("hashchange", hideKeyboard)');
    expect(script).toContain('["pushState", "replaceState"]');
    expect(script).toContain("MutationObserver");
    expect(script).toContain("hideIfTargetLeftPage");
    expect(script).toContain("STALE_TARGET_CHECK_DELAY_MS");
    expect(script).toContain("dismissTargetFromEvent");
    expect(source).toContain('data-pipzo-dismiss-keyboard="true"');
  });

  it("treats explicit page-navigation controls as immediate keyboard dismissal targets", () => {
    const keyboard = loadKeyboardApi();
    const backButton = new FakeButton();
    backButton.dataset.pipzoDismissKeyboard = "true";
    const label = new FakeButton();
    label.parent = backButton;
    const normalButton = new FakeButton();

    expect(keyboard.dismissTargetFromEvent({ target: backButton })).toBe(backButton);
    expect(keyboard.dismissTargetFromEvent({ composedPath: () => [label], target: label })).toBe(backButton);
    expect(keyboard.dismissTargetFromEvent({ target: normalButton })).toBeNull();
  });

  it("can rebind typing to the active editable field after a React input re-render", () => {
    const keyboard = loadKeyboardApi();
    const replacementField = new FakeInput();

    expect(keyboard.commandTarget({ activeElement: replacementField })).toBe(replacementField);
    replacementField.isConnected = false;
    expect(keyboard.commandTarget({ activeElement: replacementField })).toBeNull();
  });

  it("keeps Wi-Fi password reveal local and uses an icon-only eye state", () => {
    const source = readFileSync("src/App.tsx", "utf8");
    const stylesheet = readFileSync("src/styles.css", "utf8");

    expect(source).toContain("wifiPasswordVisible");
    expect(source).toContain('aria-label={controls.passwordVisible ? "Hide Wi-Fi password" : "Show Wi-Fi password"}');
    expect(source).toContain("aria-pressed={controls.passwordVisible}");
    expect(source).toContain('title={controls.passwordVisible ? "Hide Wi-Fi password" : "Show Wi-Fi password"}');
    expect(source).toContain('type={controls.passwordVisible ? "text" : "password"}');
    expect(source).toContain('className={controls.passwordVisible ? "wifi-password-eye is-visible" : "wifi-password-eye"}');
    expect(source).not.toContain('{controls.passwordVisible ? "Hide" : "Show"}');
    expect(stylesheet).toContain(".wifi-password-eye");
    expect(stylesheet).toContain(".wifi-password-eye.is-visible::after");
    expect(source).toContain("onTogglePasswordVisibility");
  });

  it("installs Spotify-only scroll controls for external authorization pages", () => {
    const keyboard = loadKeyboardApi();
    const script = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
    const stylesheet = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.css", "utf8");

    expect(keyboard.isSpotifyAccountsPage()).toBe(false);
    expect(script).toContain("SPOTIFY_SCROLL_ROOT_ID");
    expect(script).toContain("SPOTIFY_ACCOUNT_LAUNCHER_ID");
    expect(script).toContain("SPOTIFY_RECOVERY_ROOT_ID");
    expect(script).toContain("PIPZO_SPOTIFY_SETTINGS_URL");
    expect(script).toContain('host === "accounts.spotify.com"');
    expect(script).toContain("isSpotifyAuthPage");
    expect(script).toContain("scrollSpotifyPage");
    expect(script).toContain("ensureSpotifyAccountLauncher");
    expect(script).toContain("ensureSpotifyRecoveryControls");
    expect(script).toContain("showSpotifyAccountKeyboard");
    expect(script).toContain("spotifyFallbackTarget");
    expect(stylesheet).toContain("#pipzo-spotify-scroll-controls");
    expect(stylesheet).toContain("#pipzo-spotify-account-keyboard-launcher");
    expect(stylesheet).toContain("#pipzo-spotify-auth-recovery");
  });

  it("recognizes Spotify auth-like subdomain pages without enabling general open.spotify overlays", () => {
    const accounts = loadKeyboardApi({ protocol: "https:", host: "accounts.spotify.com", pathname: "/login" });
    const login = loadKeyboardApi({ protocol: "https:", host: "www.spotify.com", pathname: "/login" });
    const open = loadKeyboardApi({ protocol: "https:", host: "open.spotify.com", pathname: "/playlist/abc" });

    expect(accounts.isSpotifyAuthPage()).toBe(true);
    expect(login.isSpotifyAuthPage()).toBe(true);
    expect(open.isSpotifyAuthPage()).toBe(false);
  });

  it("declares a minimal Spotify session reset extension surface", () => {
    const manifest = readFileSync("../provisioning/chromium-extension/virtual-keyboard/manifest.json", "utf8");
    const bridge = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
    const resetWorker = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-session-reset.js", "utf8");
    const app = readFileSync("src/App.tsx", "utf8");

    expect(manifest).toContain('"permissions": ["browsingData", "cookies", "scripting"]');
    expect(manifest).toContain('"host_permissions"');
    expect(manifest).toContain('"http://127.0.0.1:8000/*"');
    expect(manifest).toContain('"http://localhost:8000/*"');
    expect(manifest).toContain('"https://*.spotify.com/*"');
    expect(manifest).toContain('"service_worker": "pipzo-session-reset.js"');
    expect(manifest).toContain('"version": "0.1.7"');
    expect(manifest).toContain('"match_about_blank": true');
    expect(manifest).toContain('"match_origin_as_fallback": true');
    expect(bridge).toContain("pipzo:spotify-session-reset-request");
    expect(bridge).toContain("pipzo:spotify-session-reset-response");
    expect(bridge).toContain("isPipzoAppPage");
    expect(resetWorker).toContain("SPOTIFY_COOKIE_DOMAIN");
    expect(resetWorker).toContain('"spotify.com"');
    expect(resetWorker).toContain("senderIsTrustedApp");
    expect(resetWorker).toContain("chrome.cookies.getAll");
    expect(resetWorker).toContain("chrome.browsingData.remove");
    expect(resetWorker).toContain("executeScript({ target, files: [KEYBOARD_SCRIPT_FILE] }");
    expect(resetWorker).toContain("DIAGNOSTIC_ENDPOINT");
    expect(resetWorker).toContain("http://127.0.0.1:8000/api/v1/diagnostics/extension");
    expect(resetWorker).toContain("originClass");
    expect(resetWorker).toContain("redactedPath");
    expect(bridge).toContain("DIAGNOSTIC_MESSAGE_TYPE");
    expect(bridge).toContain("sendExtensionDiagnostic");
    expect(bridge).toContain("recoveryControlsPresent");
    expect(resetWorker).toContain("chrome.tabs.onUpdated");
    expect(app).toContain("requestSpotifyBrowserSessionReset");
    expect(app).toContain("resetSpotifyBrowserSessionForSwitch");
    expect(app).toContain("resetSpotifyBrowserSession");
    expect(app).toContain("confirm: true");
    expect(app).toContain("Pipzo will not start account switching until the browser session is cleared.");
    expect(app).toContain("Pipzo will reopen with a fresh browser session.");
  });

  it("limits Spotify browser session clearing to local Pipzo app senders and Spotify-owned data", () => {
    const reset = loadSessionResetApi();

    expect(reset.SPOTIFY_COOKIE_DOMAIN).toBe("spotify.com");
    expect(reset.SPOTIFY_BROWSING_ORIGINS).toEqual([
      "https://accounts.spotify.com",
      "https://open.spotify.com",
      "https://www.spotify.com",
      "https://spotify.com",
    ]);
    expect(reset.TRUSTED_APP_ORIGINS.has("http://127.0.0.1:8000")).toBe(true);
    expect(reset.TRUSTED_APP_ORIGINS.has("http://localhost:8000")).toBe(true);
    expect(reset.senderIsTrustedApp({ url: "http://127.0.0.1:8000/settings/spotify" })).toBe(true);
    expect(reset.senderIsTrustedApp({ url: "http://localhost:8000/" })).toBe(true);
    expect(reset.senderIsTrustedApp({ url: "https://accounts.spotify.com/authorize" })).toBe(false);
    expect(reset.senderIsTrustedApp({ url: "http://evil.example/" })).toBe(false);
    expect(reset.cookieUrl({ domain: ".spotify.com", path: "/", secure: true })).toBe("https://spotify.com/");
    expect(reset.cookieUrl({ domain: "accounts.spotify.com", path: "/login", secure: true })).toBe("https://accounts.spotify.com/login");
  });

  it("limits dynamic keyboard injection to the existing local app and Spotify origins", () => {
    const reset = loadSessionResetApi();

    expect(reset.KEYBOARD_ORIGIN_PATTERNS).toEqual([
      "http://127.0.0.1:8000/*",
      "http://localhost:8000/*",
      "https://*.spotify.com/*",
    ]);
    expect(reset.urlIsKeyboardOrigin("http://127.0.0.1:8000/settings/spotify")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("http://localhost:8000/")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("https://accounts.spotify.com/login")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("https://open.spotify.com/")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("https://example.test/")).toBe(false);
    expect(reset.originClass("http://127.0.0.1:8000/settings/spotify?code=secret")).toBe("local_pipzo");
    expect(reset.originClass("https://accounts.spotify.com/login?continue=secret")).toBe("spotify_accounts");
    expect(reset.originClass("https://open.spotify.com/")).toBe("other_spotify");
    expect(reset.redactedPath("https://accounts.spotify.com/login?continue=secret#frag")).toBe("/login");
  });
});
