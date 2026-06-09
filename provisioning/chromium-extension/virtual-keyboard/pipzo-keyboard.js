(function installPipzoKeyboard(globalScope) {
  "use strict";

  const ROOT_ID = "pipzo-extension-keyboard";
  const SPOTIFY_SCROLL_ROOT_ID = "pipzo-spotify-scroll-controls";
  const SPOTIFY_ACCOUNT_LAUNCHER_ID = "pipzo-spotify-account-keyboard-launcher";
  const SPOTIFY_RECOVERY_ROOT_ID = "pipzo-spotify-auth-recovery";
  const DIAGNOSTIC_MESSAGE_TYPE = "pipzo.extensionDiagnostic";
  const SPOTIFY_SESSION_RESET_REQUEST = "pipzo:spotify-session-reset-request";
  const SPOTIFY_SESSION_RESET_RESPONSE = "pipzo:spotify-session-reset-response";
  const PIPZO_SPOTIFY_SETTINGS_URL = "http://127.0.0.1:8000/settings/spotify";
  const EDITABLE_INPUT_TYPES = new Set(["text", "password", "email", "search", "number", "tel"]);
  const NUMERIC_INPUT_TYPES = new Set(["number", "tel"]);
  const NUMERIC_INPUT_MODES = new Set(["numeric", "decimal", "tel"]);
  const ACTIVE_ELEMENT_CHECK_DELAYS_MS = [0, 150, 500, 1200];
  const STALE_TARGET_CHECK_DELAY_MS = 500;
  const SHIFTED_NUMBER_KEYS = {
    "1": "!",
    "2": "@",
    "3": "#",
    "4": "$",
    "5": "%",
    "6": "^",
    "7": "&",
    "8": "*",
    "9": "(",
    "0": ")",
  };
  const LETTER_ROWS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    [{ label: "Shift", kind: "shift" }, "a", "s", "d", "f", "g", "h", "j", "k", "l", { label: "Backspace", kind: "backspace" }],
    ["z", "x", "c", "v", "b", "n", "m"],
  ];
  const SYMBOL_ROWS = [
    ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"],
    ["-", "_", "=", "+", "[", "]", "{", "}"],
    [";", ":", "'", "\"", ",", ".", "/", "?"],
    ["`", "~", "<", ">", "\\", "|"],
  ];
  const NUMERIC_ROWS = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [
      { label: "Clear", kind: "clear" },
      "0",
      { label: "Backspace", kind: "backspace" },
      { label: "Done", kind: "done", primary: true },
    ],
  ];

  const state = {
    caps: false,
    mode: "letters",
    shift: false,
    target: null,
  };
  let lastKeyboardActivation = { commandKey: "", source: "", time: 0 };

  function isSpotifyAccountsPage() {
    const locationRef = globalScope.location;
    return locationRef?.protocol === "https:" && locationRef?.host === "accounts.spotify.com";
  }

  function isSpotifyAuthPage() {
    const locationRef = globalScope.location;
    if (isSpotifyAccountsPage()) return true;
    if (locationRef?.protocol !== "https:" || !locationRef?.host?.endsWith(".spotify.com")) return false;
    const path = locationRef.pathname || "/";
    return /\/(?:authorize|login|auth|account|oauth|challenge|verification|verify)(?:\/|$)/i.test(path);
  }

  function isPipzoAppPage() {
    const locationRef = globalScope.location;
    if (locationRef?.protocol !== "http:") return false;
    return locationRef.host === "127.0.0.1:8000" || locationRef.host === "localhost:8000";
  }

  function isConnectedTarget(element) {
    return Boolean(element?.isConnected ?? element);
  }

  function isEditableTarget(element) {
    if (!element) return false;
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (!(element instanceof HTMLInputElement)) return false;
    return !element.disabled && !element.readOnly && EDITABLE_INPUT_TYPES.has(element.type || "text");
  }

  function querySelectorAllDeep(root, selector) {
    if (!root?.querySelectorAll) return [];
    const results = Array.from(root.querySelectorAll(selector) || []);
    const descendants = Array.from(root.querySelectorAll("*") || []);
    descendants.forEach((element) => {
      if (!element?.shadowRoot) return;
      results.push(...querySelectorAllDeep(element.shadowRoot, selector));
    });
    return results;
  }

  function normalizedAttr(element, name, propertyName = name) {
    const propertyValue = element?.[propertyName];
    if (typeof propertyValue === "string" && propertyValue) return propertyValue.toLowerCase();
    if (typeof element?.getAttribute === "function") {
      const attrValue = element.getAttribute(name);
      if (typeof attrValue === "string") return attrValue.toLowerCase();
    }
    return "";
  }

  function isNumericTarget(element) {
    if (!(element instanceof HTMLInputElement)) return false;
    if (NUMERIC_INPUT_TYPES.has(element.type || "text")) return true;
    if (NUMERIC_INPUT_MODES.has(normalizedAttr(element, "inputmode", "inputMode"))) return true;
    if (normalizedAttr(element, "autocomplete") === "one-time-code") return true;
    const pattern = normalizedAttr(element, "pattern");
    return /\\d|\[0-9\]|\[\\d\]/.test(pattern);
  }

  function isOtpLikeTarget(element) {
    if (!isNumericTarget(element)) return false;
    if (normalizedAttr(element, "autocomplete") === "one-time-code") return true;
    const name = `${normalizedAttr(element, "name")} ${normalizedAttr(element, "id")}`;
    if (/\b(otp|code|verification|pin)\b/.test(name)) return true;
    return Number(element.maxLength) === 1;
  }

  function isSpotifySixDigitChallengePage(documentRef) {
    if (!documentRef?.querySelectorAll) return false;
    const spotifyTopPage = isSpotifyAuthPage();
    const text = documentRef?.body?.innerText || "";
    const hasChallengeText = /(?:6|six)[-\s]?digit|verification code|login code|security code|enter(?:\s+the)?\s+code/i.test(text);
    const inputs = querySelectorAllDeep(documentRef, "input");
    const numericInputs = inputs.filter((input) => isEditableTarget(input) && isNumericTarget(input));
    const otpInputs = inputs.filter((input) => isEditableTarget(input) && (isOtpLikeTarget(input) || Number(input.maxLength) === 1));
    if ((spotifyTopPage || hasChallengeText) && otpInputs.length >= 4) return true;
    if ((spotifyTopPage || hasChallengeText) && numericInputs.length >= 1 && inputs.length <= 8) return true;
    const digitBoxControls = Array.from(
      querySelectorAllDeep(documentRef, "input,button,[role='textbox'],[role='spinbutton'],[contenteditable='true']"),
    ).filter((element) => {
      if (element instanceof HTMLInputElement) return isEditableTarget(element);
      if (element instanceof HTMLButtonElement) return !element.disabled;
      if (element?.isContentEditable) return true;
      const role = normalizedAttr(element, "role");
      return role === "textbox" || role === "spinbutton";
    });
    return (spotifyTopPage || hasChallengeText) && digitBoxControls.length >= 6;
  }

  function spotifyChallengeTarget(documentRef) {
    if (!isSpotifySixDigitChallengePage(documentRef)) return null;
    const active = documentRef.activeElement;
    if (isEditableTarget(active)) return active;
    const candidates = querySelectorAllDeep(documentRef, "input");
    return candidates.find((candidate) => isEditableTarget(candidate) && isOtpLikeTarget(candidate) && !candidate.value)
      || candidates.find((candidate) => isEditableTarget(candidate) && isNumericTarget(candidate))
      || candidates.find((candidate) => isEditableTarget(candidate))
      || null;
  }

  function spotifyFallbackTarget(documentRef) {
    const challengeTarget = spotifyChallengeTarget(documentRef);
    if (challengeTarget) return challengeTarget;
    const active = documentRef.activeElement;
    if (isEditableTarget(active)) return active;
    const candidates = querySelectorAllDeep(documentRef, "input,textarea");
    return candidates.find((candidate) => isEditableTarget(candidate) && !candidate.value)
      || candidates.find((candidate) => isEditableTarget(candidate))
      || null;
  }

  function keyboardModeForTarget(element) {
    return isNumericTarget(element) ? "numeric" : "letters";
  }

  function editableTargetFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const candidate of path) {
      if (isEditableTarget(candidate)) return candidate;
    }
    return isEditableTarget(event.target) ? event.target : null;
  }

  function dismissTargetFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const candidate of path) {
      if (candidate?.dataset?.pipzoDismissKeyboard === "true") return candidate;
      if (typeof candidate?.closest === "function") {
        const target = candidate.closest("[data-pipzo-dismiss-keyboard='true']");
        if (target) return target;
      }
    }
    const target = event.target;
    if (target?.dataset?.pipzoDismissKeyboard === "true") return target;
    if (typeof target?.closest === "function") return target.closest("[data-pipzo-dismiss-keyboard='true']");
    return null;
  }

  function displayKey(key, currentState) {
    if (currentState.mode === "numeric") return key;
    if (currentState.mode !== "letters") return key;
    if (currentState.shift && Object.prototype.hasOwnProperty.call(SHIFTED_NUMBER_KEYS, key)) {
      return SHIFTED_NUMBER_KEYS[key];
    }
    if (!/^[a-z]$/.test(key)) return key;
    return currentState.shift || currentState.caps ? key.toUpperCase() : key;
  }

  function commandLabel(command, currentState) {
    if (command.kind === "shift" && currentState.caps) return "CAPS";
    if (command.kind === "mode") return currentState.mode === "letters" ? "Symbols" : "Letters";
    return command.label;
  }

  function commandForKey(key) {
    return typeof key === "string" ? { label: key, kind: "text", value: key } : key;
  }

  function commandKey(command) {
    return `${command.kind}:${command.value ?? ""}`;
  }

  function writeCommandDataset(button, command) {
    button.dataset.pipzoKeyboardCommandKind = command.kind;
    if (typeof command.value === "string") {
      button.dataset.pipzoKeyboardCommandValue = command.value;
    } else {
      delete button.dataset.pipzoKeyboardCommandValue;
    }
  }

  function commandFromButton(button) {
    const kind = button?.dataset?.pipzoKeyboardCommandKind;
    if (!kind) return null;
    if (kind === "text") return { label: button.textContent || button.dataset.pipzoKeyboardCommandValue || "", kind, value: button.dataset.pipzoKeyboardCommandValue || "" };
    if (kind === "space") return { label: "Space", kind };
    if (kind === "backspace") return { label: "Backspace", kind };
    if (kind === "clear") return { label: "Clear", kind };
    if (kind === "done") return { label: "Done", kind, primary: true };
    if (kind === "mode") return { label: "Mode", kind };
    if (kind === "shift") return { label: "Shift", kind };
    return null;
  }

  function commandRows(currentState) {
    if (currentState.mode === "numeric") return NUMERIC_ROWS;
    const commandRow = [
      { label: "Clear", kind: "clear" },
      { label: currentState.mode === "letters" ? "Symbols" : "Letters", kind: "mode" },
      { label: "Space", kind: "space" },
      { label: "Done", kind: "done", primary: true },
    ];
    if (currentState.mode === "letters") return [...LETTER_ROWS, commandRow];
    return [
      ...SYMBOL_ROWS,
      [
        { label: "Clear", kind: "clear" },
        { label: "Letters", kind: "mode" },
        { label: "Backspace", kind: "backspace" },
        { label: "Space", kind: "space" },
        { label: "Done", kind: "done", primary: true },
      ],
    ];
  }

  function rowLabels(currentState) {
    return commandRows(currentState).map((row) =>
      row.map((key) => {
        const command = commandForKey(key);
        if (command.kind === "text") return displayKey(command.value, currentState);
        return commandLabel(command, currentState);
      }),
    );
  }

  function nextState(currentState, command) {
    const updated = { ...currentState };
    if (updated.mode === "numeric") {
      updated.shift = false;
      updated.caps = false;
      return updated;
    }
    if (command.kind === "shift") {
      if (updated.caps) {
        updated.caps = false;
        updated.shift = false;
      } else if (updated.shift) {
        updated.caps = true;
        updated.shift = false;
      } else {
        updated.shift = true;
      }
    }
    if (command.kind === "mode") {
      updated.mode = updated.mode === "letters" ? "symbols" : "letters";
      updated.shift = false;
    }
    if ((command.kind === "text" || command.kind === "space") && updated.shift && !updated.caps) {
      updated.shift = false;
    }
    return updated;
  }

  function insertedText(command, currentState) {
    if (command.kind === "space") return " ";
    if (command.kind !== "text") return "";
    if (currentState.mode === "numeric" && !/^[0-9]$/.test(command.value)) return "";
    return displayKey(command.value, currentState);
  }

  function applyCommandValue(value, selectionStart, selectionEnd, command, currentState) {
    const start = Number.isInteger(selectionStart) ? selectionStart : value.length;
    const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
    if (command.kind === "clear") return { value: "", caret: 0 };
    if (command.kind === "backspace") {
      if (start !== end) return { value: value.slice(0, start) + value.slice(end), caret: start };
      const caret = Math.max(0, start - 1);
      return { value: value.slice(0, caret) + value.slice(end), caret };
    }
    const text = insertedText(command, currentState);
    if (!text) return { value, caret: start };
    const nextValue = value.slice(0, start) + text + value.slice(end);
    return { value: nextValue, caret: start + text.length };
  }

  function eventForTarget(type, options = {}) {
    const EventConstructor =
      (type === "beforeinput" || type === "input" ? globalScope.InputEvent : null)
      || (type.startsWith("key") ? globalScope.KeyboardEvent : null)
      || (type.startsWith("composition") ? globalScope.CompositionEvent : null)
      || globalScope.Event
      || Event;
    try {
      return new EventConstructor(type, options);
    } catch {
      const event = new Event(type, { bubbles: Boolean(options.bubbles), cancelable: Boolean(options.cancelable) });
      Object.entries(options).forEach(([key, value]) => {
        if (key === "bubbles" || key === "cancelable" || key === "composed") return;
        try {
          Object.defineProperty(event, key, { configurable: true, value });
        } catch {
          // Some browser event properties are read-only; best-effort payload is enough.
        }
      });
      return event;
    }
  }

  function inputTypeForCommand(command) {
    if (command.kind === "backspace") return "deleteContentBackward";
    if (command.kind === "clear") return "deleteContentBackward";
    return "insertText";
  }

  function keyPayloadForCommand(command, currentState) {
    if (command.kind === "backspace") return { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, data: null };
    if (command.kind === "clear") return { key: "Delete", code: "Delete", keyCode: 46, which: 46, data: null };
    const text = insertedText(command, currentState);
    if (text === " ") return { key: " ", code: "Space", keyCode: 32, which: 32, data: " " };
    const digit = /^[0-9]$/.test(text);
    const letter = /^[a-z]$/i.test(text);
    return {
      key: text,
      code: digit ? `Digit${text}` : letter ? `Key${text.toUpperCase()}` : "",
      keyCode: text.length === 1 ? text.toUpperCase().charCodeAt(0) : 0,
      which: text.length === 1 ? text.toUpperCase().charCodeAt(0) : 0,
      data: text || null,
    };
  }

  function dispatchKeyEvent(target, type, payload) {
    target.dispatchEvent(eventForTarget(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: payload.key,
      code: payload.code,
      keyCode: payload.keyCode,
      which: payload.which,
    }));
  }

  function dispatchBeforeInputEvent(target, inputType, data) {
    target.dispatchEvent(eventForTarget("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      data,
      inputType,
    }));
  }

  function dispatchCompositionEvents(target, data) {
    if (!data) return;
    target.dispatchEvent(eventForTarget("compositionstart", { bubbles: true, cancelable: true, composed: true, data: "" }));
    target.dispatchEvent(eventForTarget("compositionupdate", { bubbles: true, cancelable: true, composed: true, data }));
    target.dispatchEvent(eventForTarget("compositionend", { bubbles: true, cancelable: true, composed: true, data }));
  }

  function dispatchInputEvents(target, inputType, data) {
    target.dispatchEvent(eventForTarget("input", { bubbles: true, cancelable: false, composed: true, data, inputType }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function writeTargetValue(target, value) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (typeof descriptor?.set === "function") {
      descriptor.set.call(target, value);
      return;
    }
    target.value = value;
  }

  function selectionForCommand(target, command) {
    if (command.kind === "text" && /^[0-9]$/.test(command.value) && isOtpLikeTarget(target) && Number(target.maxLength) === 1) {
      return { start: 0, end: (target.value || "").length };
    }
    return { start: target.selectionStart, end: target.selectionEnd };
  }

  function setTargetValue(target, command) {
    state.mode = keyboardModeForTarget(target);
    const selection = selectionForCommand(target, command);
    const result = applyCommandValue(
      target.value || "",
      selection.start,
      selection.end,
      command,
      state,
    );
    const inputType = inputTypeForCommand(command);
    const keyPayload = keyPayloadForCommand(command, state);
    dispatchKeyEvent(target, "keydown", keyPayload);
    dispatchBeforeInputEvent(target, inputType, keyPayload.data);
    if (isOtpLikeTarget(target)) dispatchCompositionEvents(target, keyPayload.data);
    writeTargetValue(target, result.value);
    if (typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(result.caret, result.caret);
      } catch {
        // Some numeric input types reject selection APIs even though value mutation works.
      }
    }
    dispatchInputEvents(target, inputType, keyPayload.data);
    dispatchKeyEvent(target, "keyup", keyPayload);
    if (command.kind === "text" && /^[0-9]$/.test(command.value) && shouldAdvanceOtpTarget(target, result)) {
      focusNextOtpTarget(target);
    }
  }

  function shouldAdvanceOtpTarget(target, result) {
    if (!isOtpLikeTarget(target)) return false;
    const maxLength = Number(target.maxLength);
    if (Number.isInteger(maxLength) && maxLength > 0) return result.value.length >= maxLength;
    return result.value.length >= 1;
  }

  function focusNextOtpTarget(target) {
    const candidates = [];
    if (target?.ownerDocument && typeof target.ownerDocument.querySelectorAll === "function") {
      candidates.push(...querySelectorAllDeep(target.ownerDocument, "input"));
    } else {
      let next = target?.nextElementSibling;
      while (next) {
        candidates.push(next);
        next = next.nextElementSibling;
      }
    }
    const startIndex = candidates.indexOf(target);
    const following = startIndex >= 0 ? candidates.slice(startIndex + 1) : candidates;
    const nextTarget = following.find((candidate) => isEditableTarget(candidate) && isOtpLikeTarget(candidate) && !candidate.value);
    if (typeof nextTarget?.focus === "function") {
      try {
        nextTarget.focus({ preventScroll: true });
      } catch {
        nextTarget.focus();
      }
    }
    return nextTarget || null;
  }

  function buildButton(documentRef, label, command, options = {}) {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.textContent = label;
    writeCommandDataset(button, command);
    if (options.active) button.dataset.active = "true";
    if (options.primary) button.dataset.primary = "true";
    return button;
  }

  function buildRow(documentRef, keys, role) {
    const row = documentRef.createElement("div");
    row.className = "pipzo-keyboard-row";
    if (role) row.dataset.role = role;
    row.dataset.columns = String(keys.length);
    row.style.setProperty("--pipzo-keyboard-columns", String(keys.length));
    keys.forEach((key) => {
      const command = commandForKey(key);
      const options = {
        active: (command.kind === "shift" && (state.shift || state.caps)) || Boolean(command.active),
        primary: Boolean(command.primary),
      };
      if (command.kind === "text") {
        row.appendChild(buildButton(documentRef, displayKey(command.value, state), command, options));
      } else {
        row.appendChild(buildButton(documentRef, commandLabel(command, state), command, options));
      }
    });
    return row;
  }

  function syncKeyboardInset(documentRef, root) {
    const height = root.hidden ? 0 : Math.ceil(root.getBoundingClientRect().height);
    documentRef.documentElement?.style.setProperty("--pipzo-keyboard-inset", `${height}px`);
  }

  function clearKeyboardInset(documentRef) {
    documentRef.documentElement?.style.setProperty("--pipzo-keyboard-inset", "0px");
  }

  function renderKeyboard(root) {
    const documentRef = root.ownerDocument;
    root.replaceChildren();
    commandRows(state).forEach((row, index, rows) => {
      root.appendChild(buildRow(documentRef, row, index === rows.length - 1 ? "commands" : undefined));
    });
  }

  function showKeyboard(documentRef, target) {
    state.target = target;
    state.mode = keyboardModeForTarget(target);
    if (state.mode === "numeric") {
      state.shift = false;
      state.caps = false;
    }
    const root = ensureRoot(documentRef);
    if (!root) return;
    renderKeyboard(root);
    root.hidden = false;
    syncKeyboardInset(documentRef, root);
  }

  function hideKeyboard() {
    const documentRef = globalScope.document;
    const root = documentRef?.getElementById(ROOT_ID);
    if (root) root.hidden = true;
    if (documentRef) clearKeyboardInset(documentRef);
    state.target = null;
  }

  function isKeyboardVisible(documentRef) {
    const root = documentRef?.getElementById(ROOT_ID);
    return Boolean(root && !root.hidden);
  }

  function commandTarget(documentRef) {
    if (state.target && isConnectedTarget(state.target) && isEditableTarget(state.target)) return state.target;
    const active = documentRef?.activeElement;
    if (isConnectedTarget(active) && isEditableTarget(active)) {
      state.target = active;
      return active;
    }
    const spotifyTarget = spotifyChallengeTarget(documentRef);
    if (spotifyTarget) {
      state.target = spotifyTarget;
      return spotifyTarget;
    }
    return null;
  }

  function handleCommand(command) {
    if (command.kind === "done") {
      hideKeyboard();
      return;
    }
    const target = commandTarget(globalScope.document);
    if (target && isEditableTarget(target) && ["text", "space", "backspace", "clear"].includes(command.kind)) {
      setTargetValue(target, command);
      target.focus();
    }
    Object.assign(state, nextState(state, command));
    const root = globalScope.document?.getElementById(ROOT_ID);
    if (root && !root.hidden) {
      renderKeyboard(root);
      syncKeyboardInset(root.ownerDocument, root);
    }
  }

  function stopKeyboardEvent(event) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  function keyboardCommandButtonFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const candidate of path) {
      if (candidate instanceof HTMLButtonElement && commandFromButton(candidate)) return candidate;
    }
    const target = event.target;
    if (target instanceof HTMLButtonElement && commandFromButton(target)) return target;
    if (typeof target?.closest === "function") {
      const closest = target.closest(`#${ROOT_ID} button[data-pipzo-keyboard-command-kind]`);
      if (closest instanceof HTMLButtonElement && commandFromButton(closest)) return closest;
    }
    return null;
  }

  function isPipzoControlEvent(event) {
    if (keyboardCommandButtonFromEvent(event)) return true;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const candidate of path) {
      if (candidate?.id === ROOT_ID || candidate?.id === SPOTIFY_ACCOUNT_LAUNCHER_ID || candidate?.id === SPOTIFY_RECOVERY_ROOT_ID) return true;
      if (typeof candidate?.closest === "function") {
        const control = candidate.closest(`#${ROOT_ID}, #${SPOTIFY_ACCOUNT_LAUNCHER_ID}, #${SPOTIFY_RECOVERY_ROOT_ID}`);
        if (control) return true;
      }
    }
    const target = event.target;
    if (target?.id === ROOT_ID || target?.id === SPOTIFY_ACCOUNT_LAUNCHER_ID || target?.id === SPOTIFY_RECOVERY_ROOT_ID) return true;
    if (typeof target?.closest === "function") {
      return Boolean(target.closest(`#${ROOT_ID}, #${SPOTIFY_ACCOUNT_LAUNCHER_ID}, #${SPOTIFY_RECOVERY_ROOT_ID}`));
    }
    return false;
  }

  function shouldIgnoreKeyboardActivation(event) {
    if (event.type === "pointerdown" && typeof event.button === "number" && event.button !== 0) return true;
    if (event.type === "mousedown" && typeof globalScope.PointerEvent === "function") return true;
    return false;
  }

  function shouldSuppressDuplicateActivation(command, event) {
    const now = typeof globalScope.performance?.now === "function" ? globalScope.performance.now() : Date.now();
    const key = commandKey(command);
    const source = event.type || "";
    const fallbackAfterPrimary =
      (source === "click" || source === "mousedown")
      && (lastKeyboardActivation.source === "pointerdown" || lastKeyboardActivation.source === "touchstart");
    if (fallbackAfterPrimary && lastKeyboardActivation.commandKey === key && now - lastKeyboardActivation.time < 350) return true;
    lastKeyboardActivation = { commandKey: key, source, time: now };
    return false;
  }

  function handleKeyboardActivation(event) {
    const button = keyboardCommandButtonFromEvent(event);
    if (!button) return false;
    stopKeyboardEvent(event);
    if (shouldIgnoreKeyboardActivation(event)) return true;
    const command = commandFromButton(button);
    if (!command) return true;
    if (shouldSuppressDuplicateActivation(command, event)) return true;
    handleCommand(command);
    return true;
  }

  function installKeyboardActivationHandlers(root) {
    if (root.__pipzoKeyboardActivationInstalled) return;
    root.__pipzoKeyboardActivationInstalled = true;
    ["pointerdown", "touchstart", "mousedown", "click"].forEach((type) => {
      root.addEventListener(type, handleKeyboardActivation, true);
    });
  }

  function ensureRoot(documentRef) {
    let root = documentRef.getElementById(ROOT_ID);
    if (root) {
      installKeyboardActivationHandlers(root);
      return root;
    }
    if (!documentRef.body) return null;
    root = documentRef.createElement("div");
    root.id = ROOT_ID;
    root.hidden = true;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Pipzo touch keyboard");
    root.setAttribute("data-pipzo-keyboard-root", "true");
    documentRef.body.appendChild(root);
    installKeyboardActivationHandlers(root);
    clearKeyboardInset(documentRef);
    return root;
  }

  function scrollSpotifyPage(direction) {
    const distance = Math.max(Math.round(globalScope.innerHeight * 0.72), 320);
    const top = direction === "up" ? -distance : distance;
    globalScope.scrollBy({ top, left: 0, behavior: "smooth" });
  }

  function ensureSpotifyScrollControls(documentRef) {
    if (!isSpotifyAuthPage()) return;
    if (!documentRef.body) return;
    if (documentRef.getElementById(SPOTIFY_SCROLL_ROOT_ID)) return;
    const root = documentRef.createElement("div");
    root.id = SPOTIFY_SCROLL_ROOT_ID;

    const up = documentRef.createElement("button");
    up.type = "button";
    up.textContent = "Up";
    up.setAttribute("aria-label", "Scroll Spotify page up");
    up.addEventListener("pointerdown", (event) => event.preventDefault());
    up.addEventListener("click", () => scrollSpotifyPage("up"));

    const down = documentRef.createElement("button");
    down.type = "button";
    down.textContent = "Down";
    down.setAttribute("aria-label", "Scroll Spotify page down");
    down.addEventListener("pointerdown", (event) => event.preventDefault());
    down.addEventListener("click", () => scrollSpotifyPage("down"));

    root.append(up, down);
    documentRef.body.appendChild(root);
  }

  function ensureSpotifyAccountLauncher(documentRef) {
    if (!isSpotifyAuthPage()) return;
    if (!documentRef.body) return;
    if (documentRef.getElementById(SPOTIFY_ACCOUNT_LAUNCHER_ID)) return;
    const button = documentRef.createElement("button");
    button.id = SPOTIFY_ACCOUNT_LAUNCHER_ID;
    button.type = "button";
    button.textContent = "123";
    button.setAttribute("aria-label", "Show Pipzo keyboard");
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => showSpotifyAccountKeyboard(documentRef));
    documentRef.body.appendChild(button);
  }

  function returnToPipzo() {
    globalScope.location.assign(PIPZO_SPOTIFY_SETTINGS_URL);
  }

  function ensureSpotifyRecoveryControls(documentRef) {
    if (!isSpotifyAuthPage()) return;
    if (!documentRef.body) return;
    if (documentRef.getElementById(SPOTIFY_RECOVERY_ROOT_ID)) return;
    const root = documentRef.createElement("div");
    root.id = SPOTIFY_RECOVERY_ROOT_ID;

    const launcher = documentRef.createElement("button");
    launcher.type = "button";
    launcher.textContent = "123";
    launcher.setAttribute("aria-label", "Show Pipzo keyboard");
    launcher.addEventListener("pointerdown", (event) => event.preventDefault());
    launcher.addEventListener("click", () => showSpotifyAccountKeyboard(documentRef));

    const back = documentRef.createElement("button");
    back.type = "button";
    back.textContent = "Back to Pipzo";
    back.setAttribute("aria-label", "Return to Pipzo Spotify settings");
    back.addEventListener("pointerdown", (event) => event.preventDefault());
    back.addEventListener("click", returnToPipzo);

    root.append(launcher, back);
    documentRef.body.appendChild(root);
  }

  function dispatchSpotifySessionResetResponse(documentRef, detail) {
    if (documentRef.documentElement) {
      documentRef.documentElement.dataset.pipzoSpotifySessionResetResponseId = detail.requestId ?? "";
      documentRef.documentElement.dataset.pipzoSpotifySessionResetOk = detail.ok ? "true" : "false";
      if (typeof detail.clearedCookies === "number") {
        documentRef.documentElement.dataset.pipzoSpotifySessionResetClearedCookies = String(detail.clearedCookies);
      } else {
        delete documentRef.documentElement.dataset.pipzoSpotifySessionResetClearedCookies;
      }
      if (detail.error) {
        documentRef.documentElement.dataset.pipzoSpotifySessionResetError = detail.error;
      } else {
        delete documentRef.documentElement.dataset.pipzoSpotifySessionResetError;
      }
    }
    documentRef.dispatchEvent(new CustomEvent(SPOTIFY_SESSION_RESET_RESPONSE, { detail }));
  }

  function installSpotifySessionResetBridge(documentRef) {
    if (!isPipzoAppPage()) return;
    if (documentRef.__pipzoSpotifySessionResetBridgeInstalled) return;
    documentRef.__pipzoSpotifySessionResetBridgeInstalled = true;
    documentRef.addEventListener(SPOTIFY_SESSION_RESET_REQUEST, (event) => {
      const requestId = event.detail?.requestId ?? documentRef.documentElement?.dataset?.pipzoSpotifySessionResetRequestId;
      const sendMessage = globalScope.chrome?.runtime?.sendMessage;
      if (typeof sendMessage !== "function") {
        dispatchSpotifySessionResetResponse(documentRef, { requestId, ok: false, error: "extension_unavailable" });
        return;
      }
      sendMessage({ type: "pipzo.clearSpotifySession" }, (response) => {
        const runtimeError = globalScope.chrome?.runtime?.lastError?.message;
        if (runtimeError) {
          dispatchSpotifySessionResetResponse(documentRef, { requestId, ok: false, error: "extension_unavailable" });
          return;
        }
        dispatchSpotifySessionResetResponse(documentRef, {
          requestId,
          ok: Boolean(response?.ok),
          clearedCookies: typeof response?.clearedCookies === "number" ? response.clearedCookies : undefined,
          error: response?.error,
        });
      });
    });
  }

  function hasOtpLikeTarget(documentRef) {
    const candidates = querySelectorAllDeep(documentRef, "input");
    return candidates.some((candidate) => isEditableTarget(candidate) && isOtpLikeTarget(candidate));
  }

  function sendExtensionDiagnostic(documentRef) {
    const sendMessage = globalScope.chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== "function") return;
    const keyboardRoot = documentRef.getElementById(ROOT_ID);
    const event = {
      topFrame: globalScope.top === globalScope.self,
      keyboardRootPresent: Boolean(keyboardRoot),
      keyboardVisible: Boolean(keyboardRoot && !keyboardRoot.hidden),
      launcherPresent: Boolean(documentRef.getElementById(SPOTIFY_ACCOUNT_LAUNCHER_ID)),
      recoveryControlsPresent: Boolean(documentRef.getElementById(SPOTIFY_RECOVERY_ROOT_ID)),
      scrollControlsPresent: Boolean(documentRef.getElementById(SPOTIFY_SCROLL_ROOT_ID)),
      editablePresent: Boolean(documentRef.querySelector?.("input,textarea,[contenteditable='true']")),
      otpLikePresent: hasOtpLikeTarget(documentRef),
    };
    sendMessage({ type: DIAGNOSTIC_MESSAGE_TYPE, event }, () => {
      globalScope.chrome?.runtime?.lastError?.message;
    });
  }

  function scheduleExtensionDiagnostic(documentRef, delay = 0) {
    globalScope.setTimeout(() => sendExtensionDiagnostic(documentRef), delay);
  }

  function markInstalled(documentRef) {
    if (documentRef.documentElement) {
      documentRef.documentElement.dataset.pipzoKeyboardExtension = "ready";
    }
  }

  function showKeyboardForTarget(documentRef, target) {
    if (!isEditableTarget(target)) return;
    if (typeof target.focus === "function" && documentRef.activeElement !== target) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    }
    showKeyboard(documentRef, target);
  }

  function showSpotifyChallengeKeyboard(documentRef) {
    const target = spotifyChallengeTarget(documentRef);
    if (target) {
      showKeyboardForTarget(documentRef, target);
      return true;
    }
    if (!isSpotifySixDigitChallengePage(documentRef)) return false;
    state.target = null;
    state.mode = "numeric";
    state.shift = false;
    state.caps = false;
    const root = ensureRoot(documentRef);
    if (!root) return false;
    renderKeyboard(root);
    root.hidden = false;
    syncKeyboardInset(documentRef, root);
    return true;
  }

  function showSpotifyAccountKeyboard(documentRef) {
    if (!isSpotifyAuthPage()) return false;
    const target = spotifyFallbackTarget(documentRef);
    if (target) {
      showKeyboardForTarget(documentRef, target);
      return true;
    }
    state.target = null;
    state.mode = isSpotifySixDigitChallengePage(documentRef) ? "numeric" : "letters";
    state.shift = false;
    state.caps = false;
    const root = ensureRoot(documentRef);
    if (!root) return false;
    renderKeyboard(root);
    root.hidden = false;
    syncKeyboardInset(documentRef, root);
    return true;
  }

  function handlePageActivation(documentRef, event) {
    if (isPipzoControlEvent(event)) return false;
    const target = editableTargetFromEvent(event);
    if (!target) {
      if (dismissTargetFromEvent(event)) hideKeyboard();
      else if (isSpotifyAuthPage()) hideKeyboard();
      return false;
    }
    showKeyboardForTarget(documentRef, target);
    globalScope.setTimeout(() => showKeyboardForTarget(documentRef, target), 0);
    return true;
  }

  function checkActiveElement(documentRef) {
    const active = documentRef.activeElement;
    if (isEditableTarget(active)) showKeyboard(documentRef, active);
  }

  function hideIfTargetLeftPage(documentRef) {
    if (!isKeyboardVisible(documentRef)) return;
    if (state.target && isConnectedTarget(state.target)) return;
    if (isEditableTarget(documentRef.activeElement)) return;
    hideKeyboard();
  }

  function scheduleStaleTargetCheck(documentRef) {
    globalScope.setTimeout(() => hideIfTargetLeftPage(documentRef), STALE_TARGET_CHECK_DELAY_MS);
  }

  function scheduleActiveElementChecks(documentRef) {
    ACTIVE_ELEMENT_CHECK_DELAYS_MS.forEach((delay) => {
      globalScope.setTimeout(() => checkActiveElement(documentRef), delay);
    });
  }

  function install(documentRef) {
    if (!documentRef || documentRef.__pipzoKeyboardInstalled) return;
    if (!isPipzoAppPage() && !isSpotifyAuthPage() && !isSpotifySixDigitChallengePage(documentRef)) return;
    documentRef.__pipzoKeyboardInstalled = true;
    markInstalled(documentRef);
    ensureRoot(documentRef);
    ensureSpotifyScrollControls(documentRef);
    ensureSpotifyAccountLauncher(documentRef);
    ensureSpotifyRecoveryControls(documentRef);
    installSpotifySessionResetBridge(documentRef);
    scheduleExtensionDiagnostic(documentRef);
    scheduleExtensionDiagnostic(documentRef, 700);
    const handleActivation = (event) => {
      handlePageActivation(documentRef, event);
    };
    documentRef.addEventListener("pointerdown", handleActivation, true);
    documentRef.addEventListener("touchstart", handleActivation, true);
    documentRef.addEventListener("mousedown", handleActivation, true);
    documentRef.addEventListener("focusin", (event) => {
      const target = event.target;
      if (isEditableTarget(target)) showKeyboard(documentRef, target);
      else if (isSpotifyAuthPage()) hideKeyboard();
      else showSpotifyChallengeKeyboard(documentRef);
    });
    documentRef.defaultView?.addEventListener("pagehide", hideKeyboard);
    documentRef.defaultView?.addEventListener("popstate", hideKeyboard);
    documentRef.defaultView?.addEventListener("hashchange", hideKeyboard);
    const historyRef = documentRef.defaultView?.history;
    if (historyRef && !historyRef.__pipzoKeyboardNavigationPatched) {
      ["pushState", "replaceState"].forEach((method) => {
        const original = historyRef[method];
        if (typeof original !== "function") return;
        historyRef[method] = function pipzoKeyboardHistoryMethod(...args) {
          const result = original.apply(this, args);
          hideKeyboard();
          return result;
        };
      });
      historyRef.__pipzoKeyboardNavigationPatched = true;
    }
    if (typeof globalScope.MutationObserver === "function") {
      const observer = new globalScope.MutationObserver(() => {
        ensureSpotifyScrollControls(documentRef);
        ensureSpotifyAccountLauncher(documentRef);
        ensureSpotifyRecoveryControls(documentRef);
        scheduleStaleTargetCheck(documentRef);
        scheduleExtensionDiagnostic(documentRef, 100);
      });
      if (documentRef.documentElement) {
        observer.observe(documentRef.documentElement, { childList: true, subtree: true });
      }
    }
    scheduleActiveElementChecks(documentRef);
    if (isSpotifySixDigitChallengePage(documentRef)) {
      globalScope.setTimeout(() => showSpotifyChallengeKeyboard(documentRef), 0);
      globalScope.setTimeout(() => showSpotifyChallengeKeyboard(documentRef), 600);
    }
  }

  globalScope.__pipzoKeyboardTestApi = {
    applyCommandValue,
    commandTarget,
    dismissTargetFromEvent,
    editableTargetFromEvent,
    displayKey,
    hideIfTargetLeftPage,
    focusNextOtpTarget,
    isConnectedTarget,
    isEditableTarget,
    isEditableInputType: (type) => EDITABLE_INPUT_TYPES.has(type),
    isOtpLikeTarget,
    isSpotifySixDigitChallengePage,
    keyboardModeForTarget,
    commandFromButton,
    handleKeyboardActivation,
    handlePageActivation,
    isPipzoControlEvent,
    isPipzoAppPage,
    isSpotifyAuthPage,
    nextState,
    isSpotifyAccountsPage,
    spotifyChallengeTarget,
    spotifyFallbackTarget,
    rowLabels,
    sendExtensionDiagnostic,
    setTargetValue,
  };

  if (globalScope.document?.readyState === "loading") {
    globalScope.document.addEventListener("DOMContentLoaded", () => install(globalScope.document), { once: true });
  } else if (globalScope.document) {
    install(globalScope.document);
  }
})(globalThis);
