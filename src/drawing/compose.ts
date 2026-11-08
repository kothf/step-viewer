// Composes a sheet into primitives: the sheet format plus every view's lines,
// placed and scaled, filtered by the view's display style and tangent edges.
// Section views add hatching on their cut faces; detail views are their parent's
// lines clipped to a circle; parents carry the cutting lines, detail circles and
// view arrows of the views made from them (FR-DRW-012/013/014).
import type { Projection, Seg2, V3 } from "../kernel/drawing";
import type { Pen, Layer, Prim } from "./prims";
import { formatPrims, type Fields } from "./sheet";
import type { DrawingView, HatchPattern, Sheet } from "./types";
import { sheetNotes, viewAnnots, type AnnotCtx } from "./annot";
import { alignedLegs, altReq, boxInView, cutLegs, findView, isShaded, lookDir, type CutLeg, viewReq, viewDir, viewScale, viewScalePair, scaleText } from "./views";

export interface ViewBox { id: string; x0: number; y0: number; x1: number; y1: number; ready: boolean }

/** Where a view's model coordinates land on the sheet. */
export interface Placement {
  s: number; uc: number; vc: number; x: number; y: number; box: [number, number, number, number]; ready: boolean;
  /** A broken view (FR-DRW-015): model point → closed-up view axes, and back. `box`, `uc` and `vc` are closed up. */
  sq?: (u: number, w: number) => [number, number];
  unsq?: (u: number, w: number) => [number, number];
}

export function placement(sheet: Sheet, v: DrawingView, proj: Projection | undefined, modelBox: [V3, V3] | null): Placement {
  const s = viewScale(sheet, v);
  let box: [number, number, number, number];
  if (v.kind === "detail" && v.outline && v.outline.length >= 6) box = polyBox(v.outline);
  else if (v.kind === "detail" && v.c && v.r) box = [v.c[0] - v.r, v.c[1] - v.r, v.c[0] + v.r, v.c[1] + v.r];
  else box = proj && (proj.vis.length || proj.hid.length) ? proj.box : modelBox ? boxInView(modelBox, viewDir(sheet, v)) : [-10, -10, 10, 10];
  const c = cropOf(v);
  if (c) {
    const b: [number, number, number, number] = [Math.max(box[0], c[0]), Math.max(box[1], c[1]), Math.min(box[2], c[2]), Math.min(box[3], c[3])];
    box = b[0] < b[2] && b[1] < b[3] ? b : c;
  }
  const bm = breakMap(v, s);
  if (bm) { const [u0, w0] = bm.fwd(box[0], box[1]), [u1, w1] = bm.fwd(box[2], box[3]); box = [u0, w0, u1, w1]; }
  return { s, uc: (box[0] + box[2]) / 2, vc: (box[1] + box[3]) / 2, x: v.x, y: v.y, box, ready: !!proj, ...(bm ? { sq: bm.fwd, unsq: bm.inv } : {}) };
}

export function viewRect(p: Placement): [number, number, number, number] {
  const hw = (p.box[2] - p.box[0]) / 2 * p.s, hh = (p.box[3] - p.box[1]) / 2 * p.s;
  return [p.x - hw, p.y - hh, p.x + hw, p.y + hh];
}

/** Model point of a view (its own axes) → sheet. */
export const toSheet = (pl: Placement, u: number, w: number): [number, number] => {
  if (pl.sq) [u, w] = pl.sq(u, w);
  return [pl.x + (u - pl.uc) * pl.s, pl.y + (w - pl.vc) * pl.s];
};
/** Sheet point → model point of a view. */
export const fromSheet = (pl: Placement, x: number, y: number): [number, number] => {
  const u = pl.uc + (x - pl.x) / pl.s, w = pl.vc + (y - pl.y) / pl.s;
  return pl.unsq ? pl.unsq(u, w) : [u, w];
};

// ---------- crop and break views (FR-DRW-015) ----------

/** The gap a break closes up to, on the sheet (mm). */
export const BREAK_GAP = 6;

/** A view's crop rectangle, ordered, or null. */
export function cropOf(v: DrawingView): [number, number, number, number] | null {
  const c = v.kind === "detail" ? undefined : v.crop;
  if (!c) return null;
  const r: [number, number, number, number] = [Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])];
  return r[2] - r[0] > 1e-6 && r[3] - r[1] > 1e-6 ? r : null;
}

interface Band { a: number; b: number }
/**
 * How a broken view closes up: bands along u (axis 0) and v (axis 1), merged and sorted; `fwd` maps a model point to
 * the closed-up axes (a point inside a band lands proportionally inside its gap, so `inv` undoes it exactly). Null without breaks.
 */
export function breakMap(v: DrawingView, s: number): { bands: [Band[], Band[]]; G: number; fwd: (u: number, w: number) => [number, number]; inv: (u: number, w: number) => [number, number] } | null {
  if (v.kind === "detail" || !v.breaks?.length) return null;
  const G = BREAK_GAP / s;
  const bands: [Band[], Band[]] = [[], []];
  for (const ax of [0, 1] as const) {
    const list = v.breaks.filter(b => (b.axis === "u") === (ax === 0)).map(b => ({ a: Math.min(b.a, b.b), b: Math.max(b.a, b.b) })).sort((p, q) => p.a - q.a);
    for (const b of list) { const last = bands[ax].at(-1); if (last && b.a <= last.b) last.b = Math.max(last.b, b.b); else bands[ax].push({ ...b }); }
    bands[ax] = bands[ax].filter(b => b.b - b.a > G * 1.01);
  }
  if (!bands[0].length && !bands[1].length) return null;
  const f = (x: number, list: Band[]) => {
    let sh = 0;
    for (const b of list) { if (x <= b.a) break; if (x < b.b) return b.a - sh + (x - b.a) / (b.b - b.a) * G; sh += b.b - b.a - G; }
    return x - sh;
  };
  const g = (y: number, list: Band[]) => {
    let sh = 0;
    for (const b of list) { const a2 = b.a - sh; if (y <= a2) break; if (y < a2 + G) return b.a + (y - a2) / G * (b.b - b.a); sh += b.b - b.a - G; }
    return y + sh;
  };
  return { bands, G, fwd: (u, w) => [f(u, bands[0]), f(w, bands[1])], inv: (u, w) => [g(u, bands[0]), g(w, bands[1])] };
}

/** The parts of segments on one side of the line u = at (axis 0) or v = at (axis 1). */
export function clipHalf(segs: Seg2[], axis: 0 | 1, at: number, below: boolean): Seg2[] {
  const inside = (x: number) => (below ? x <= at + 1e-9 : x >= at - 1e-9);
  const out: Seg2[] = [];
  const cut = (ax: number, ay: number, bx: number, by: number): [number, number] | null => {
    const a = axis ? ay : ax, b = axis ? by : bx, ia = inside(a), ib = inside(b);
    if (ia && ib) return [0, 1];
    if (!ia && !ib) return null;
    const t = (at - a) / (b - a);
    return ia ? [0, t] : [t, 1];
  };
  for (const g of segs) {
    if (g.k === "l") {
      const t = cut(g.p[0], g.p[1], g.p[2], g.p[3]);
      if (t) { const L = (k: number) => [g.p[0] + (g.p[2] - g.p[0]) * k, g.p[1] + (g.p[3] - g.p[1]) * k]; out.push({ ...g, p: [...L(t[0]), ...L(t[1])] as [number, number, number, number] }); }
    } else if (g.k === "a") {
      const d = (at - g.o[axis]) / g.r, cuts = [g.a0, g.a1];
      if (Math.abs(d) < 1) {
        const base = axis ? Math.asin(d) : Math.acos(d);
        for (const a of axis ? [base, Math.PI - base] : [base, -base]) for (let k = -2; k <= 2; k++) { const x = a + k * 2 * Math.PI; if (x > g.a0 && x < g.a1) cuts.push(x); }
      }
      cuts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2;
        if (cuts[i + 1] - cuts[i] > 1e-9 && inside(g.o[axis] + g.r * (axis ? Math.sin(m) : Math.cos(m)))) out.push({ ...g, a0: cuts[i], a1: cuts[i + 1] });
      }
    } else {
      let run: number[] = [];
      const flush = () => { if (run.length >= 4) out.push({ k: "p", c: g.c, p: run }); run = []; };
      for (let i = 0; i + 3 < g.p.length; i += 2) {
        const t = cut(g.p[i], g.p[i + 1], g.p[i + 2], g.p[i + 3]);
        if (!t) { flush(); continue; }
        const P = (k: number) => [g.p[i] + (g.p[i + 2] - g.p[i]) * k, g.p[i + 1] + (g.p[i + 3] - g.p[i + 1]) * k];
        if (t[0] > 1e-9) { flush(); run.push(...P(t[0])); } else if (!run.length) run.push(...P(0));
        run.push(...P(t[1]));
        if (t[1] < 1 - 1e-9) flush();
      }
      flush();
    }
  }
  return out;
}

/** A view's segments (model view axes) cropped and broken: what is left, closed up. */
export function trimSegs(v: DrawingView, s: number, segs: Seg2[]): Seg2[] {
  const c = cropOf(v);
  if (c) segs = clipHalf(clipHalf(clipHalf(clipHalf(segs, 0, c[0], false), 0, c[2], true), 1, c[1], false), 1, c[3], true);
  const bm = breakMap(v, s);
  if (!bm) return segs;
  for (const ax of [0, 1] as const) for (const b of bm.bands[ax]) segs = [...clipHalf(segs, ax, b.a, true), ...clipHalf(segs, ax, b.b, false)];
  // Each piece now lies between two bands: move it by that interval's shift.
  return segs.map(g => {
    const mid: [number, number] = g.k === "l" ? [(g.p[0] + g.p[2]) / 2, (g.p[1] + g.p[3]) / 2]
      : g.k === "a" ? [g.o[0] + g.r * Math.cos((g.a0 + g.a1) / 2), g.o[1] + g.r * Math.sin((g.a0 + g.a1) / 2)]
      : [(g.p[0] + g.p[2]) / 2, (g.p[1] + g.p[3]) / 2];
    const [fu, fw] = bm.fwd(mid[0], mid[1]), du = fu - mid[0], dw = fw - mid[1];
    if (Math.abs(du) < 1e-12 && Math.abs(dw) < 1e-12) return g;
    if (g.k === "l") return { ...g, p: [g.p[0] + du, g.p[1] + dw, g.p[2] + du, g.p[3] + dw] as [number, number, number, number] };
    if (g.k === "a") return { ...g, o: [g.o[0] + du, g.o[1] + dw] as [number, number] };
    return { ...g, p: g.p.map((x, i) => x + (i % 2 ? dw : du)) };
  });
}

/** Extra lines of a view in its model axes (threads, sketches), clipped and closed up like its edges. */
export function decorPrims(v: DrawingView, pl: Placement, segs: Seg2[], pen: Pen, layer: Layer): Prim[] {
  segs = clipDetail(v, segs);
  const X = (u: number) => pl.x + (u - pl.uc) * pl.s, Y = (w: number) => pl.y + (w - pl.vc) * pl.s;
  const out: Prim[] = [];
  for (const g of trimSegs(v, pl.s, segs)) {
    if (g.k === "l") out.push({ t: "l", p: [X(g.p[0]), Y(g.p[1]), X(g.p[2]), Y(g.p[3])], pen, layer });
    else if (g.k === "a") out.push({ t: "a", o: [X(g.o[0]), Y(g.o[1])], r: g.r * pl.s, a0: g.a0, a1: g.a1, pen, layer });
    else { const p: number[] = []; for (let i = 0; i < g.p.length; i += 2) p.push(X(g.p[i]), Y(g.p[i + 1])); out.push({ t: "p", p, pen, layer }); }
  }
  return out;
}

/** Zig-zag break lines (ISO 128) at each closed-up band, across the view, in sheet mm. */
function breakLines(v: DrawingView, pl: Placement): Prim[] {
  const bm = breakMap(v, pl.s);
  if (!bm) return [];
  const out: Prim[] = [];
  const r = viewRect(pl);
  for (const ax of [0, 1] as const) {
    let sh = 0;
    for (const b of bm.bands[ax]) {
      const a2 = b.a - sh;
      sh += b.b - b.a - bm.G;
      for (const at of [a2, a2 + bm.G]) {
        const k = ax ? pl.y + (at - pl.vc) * pl.s : pl.x + (at - pl.uc) * pl.s;
        const lo = (ax ? r[0] : r[1]) - 2, hi = (ax ? r[2] : r[3]) + 2, m = (lo + hi) / 2;
        const pts = [[k, lo], [k, m - 1.5], [k + 1.2, m - 0.7], [k - 1.2, m + 0.7], [k, m + 1.5], [k, hi]];
        out.push({ t: "p", p: pts.flatMap(([q, w]) => (ax ? [w, q] : [q, w])), pen: "thin", layer: "VISIBLE" });
      }
    }
  }
  return out;
}

// ---------- clipping to a detail profile (FR-DRW-013) ----------

export function polyBox(p: number[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < p.length; i += 2) { b[0] = Math.min(b[0], p[i]); b[1] = Math.min(b[1], p[i + 1]); b[2] = Math.max(b[2], p[i]); b[3] = Math.max(b[3], p[i + 1]); }
  return b;
}

/** Even-odd test of (x, y) against a closed polygon of u, v pairs. */
export function inPoly(p: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < xj + (y - yj) * (xi - xj) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/** The detail view's boundary trims its lines: the profile when it has one, else the circle. */
export function clipDetail(v: DrawingView, segs: Seg2[]): Seg2[] {
  if (v.kind !== "detail") return segs;
  if (v.outline && v.outline.length >= 6) return clipToPoly(segs, v.outline);
  return v.c && v.r ? clipToCircle(segs, v.c, v.r) : segs;
}

/** Parameters where segment a→b crosses the polygon's edges, with 0 and 1, sorted. */
function polyCuts(p: number[], ax: number, ay: number, bx: number, by: number): number[] {
  const ts = [0, 1], dx = bx - ax, dy = by - ay;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const ex = p[i] - p[j], ey = p[i + 1] - p[j + 1], den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-15) continue;
    const wx = p[j] - ax, wy = p[j + 1] - ay;
    const t = (wx * ey - wy * ex) / den, s = (wx * dy - wy * dx) / den;
    if (t > 1e-12 && t < 1 - 1e-12 && s >= -1e-12 && s <= 1 + 1e-12) ts.push(t);
  }
  return ts.sort((a, b) => a - b);
}

export function clipToPoly(segs: Seg2[], poly: number[]): Seg2[] {
  const out: Seg2[] = [];
  const pieces = (ax: number, ay: number, bx: number, by: number) => {
    const ts = polyCuts(poly, ax, ay, bx, by), keep: [number, number][] = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const m = (ts[i] + ts[i + 1]) / 2;
      if (ts[i + 1] - ts[i] > 1e-12 && inPoly(poly, ax + (bx - ax) * m, ay + (by - ay) * m)) {
        // Pieces meeting at a corner of the profile are one piece.
        const last = keep[keep.length - 1];
        if (last && Math.abs(last[1] - ts[i]) < 1e-12) last[1] = ts[i + 1]; else keep.push([ts[i], ts[i + 1]]);
      }
    }
    return keep;
  };
  for (const g of segs) {
    if (g.k === "l") {
      const L = (k: number) => [g.p[0] + (g.p[2] - g.p[0]) * k, g.p[1] + (g.p[3] - g.p[1]) * k];
      for (const [t0, t1] of pieces(g.p[0], g.p[1], g.p[2], g.p[3])) out.push({ ...g, p: [...L(t0), ...L(t1)] as [number, number, number, number] });
    } else if (g.k === "a") {
      // Split where the arc's circle meets each polygon edge; keep the pieces whose middle is inside.
      const cuts = [g.a0, g.a1];
      for (let i = 0, n = poly.length, j = n - 2; i < n; j = i, i += 2) {
        const ax = poly[j] - g.o[0], ay = poly[j + 1] - g.o[1], dx = poly[i] - poly[j], dy = poly[i + 1] - poly[j + 1];
        const A = dx * dx + dy * dy, B = 2 * (ax * dx + ay * dy), C = ax * ax + ay * ay - g.r * g.r, D = B * B - 4 * A * C;
        if (A < 1e-18 || D < 0) continue;
        for (const t of [(-B - Math.sqrt(D)) / (2 * A), (-B + Math.sqrt(D)) / (2 * A)]) {
          if (t < -1e-12 || t > 1 + 1e-12) continue;
          const a = Math.atan2(ay + dy * t, ax + dx * t);
          for (let k = -2; k <= 2; k++) { const x = a + k * 2 * Math.PI; if (x > g.a0 && x < g.a1) cuts.push(x); }
        }
      }
      cuts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2;
        if (cuts[i + 1] - cuts[i] > 1e-9 && inPoly(poly, g.o[0] + g.r * Math.cos(m), g.o[1] + g.r * Math.sin(m))) out.push({ ...g, a0: cuts[i], a1: cuts[i + 1] });
      }
    } else {
      let run: number[] = [];
      const flush = () => { if (run.length >= 4) out.push({ k: "p", c: g.c, p: run }); run = []; };
      for (let i = 0; i + 3 < g.p.length; i += 2) {
        const P = (k: number) => [g.p[i] + (g.p[i + 2] - g.p[i]) * k, g.p[i + 1] + (g.p[i + 3] - g.p[i + 1]) * k];
        const keep = pieces(g.p[i], g.p[i + 1], g.p[i + 2], g.p[i + 3]);
        if (!keep.length) { flush(); continue; }
        for (const [t0, t1] of keep) {
          if (t0 > 1e-9 || !run.length) { flush(); run.push(...P(t0)); }
          run.push(...P(t1));
          if (t1 < 1 - 1e-9) flush();
        }
      }
      flush();
    }
  }
  return out;
}

// ---------- clipping to a circle (detail views) ----------

/** Parameters t in [0, 1] of the parts of segment a→b inside the circle. */
function clipLine(ax: number, ay: number, bx: number, by: number, c: [number, number], R: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay, fx = ax - c[0], fy = ay - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R * R;
  if (A < 1e-18) return C <= 0 ? [0, 1] : null;
  const D = B * B - 4 * A * C;
  if (D <= 0) return null;
  const q = Math.sqrt(D), t0 = Math.max(0, (-B - q) / (2 * A)), t1 = Math.min(1, (-B + q) / (2 * A));
  return t1 > t0 ? [t0, t1] : null;
}

export function clipToCircle(segs: Seg2[], c: [number, number], R: number): Seg2[] {
  const out: Seg2[] = [];
  for (const g of segs) {
    if (g.k === "l") {
      const t = clipLine(g.p[0], g.p[1], g.p[2], g.p[3], c, R);
      if (t) { const L = (k: number) => [g.p[0] + (g.p[2] - g.p[0]) * k, g.p[1] + (g.p[3] - g.p[1]) * k]; out.push({ ...g, p: [...L(t[0]), ...L(t[1])] as [number, number, number, number] }); }
    } else if (g.k === "a") {
      // Split the arc where it crosses the clip circle, keep the pieces whose middle is inside.
      const d = Math.hypot(g.o[0] - c[0], g.o[1] - c[1]);
      const cuts = [g.a0, g.a1];
      if (d > 1e-12 && d < g.r + R && d > Math.abs(g.r - R)) {
        const base = Math.atan2(c[1] - g.o[1], c[0] - g.o[0]), h = Math.acos((g.r * g.r + d * d - R * R) / (2 * g.r * d));
        for (const a of [base - h, base + h]) for (let k = -2; k <= 2; k++) { const x = a + k * 2 * Math.PI; if (x > g.a0 && x < g.a1) cuts.push(x); }
      }
      cuts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const m = (cuts[i] + cuts[i + 1]) / 2;
        if (cuts[i + 1] - cuts[i] > 1e-9 && Math.hypot(g.o[0] + g.r * Math.cos(m) - c[0], g.o[1] + g.r * Math.sin(m) - c[1]) < R) out.push({ ...g, a0: cuts[i], a1: cuts[i + 1] });
      }
    } else {
      let run: number[] = [];
      const flush = () => { if (run.length >= 4) out.push({ k: "p", c: g.c, p: run }); run = []; };
      for (let i = 0; i + 3 < g.p.length; i += 2) {
        const t = clipLine(g.p[i], g.p[i + 1], g.p[i + 2], g.p[i + 3], c, R);
        if (!t) { flush(); continue; }
        const P = (k: number) => [g.p[i] + (g.p[i + 2] - g.p[i]) * k, g.p[i + 1] + (g.p[i + 3] - g.p[i + 1]) * k];
        if (t[0] > 1e-9) { flush(); run.push(...P(t[0])); } else if (!run.length) run.push(...P(0));
        run.push(...P(t[1]));
        if (t[1] < 1 - 1e-9) flush();
      }
      flush();
    }
  }
  return out;
}

// ---------- hatching (section views) ----------

/** 45° hatch lines inside closed loops (sheet mm, even-odd), `gap` apart, shifted `offset` across; `dash` = [on, off] lengths. */
export function hatch(loops: number[][], gap = 2.5, angle = Math.PI / 4, offset = 0, dash?: [number, number]): [number, number, number, number][] {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  // Rotate so the hatch lines are horizontal: y' = −x·sin + y·cos.
  const rot = loops.map(l => { const r: number[] = []; for (let i = 0; i < l.length; i += 2) r.push(l[i] * ca + l[i + 1] * sa, -l[i] * sa + l[i + 1] * ca); return r; });
  let y0 = Infinity, y1 = -Infinity;
  for (const l of rot) for (let i = 1; i < l.length; i += 2) { y0 = Math.min(y0, l[i]); y1 = Math.max(y1, l[i]); }
  const out: [number, number, number, number][] = [];
  if (!isFinite(y0)) return out;
  for (let y = Math.ceil((y0 - offset) / gap) * gap + offset; y <= y1; y += gap) {
    const xs: number[] = [];
    for (const l of rot) {
      const n = l.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = l[2 * i], ay = l[2 * i + 1], bx = l[(2 * i + 2) % l.length], by = l[(2 * i + 3) % l.length];
        if ((ay <= y) !== (by <= y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = xs[i], b = xs[i + 1];
      if (b - a < 1e-6) continue;
      if (!dash) { out.push([a * ca - y * sa, a * sa + y * ca, b * ca - y * sa, b * sa + y * ca]); continue; }
      // Dashes keep their phase from the origin, so neighbouring loops line up.
      const per = dash[0] + dash[1];
      for (let s0 = Math.floor(a / per) * per; s0 < b; s0 += per) {
        const p = Math.max(a, s0), q = Math.min(b, s0 + dash[0]);
        if (q - p > 1e-6) out.push([p * ca - y * sa, p * sa + y * ca, q * ca - y * sa, q * sa + y * ca]);
      }
    }
  }
  return out;
}

// ---------- a view's primitives ----------

/** Hatch spacing (sheet mm), angle (degrees) and pattern of a view. */
export function hatchOf(v: DrawingView): { gap: number; angle: number; pattern: HatchPattern } {
  return { gap: Math.max(0.5, v.hatch?.gap ?? 2.5), angle: v.hatch?.angle ?? 45, pattern: v.hatch?.pattern ?? "material" };
}

/** The hatch patterns a view can use, in menu order. */
export const HATCH_PATTERNS: { id: HatchPattern; name: string }[] = [
  { id: "material", name: "By material" },
  { id: "ansi31", name: "ANSI31 (iron, general)" },
  { id: "ansi32", name: "ANSI32 (steel)" },
  { id: "ansi33", name: "ANSI33 (brass, bronze, copper)" },
  { id: "ansi34", name: "ANSI34 (plastic, rubber)" },
  { id: "ansi37", name: "ANSI37 (lead, zinc, insulation)" },
  { id: "ansi38", name: "ANSI38 (aluminium)" },
];

/** The ANSI pattern for a material name (ANSI Y14.2); anything unknown is general use (ANSI31). */
export function materialPattern(mat: string | null | undefined): Exclude<HatchPattern, "material"> {
  const m = (mat ?? "").toLowerCase();
  if (/steel/.test(m)) return "ansi32";
  if (/brass|bronze|copper/.test(m)) return "ansi33";
  if (/alumin|magnes/.test(m)) return "ansi38";
  if (/lead|zinc|insulat/.test(m)) return "ansi37";
  if (/\b(abs|pla|petg|nylon|pa\d*|pom|delrin|peek|rubber|plastic|polycarbonate|polyamide|polypropylene|polyethylene|pvc|ptfe)\b/.test(m)) return "ansi34";
  return "ansi31";
}

/**
 * Hatch lines of one pattern inside loops (sheet mm, even-odd): `gap` is the pattern's base spacing, `angle` its
 * main direction (radians). Line families follow the ANSI patterns' look at drawing scale.
 */
export function patternHatch(loops: number[][], pattern: Exclude<HatchPattern, "material">, gap: number, angle: number): [number, number, number, number][] {
  const g = gap, q = Math.PI / 2;
  switch (pattern) {
    case "ansi32": return [...hatch(loops, 2 * g, angle), ...hatch(loops, 2 * g, angle, 0.5 * g)];
    case "ansi33": return [...hatch(loops, 2 * g, angle), ...hatch(loops, 2 * g, angle, g, [g, 0.5 * g])];
    case "ansi34": return [0, 0.3, 0.6, 0.9].flatMap(k => hatch(loops, 2.5 * g, angle, k * g));
    case "ansi37": return [...hatch(loops, g, angle), ...hatch(loops, g, angle + q)];
    case "ansi38": return [...hatch(loops, g, angle), ...hatch(loops, 2 * g, angle + q, 0, [g, g])];
    default: return hatch(loops, g, angle);
  }
}

/**
 * The hatch lines of a section's cut loops (sheet mm). Loops are grouped by who they belong to (`keys`: component or
 * body); each group gets its material's pattern (or the view's), and neighbouring groups turn 90° and change spacing so
 * parts in an assembly section tell apart (FR-DRW-012).
 */
export function sectionHatch(loops: number[][], hs: { gap: number; angle: number; pattern: HatchPattern }, keys?: string[], mats?: (string | null)[]): [number, number, number, number][] {
  const groups = new Map<string, { loops: number[][]; mat: string | null }>();
  loops.forEach((l, i) => {
    const k = keys?.[i] ?? "";
    let g = groups.get(k);
    if (!g) groups.set(k, g = { loops: [], mat: mats?.[i] ?? null });
    g.loops.push(l);
  });
  const SCALE = [1, 1, 0.75, 0.75, 1.4, 1.4], out: [number, number, number, number][] = [];
  let j = 0;
  for (const g of groups.values()) {
    const pat = hs.pattern === "material" ? materialPattern(g.mat) : hs.pattern;
    const multi = groups.size > 1;
    const ang = (hs.angle + (multi && j % 2 ? 90 : 0)) * Math.PI / 180, gap = hs.gap * (multi ? SCALE[j % SCALE.length] : 1);
    out.push(...patternHatch(g.loops, pat, gap, ang));
    j++;
  }
  return out;
}

/** A view's lines in sheet mm. */
export function viewPrims(v: DrawingView, proj: Projection, pl: Placement): Prim[] {
  const out: Prim[] = [];
  const style = v.style ?? (v.kind === "section" ? "hlr" : "hlv"), tan = v.tangent ?? "visible";
  const X = (u: number) => pl.x + (u - pl.uc) * pl.s, Y = (w: number) => pl.y + (w - pl.vc) * pl.s;
  const put = (g: Seg2, pen: Pen, layer: Layer) => {
    if (g.k === "l") out.push({ t: "l", p: [X(g.p[0]), Y(g.p[1]), X(g.p[2]), Y(g.p[3])], pen, layer });
    else if (g.k === "a") out.push({ t: "a", o: [X(g.o[0]), Y(g.o[1])], r: g.r * pl.s, a0: g.a0, a1: g.a1, pen, layer });
    else { const p: number[] = []; for (let i = 0; i < g.p.length; i += 2) p.push(X(g.p[i]), Y(g.p[i + 1])); out.push({ t: "p", p, pen, layer }); }
  };
  let vis = proj.vis, hid = proj.hid;
  const shaded = isShaded(v) && !!proj.shade;
  if (shaded) {
    out.push(...shadePrims(v, proj.shade!, pl));
    hid = [];
    if (style === "shaded") vis = [];
  }
  vis = clipDetail(v, vis); hid = clipDetail(v, hid);
  vis = trimSegs(v, pl.s, vis); hid = trimSegs(v, pl.s, hid);
  if (proj.cut?.length) {
    // Hatch lines are spaced on the sheet but made in model axes, so a detail circle, crop or break trims them like the lines.
    const loops = proj.cut.map(l => l.map(x => x * pl.s));
    const hs = hatchOf(v);
    let hs2: Seg2[] = sectionHatch(loops, hs, proj.cutKey, proj.cutMat).map(h => ({ k: "l", c: 0, p: h.map(x => x / pl.s) as [number, number, number, number] }));
    hs2 = clipDetail(v, hs2);
    for (const g of trimSegs(v, pl.s, hs2)) put(g, "thin", "HATCH");
  }
  // Hidden lines first, so visible ones draw over them.
  if (style !== "hlr") for (const g of hid) {
    if (g.c === 1 && (tan === "hidden" || style === "hlv")) continue;
    put(g, style === "wire" ? (g.c === 1 && tan === "thin" ? "thin" : "thick") : "hidden", style === "wire" ? (g.c === 1 ? "TANGENT" : "VISIBLE") : "HIDDEN");
  }
  for (const g of vis) {
    if (g.c === 1) { if (tan !== "hidden") put(g, tan === "thin" ? "thin" : "thick", "TANGENT"); }
    else put(g, "thick", "VISIBLE");
  }
  if (v.kind === "detail" && v.outline && v.outline.length >= 6) out.push({ t: "p", p: v.outline.map((x, i) => i % 2 ? pl.y + (x - pl.vc) * pl.s : pl.x + (x - pl.uc) * pl.s), pen: "thin", layer: "ANNOT", closed: true });
  else if (v.kind === "detail" && v.r) out.push({ t: "a", o: [pl.x, pl.y], r: v.r * pl.s, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
  out.push(...breakLines(v, pl));
  return out;
}

/**
 * A shaded view's triangles on the sheet (FR-DRW-010). A detail view keeps the ones whose middle is inside its
 * circle; crop and break views keep the ones whose middle survives, moved with it.
 */
export function shadePrims(v: DrawingView, tris: number[], pl: Placement): Prim[] {
  const out: Prim[] = [];
  const X = (u: number) => pl.x + (u - pl.uc) * pl.s, Y = (w: number) => pl.y + (w - pl.vc) * pl.s;
  const det = v.kind === "detail" && v.c && v.r ? { c: v.c, r2: v.r * v.r } : null, trim = !!(v.crop || v.breaks?.length);
  for (let i = 0; i + 6 < tris.length; i += 7) {
    const cu = (tris[i] + tris[i + 2] + tris[i + 4]) / 3, cv = (tris[i + 1] + tris[i + 3] + tris[i + 5]) / 3;
    if (det && (v.outline ? !inPoly(v.outline, cu, cv) : (cu - det.c[0]) ** 2 + (cv - det.c[1]) ** 2 > det.r2)) continue;
    let du = 0, dv = 0;
    if (trim) {
      const kept = trimSegs(v, pl.s, [{ k: "l", c: 0, p: [cu, cv, cu + 1e-6, cv] }]);
      if (!kept.length || kept[0].k !== "l") continue;
      du = kept[0].p[0] - cu; dv = kept[0].p[1] - cv;
    }
    out.push({ t: "p", p: [X(tris[i] + du), Y(tris[i + 1] + dv), X(tris[i + 2] + du), Y(tris[i + 3] + dv), X(tris[i + 4] + du), Y(tris[i + 5] + dv)], pen: "thin", layer: "SHADE", fill: true, closed: true, gray: tris[i + 6] });
  }
  return out;
}

/** A filled arrowhead with its tip at (x, y), pointing along (dx, dy). */
export function arrowHead(x: number, y: number, dx: number, dy: number, len = 3.5, w = 1.2): Prim {
  const L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  return { t: "p", p: [x, y, x - ux * len - uy * w / 2, y - uy * len + ux * w / 2, x - ux * len + uy * w / 2, y - uy * len - ux * w / 2], pen: "thin", layer: "ANNOT", fill: true, closed: true };
}

/** Marks on a parent view for the views made from it: cutting lines, detail circles, view arrows. */
export function childMarks(sheet: Sheet, parent: DrawingView, pl: Placement): Prim[] {
  const out: Prim[] = [];
  const r = viewRect(pl);
  for (const v of sheet.views) {
    if (v.parent !== parent.id || !v.kind) continue;
    const letter = v.letter ?? "";
    if (v.kind === "detail" && v.outline && v.outline.length >= 6) {
      const q: number[] = [];
      for (let i = 0; i + 1 < v.outline.length; i += 2) q.push(...toSheet(pl, v.outline[i], v.outline[i + 1]));
      out.push({ t: "p", p: q, pen: "thin", layer: "ANNOT", closed: true });
      // The letter beside the corner furthest up and right.
      let k = 0;
      for (let i = 2; i < q.length; i += 2) if (q[i] + q[i + 1] > q[k] + q[k + 1]) k = i;
      out.push({ t: "t", x: q[k] + 1.5, y: q[k + 1] + 1.5, s: letter, h: 5, al: "l", layer: "ANNOT" });
      continue;
    }
    if (v.kind === "detail" && v.c && v.r) {
      const [cx, cy] = toSheet(pl, v.c[0], v.c[1]), R = v.r * pl.s;
      out.push({ t: "a", o: [cx, cy], r: R, a0: 0, a1: 2 * Math.PI, pen: "thin", layer: "ANNOT" });
      out.push({ t: "t", x: cx + R * 0.75 + 1.5, y: cy + R * 0.75 + 1.5, s: letter, h: 5, al: "l", layer: "ANNOT" });
      continue;
    }
    if (!v.line) continue;
    const al = v.kind === "section" && v.aligned && v.path ? alignedLegs(v.path) : null;
    if (al) { out.push(...alignedMarks(v.path!, al.ang, lookDir(v), letter, pl, r)); continue; }
    const legs = v.kind === "section" && v.path && !v.aligned ? cutLegs(v.path) : null;
    if (legs) { out.push(...pathMarks(legs, lookDir(v), letter, pl, r)); continue; }
    const [a, b] = [toSheet(pl, v.line[0], v.line[1]), toSheet(pl, v.line[2], v.line[3])];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const q = lookDir(v);
    if (v.kind === "section") {
      // Extend the cutting line past the view, thick ends (ISO 128-44), arrows the way the view looks.
      // The line runs across the whole view box (the infinite line clipped to it), and at least between its two points.
      let t0 = 0, t1 = L, lo = -Infinity, hi = Infinity;
      for (const [u, p0, m0, m1] of [[ux, a[0], r[0], r[2]], [uy, a[1], r[1], r[3]]]) {
        if (Math.abs(u) < 1e-9) continue;
        const k0 = (m0 - p0) / u, k1 = (m1 - p0) / u;
        lo = Math.max(lo, Math.min(k0, k1)); hi = Math.min(hi, Math.max(k0, k1));
      }
      if (lo < hi) { t0 = Math.min(t0, lo); t1 = Math.max(t1, hi); }
      t0 -= 4; t1 += 4;
      const P = (t: number): [number, number] => [a[0] + ux * t, a[1] + uy * t];
      const [s0, s1] = [P(t0), P(t1)];
      out.push({ t: "l", p: [...P(t0 + 6), ...P(t1 - 6)] as [number, number, number, number], pen: "center", layer: "ANNOT" });
      out.push({ t: "l", p: [...s0, ...P(t0 + 6)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
      out.push({ t: "l", p: [...P(t1 - 6), ...s1] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
      for (const s of [s0, s1]) {
        const tail: [number, number] = [s[0] + q[0] * 8, s[1] + q[1] * 8];
        out.push({ t: "l", p: [tail[0], tail[1], s[0] + q[0] * 3.5, s[1] + q[1] * 3.5], pen: "thin", layer: "ANNOT" });
        out.push(arrowHead(s[0], s[1], -q[0], -q[1]));
        out.push({ t: "t", x: tail[0] + q[0] * 2, y: tail[1] + q[1] * 2 - 1.7, s: letter, h: 5, al: "c", layer: "ANNOT" });
      }
    } else {
      // Auxiliary view: an arrow square to the edge, at its middle, pointing at it.
      const m: [number, number] = [(a[0] + b[0]) / 2 + q[0] * 3, (a[1] + b[1]) / 2 + q[1] * 3];
      const tail: [number, number] = [m[0] + q[0] * 10, m[1] + q[1] * 10];
      out.push({ t: "l", p: [tail[0], tail[1], m[0] + q[0] * 3.5, m[1] + q[1] * 3.5], pen: "thin", layer: "ANNOT" });
      out.push(arrowHead(m[0], m[1], -q[0], -q[1]));
      out.push({ t: "t", x: tail[0] + q[0] * 3, y: tail[1] + q[1] * 3 - 1.7, s: letter, h: 5, al: "c", layer: "ANNOT" });
    }
  }
  return out;
}

/** How far a ray from `s` along unit `d` runs before it leaves the rectangle `r` (0 when it starts outside). */
function exitAt(s: [number, number], d: [number, number], r: [number, number, number, number]): number {
  let k = Infinity;
  for (const [u, p0, m0, m1] of [[d[0], s[0], r[0], r[2]], [d[1], s[1], r[1], r[3]]]) {
    if (p0 < m0 || p0 > m1) return 0;
    if (Math.abs(u) > 1e-9) k = Math.min(k, ((u > 0 ? m1 : m0) - p0) / u);
  }
  return Number.isFinite(k) ? Math.max(0, k) : 0;
}

/**
 * The cutting path of an offset or half section (ISO 128-44): thin chain line, thick at the ends and at every
 * bend, the ends run out past the view; arrows the way the view looks at the start and, unless the path stops
 * on a step (half section), at the end.
 */
function pathMarks(legs: CutLeg[], q: [number, number], letter: string, pl: Placement, r: [number, number, number, number]): Prim[] {
  const out: Prim[] = [];
  const pts = [legs[0].a, ...legs.map(l => l.b)].map(p => toSheet(pl, p[0], p[1]));
  const dir = (a: [number, number], b: [number, number]): [number, number] => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
  const d0 = dir(pts[1], pts[0]), last = legs[legs.length - 1].cut, n = pts.length;
  const d1 = dir(pts[n - 2], pts[n - 1]);
  const run = (p: [number, number], d: [number, number], k: number): [number, number] => [p[0] + d[0] * k, p[1] + d[1] * k];
  const s0 = run(pts[0], d0, exitAt(pts[0], d0, r) + 4), s1 = run(pts[n - 1], d1, last ? exitAt(pts[n - 1], d1, r) + 4 : 0);
  const line = [s0, ...pts.slice(1, -1), s1];
  for (let i = 0; i + 1 < line.length; i++) out.push({ t: "l", p: [...line[i], ...line[i + 1]] as [number, number, number, number], pen: "center", layer: "ANNOT" });
  out.push({ t: "l", p: [...s0, ...run(s0, d0, -6)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
  out.push({ t: "l", p: [...s1, ...run(s1, d1, -6)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
  for (let i = 1; i < n - 1; i++) {
    const a = dir(pts[i], pts[i - 1]), b = dir(pts[i], pts[i + 1]);
    out.push({ t: "l", p: [...run(pts[i], a, 3), ...pts[i]] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
    out.push({ t: "l", p: [...pts[i], ...run(pts[i], b, 3)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
  }
  for (const s of last ? [s0, s1] : [s0]) {
    const tail: [number, number] = [s[0] + q[0] * 8, s[1] + q[1] * 8];
    out.push({ t: "l", p: [tail[0], tail[1], s[0] + q[0] * 3.5, s[1] + q[1] * 3.5], pen: "thin", layer: "ANNOT" });
    out.push(arrowHead(s[0], s[1], -q[0], -q[1]));
    out.push({ t: "t", x: tail[0] + q[0] * 2, y: tail[1] + q[1] * 2 - 1.7, s: letter, h: 5, al: "c", layer: "ANNOT" });
  }
  return out;
}

/**
 * The cutting line of an aligned section (ISO 128-44): two legs from the centre, thin chain line, thick at the ends
 * and at the centre; each end runs out past the view with an arrow looking the way its leg is seen (the second
 * leg's arrow turned back by the section's turn).
 */
function alignedMarks(path: number[], ang: number, q: [number, number], letter: string, pl: Placement, r: [number, number, number, number]): Prim[] {
  const out: Prim[] = [];
  const [e1, c, e2] = [0, 2, 4].map(i => toSheet(pl, path[i], path[i + 1]));
  const dir = (a: [number, number], b: [number, number]): [number, number] => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
  const run = (p: [number, number], d: [number, number], k: number): [number, number] => [p[0] + d[0] * k, p[1] + d[1] * k];
  const d1 = dir(c, e1), d2 = dir(c, e2);
  const s1 = run(e1, d1, exitAt(e1, d1, r) + 4), s2 = run(e2, d2, exitAt(e2, d2, r) + 4);
  out.push({ t: "l", p: [...s1, ...c] as [number, number, number, number], pen: "center", layer: "ANNOT" });
  out.push({ t: "l", p: [...c, ...s2] as [number, number, number, number], pen: "center", layer: "ANNOT" });
  for (const [s, d] of [[s1, d1], [s2, d2]] as [[number, number], [number, number]][]) out.push({ t: "l", p: [...s, ...run(s, d, -6)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
  out.push({ t: "l", p: [...run(c, d1, 3), ...c] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
  out.push({ t: "l", p: [...c, ...run(c, d2, 3)] as [number, number, number, number], pen: "frame", layer: "ANNOT" });
  const cs = Math.cos(-ang), sn = Math.sin(-ang), q2: [number, number] = [q[0] * cs - q[1] * sn, q[0] * sn + q[1] * cs];
  for (const [s, qq] of [[s1, q], [s2, q2]] as [[number, number], [number, number]][]) {
    const tail: [number, number] = [s[0] + qq[0] * 8, s[1] + qq[1] * 8];
    out.push({ t: "l", p: [tail[0], tail[1], s[0] + qq[0] * 3.5, s[1] + qq[1] * 3.5], pen: "thin", layer: "ANNOT" });
    out.push(arrowHead(s[0], s[1], -qq[0], -qq[1]));
    out.push({ t: "t", x: tail[0] + qq[0] * 2, y: tail[1] + qq[1] * 2 - 1.7, s: letter, h: 5, al: "c", layer: "ANNOT" });
  }
  return out;
}

/** The label under a view: its name (or SECTION A-A / DETAIL B / VIEW C) and the scale when it differs or is asked for. */
export function viewLabel(sheet: Sheet, v: DrawingView, pl: Placement, label: (s: string, p?: Record<string, string>) => string): Prim[] {
  const special = v.kind && v.letter;
  if (!v.label && !special) return [];
  const r = viewRect(pl);
  const title = !special ? v.name : v.kind === "section" ? label("SECTION {a}-{a}", { a: v.letter! }) : v.kind === "detail" ? label("DETAIL {a}", { a: v.letter! }) : label("VIEW {a}", { a: v.letter! });
  const out: Prim[] = [{ t: "t", x: v.x, y: r[1] - 7, s: title, h: 3.5, al: "c", layer: "TEXT" }];
  if (v.label || v.kind === "detail" || v.scale) out.push({ t: "t", x: v.x, y: r[1] - 11.5, s: `${label("Scale")} ${scaleText(viewScalePair(sheet, v))}`, h: 2.5, al: "c", layer: "TEXT" });
  return out;
}

/** Everything drawn for one view: its lines, the marks of its child views and its label. */
export function viewBody(sheet: Sheet, v: DrawingView, proj: Projection | undefined, pl: Placement, label: (s: string, p?: Record<string, string>) => string, ctx?: AnnotCtx, alt?: Projection): Prim[] {
  const out = [...(proj ? viewPrims(v, proj, pl) : []), ...(alt ? altPrims(v, alt, pl) : []), ...childMarks(sheet, v, pl), ...viewLabel(sheet, v, pl, label)];
  if (ctx) out.push(...viewAnnots(sheet, v, pl, ctx).prims);
  return out;
}

/** Alternate position lines (FR-DRW-015): the moved components' visible edges as thin phantom lines (ISO 128 type 05). */
export function altPrims(v: DrawingView, alt: Projection, pl: Placement): Prim[] {
  return decorPrims(v, pl, alt.vis, "phantom", "PHANTOM");
}

export interface Composed { prims: Prim[]; boxes: ViewBox[] }

/** The whole sheet. `projections` is looked up by each view's request key. */
export function composeSheet(sheet: Sheet, fields: Fields, projections: Map<string, Projection>, modelBox: [V3, V3] | null, label: (s: string, p?: Record<string, string>) => string, ctx?: AnnotCtx): Composed {
  const prims = formatPrims(sheet, fields, label);
  const boxes: ViewBox[] = [];
  for (const v of sheet.views) {
    const proj = projections.get(viewReq(sheet, v).key);
    const pl = placement(sheet, v, proj, modelBox);
    const r = viewRect(pl);
    boxes.push({ id: v.id, x0: r[0], y0: r[1], x1: r[2], y1: r[3], ready: !!proj });
    const ar = altReq(sheet, v);
    prims.push(...viewBody(sheet, v, proj, pl, label, ctx, ar ? projections.get(ar.key) : undefined));
  }
  prims.push(...sheetNotes(sheet, label, ctx?.dec, ctx?.bom).prims);
  return { prims, boxes };
}

/** The next free letter for a section, detail or auxiliary view (I, O, Q are skipped, as ISO advises). */
export function nextLetter(sheets: Sheet[]): string {
  const used = new Set(sheets.flatMap(s => s.views.map(v => v.letter).filter(Boolean)));
  const abc = "ABCDEFGHJKLMNPRSTUVWXYZ";
  for (let n = 0; ; n++) for (const ch of abc) { const l = n ? ch + n : ch; if (!used.has(l)) return l; }
}

export { findView };
