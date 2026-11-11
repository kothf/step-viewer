// Preferences (FR-UI-080): the Modelling and Sketch settings kept per browser in localStorage. Pure apart from
// localStorage, so the controller, the sketch editor and the dialog (prefsUi.ts) read the same values.
// The sketch keys predate the dialog (the sketch panel and the quick bar write them too) and keep their names.

export type PrefKey =
  | "rotateToSketch" | "quality" | "verify" | "autosave" | "lenStep" | "angStep" | "middle" | "wheel"
  | "autoRels" | "showRels" | "modelSnap" | "slotDims" | "addDims" | "grid" | "gridSnap" | "gridStep";

export interface Prefs {
  /** Turn the view normal to the sketch plane when a sketch opens. */
  rotateToSketch: boolean;
  /** Tessellation of the part on screen: coarse is faster, fine is smoother. */
  quality: "coarse" | "normal" | "fine";
  /** Check the body after each feature (BRepCheck), as SolidWorks' verification on rebuild. */
  verify: boolean;
  /** Seconds after the last change before the recovery journal is written; 0 = off. */
  autosave: number;
  /** Arrow-key / spin step of lengths in the shown unit, and of angles in degrees. */
  lenStep: number;
  angStep: number;
  /** What a middle-button drag does outside sketches (in a sketch it always rotates). */
  middle: "pan" | "rotate";
  /** Wheel zoom direction: "reverse" zooms in when the wheel turns towards you. */
  wheel: "normal" | "reverse";
  autoRels: boolean;
  showRels: boolean;
  modelSnap: boolean;
  slotDims: boolean;
  /** New lines, rectangles, circles, arcs and polygons get their sizes as dimensions and the Modify box. */
  addDims: boolean;
  grid: boolean;
  gridSnap: boolean;
  /** Millimetres between grid lines; 0 follows the zoom. */
  gridStep: number;
}

export const DEFAULT_PREFS: Prefs = {
  rotateToSketch: true, quality: "normal", verify: false, autosave: 1, lenStep: 1, angStep: 5, middle: "pan", wheel: "normal",
  autoRels: true, showRels: true, modelSnap: true, slotDims: true,
  // Off under webdriver, so the smoke test's click-drawn sketches stay as drawn; its own check turns it on.
  addDims: typeof navigator === "undefined" || !navigator.webdriver,
  grid: false, gridSnap: false, gridStep: 0,
};

/** localStorage key of each preference. Booleans that default to on are stored "0" when off, the others "1" when on. */
export const PREF_STORE: Record<PrefKey, string> = {
  rotateToSketch: "mc:skRotate", quality: "mc:quality", verify: "mc:verify", autosave: "mc:autosave",
  lenStep: "mc:lenStep", angStep: "mc:angStep", middle: "mc:middle", wheel: "mc:wheel",
  autoRels: "mc:autoRels", showRels: "mc:skRels", modelSnap: "mc:modelSnap", slotDims: "mc:slotDims", addDims: "mc:skAddDims",
  grid: "mc:skGrid", gridSnap: "mc:skGridSnap", gridStep: "mc:skGridStep",
};

/** Seconds offered for the recovery journal (0 = off). */
export const AUTOSAVE_CHOICES = [1, 10, 30, 60, 300, 0];

/** Mesh quality factor for the kernel (smaller = finer). */
export function qualityFactor(q: Prefs["quality"]) { return q === "coarse" ? 2 : q === "fine" ? 0.5 : 1; }

/** A preference from its stored text (null = not stored), checked against its kind; bad values give the default. */
export function parsePref<K extends PrefKey>(k: K, raw: string | null): Prefs[K] {
  const def = DEFAULT_PREFS[k];
  if (raw === null || raw === "") return def;
  if (typeof def === "boolean") return (raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : def) as Prefs[K];
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return def;
    if ((k === "lenStep" || k === "angStep") && n <= 0) return def;
    return n as Prefs[K];
  }
  if (k === "quality") return (["coarse", "normal", "fine"].includes(raw) ? raw : def) as Prefs[K];
  if (k === "middle") return (raw === "rotate" || raw === "pan" ? raw : def) as Prefs[K];
  if (k === "wheel") return (raw === "reverse" || raw === "normal" ? raw : def) as Prefs[K];
  return def;
}

/** The stored text of a value. */
export function prefText(v: Prefs[PrefKey]): string {
  return typeof v === "boolean" ? (v ? "1" : "0") : String(v);
}

export function getPref<K extends PrefKey>(k: K): Prefs[K] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PREF_STORE[k]); } catch { /* private mode */ }
  return parsePref(k, raw);
}

export function loadPrefs(): Prefs {
  const out = { ...DEFAULT_PREFS } as Record<PrefKey, unknown>;
  for (const k of Object.keys(DEFAULT_PREFS) as PrefKey[]) out[k] = getPref(k);
  return out as unknown as Prefs;
}

const listeners = new Set<(p: Prefs, changed: PrefKey[]) => void>();

/** Runs `fn` after preferences change (from the dialog or `setPrefs`). Returns the unsubscribe function. */
export function onPrefs(fn: (p: Prefs, changed: PrefKey[]) => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** Stores the given values and tells the listeners which ones changed. */
export function setPrefs(p: Partial<Prefs>) {
  const before = loadPrefs();
  const changed: PrefKey[] = [];
  for (const [k, v] of Object.entries(p) as [PrefKey, Prefs[PrefKey]][]) {
    if (v === undefined) continue;
    const val = parsePref(k, prefText(v));
    if (val !== before[k]) changed.push(k);
    try { localStorage.setItem(PREF_STORE[k], prefText(val)); } catch { /* private mode */ }
  }
  if (!changed.length) return changed;
  const now = loadPrefs();
  for (const fn of listeners) fn(now, changed);
  return changed;
}

/** Spin / arrow-key step for a value shown in `unit` (lengths) or degrees (angles). One unit in inches is 0.1. */
export function stepFor(kind: "length" | "angle", unit = "mm") {
  if (kind === "angle") return getPref("angStep");
  const s = getPref("lenStep");
  return s === 1 && unit === "in" ? 0.1 : s;
}

/** Milliseconds from the last change to the recovery journal write, or null when it is off. */
export function autosaveDelay(): number | null {
  const s = getPref("autosave");
  return s <= 0 ? null : s === 1 ? 800 : s * 1000;
}
