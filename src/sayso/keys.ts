import { platform } from "@tauri-apps/plugin-os";

const MODIFIER_ORDER = [
  "fn",
  "ctrl",
  "control",
  "option",
  "alt",
  "shift",
  "cmd",
  "command",
  "meta",
  "super",
];

const BASE_ORDER = (part: string) => {
  const base = part.replace(/_(left|right)$/, "");
  const index = MODIFIER_ORDER.indexOf(base);
  return index === -1 ? MODIFIER_ORDER.length : index;
};

const COMMON_NAMES: Record<string, string> = {
  fn: "Fn",
  function: "Fn",
  shift: "Shift",
  space: "Space",
  escape: "Esc",
  tab: "Tab",
};

/**
 * Modifier spellings differ per platform while the backend emits the same
 * tokens everywhere (`alt`, `super`, ... — see `shortcut/handy_keys.rs`), so
 * the label table is chosen once at load.
 */
const MAC_NAMES: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  option: "Option",
  alt: "Option",
  cmd: "Command",
  command: "Command",
  meta: "Command",
  super: "Command",
  enter: "Return",
  return: "Return",
  backspace: "Delete",
};

const PC_NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  option: "Alt",
  alt: "Alt",
  cmd: "Win",
  command: "Win",
  meta: "Win",
  super: "Win",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
};

const NAMES: Record<string, string> = {
  ...COMMON_NAMES,
  ...(platform() === "macos" ? MAC_NAMES : PC_NAMES),
};

const labelFor = (part: string): string => {
  const side = part.match(/_(left|right)$/)?.[1];
  const base = part.replace(/_(left|right)$/, "");
  let name = NAMES[base];
  if (!name) {
    name = /^f\d+$/.test(base)
      ? base.toUpperCase()
      : base.length === 1
        ? base.toUpperCase()
        : base.charAt(0).toUpperCase() + base.slice(1);
  }
  if (side === "left") return `Left ${name}`;
  if (side === "right") return `Right ${name}`;
  return name;
};

/** Split a handy-keys binding ("shift_left+fn") into display chips ["Fn", "Left Shift"]. */
export const bindingChips = (binding: string | undefined | null): string[] => {
  if (!binding) return [];
  return binding
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => BASE_ORDER(a) - BASE_ORDER(b))
    .map(labelFor);
};
