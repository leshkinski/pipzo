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
  dismissTargetFromEvent: (event: { target?: unknown; composedPath?: () => unknown[] }) => unknown | null;
  displayKey: (key: string, state: { mode: string; shift: boolean; caps: boolean }) => string;
  editableTargetFromEvent: (event: { target?: unknown; composedPath?: () => unknown[] }) => unknown | null;
  hideIfTargetLeftPage: (documentRef: unknown) => void;
  focusNextOtpTarget: (element: unknown) => unknown | null;
  isConnectedTarget: (element: unknown) => boolean;
  isEditableTarget: (element: unknown) => boolean;
  isEditableInputType: (type: string) => boolean;
  isOtpLikeTarget: (element: unknown) => boolean;
  isSpotifySixDigitChallengePage: (documentRef: unknown) => boolean;
  isPipzoAppPage: () => boolean;
  isSpotifyAccountsPage: () => boolean;
  keyboardModeForTarget: (element: unknown) => "letters" | "numeric";
  nextState: (
    state: { mode: string; shift: boolean; caps: boolean },
    command: { kind: string },
  ) => { mode: string; shift: boolean; caps: boolean };
  rowLabels: (state: { mode: string; shift: boolean; caps: boolean }) => string[][];
  spotifyChallengeTarget: (documentRef: unknown) => unknown | null;
};

type SessionResetTestApi = {
  KEYBOARD_ORIGIN_PATTERNS: string[];
  SPOTIFY_BROWSING_ORIGINS: string[];
  SPOTIFY_COOKIE_DOMAIN: string;
  TRUSTED_APP_ORIGINS: Set<string>;
  cookieUrl: (cookie: { domain?: string; path?: string; secure?: boolean }) => string;
  senderIsTrustedApp: (sender: { url?: string }) => boolean;
  urlIsKeyboardOrigin: (url: string) => boolean;
};

class FakeInput {
  autocomplete = "";
  disabled = false;
  inputMode = "";
  isConnected = true;
  maxLength = -1;
  name = "";
  pattern = "";
  readOnly = false;
  type = "text";
  value = "";
  nextElementSibling: FakeInput | null = null;

  focusCalls = 0;

  focus(): void {
    this.focusCalls += 1;
  }

  dispatchEvent(): boolean {
    return true;
  }

  setSelectionRange(): void {
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

  closest(selector: string): FakeButton | null {
    if (selector !== "[data-pipzo-dismiss-keyboard='true']") return null;
    if (this.dataset.pipzoDismissKeyboard === "true") return this;
    return this.parent?.closest(selector) ?? null;
  }
}

function loadKeyboardApi(location?: { protocol: string; host: string }): KeyboardTestApi {
  const source = readFileSync("../provisioning/chromium-extension/virtual-keyboard/pipzo-keyboard.js", "utf8");
  const context: {
    HTMLInputElement: typeof FakeInput;
    HTMLButtonElement: typeof FakeButton;
    HTMLTextAreaElement: typeof FakeTextArea;
    __pipzoKeyboardTestApi?: KeyboardTestApi;
    location?: { protocol: string; host: string };
    globalThis?: unknown;
  } = {
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton,
    HTMLTextAreaElement: FakeTextArea,
    location,
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
    expect(script).toContain("SPOTIFY_CODE_LAUNCHER_ID");
    expect(script).toContain('host === "accounts.spotify.com"');
    expect(script).toContain("scrollSpotifyPage");
    expect(script).toContain("ensureSpotifyCodeLauncher");
    expect(stylesheet).toContain("#pipzo-spotify-scroll-controls");
    expect(stylesheet).toContain("#pipzo-spotify-code-launcher");
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

  it("limits dynamic keyboard injection to the existing local app and Spotify account origins", () => {
    const reset = loadSessionResetApi();

    expect(reset.KEYBOARD_ORIGIN_PATTERNS).toEqual([
      "http://127.0.0.1:8000/*",
      "http://localhost:8000/*",
      "https://accounts.spotify.com/*",
    ]);
    expect(reset.urlIsKeyboardOrigin("http://127.0.0.1:8000/settings/spotify")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("http://localhost:8000/")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("https://accounts.spotify.com/login")).toBe(true);
    expect(reset.urlIsKeyboardOrigin("https://open.spotify.com/")).toBe(false);
    expect(reset.urlIsKeyboardOrigin("https://example.test/")).toBe(false);
  });
});
