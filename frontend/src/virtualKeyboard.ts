export type VirtualKeyboardMode = "letters" | "symbols";
export type VirtualKeyboardShift = "off" | "shift" | "caps";

export type VirtualKeyboardState = {
  mode: VirtualKeyboardMode;
  shift: VirtualKeyboardShift;
};

export type VirtualKeyboardCommand =
  | { kind: "text"; value: string }
  | { kind: "backspace" }
  | { kind: "space" }
  | { kind: "clear" }
  | { kind: "shift" }
  | { kind: "caps" }
  | { kind: "mode"; mode: VirtualKeyboardMode };

export type VirtualKeyboardResult = {
  value: string;
  state: VirtualKeyboardState;
};

export const initialVirtualKeyboardState: VirtualKeyboardState = {
  mode: "letters",
  shift: "off",
};

export const virtualKeyboardLetterRows = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

export const virtualKeyboardSymbolRows = [
  ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"],
  ["-", "_", "=", "+", "[", "]", "{", "}"],
  [";", ":", "'", "\"", ",", ".", "/", "?"],
  ["`", "~", "<", ">", "\\", "|"],
];

export function virtualKeyboardDisplayKey(key: string, state: VirtualKeyboardState): string {
  if (state.mode !== "letters" || !/^[a-z]$/.test(key)) {
    return key;
  }
  return state.shift === "off" ? key : key.toUpperCase();
}

export function applyVirtualKeyboardCommand(
  value: string,
  state: VirtualKeyboardState,
  command: VirtualKeyboardCommand,
): VirtualKeyboardResult {
  if (command.kind === "backspace") {
    return { value: value.slice(0, -1), state };
  }
  if (command.kind === "space") {
    return { value: `${value} `, state: consumeOneShotShift(state) };
  }
  if (command.kind === "clear") {
    return { value: "", state };
  }
  if (command.kind === "shift") {
    return {
      value,
      state: { ...state, shift: state.shift === "shift" ? "off" : "shift" },
    };
  }
  if (command.kind === "caps") {
    return {
      value,
      state: { ...state, shift: state.shift === "caps" ? "off" : "caps" },
    };
  }
  if (command.kind === "mode") {
    return {
      value,
      state: { mode: command.mode, shift: command.mode === "symbols" ? "off" : state.shift },
    };
  }

  const text = virtualKeyboardDisplayKey(command.value, state);
  return {
    value: `${value}${text}`,
    state: consumeOneShotShift(state),
  };
}

function consumeOneShotShift(state: VirtualKeyboardState): VirtualKeyboardState {
  if (state.shift !== "shift") {
    return state;
  }
  return { ...state, shift: "off" };
}

export function wifiPasswordKeyboardEnabled(needsPassword: boolean): boolean {
  return needsPassword;
}
