// 2D geometry on feature primitives: hit tests, nearest boundary points,
// edge-to-edge clearance and a uniform grid for fast lookups.

import type { Prim } from "./model";
import type { Feature, FeatStore } from "./build";

export type P2 = [number, number];

export function closestOnSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): P2 {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return [ax + t * dx, ay + t * dy];
}

export function pointInPoly(x: number, y: number, pts: number[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function primContains(p: Prim, x: number, y: number) {
  if (p.k === "c") { const [cx, cy] = closestOnSeg(x, y, p.ax, p.ay, p.bx, p.by); return Math.hypot(x - cx, y - cy) <= p.r; }
  return pointInPoly(x, y, p.pts);
}

/** Nearest point on a primitive's boundary. */
export function nearestOnBoundary(p: Prim, x: number, y: number): P2 | null {
  if (p.k === "c") {
    const [cx, cy] = closestOnSeg(x, y, p.ax, p.ay, p.bx, p.by);
    const d = Math.hypot(x - cx, y - cy);
    if (d < 1e-12 || p.r <= 0) return p.r <= 0 ? [cx, cy] : null;
    return [cx + ((x - cx) / d) * p.r, cy + ((y - cy) / d) * p.r];
  }
  let best: P2 | null = null, bd = Infinity;
  const n = p.pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const q = closestOnSeg(x, y, p.pts[i], p.pts[i + 1], p.pts[j], p.pts[j + 1]);
    const d = Math.hypot(q[0] - x, q[1] - y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

/** Closest points between two segments. */
export function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): { d: number; p: P2; q: P2 } {
  const cands: [P2, P2][] = [];
  // Proper intersection
  const r = [bx - ax, by - ay], s = [dx - cx, dy - cy];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) > 1e-18) {
    const t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / den, u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { const p: P2 = [ax + t * r[0], ay + t * r[1]]; return { d: 0, p, q: p }; }
  }
  cands.push([[ax, ay], closestOnSeg(ax, ay, cx, cy, dx, dy)]);
  cands.push([[bx, by], closestOnSeg(bx, by, cx, cy, dx, dy)]);
  cands.push([closestOnSeg(cx, cy, ax, ay, bx, by), [cx, cy]]);
  cands.push([closestOnSeg(dx, dy, ax, ay, bx, by), [dx, dy]]);
  let best = cands[0], bd = Infinity;
  for (const c of cands) { const d = Math.hypot(c[0][0] - c[1][0], c[0][1] - c[1][1]); if (d < bd) { bd = d; best = c; } }
  return { d: bd, p: best[0], q: best[1] };
}

function edges(p: Prim): number[][] {
  if (p.k === "c") return [[p.ax, p.ay, p.bx, p.by]];
  const out: number[][] = [];
  for (let i = 0; i < p.pts.length; i += 2) { const j = (i + 2) % p.pts.length; out.push([p.pts[i], p.pts[i + 1], p.pts[j], p.pts[j + 1]]); }
  return out;
}

/** Edge-to-edge distance between two primitives (0 when they touch or overlap), with the closest boundary points. */
export function primGap(a: Prim, b: Prim): { d: number; p: P2; q: P2 } {
  const ra = a.k === "c" ? a.r : 0, rb = b.k === "c" ? b.r : 0;
  // Overlap tests for polygons (a capsule's spine inside a polygon, or a vertex inside the other polygon).
  if (a.k === "p" && pointInPoly(b.k === "c" ? b.ax : b.pts[0], b.k === "c" ? b.ay : b.pts[1], a.pts)) { const p: P2 = b.k === "c" ? [b.ax, b.ay] : [b.pts[0], b.pts[1]]; return { d: 0, p, q: p }; }
  if (b.k === "p" && pointInPoly(a.k === "c" ? a.ax : a.pts[0], a.k === "c" ? a.ay : a.pts[1], b.pts)) { const p: P2 = a.k === "c" ? [a.ax, a.ay] : [a.pts[0], a.pts[1]]; return { d: 0, p, q: p }; }
  let best = { d: Infinity, p: [0, 0] as P2, q: [0, 0] as P2 };
  for (const e of edges(a)) for (const g of edges(b)) {
    const s = segSeg(e[0], e[1], e[2], e[3], g[0], g[1], g[2], g[3]);
    if (s.d < best.d) best = s;
  }
  const gap = best.d - ra - rb;
  if (gap <= 0) { const m: P2 = [(best.p[0] + best.q[0]) / 2, (best.p[1] + best.q[1]) / 2]; return { d: 0, p: m, q: m }; }
  const ux = (best.q[0] - best.p[0]) / best.d, uy = (best.q[1] - best.p[1]) / best.d;
  return { d: gap, p: [best.p[0] + ux * ra, best.p[1] + uy * ra], q: [best.q[0] - ux * rb, best.q[1] - uy * rb] };
}

/** Clearance between two features: the smallest gap over their primitives. */
export function featureGap(a: Feature, b: Feature) {
  let best = { d: Infinity, p: [0, 0] as P2, q: [0, 0] as P2 };
  for (const pa of a.prims) for (const pb of b.prims) {
    if (best.d === 0) return best;
    const g = primGap(pa, pb);
    if (g.d < best.d) best = g;
  }
  return best;
}

// ---------- grid ----------

export class Grid {
  private cells = new Map<number, number[]>();
  private big: number[] = [];
  private cs: number;
  private x0: number;
  private y0: number;
  constructor(feats: FeatStore, bbox: [number, number, number, number]) {
    const w = Math.max(bbox[2] - bbox[0], 1e-3), h = Math.max(bbox[3] - bbox[1], 1e-3);
    this.cs = Math.max(Math.sqrt((w * h) / Math.max(256, feats.length)), 0.05);
    this.x0 = bbox[0]; this.y0 = bbox[1];
    const B = feats.p.bb;
    for (let i = 0; i < feats.length; i++) {
      if (!(B[4 * i] <= B[4 * i + 2])) continue;
      const [i0, j0, i1, j1] = this.range(B[4 * i], B[4 * i + 1], B[4 * i + 2], B[4 * i + 3]);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) { this.big.push(i); continue; } // huge pours: always tested
      for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) {
        const k = a * 100003 + b;
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
      }
    }
  }
  private range(x0: number, y0: number, x1: number, y1: number) {
    const c = this.cs;
    return [Math.floor((x0 - this.x0) / c), Math.floor((y0 - this.y0) / c), Math.floor((x1 - this.x0) / c), Math.floor((y1 - this.y0) / c)];
  }
  /** Feature indices whose cells overlap the box (may contain duplicates). */
  query(x0: number, y0: number, x1: number, y1: number, out = new Set<number>()) {
    const [i0, j0, i1, j1] = this.range(x0, y0, x1, y1);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 20000) { for (const l of this.cells.values()) for (const i of l) out.add(i); for (const i of this.big) out.add(i); return out; }
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) { const l = this.cells.get(a * 100003 + b); if (l) for (const i of l) out.add(i); }
    for (const i of this.big) out.add(i);
    return out;
  }
}
