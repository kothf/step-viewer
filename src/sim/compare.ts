// Comparing two solved studies, or a study with its own result before the last change (FR-STU-023).
// Pure: a summary holds only peak values, so it is small enough to keep beside the document.

export interface Summary {
  kind: "static" | "modal";
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
}

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
  /** maxvm | maxu | sf | mass | f<n> */
  key: string;
  a: number | null;
  b: number | null;
  /** (a − b) / |b| in %, null when either is missing or b is 0. */
  change: number | null;
}

const row = (key: string, a: number | null | undefined, b: number | null | undefined): CompareRow => {
  const x = a ?? null, y = b ?? null;
  return { key, a: x, b: y, change: x != null && y != null && Math.abs(y) > 1e-300 ? (100 * (x - y)) / Math.abs(y) : null };
};

/** Rows of `a` (this result) against `b` (the other); empty when the kinds differ. */
export function compareRows(a: Summary, b: Summary): CompareRow[] {
  if (a.kind !== b.kind) return [];
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
  if ((s.kind !== "static" && s.kind !== "modal") || typeof s.name !== "string" || typeof s.key !== "string" || !num(s.at)) return null;
  const out: Summary = { kind: s.kind, name: s.name, key: s.key, at: s.at };
  if (num(s.maxU)) out.maxU = s.maxU;
  if (num(s.maxVm)) out.maxVm = s.maxVm;
  if (num(s.sf)) out.sf = s.sf;
  if (num(s.mass)) out.mass = s.mass;
  if (Array.isArray(s.freqs)) out.freqs = s.freqs.filter(num).slice(0, 60);
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
