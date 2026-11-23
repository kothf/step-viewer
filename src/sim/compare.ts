// Comparing two solved studies, or a study with its own result before the last change (FR-STU-023).
// Pure: a summary holds only peak values, so it is small enough to keep beside the document.

export interface Summary {
  /** thermal = a steady thermal result, warm = a transient one (at its end time) (FR-TRES-030). */
  kind: "static" | "modal" | "thermal" | "warm";
  /** The study's name when it was solved. */
  name: string;
  /** What the results depended on (the study state key): two summaries with one key are the same result. */
  key: string;
  /** When it was solved, ms. */
  at: number;
  /** Static: largest displacement, mm. */
  maxU?: number;
  /** Static: highest von Mises stress, MPa. */
  maxVm?: number;
  /** Static: lowest safety factor against yield, when the material has a yield strength. */
  sf?: number | null;
  /** Modal: mass, kg. */
  mass?: number;
  /** Modal: the natural frequencies that are not rigid-body motions, Hz, from the lowest. */
  freqs?: number[];
  /** Thermal: highest and lowest temperature, °C. */
  tmax?: number;
  tmin?: number;
  /** Thermal: heat put in, W. */
  heat?: number;
  /** Thermal, assemblies: each component's highest temperature, °C, by name. */
  comps?: { name: string; max: number }[];
}

/** The most component rows a thermal comparison lists. */
export const COMPARE_COMPS = 12;

/** What is kept per study: the last result and the one before the last change. */
export interface Kept2 { now?: Summary; before?: Summary }
export type SummaryStore = Record<string, Kept2>;

/** The most frequencies a comparison lists. */
export const COMPARE_MODES = 6;

/** Takes a new result of a study: an older result of another state becomes "before". */
export function noteSummary(store: SummaryStore, id: string, s: Summary): SummaryStore {
  const k = store[id] ?? {};
  if (k.now && k.now.key === s.key) return { ...store, [id]: { ...k, now: { ...s, at: k.now.at } } };
  return { ...store, [id]: { now: s, ...(k.now ? { before: k.now } : k.before ? { before: k.before } : {}) } };
}

export interface CompareRow {
  /** maxvm | maxu | sf | mass | f<n> | tmax | tmin | heat | c:<component name> */
  key: string;
  a: number | null;
  b: number | null;
  /** (a − b) / |b| in %, null when either is missing or b is 0. */
  change: number | null;
  /** Temperatures: a − b in K, which is what a temperature change means (a % of °C is not). */
  diff?: number | null;
}

/** A temperature row: the change is the difference in K. */
const trow = (key: string, a: number | null | undefined, b: number | null | undefined): CompareRow => {
  const x = a ?? null, y = b ?? null;
  return { key, a: x, b: y, change: null, diff: x != null && y != null ? x - y : null };
};

const row = (key: string, a: number | null | undefined, b: number | null | undefined): CompareRow => {
  const x = a ?? null, y = b ?? null;
  return { key, a: x, b: y, change: x != null && y != null && Math.abs(y) > 1e-300 ? (100 * (x - y)) / Math.abs(y) : null };
};

/** Rows of `a` (this result) against `b` (the other); empty when the kinds differ. */
export function compareRows(a: Summary, b: Summary): CompareRow[] {
  if (a.kind !== b.kind) return [];
  if (a.kind === "thermal" || a.kind === "warm") {
    const rows = [trow("tmax", a.tmax, b.tmax), trow("tmin", a.tmin, b.tmin)];
    if (a.heat != null || b.heat != null) rows.push(row("heat", a.heat, b.heat));
    // components by name: this result's hottest first, then ones only the other has
    const other = new Map((b.comps ?? []).map(c => [c.name, c.max]));
    const mine = [...(a.comps ?? [])].sort((p, q) => q.max - p.max);
    const names = [...mine.map(c => c.name), ...(b.comps ?? []).filter(c => !mine.some(m => m.name === c.name)).sort((p, q) => q.max - p.max).map(c => c.name)];
    const at = new Map(mine.map(c => [c.name, c.max]));
    for (const n of names.slice(0, COMPARE_COMPS)) rows.push(trow(`c:${n}`, at.get(n), other.get(n)));
    return rows;
  }
  if (a.kind === "static") {
    const rows = [row("maxvm", a.maxVm, b.maxVm), row("maxu", a.maxU, b.maxU)];
    if (a.sf != null || b.sf != null) rows.push(row("sf", a.sf, b.sf));
    return rows;
  }
  const rows = [row("mass", a.mass, b.mass)];
  const n = Math.min(COMPARE_MODES, Math.max(a.freqs?.length ?? 0, b.freqs?.length ?? 0));
  for (let i = 0; i < n; i++) rows.push(row(`f${i + 1}`, a.freqs?.[i], b.freqs?.[i]));
  return rows;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validSummary(v: unknown): Summary | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if ((s.kind !== "static" && s.kind !== "modal" && s.kind !== "thermal" && s.kind !== "warm") || typeof s.name !== "string" || typeof s.key !== "string" || !num(s.at)) return null;
  const out: Summary = { kind: s.kind, name: s.name, key: s.key, at: s.at };
  if (num(s.maxU)) out.maxU = s.maxU;
  if (num(s.maxVm)) out.maxVm = s.maxVm;
  if (num(s.sf)) out.sf = s.sf;
  if (num(s.mass)) out.mass = s.mass;
  if (Array.isArray(s.freqs)) out.freqs = s.freqs.filter(num).slice(0, 60);
  if (num(s.tmax)) out.tmax = s.tmax;
  if (num(s.tmin)) out.tmin = s.tmin;
  if (num(s.heat)) out.heat = s.heat;
  if (Array.isArray(s.comps)) out.comps = s.comps.filter((c): c is { name: string; max: number } => !!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string" && num((c as { max?: unknown }).max)).slice(0, 400).map(c => ({ name: c.name, max: c.max }));
  return out;
}

/** Reads a stored set of summaries; anything that is not one is dropped. */
export function parseSummaries(text: string | null): SummaryStore {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: SummaryStore = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const k = v as Record<string, unknown>, now = validSummary(k.now), before = validSummary(k.before);
      if (now || before) out[id] = { ...(now ? { now } : {}), ...(before ? { before } : {}) };
    }
    return out;
  } catch { return {}; }
}
