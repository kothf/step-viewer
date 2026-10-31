// Turns parsed layer objects into (1) SVG path batches for drawing and export and
// (2) features: shape primitives, snap points and bounds for picking and measuring.

import { ccw, translatePrim } from "./gerber";
import type { ApDef, CV, GObj, ParsedLayer, Prim } from "./model";

export const SNAP_VERTEX = 0, SNAP_CENTER = 1, SNAP_MID = 2;

export interface Feature {
  /** Index into the layer's objs. */
  o: number;
  prims: Prim[];
  bb: [number, number, number, number];
  /** x, y, kind triples (SNAP_*). */
  snaps: number[];
}

export interface Batch {
  dark: boolean;
  /** Filled (nonzero) path data in chunks; every shape is counter-clockwise so overlaps stay filled. */
  fill: string[];
  /** Shapes with holes, filled even-odd one by one. */
  eo: string[];
  /** Zero-width draws (1 px hairlines). */
  hair: string;
}

export interface BuiltLayer extends ParsedLayer {
  /** Features packed in typed arrays (cheap to send from the worker); feature i belongs to objs[i]. */
  packed: PackedFeats;
  batches: Batch[];
  bbox: [number, number, number, number];
}

const f = (v: number) => String(Math.round(v * 1e6) / 1e6);
const ARC_STEP = (2 * Math.PI) / 180; // tessellation step for picking and distances

/** Signed CCW sweep from a to b around c (positive when ccw). Full circle when the ends coincide. */
export function arcSweep(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, isCcw: boolean) {
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  let sw = Math.atan2(y2 - cy, x2 - cx) - a0;
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-9) sw = isCcw ? 2 * Math.PI : -2 * Math.PI;
  else if (isCcw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
  return { a0, sw, r: Math.hypot(x1 - cx, y1 - cy) };
}

export function tessArc(cx: number, cy: number, r: number, a0: number, sw: number, out: number[] = [], skipFirst = false) {
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(sw) / ARC_STEP)));
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const a = a0 + (sw * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

// ---------- path data ----------

const circleD = (x: number, y: number, r: number) =>
  `M${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x + r)} ${f(y)}Z`;
const circleCwD = (x: number, y: number, r: number) =>
  `M${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}Z`;

export function primD(p: Prim): string {
  if (p.k === "p") {
    let d = `M${f(p.pts[0])} ${f(p.pts[1])}`;
    for (let i = 2; i < p.pts.length; i += 2) d += `L${f(p.pts[i])} ${f(p.pts[i + 1])}`;
    return d + "Z";
  }
  const { ax, ay, bx, by, r } = p;
  const l = Math.hypot(bx - ax, by - ay);
  if (l < 1e-9) return circleD(ax, ay, r);
  const nx = (-(by - ay) / l) * r, ny = ((bx - ax) / l) * r;
  return `M${f(ax - nx)} ${f(ay - ny)}L${f(bx - nx)} ${f(by - ny)}A${f(r)} ${f(r)} 0 0 1 ${f(bx + nx)} ${f(by + ny)}L${f(ax + nx)} ${f(ay + ny)}A${f(r)} ${f(r)} 0 0 1 ${f(ax - nx)} ${f(ay - ny)}Z`;
}

/** A thick arc as a CCW outline (annular sector with round ends). */
function thickArcD(cx: number, cy: number, R: number, a0: number, sw: number, h: number): string {
  if (sw < 0) { a0 += sw; sw = -sw; }
  const a1 = a0 + sw;
  const ro = R + h, ri = R - h;
  if (sw >= 2 * Math.PI - 1e-9) return circleD(cx, cy, ro) + (ri > 0 ? circleCwD(cx, cy, ri) : "");
  const P = (r: number, a: number) => `${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`;
  const large = sw > Math.PI ? 1 : 0;
  let d = `M${P(ro, a0)}A${f(ro)} ${f(ro)} 0 ${large} 1 ${P(ro, a1)}A${f(h)} ${f(h)} 0 0 1 ${P(ri, a1)}`;
  d += ri > 0 ? `A${f(ri)} ${f(ri)} 0 ${large} 0 ${P(ri, a0)}` : `L${P(0, 0)}`;
  return d + `A${f(h)} ${f(h)} 0 0 1 ${P(ro, a0)}Z`;
}

function contourArea(c: CV[]): number {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += (p.x * q.y - q.x * p.y) / 2;
    if (q.arc && i + 1 < c.length) {
      const { sw, r } = arcSweep(p.x, p.y, q.x, q.y, q.arc.cx, q.arc.cy, q.arc.ccw);
      a += (r * r / 2) * (sw - Math.sin(sw));
    }
  }
  return a;
}

/** Exact signed area of a region contour (arcs included). */
export const regionArea = contourArea;

function reverseContour(c: CV[]): CV[] {
  const out: CV[] = [];
  for (let i = c.length - 1; i >= 0; i--) {
    const next = c[i + 1]; // the segment that ended at c[i+1] started at c[i]; reversed it ends at c[i]
    out.push({ x: c[i].x, y: c[i].y, arc: next?.arc ? { ...next.arc, ccw: !next.arc.ccw } : undefined });
  }
  return out;
}

function contourD(c: CV[]): string {
  let d = `M${f(c[0].x)} ${f(c[0].y)}`;
  for (let i = 1; i < c.length; i++) {
    const v = c[i], p = c[i - 1];
    if (v.arc) {
      const { sw, r } = arcSweep(p.x, p.y, v.x, v.y, v.arc.cx, v.arc.cy, v.arc.ccw);
      if (Math.abs(Math.abs(sw) - 2 * Math.PI) < 1e-9) {
        const mx = 2 * v.arc.cx - p.x, my = 2 * v.arc.cy - p.y;
        const s = v.arc.ccw ? 1 : 0;
        d += `A${f(r)} ${f(r)} 0 1 ${s} ${f(mx)} ${f(my)}A${f(r)} ${f(r)} 0 1 ${s} ${f(v.x)} ${f(v.y)}`;
      } else d += `A${f(r)} ${f(r)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${v.arc.ccw ? 1 : 0} ${f(v.x)} ${f(v.y)}`;
    } else d += `L${f(v.x)} ${f(v.y)}`;
  }
  return d + "Z";
}

export function contourPts(c: CV[]): number[] {
  const out: number[] = [c[0].x, c[0].y];
  for (let i = 1; i < c.length; i++) {
    const v = c[i], p = c[i - 1];
    if (v.arc) {
      const { a0, sw, r } = arcSweep(p.x, p.y, v.x, v.y, v.arc.cx, v.arc.cy, v.arc.ccw);
      tessArc(v.arc.cx, v.arc.cy, r, a0, sw, out, true);
    } else out.push(v.x, v.y);
  }
  return out;
}

// ---------- features ----------

/** Radius used for a track drawn with a non-circular aperture (approximation). */
export function trackRadius(ap: ApDef | undefined) {
  if (!ap) return 0;
  const P = ap.params;
  if (ap.shape === "C") return (P[0] ?? 0) / 2;
  if (ap.shape === "R" || ap.shape === "O") return Math.min(P[0], P[1]) / 2;
  if (ap.shape === "P") return P[0] / 2;
  const bb = primsBox(ap.prims);
  return Math.min(bb[2] - bb[0], bb[3] - bb[1]) / 2;
}

export function primsBox(prims: Prim[]): [number, number, number, number] {
  const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    if (p.k === "c") {
      bb[0] = Math.min(bb[0], p.ax - p.r, p.bx - p.r); bb[1] = Math.min(bb[1], p.ay - p.r, p.by - p.r);
      bb[2] = Math.max(bb[2], p.ax + p.r, p.bx + p.r); bb[3] = Math.max(bb[3], p.ay + p.r, p.by + p.r);
    } else for (let i = 0; i < p.pts.length; i += 2) {
      bb[0] = Math.min(bb[0], p.pts[i]); bb[1] = Math.min(bb[1], p.pts[i + 1]);
      bb[2] = Math.max(bb[2], p.pts[i]); bb[3] = Math.max(bb[3], p.pts[i + 1]);
    }
  }
  return bb;
}

/** Convex hull (CCW) of a point list. */
function hull(pts: number[]): number[] {
  const P: [number, number][] = [];
  for (let i = 0; i < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)].flat();
}

export function buildLayer(L: ParsedLayer): BuiltLayer {
  const feats: Feature[] = [];
  const batches: Batch[] = [];
  let cur: Batch | null = null;
  let chunk = "", inChunk = 0;
  const flush = () => { if (cur && chunk) { cur.fill.push(chunk); chunk = ""; inChunk = 0; } };
  const batch = (dark: boolean) => {
    if (!cur || cur.dark !== dark) { flush(); cur = { dark, fill: [], eo: [], hair: "" }; batches.push(cur); }
    return cur;
  };
  const addFill = (d: string) => { chunk += d; if (++inChunk >= 3000) flush(); };
  const warnings = new Set(L.warnings);

  L.objs.forEach((o, oi) => {
    let prims: Prim[] = [];
    const snaps: number[] = [];
    if (o.t === "flash") {
      const ap = L.apertures[o.ap];
      const b = batch(o.dark);
      if (ap) {
        prims = ap.prims.map(p => translatePrim(p, o.x, o.y));
        if (ap.clear.length && prims.length === 1) b.eo.push(primD(prims[0]) + ap.clear.map(p => primD(translatePrim(p, o.x, o.y))).join(""));
        else { if (ap.clear.length) warnings.add("Exposure-off parts of some macro pads are not cut out."); for (const p of prims) addFill(primD(p)); }
        snaps.push(o.x, o.y, SNAP_CENTER);
        if (ap.shape !== "C" && ap.shape !== "O") for (const p of prims) if (p.k === "p" && p.pts.length <= 128) for (let i = 0; i < p.pts.length; i += 2) snaps.push(p.pts[i], p.pts[i + 1], SNAP_VERTEX);
      }
    } else if (o.t === "track") {
      const ap = L.apertures[o.ap];
      const b = batch(o.dark);
      const r = trackRadius(ap);
      if (ap?.shape === "R") {
        const [w, h] = ap.params;
        const pts = [o.x1 - w / 2, o.y1 - h / 2, o.x1 + w / 2, o.y1 - h / 2, o.x1 + w / 2, o.y1 + h / 2, o.x1 - w / 2, o.y1 + h / 2,
          o.x2 - w / 2, o.y2 - h / 2, o.x2 + w / 2, o.y2 - h / 2, o.x2 + w / 2, o.y2 + h / 2, o.x2 - w / 2, o.y2 + h / 2];
        prims = [{ k: "p", pts: hull(pts) }];
        addFill(primD(prims[0]));
      } else {
        prims = [{ k: "c", ax: o.x1, ay: o.y1, bx: o.x2, by: o.y2, r }];
        if (r > 0) addFill(primD(prims[0])); else b.hair += `M${f(o.x1)} ${f(o.y1)}L${f(o.x2)} ${f(o.y2)}`;
      }
      snaps.push(o.x1, o.y1, SNAP_VERTEX, o.x2, o.y2, SNAP_VERTEX, (o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, SNAP_MID);
    } else if (o.t === "arc") {
      const ap = L.apertures[o.ap];
      const b = batch(o.dark);
      const r = trackRadius(ap);
      const { a0, sw, r: R } = arcSweep(o.x1, o.y1, o.x2, o.y2, o.cx, o.cy, o.ccw);
      const pts = tessArc(o.cx, o.cy, R, a0, sw);
      for (let i = 2; i < pts.length; i += 2) prims.push({ k: "c", ax: pts[i - 2], ay: pts[i - 1], bx: pts[i], by: pts[i + 1], r });
      if (r > 0) addFill(thickArcD(o.cx, o.cy, R, a0, sw, r));
      else {
        const full = Math.abs(Math.abs(sw) - 2 * Math.PI) < 1e-9;
        const s = sw > 0 ? 1 : 0;
        b.hair += full
          ? `M${f(o.x1)} ${f(o.y1)}A${f(R)} ${f(R)} 0 1 ${s} ${f(2 * o.cx - o.x1)} ${f(2 * o.cy - o.y1)}A${f(R)} ${f(R)} 0 1 ${s} ${f(o.x1)} ${f(o.y1)}`
          : `M${f(o.x1)} ${f(o.y1)}A${f(R)} ${f(R)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${s} ${f(o.x2)} ${f(o.y2)}`;
      }
      const am = a0 + sw / 2;
      snaps.push(o.x1, o.y1, SNAP_VERTEX, o.x2, o.y2, SNAP_VERTEX, o.cx, o.cy, SNAP_CENTER, o.cx + R * Math.cos(am), o.cy + R * Math.sin(am), SNAP_MID);
    } else if (o.t === "region") {
      batch(o.dark);
      for (let c of o.contours) {
        if (contourArea(c) < 0) c = reverseContour(c);
        addFill(contourD(c));
        prims.push({ k: "p", pts: ccw(contourPts(c)) });
        for (let i = 0; i < c.length; i++) {
          snaps.push(c[i].x, c[i].y, SNAP_VERTEX);
          const a = c[i].arc;
          if (a) snaps.push(a.cx, a.cy, SNAP_CENTER);
        }
      }
    } else if (o.t === "hole") {
      batch(true);
      prims = [{ k: "c", ax: o.x, ay: o.y, bx: o.x, by: o.y, r: o.d / 2 }];
      addFill(primD(prims[0]));
      snaps.push(o.x, o.y, SNAP_CENTER);
    } else if (o.t === "slot") {
      batch(true);
      prims = [{ k: "c", ax: o.x1, ay: o.y1, bx: o.x2, by: o.y2, r: o.d / 2 }];
      addFill(primD(prims[0]));
      snaps.push(o.x1, o.y1, SNAP_CENTER, o.x2, o.y2, SNAP_CENTER, (o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, SNAP_MID);
    }
    feats.push({ o: oi, prims, bb: primsBox(prims), snaps });
  });
  flush();
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ft of feats) {
    if (!(ft.bb[0] <= ft.bb[2])) continue;
    bbox[0] = Math.min(bbox[0], ft.bb[0]); bbox[1] = Math.min(bbox[1], ft.bb[1]);
    bbox[2] = Math.max(bbox[2], ft.bb[2]); bbox[3] = Math.max(bbox[3], ft.bb[3]);
  }
  return { ...L, warnings: [...warnings], packed: packFeats(feats), batches, bbox };
}

export interface PackedFeats {
  n: number;
  bb: Float64Array;
  pOff: Uint32Array;
  pData: Float64Array;
  sOff: Uint32Array;
  sData: Float64Array;
}

function packFeats(feats: Feature[]): PackedFeats {
  const n = feats.length;
  let pn = 0, sn = 0;
  for (const f of feats) { for (const p of f.prims) pn += p.k === "c" ? 6 : 2 + p.pts.length; sn += f.snaps.length; }
  const out: PackedFeats = { n, bb: new Float64Array(4 * n), pOff: new Uint32Array(n + 1), pData: new Float64Array(pn), sOff: new Uint32Array(n + 1), sData: new Float64Array(sn) };
  let pi = 0, si = 0;
  feats.forEach((f, i) => {
    out.bb.set(f.bb, 4 * i);
    out.pOff[i] = pi;
    for (const p of f.prims) {
      if (p.k === "c") { out.pData.set([0, p.ax, p.ay, p.bx, p.by, p.r], pi); pi += 6; }
      else { out.pData[pi] = 1; out.pData[pi + 1] = p.pts.length; out.pData.set(p.pts, pi + 2); pi += 2 + p.pts.length; }
    }
    out.sOff[i] = si;
    out.sData.set(f.snaps, si);
    si += f.snaps.length;
  });
  out.pOff[n] = pi; out.sOff[n] = si;
  return out;
}

/** Decodes packed features on demand (main thread), keeping recently used ones. */
export class FeatStore {
  private cache = new Map<number, Feature>();
  constructor(readonly p: PackedFeats) {}
  get length() { return this.p.n; }
  /** Bounds of feature i: [x0, y0, x1, y1] (empty features have x0 > x1). */
  bb(i: number, k: 0 | 1 | 2 | 3) { return this.p.bb[4 * i + k]; }
  get(i: number): Feature {
    let f = this.cache.get(i);
    if (f) return f;
    const { pOff, pData, sOff, sData, bb } = this.p;
    const prims: Prim[] = [];
    for (let j = pOff[i]; j < pOff[i + 1];) {
      if (pData[j] === 0) { prims.push({ k: "c", ax: pData[j + 1], ay: pData[j + 2], bx: pData[j + 3], by: pData[j + 4], r: pData[j + 5] }); j += 6; }
      else { const m = pData[j + 1]; prims.push({ k: "p", pts: Array.from(pData.subarray(j + 2, j + 2 + m)) }); j += 2 + m; }
    }
    f = { o: i, prims, bb: [bb[4 * i], bb[4 * i + 1], bb[4 * i + 2], bb[4 * i + 3]], snaps: Array.from(sData.subarray(sOff[i], sOff[i + 1])) };
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(i, f);
    return f;
  }
}

/** Area of a flash's shape: exact for standard apertures, the sum of primitives for macros. */
export function flashArea(ap: ApDef): { area: number; exact: boolean } {
  let a = 0;
  for (const p of ap.prims) {
    if (p.k === "c") a += Math.PI * p.r * p.r + 2 * p.r * Math.hypot(p.bx - p.ax, p.by - p.ay);
    else { let s = 0; for (let i = 0; i < p.pts.length; i += 2) { const j = (i + 2) % p.pts.length; s += p.pts[i] * p.pts[j + 1] - p.pts[j] * p.pts[i + 1]; } a += Math.abs(s) / 2; }
  }
  for (const p of ap.clear) if (p.k === "c") a -= Math.PI * p.r * p.r;
  return { area: a, exact: ap.prims.length <= 1 };
}

export type { GObj };

/** Bounds of the drawn centrelines (board outlines: the cut line, not the line's outer edge). */
export function centerlineBox(objs: GObj[]): [number, number, number, number] | null {
  const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); };
  for (const o of objs) {
    if (o.t === "track") { add(o.x1, o.y1); add(o.x2, o.y2); }
    else if (o.t === "arc") { const { a0, sw, r } = arcSweep(o.x1, o.y1, o.x2, o.y2, o.cx, o.cy, o.ccw); const t = tessArc(o.cx, o.cy, r, a0, sw); for (let i = 0; i < t.length; i += 2) add(t[i], t[i + 1]); }
    else if (o.t === "region") for (const c of o.contours) for (const v of c) add(v.x, v.y);
  }
  return bb[0] <= bb[2] ? bb : null;
}
