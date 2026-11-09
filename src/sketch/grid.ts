/**
 * Sketch grid (FR-SK-041): the spacing (fixed, or automatic from the zoom), the lines over the visible part of the
 * sketch plane, and snapping a point to the nearest grid node.
 */
import type { V2 } from "../model/types";

/** Minor lines between major lines. */
export const GRID_MAJOR = 5;
/** Smallest gap between minor lines on screen, in pixels, for the automatic spacing. */
export const GRID_MIN_PX = 12;
/** Most lines drawn either way; a finer grid is drawn coarser instead. */
export const GRID_MAX_LINES = 160;

/** The 1-2-5 spacing (mm) that puts minor lines at least `minPx` pixels apart, given mm per pixel. */
export function autoStep(mmPerPx: number, minPx = GRID_MIN_PX): number {
  const want = Math.max(mmPerPx * minPx, 1e-6);
  const e = Math.pow(10, Math.floor(Math.log10(want)));
  for (const m of [1, 2, 5, 10]) if (m * e >= want - 1e-12) return m * e;
  return 10 * e;
}

/** The spacing to use: `fixed` (> 0) when set, made coarser by tens until the box needs at most `max` lines a way. */
export function gridStep(fixed: number, mmPerPx: number, box: [V2, V2], max = GRID_MAX_LINES): number {
  let s = fixed > 0 ? fixed : autoStep(mmPerPx);
  const span = Math.max(box[1][0] - box[0][0], box[1][1] - box[0][1], 0);
  while (span / s > max) s *= GRID_MAJOR;
  return s;
}

/** Grid lines over a box: each [from, to, major]. Lines through the origin count as major. */
export function gridLines(box: [V2, V2], step: number): [V2, V2, boolean][] {
  const out: [V2, V2, boolean][] = [];
  if (!(step > 0)) return out;
  const [lo, hi] = box;
  const i0 = Math.ceil(lo[0] / step), i1 = Math.floor(hi[0] / step);
  const j0 = Math.ceil(lo[1] / step), j1 = Math.floor(hi[1] / step);
  const at = (k: number) => k * step || 0; // no -0
  for (let i = i0; i <= i1; i++) out.push([[at(i), lo[1]], [at(i), hi[1]], i % GRID_MAJOR === 0]);
  for (let j = j0; j <= j1; j++) out.push([[lo[0], at(j)], [hi[0], at(j)], j % GRID_MAJOR === 0]);
  return out;
}

/** The nearest grid node; `keep` "x" or "y" leaves that coordinate as it is (a horizontal/vertical lock). */
export function snapToGrid(p: V2, step: number, keep: "x" | "y" | null = null): V2 {
  if (!(step > 0)) return p;
  const r = (v: number) => { const q = Math.round(v / step) * step; return Math.abs(q) < 1e-12 ? 0 : q; };
  return [keep === "x" ? p[0] : r(p[0]), keep === "y" ? p[1] : r(p[1])];
}
