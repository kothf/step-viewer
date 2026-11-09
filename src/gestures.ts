/**
 * Mouse gestures (FR-UI-024): with the preference on, a right-drag in a part or a sketch shows a radial guide
 * of 4 or 8 commands around the press point; releasing in a direction runs that command. A right-click without
 * a drag still opens the context menu. Panning moves to the middle button (Ctrl+middle in a sketch).
 * Slots are numbered clockwise from up: 0 up, 1 up-right, 2 right, ... 7 up-left; with 4 gestures only the
 * even slots are used.
 */

export type GestureMode = "part" | "sketch";
export interface GestureConfig { on: boolean; n: 4 | 8; part: string[]; sketch: string[] }

/** Commands a gesture can run, per mode: [id, English label]. "" = nothing. */
export const GESTURE_CMDS: Record<GestureMode, [string, string][]> = {
  part: [
    ["", "(None)"],
    ["view:top", "Top"], ["view:front", "Front"], ["view:right", "Right"], ["view:left", "Left"], ["view:back", "Back"], ["view:bottom", "Bottom"],
    ["view:iso", "Isometric"], ["view:normal", "Normal to"], ["view:fit", "Zoom to fit"],
    ["sketch", "Sketch"], ["extrude", "Extrude"], ["cut", "Cut"], ["revolve", "Revolve"], ["fillet", "Fillet"], ["chamfer", "Chamfer"],
    ["hole", "Hole"], ["shell", "Shell"], ["mirror", "Mirror"], ["plane", "Plane"], ["undo", "Undo"], ["redo", "Redo"],
  ],
  sketch: [
    ["", "(None)"],
    ["sk:line", "Line"], ["sk:rect", "Rectangle"], ["sk:circle", "Circle"], ["sk:arc", "Arc"], ["sk:slot", "Slot"], ["sk:spline", "Spline"],
    ["sk:point", "Point"], ["sk:trim", "Trim"], ["sk:offset", "Offset"], ["sk:fillet", "Fillet"], ["sk:dim", "Dimension"], ["sk:select", "Select"],
    ["view:normal", "Normal to"], ["view:fit", "Zoom to fit"], ["exit", "Exit sketch"], ["undo", "Undo"], ["redo", "Redo"],
  ],
};

export const DEFAULT_GESTURES: GestureConfig = {
  on: false,
  n: 4,
  part: ["view:top", "view:iso", "view:right", "sketch", "view:front", "extrude", "view:normal", "view:fit"],
  sketch: ["sk:line", "sk:arc", "sk:circle", "sk:trim", "sk:dim", "sk:fillet", "sk:rect", "view:normal"],
};

/** Direction names, slot order. */
export const GESTURE_DIRS = ["Up", "Up right", "Right", "Down right", "Down", "Down left", "Left", "Up left"];

/** The press must move this far (px) before a release counts as a gesture. */
export const GESTURE_RUN = 30;
/** The guide shows after this much movement (px); less is a right-click. */
export const GESTURE_SHOW = 5;

const STORE = "mc:gestures";

/** The stored configuration, repaired: unknown commands fall back to the default slot. */
export function parseGestures(text: string | null): GestureConfig {
  let raw: Partial<GestureConfig> = {};
  try { raw = text ? JSON.parse(text) : {}; } catch { raw = {}; }
  const slots = (mode: GestureMode) => {
    const ok = new Set(GESTURE_CMDS[mode].map(c => c[0]));
    const list = Array.isArray(raw[mode]) ? raw[mode]! : [];
    return DEFAULT_GESTURES[mode].map((d, i) => (typeof list[i] === "string" && ok.has(list[i]) ? list[i] : d));
  };
  return { on: raw.on === true, n: raw.n === 8 ? 8 : 4, part: slots("part"), sketch: slots("sketch") };
}

export function loadGestures(): GestureConfig {
  try { return parseGestures(localStorage.getItem(STORE)); } catch { return parseGestures(null); }
}

export function saveGestures(c: GestureConfig) {
  try { localStorage.setItem(STORE, JSON.stringify(c)); } catch { /* private window */ }
}

/** The slot (0..7, clockwise from up) a screen drag points to, or -1 inside the dead zone. With 4 gestures, even slots only. */
export function gestureSlot(dx: number, dy: number, n: 4 | 8, min = GESTURE_RUN): number {
  if (Math.hypot(dx, dy) < min) return -1;
  // Screen y grows downwards: up is −y. Angle clockwise from up, in [0, 2π).
  const a = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
  const step = (2 * Math.PI) / n;
  const k = Math.round(a / step) % n;
  return n === 8 ? k : k * 2;
}

/** English label of a command id in a mode. */
export function gestureLabel(mode: GestureMode, id: string) {
  return GESTURE_CMDS[mode].find(c => c[0] === id)?.[1] ?? id;
}
