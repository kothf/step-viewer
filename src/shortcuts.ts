/**
 * Custom keyboard shortcuts (gap list U1): a key combination per part/sketch command, set in Settings ▸ Keyboard and kept
 * in localStorage `mc:shortcuts` as { command id: "Ctrl+Shift+E" }. The app's own fixed keys (save, undo, copy, Esc…)
 * cannot be taken.
 */
export const SHORTCUT_STORE = "mc:shortcuts";
export type Shortcuts = Record<string, string>;
type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

const MOD_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Unidentified", "Process"]);
const NAMES: Record<string, string> = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc" };

/** "Ctrl+Alt+Shift+K" for a key event (Cmd counts as Ctrl), "" for a modifier on its own. */
export function comboOf(e: KeyLike): string {
  if (MOD_KEYS.has(e.key)) return "";
  const k = NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", k].filter(Boolean).join("+");
}

/** Keys the app keeps for itself, whatever the settings say. */
export const RESERVED = new Set(["Ctrl+S", "Ctrl+Shift+S", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+K", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+O", "Ctrl+P", "Ctrl+,", "Ctrl+B", "Ctrl+Q",
  "Esc", "Enter", "Tab", "Shift+Tab", "Delete", "Backspace", "Space", "Up", "Down", "Left", "Right", "F5", "F11", "F12"]);

export function parseShortcuts(text: string | null): Shortcuts {
  try {
    const o = JSON.parse(text ?? "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Shortcuts = {};
    for (const [id, c] of Object.entries(o)) if (typeof c === "string" && c && !RESERVED.has(c)) out[id] = c;
    return out;
  } catch { return {}; }
}

let cache: Shortcuts | null = null;
export function loadShortcuts(): Shortcuts {
  if (cache) return cache;
  try { cache = parseShortcuts(localStorage.getItem(SHORTCUT_STORE)); } catch { cache = {}; }
  return cache;
}
export function saveShortcuts(m: Shortcuts) {
  const clean = parseShortcuts(JSON.stringify(m));
  cache = clean;
  try { if (Object.keys(clean).length) localStorage.setItem(SHORTCUT_STORE, JSON.stringify(clean)); else localStorage.removeItem(SHORTCUT_STORE); } catch { /* private mode */ }
}

/** The command a combination runs, if any. */
export function commandFor(m: Shortcuts, combo: string): string | null {
  if (!combo) return null;
  for (const [id, c] of Object.entries(m)) if (c === combo) return id;
  return null;
}

/** Sets `id`'s combination ("" clears it); another command holding the same one loses it. Returns the one that lost it. */
export function assign(m: Shortcuts, id: string, combo: string): string | null {
  let lost: string | null = null;
  if (combo) for (const [k, c] of Object.entries(m)) if (c === combo && k !== id) { delete m[k]; lost = k; }
  if (combo) m[id] = combo; else delete m[id];
  return lost;
}
