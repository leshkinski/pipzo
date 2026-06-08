(function installPipzoKeyboard(globalScope) {
  "use strict";

  const ROOT_ID = "pipzo-extension-keyboard";
  const SPOTIFY_SCROLL_ROOT_ID = "pipzo-spotify-scroll-controls";
  const SPOTIFY_SESSION_RESET_REQUEST = "pipzo:spotify-session-reset-request";
  const SPOTIFY_SESSION_RESET_RESPONSE = "pipzo:spotify-session-reset-response";
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

  function isSpotifyAccountsPage() {
    const locationRef = globalScope.location;
    return locationRef?.protocol === "https:" && locationRef?.host === "accounts.spotify.com";
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
    if (!isSpotifyAccountsPage()) return false;
    const text = documentRef?.body?.innerText || "";
    if (!/6[-\s]?digit code/i.test(text)) return false;
    const inputs = Array.from(documentRef.querySelectorAll?.("input") || []);
    const otpInputs = inputs.filter((input) => isEditableTarget(input) && isOtpLikeTarget(input));
    if (otpInputs.length >= 6) return true;
    const digitBoxControls = Array.from(
      documentRef.querySelectorAll?.("input,button,[role='textbox'],[role='spinbutton'],[contenteditable='true']") || [],
    ).filter((element) => {
      if (element instanceof HTMLInputElement) return isEditableTarget(element);
      if (element instanceof HTMLButtonElement) return !element.disabled;
      if (element?.isContentEditable) return true;
      const role = normalizedAttr(element, "role");
      return role === "textbox" || role === "spinbutton";
    });
    return digitBoxControls.length >= 6;
  }

  function spotifyChallengeTarget(documentRef) {
    if (!isSpotifySixDigitChallengePage(documentRef)) return null;
    const active = documentRef.activeElement;
    if (isEditableTarget(active)) return active;
    const candidates = Array.from(documentRef.querySelectorAll?.("input") || []);
    return candidates.find((candidate) => isEditableTarget(candidate) && isOtpLikeTarget(candidate) && !candidate.value)
      || candidates.find((candidate) => isEditableTarget(candidate) && isNumericTarget(candidate))
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

  function dispatchInputEvents(target) {
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setTargetValue(target, command) {
    state.mode = keyboardModeForTarget(target);
    const result = applyCommandValue(
      target.value || "",
      target.selectionStart,
      target.selectionEnd,
      command,
      state,
    );
    target.value = result.value;
    if (typeof target.setSelectionRange === "function") {
      try {
        target.setSelectionRange(result.caret, result.caret);
      } catch {
        // Some numeric input types reject selection APIs even though value mutation works.
      }
    }
    dispatchInputEvents(target);
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
      candidates.push(...target.ownerDocument.querySelectorAll("input"));
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
    if (options.active) button.dataset.active = "true";
    if (options.primary) button.dataset.primary = "true";
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => handleCommand(command));
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

  function ensureRoot(documentRef) {
    let root = documentRef.getElementById(ROOT_ID);
    if (root) return root;
    if (!documentRef.body) return null;
    root = documentRef.createElement("div");
    root.id = ROOT_ID;
    root.hidden = true;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Pipzo touch keyboard");
    documentRef.body.appendChild(root);
    clearKeyboardInset(documentRef);
    return root;
  }

  function scrollSpotifyPage(direction) {
    const distance = Math.max(Math.round(globalScope.innerHeight * 0.72), 320);
    const top = direction === "up" ? -distance : distance;
    globalScope.scrollBy({ top, left: 0, behavior: "smooth" });
  }

  function ensureSpotifyScrollControls(documentRef) {
    if (!isSpotifyAccountsPage()) return;
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
    documentRef.__pipzoKeyboardInstalled = true;
    markInstalled(documentRef);
    ensureRoot(documentRef);
    ensureSpotifyScrollControls(documentRef);
    installSpotifySessionResetBridge(documentRef);
    const handleActivation = (event) => {
      const target = editableTargetFromEvent(event);
      if (!target) {
        if (showSpotifyChallengeKeyboard(documentRef)) return;
        if (dismissTargetFromEvent(event)) hideKeyboard();
        return;
      }
      showKeyboardForTarget(documentRef, target);
      globalScope.setTimeout(() => showKeyboardForTarget(documentRef, target), 0);
    };
    documentRef.addEventListener("pointerdown", handleActivation, true);
    documentRef.addEventListener("touchstart", handleActivation, true);
    documentRef.addEventListener("mousedown", handleActivation, true);
    documentRef.addEventListener("focusin", (event) => {
      const target = event.target;
      if (isEditableTarget(target)) showKeyboard(documentRef, target);
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
        scheduleStaleTargetCheck(documentRef);
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
    isPipzoAppPage,
    nextState,
    isSpotifyAccountsPage,
    spotifyChallengeTarget,
    rowLabels,
  };

  if (globalScope.document?.readyState === "loading") {
    globalScope.document.addEventListener("DOMContentLoaded", () => install(globalScope.document), { once: true });
  } else if (globalScope.document) {
    install(globalScope.document);
  }
})(globalThis);
