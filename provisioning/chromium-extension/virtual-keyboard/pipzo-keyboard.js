(function installPipzoKeyboard(globalScope) {
  "use strict";

  const ROOT_ID = "pipzo-extension-keyboard";
  const SPOTIFY_SCROLL_ROOT_ID = "pipzo-spotify-scroll-controls";
  const EDITABLE_INPUT_TYPES = new Set(["text", "password", "email", "search"]);
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

  function isConnectedTarget(element) {
    return Boolean(element?.isConnected ?? element);
  }

  function isEditableTarget(element) {
    if (!element) return false;
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (!(element instanceof HTMLInputElement)) return false;
    return !element.disabled && !element.readOnly && EDITABLE_INPUT_TYPES.has(element.type || "text");
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
    const result = applyCommandValue(
      target.value || "",
      target.selectionStart,
      target.selectionEnd,
      command,
      state,
    );
    target.value = result.value;
    if (typeof target.setSelectionRange === "function") {
      target.setSelectionRange(result.caret, result.caret);
    }
    dispatchInputEvents(target);
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
    const handleActivation = (event) => {
      const target = editableTargetFromEvent(event);
      if (!target) {
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
  }

  globalScope.__pipzoKeyboardTestApi = {
    applyCommandValue,
    commandTarget,
    dismissTargetFromEvent,
    editableTargetFromEvent,
    displayKey,
    hideIfTargetLeftPage,
    isConnectedTarget,
    isEditableTarget,
    isEditableInputType: (type) => EDITABLE_INPUT_TYPES.has(type),
    nextState,
    isSpotifyAccountsPage,
    rowLabels,
  };

  if (globalScope.document?.readyState === "loading") {
    globalScope.document.addEventListener("DOMContentLoaded", () => install(globalScope.document), { once: true });
  } else if (globalScope.document) {
    install(globalScope.document);
  }
})(globalThis);
