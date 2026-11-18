/**
 * Hide/Show item types (FR-UI-022, gap list M4): view-only switches that hide every reference plane, axis, point,
 * coordinate system, sketch or 3D curve of a part at once, as in other CAD apps' heads-up Hide/Show Items menu.
 * Each feature's own eye stays as it is; a type turned off here hides all of them. Kept in localStorage `mc:viewItems`.
 */
export type ViewItem = "planes" | "axes" | "points" | "csys" | "sketches" | "curves";
export const VIEW_ITEMS: [ViewItem, string][] = [
  ["planes", "Planes"], ["axes", "Axes"], ["points", "Points"], ["csys", "Coordinate systems"], ["sketches", "Sketches"], ["curves", "Curves"],
];
const KEY = "mc:viewItems";

/** The stored switches: every type shown unless the text turns it off. */
export function parseViewItems(text: string | null): Record<ViewItem, boolean> {
  const out = Object.fromEntries(VIEW_ITEMS.map(([k]) => [k, true])) as Record<ViewItem, boolean>;
  try {
    const o = text ? JSON.parse(text) : null;
    if (o && typeof o === "object") for (const [k] of VIEW_ITEMS) if (o[k] === false) out[k] = false;
  } catch { /* defaults */ }
  return out;
}

let items: Record<ViewItem, boolean> | null = null;
const listeners: (() => void)[] = [];

function read(): Record<ViewItem, boolean> {
  if (!items) {
    let text: string | null = null;
    try { text = localStorage.getItem(KEY); } catch { /* none */ }
    items = parseViewItems(text);
  }
  return items;
}

export function viewItemShown(k: ViewItem): boolean { return read()[k]; }
export function viewItems(): Record<ViewItem, boolean> { return { ...read() }; }

/** Turns one type (or all, with `k` null) on or off and tells the listeners. */
export function setViewItem(k: ViewItem | null, on: boolean) {
  const cur = read();
  for (const [key] of VIEW_ITEMS) if (k === null || key === k) cur[key] = on;
  try {
    const off = Object.fromEntries(VIEW_ITEMS.filter(([key]) => !cur[key]).map(([key]) => [key, false]));
    if (Object.keys(off).length) localStorage.setItem(KEY, JSON.stringify(off)); else localStorage.removeItem(KEY);
  } catch { /* view-only */ }
  for (const f of listeners) f();
}

export function onViewItems(f: () => void) { listeners.push(f); }
