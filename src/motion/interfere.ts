// Interference over a motion study (FR-FT-122): a CAD app's motion study Results → Interference Detection.
// The manager poses every frame and asks the assembly which shown components enter one another; these pure
// helpers turn the per-frame pairs into time spans per pair and a CSV.

import { compose, invert } from "../asm/math";
import type { Tf } from "../asm/types";

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

/**
 * The mesh test on faces that only touch (a bearing seated on a plate) flickers from frame to frame. A pair placed
 * relative to each other as in an earlier frame takes that frame's answer, so parts that never move against each
 * other get one answer for the whole study (engine motion test). Changes `per` in place.
 */
export function steadyClashes(per: [string, string][][], tfs: Record<string, Tf>[]) {
  const pairs = new Map<string, [string, string]>();
  for (const f of per) for (const p of f) pairs.set(pairKey(p[0], p[1]), p);
  const sets = per.map(f => new Set(f.map(p => pairKey(p[0], p[1]))));
  for (const [key, [a, b]] of pairs) {
    const first = new Map<string, boolean>();
    for (let k = 0; k < per.length; k++) {
      const ta = tfs[k]?.[a], tb = tfs[k]?.[b];
      if (!ta || !tb) continue;
      const rel = compose(invert(ta), tb).map(v => Math.round(v * 1e5) / 1e5).join(",");
      const was = first.get(rel), now = sets[k].has(key);
      if (was === undefined) { first.set(rel, now); continue; }
      if (was !== now) {
        if (was) per[k].push([a, b]); else per[k] = per[k].filter(p => pairKey(p[0], p[1]) !== key);
        if (was) sets[k].add(key); else sets[k].delete(key);
      }
    }
  }
}
