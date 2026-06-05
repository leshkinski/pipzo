(function installPipzoKeyboard(globalScope) {
  "use strict";

  const ROOT_ID = "pipzo-extension-keyboard";
  const EDITABLE_INPUT_TYPES = new Set(["text", "password", "email", "search"]);
  const ACTIVE_ELEMENT_CHECK_DELAYS_MS = [0, 150, 500, 1200];
  const LETTER_ROWS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
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

  function displayKey(key, currentState) {
    if (currentState.mode !== "letters" || !/^[a-z]$/.test(key)) return key;
    return currentState.shift || currentState.caps ? key.toUpperCase() : key;
  }

  function nextState(currentState, command) {
    const updated = { ...currentState };
    if (command.kind === "shift") updated.shift = !updated.shift;
    if (command.kind === "caps") updated.caps = !updated.caps;
    if (command.kind === "mode") {
      updated.mode = updated.mode === "letters" ? "symbols" : "letters";
      updated.shift = false;
    }
    if ((command.kind === "text" || command.kind === "space") && updated.shift) {
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

  function buildRow(documentRef, keys, columns) {
    const row = documentRef.createElement("div");
    row.className = "pipzo-keyboard-row";
    row.dataset.columns = String(columns);
    keys.forEach((key) => {
      row.appendChild(buildButton(documentRef, displayKey(key, state), { kind: "text", value: key }));
    });
    return row;
  }

  function renderKeyboard(root) {
    const documentRef = root.ownerDocument;
    root.replaceChildren();

    const utility = documentRef.createElement("div");
    utility.className = "pipzo-keyboard-row";
    utility.dataset.role = "utility";
    utility.appendChild(buildButton(documentRef, "Shift", { kind: "shift" }, { active: state.shift }));
    utility.appendChild(buildButton(documentRef, "Caps", { kind: "caps" }, { active: state.caps }));
    utility.appendChild(buildButton(documentRef, state.mode === "letters" ? "Symbols" : "Letters", { kind: "mode" }));
    utility.appendChild(buildButton(documentRef, "Backspace", { kind: "backspace" }));
    root.appendChild(utility);

    const rows = state.mode === "letters" ? LETTER_ROWS : SYMBOL_ROWS;
    rows.forEach((row, index) => root.appendChild(buildRow(documentRef, row, index === 0 ? 10 : row.length)));

    const commands = documentRef.createElement("div");
    commands.className = "pipzo-keyboard-row";
    commands.dataset.role = "commands";
    commands.appendChild(buildButton(documentRef, "Clear", { kind: "clear" }));
    commands.appendChild(buildButton(documentRef, "Space", { kind: "space" }));
    commands.appendChild(buildButton(documentRef, "Cancel", { kind: "cancel" }));
    commands.appendChild(buildButton(documentRef, "Done", { kind: "done" }, { primary: true }));
    root.appendChild(commands);
  }

  function showKeyboard(documentRef, target) {
    state.target = target;
    const root = ensureRoot(documentRef);
    if (!root) return;
    renderKeyboard(root);
    root.hidden = false;
  }

  function hideKeyboard() {
    const root = globalScope.document?.getElementById(ROOT_ID);
    if (root) root.hidden = true;
    state.target = null;
  }

  function handleCommand(command) {
    if (command.kind === "cancel" || command.kind === "done") {
      hideKeyboard();
      return;
    }
    const target = state.target;
    if (target && isEditableTarget(target) && ["text", "space", "backspace", "clear"].includes(command.kind)) {
      setTargetValue(target, command);
      target.focus();
    }
    Object.assign(state, nextState(state, command));
    const root = globalScope.document?.getElementById(ROOT_ID);
    if (root && !root.hidden) renderKeyboard(root);
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
    return root;
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
    const handleActivation = (event) => {
      const target = editableTargetFromEvent(event);
      if (!target) return;
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
    documentRef.addEventListener("focusout", () => {
      globalScope.setTimeout(() => {
        const active = documentRef.activeElement;
        const root = documentRef.getElementById(ROOT_ID);
        if (root?.contains(active) || isEditableTarget(active)) return;
        hideKeyboard();
      }, 80);
    });
    scheduleActiveElementChecks(documentRef);
  }

  globalScope.__pipzoKeyboardTestApi = {
    applyCommandValue,
    editableTargetFromEvent,
    displayKey,
    isEditableTarget,
    isEditableInputType: (type) => EDITABLE_INPUT_TYPES.has(type),
    nextState,
  };

  if (globalScope.document?.readyState === "loading") {
    globalScope.document.addEventListener("DOMContentLoaded", () => install(globalScope.document), { once: true });
  } else if (globalScope.document) {
    install(globalScope.document);
  }
})(globalThis);
