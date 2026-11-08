// Interference over a motion study (FR-FT-122): SolidWorks' motion study Results → Interference Detection.
// The manager poses every frame and asks the assembly which shown components enter one another; these pure
// helpers turn the per-frame pairs into time spans per pair and a CSV.

/** One pair of components that interfere somewhere in the study. */
export interface ClashItem {
  /** "a|b" with a < b. */
  key: string;
  a: string;
  b: string;
  /** Frames where they interfere, in order. */
  frames: number[];
  /** Runs of consecutive frames as [first, last] times (s). */
  spans: [number, number][];
}

/** The pair key of two components, order-free. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Pairs per frame (`perFrame[i]` = the pairs that interfere at frame i) to one item per pair, in order of first
 * contact. Pairs in `ignore` (those already touching at the start, unless the caller keeps them) are left out.
 */
export function clashItems(perFrame: [string, string][][], fps: number, ignore: Set<string> = new Set()): ClashItem[] {
  const by = new Map<string, ClashItem>();
  perFrame.forEach((pairs, i) => {
    for (const [p, q] of pairs) {
      const key = pairKey(p, q);
      if (ignore.has(key)) continue;
      let it = by.get(key);
      if (!it) { const [a, b] = key.split("|"); it = { key, a, b, frames: [], spans: [] }; by.set(key, it); }
      if (it.frames[it.frames.length - 1] !== i) it.frames.push(i);
    }
  });
  for (const it of by.values()) {
    let s = it.frames[0], prev = s;
    for (const f of it.frames.slice(1).concat(Infinity)) {
      if (f === prev + 1) { prev = f; continue; }
      it.spans.push([s / fps, prev / fps]);
      s = prev = f;
    }
  }
  return [...by.values()].sort((x, y) => x.frames[0] - y.frames[0] || x.key.localeCompare(y.key));
}

/** One row per span: the two components (by name), start and end time (English headers, as every export). */
export function clashCsv(items: ClashItem[], name: (id: string) => string): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const r4 = (v: number) => String(Math.round(v * 1e4) / 1e4);
  const rows = items.flatMap(it => it.spans.map(([a, b]) => [q(name(it.a)), q(name(it.b)), r4(a), r4(b)].join(",")));
  return ["component 1,component 2,from (s),to (s)", ...rows].join("\n") + "\n";
}
