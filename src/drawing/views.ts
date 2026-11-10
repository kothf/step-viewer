// View geometry on the sheet: orientations, projected view directions (first and
// third angle), scales and alignment (FR-DRW-010/011).
import { viewAxes, type V3, type ViewDir } from "../kernel/drawing";
import type { DrawingView, Orient, Projection, Sheet } from "./types";

/** Named orientations, Z up like the 3D view (front looks along +Y). */
/** The configuration name a drawing view uses for a sheet metal part's flat pattern (FR-FT-120); the flat lies on XY, top face up. */
export const FLAT_CONFIG = "@flat";

export const ORIENTS: Record<Exclude<Orient, "current">, ViewDir> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 1], up: [0, 0, 1] },
};
export const ORIENT_NAMES: Record<Orient, string> = { front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom", iso: "Isometric", current: "Current 3D view" };

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Direction of a view projected from `parent` towards `side` on the sheet. Third angle: a view
 * placed to the right shows the model seen from the right; first angle shows it from the left.
 * Diagonal sides give isometric-like views.
 */
export function projectedDir(parent: ViewDir, side: [number, number], proj: Projection): ViewDir {
  const { x, y, n } = viewAxes(parent);
  const s = proj === "third" ? 1 : -1;
  const [dx, dy] = side;
  if (dx && dy) return { dir: unit(add(add(n, x, s * dx), y, s * dy)), up: y };
  if (dx) return { dir: mul(x, s * dx), up: y };
  return { dir: mul(y, s * dy), up: mul(n, -s * dy) };
}

/**
 * Changes a sheet between first and third angle (FR-DRW-011) keeping every projected view the same view:
 * its side flips and it moves across its parent (a Top view goes from under the front view to above it),
 * as SolidWorks does. Views placed off a view that moved follow it.
 */
export function switchProjection(sheet: Sheet, proj: Projection) {
  if (sheet.projection === proj) return;
  sheet.projection = proj;
  const old = new Map(sheet.views.map(v => [v.id, [v.x, v.y] as [number, number]]));
  const done = new Set<string>();
  const place = (v: DrawingView, depth = 0) => {
    if (done.has(v.id) || depth > 20) return;
    done.add(v.id);
    const par = v.parent ? findView(sheet, v.parent) : undefined;
    if (!par) return;
    place(par, depth + 1);
    const [ox, oy] = old.get(v.id)!, [px, py] = old.get(par.id)!;
    if (!v.kind && v.side) {
      v.side = [-v.side[0] || 0, -v.side[1] || 0];
      v.x = par.x - (ox - px); v.y = par.y - (oy - py);
    } else { v.x = par.x + (ox - px); v.y = par.y + (oy - py); }
  };
  for (const v of sheet.views) place(v);
}

/**
 * The view seen from the side `q` (a unit 2D direction on the sheet, in the parent's axes), with the
 * viewer on that side: a third-angle projection along any direction. Section and auxiliary views use it.
 */
export function sideView(parent: ViewDir, q: [number, number]): ViewDir {
  const { x, y, n } = viewAxes(parent);
  const r: [number, number] = [-q[1], q[0]];
  const r3 = add(mul(x, r[0]), y, r[1]);
  const X = add(mul(n, -q[0]), r3, r[0]), Y = add(mul(n, -q[1]), r3, r[1]);
  const dir = unit([X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]]);
  return { dir, up: unit(Y) };
}

/** Section / aux views: the unit sheet direction (parent axes) from the line towards the view. */
export function lookDir(v: DrawingView): [number, number] {
  const [a, b, c, d] = v.line!, L = Math.hypot(c - a, d - b) || 1, s = v.look ?? 1;
  return [-(d - b) / L * s, (c - a) / L * s];
}

export function findView(sheet: Sheet, id: string | undefined) { return id ? sheet.views.find(v => v.id === id) : undefined; }

/** The view's direction, following projected views up to their model view. */
export function viewDir(sheet: Sheet, v: DrawingView, depth = 0): ViewDir {
  if (v.kind && v.parent && depth < 20) {
    const p = findView(sheet, v.parent);
    if (p) {
      const pd = viewDir(sheet, p, depth + 1);
      if (v.kind === "detail") return pd;
      return sideView(pd, lookDir(v));
    }
  }
  if (v.parent && v.side && depth < 20) {
    const p = findView(sheet, v.parent);
    if (p) return projectedDir(viewDir(sheet, p, depth + 1), v.side, sheet.projection);
  }
  if (v.dir) return v.dir;
  return ORIENTS[(v.orient && v.orient !== "current" ? v.orient : "front")];
}

/** Scale factor (sheet mm per model mm). Projected views use their parent's. */
export function viewScale(sheet: Sheet, v: DrawingView, depth = 0): number {
  if (v.scale) return v.scale[0] / v.scale[1];
  if (v.kind === "detail" && v.parent && depth < 20) { const p = findView(sheet, v.parent); if (p) return 2 * viewScale(sheet, p, depth + 1); }
  if (v.parent && depth < 20) { const p = findView(sheet, v.parent); if (p) return viewScale(sheet, p, depth + 1); }
  return sheet.scale[0] / sheet.scale[1];
}
export function viewScalePair(sheet: Sheet, v: DrawingView, depth = 0): [number, number] {
  if (v.scale) return v.scale;
  if (v.kind === "detail" && v.parent && depth < 20) { const p = findView(sheet, v.parent); if (p) { const s = viewScalePair(sheet, p, depth + 1); return s[1] % 2 === 0 ? [s[0], s[1] / 2] : [s[0] * 2, s[1]]; } }
  if (v.parent && depth < 20) { const p = findView(sheet, v.parent); if (p) return viewScalePair(sheet, p, depth + 1); }
  return sheet.scale;
}

/** Projected views stay lined up with their parent: same y (left/right) or same x (above/below). */
export function alignAxis(v: DrawingView): "x" | "y" | [number, number] | null {
  if (v.free) return null;
  if (v.kind === "section" || v.kind === "aux") return v.line ? lookDir(v) : null;
  if (!v.parent || !v.side) return null;
  if (v.side[0] && !v.side[1]) return "y";
  if (v.side[1] && !v.side[0]) return "x";
  return null;
}

/** The side (−1/0/1 each) of a point from a parent's centre: the nearest of 8 directions. */
export function sideOf(dx: number, dy: number): [number, number] {
  const a = Math.atan2(dy, dx), k = Math.round(a / (Math.PI / 4));
  const c = Math.round(Math.cos(k * Math.PI / 4)), s = Math.round(Math.sin(k * Math.PI / 4));
  return [c, s];
}

/** Bounding box of the model's 8 box corners in a view (model mm, view axes): a quick stand-in until the lines arrive. */
export function boxInView(box: [V3, V3], vd: ViewDir): [number, number, number, number] {
  const { x, y } = viewAxes(vd);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p: V3 = [box[i & 1][0], box[(i >> 1) & 1][1], box[(i >> 2) & 1][2]];
    const u = p[0] * x[0] + p[1] * x[1] + p[2] * x[2], w = p[0] * y[0] + p[1] * y[1] + p[2] * y[2];
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, w); y1 = Math.max(y1, w);
  }
  return [x0, y0, x1, y1];
}

/** One leg of a cutting path (parent view axes): `cut` legs run along the first one, the others step square to it. */
export interface CutLeg { a: [number, number]; b: [number, number]; cut: boolean }

/**
 * The legs of an offset or half section's path (FR-DRW-012), or null when a leg is neither parallel
 * nor square to the first (within 0.5°), a cut leg runs back against the first, or the path has under 3 points.
 */
export function cutLegs(path: number[]): CutLeg[] | null {
  if (path.length < 6 || path.length % 2) return null;
  const L0 = Math.hypot(path[2] - path[0], path[3] - path[1]);
  if (L0 < 1e-9) return null;
  const e: [number, number] = [(path[2] - path[0]) / L0, (path[3] - path[1]) / L0];
  const legs: CutLeg[] = [];
  for (let i = 0; i + 3 < path.length; i += 2) {
    const a: [number, number] = [path[i], path[i + 1]], b: [number, number] = [path[i + 2], path[i + 3]];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const c = (dx * e[0] + dy * e[1]) / L;
    if (c > 0.99996) legs.push({ a, b, cut: true });
    else if (Math.abs(c) < 0.0087) legs.push({ a, b, cut: false });
    else return null;
  }
  return legs.length >= 2 && legs[0].cut ? legs : null;
}

/** Stand-in for "beyond the model" in a staircase cutter; the kernel clamps it to the model's size. */
export const FAR = 1e9;

/**
 * The material an offset or half section takes away, as a staircase polygon in (t, o): t along the first leg
 * from its start, o towards the viewer (`m`, unit, parent axes). Each cut leg removes everything beyond its
 * offset over its run; the first runs out backwards and the last forwards unless the path ends on a step.
 * `offs` are the cut legs' offsets (the planes whose cut faces are hatched).
 */
export function staircase(legs: CutLeg[], m: [number, number]): { pts: number[]; offs: number[] } {
  const o0 = legs[0].a, e: [number, number] = [-m[1], m[0]];
  const d = legs[0].b[0] - o0[0], w = legs[0].b[1] - o0[1];
  const sg = d * e[0] + w * e[1] >= 0 ? 1 : -1;
  const T = (p: [number, number]) => sg * ((p[0] - o0[0]) * e[0] + (p[1] - o0[1]) * e[1]);
  const O = (p: [number, number]) => (p[0] - o0[0]) * m[0] + (p[1] - o0[1]) * m[1];
  const cuts = legs.filter(l => l.cut);
  const offs = cuts.map(l => O(l.a));
  const pts: number[] = [-FAR, FAR, -FAR, offs[0]];
  cuts.forEach((l, i) => {
    const end = i === cuts.length - 1 ? (legs[legs.length - 1].cut ? FAR : T(l.b)) : T(l.b);
    pts.push(end, offs[i]);
    if (i < cuts.length - 1) pts.push(end, offs[i + 1]);
  });
  pts.push(pts[pts.length - 2], FAR);
  return { pts, offs };
}

/** A staircase cutter for the kernel: (t, o) points with `FAR` ends, the frame they live in, and the hatched planes. */
export interface Stair { o: V3; e: V3; m: V3; pts: number[]; planes: number[] }
/** An aligned section's turn: the half beyond the plane through `c` square to `s` (on the second leg's side) is turned by `ang` (radians) about the axis through `c` along `axis`. */
export interface Align { c: V3; s: V3; axis: V3; ang: number }

/**
 * The legs of an aligned section in parent view axes: unit directions from the centre to each end, and the turn
 * (radians, counter-clockwise about the parent's view normal) that lays the second leg along the first one's extension.
 */
export function alignedLegs(path: number[]): { c: [number, number]; d1: [number, number]; d2: [number, number]; ang: number } | null {
  if (path.length !== 6) return null;
  const c: [number, number] = [path[2], path[3]];
  const l1 = Math.hypot(path[0] - c[0], path[1] - c[1]), l2 = Math.hypot(path[4] - c[0], path[5] - c[1]);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  const d1: [number, number] = [(path[0] - c[0]) / l1, (path[1] - c[1]) / l1], d2: [number, number] = [(path[4] - c[0]) / l2, (path[5] - c[1]) / l2];
  // Turn d2 onto −d1.
  const ang = Math.atan2(d2[0] * -d1[1] - d2[1] * -d1[0], d2[0] * -d1[0] + d2[1] * -d1[1]);
  // Straight (no turn) or folded back onto the first leg: not an aligned section.
  if (Math.abs(ang) < 0.0087 || Math.abs(ang) > Math.PI - 0.0087) return null;
  return { c, d1, d2, ang };
}

/** What the worker computes for a view: a projection along `view`, cut at `p` for a section; `key` caches it. Detail views reuse their parent's. */
export type ViewReq = { view: ViewDir; p?: V3; poly?: number[]; stair?: Stair; align?: Align; exclude?: string[]; shade?: boolean; cfg?: string; only?: string[]; key: string };

/** The part configuration a view shows (FR-DRW-010): its own, else its parent's up to the model view; absent = the active one. */
export function viewConfig(sheet: Sheet, v: DrawingView, depth = 0): string | undefined {
  if (v.config) return v.config;
  const p = v.parent && depth < 20 ? findView(sheet, v.parent) : undefined;
  return p ? viewConfig(sheet, p, depth + 1) : undefined;
}

/** The components an assembly view shows alone: its own list, else its parent's up to the model view; absent = all. */
/** The topology a component-only view draws on: edges and cylinders of its components (face names `<comp>@<face>`). */
export function topoOnly<T extends { edges: { k: string }[]; cyls: { f?: string }[]; revs?: { f?: string }[]; holes?: { f?: string }[] }>(topo: T, only?: string[]): T {
  if (!only?.length) return topo;
  const mine = (k?: string) => { const i = k ? k.indexOf("@") : -1, c = i > 0 ? k!.slice(0, i) : null; return !!c && only.some(x => c === x || c.startsWith(x + "/")); };
  return { ...topo, edges: topo.edges.filter(e => mine(e.k)), cyls: topo.cyls.filter(c => mine(c.f)), ...(topo.revs ? { revs: topo.revs.filter(c => mine(c.f)) } : {}), ...(topo.holes ? { holes: topo.holes.filter(c => mine(c.f)) } : {}) };
}

export function viewOnly(sheet: Sheet, v: DrawingView, depth = 0): string[] | undefined {
  if (v.only?.length) return v.only;
  const p = v.parent && depth < 20 ? findView(sheet, v.parent) : undefined;
  return p ? viewOnly(sheet, p, depth + 1) : undefined;
}

export function viewReq(sheet: Sheet, v: DrawingView): ViewReq {
  let r = rawReq(sheet, v);
  const cfg = viewConfig(sheet, v), only = viewOnly(sheet, v);
  if (cfg) r = { ...r, cfg, key: `${r.key}|cfg|${cfg}` };
  if (only) { const o = [...only].sort(); r = { ...r, only: o, key: `${r.key}|on|${o.join(",")}` }; }
  return r;
}

function rawReq(sheet: Sheet, v: DrawingView, depth = 0): ViewReq {
  if (v.kind === "detail" && v.parent && depth < 20) {
    const p = findView(sheet, v.parent);
    if (p) { const r = rawReq(sheet, p, depth + 1); return isShaded(v) && !r.p && !r.shade ? { ...r, shade: true, key: `${r.key}|sh` } : r; }
  }
  const view = viewDir(sheet, v);
  if (v.kind === "section" && v.parent && v.line) {
    const par = findView(sheet, v.parent);
    if (par) {
      const { x, y } = viewAxes(viewDir(sheet, par));
      const exclude = v.exclude?.length ? [...v.exclude].sort() : undefined;
      const ex = exclude ? `|ex|${exclude.join(",")}` : "";
      const al = v.aligned && v.path ? alignedLegs(v.path) : null;
      if (al) {
        const n0 = viewAxes(viewDir(sheet, par)).n;
        const P = (u: number, w: number) => add(mul(x, u), y, w);
        const c = P(al.c[0], al.c[1]), sv = P(al.d2[0] - al.d1[0], al.d2[1] - al.d1[1]), sl = Math.hypot(sv[0], sv[1], sv[2]) || 1;
        const align: Align = { c, s: [sv[0] / sl, sv[1] / sl, sv[2] / sl], axis: n0, ang: al.ang };
        return { view, p: c, align, exclude, key: `${dirKey(view)}|al|${c.map(k => k.toFixed(6)).join(",")}|${align.s.map(k => k.toFixed(6)).join(",")}|${al.ang.toFixed(6)}${ex}` };
      }
      const legs = v.path && !v.aligned ? cutLegs(v.path) : null;
      if (legs) {
        const n = viewAxes(view).n, mu = n[0] * x[0] + n[1] * x[1] + n[2] * x[2], mv = n[0] * y[0] + n[1] * y[1] + n[2] * y[2];
        // m: square to the path's first leg, on the viewer's side (n from the stored line may be a hair off the path).
        const l0 = legs[0], lx = l0.b[0] - l0.a[0], ly = l0.b[1] - l0.a[1], ll = Math.hypot(lx, ly) || 1;
        const sq: [number, number] = [-ly / ll, lx / ll], m: [number, number] = sq[0] * mu + sq[1] * mv >= 0 ? sq : [-sq[0], -sq[1]];
        const { pts, offs } = staircase(legs, m);
        const o = add(mul(x, legs[0].a[0]), y, legs[0].a[1]);
        const ev = [legs[0].b[0] - legs[0].a[0], legs[0].b[1] - legs[0].a[1]], el = Math.hypot(ev[0], ev[1]);
        const e = add(mul(x, ev[0] / el), y, ev[1] / el), m3 = add(mul(x, m[0]), y, m[1]);
        // Offsets along the cutter's own normal m3: the view's n comes from the stored line, which can be a hair off
        // the rounded path, and then no cut face matched its plane (half section without hatching, drawings exam #13).
        const d0 = o[0] * m3[0] + o[1] * m3[1] + o[2] * m3[2];
        const stair: Stair = { o, e, m: m3, pts, planes: offs.map(k => d0 + k) };
        return { view, p: o, stair, exclude, key: `${dirKey(view)}|st|${o.map(c => c.toFixed(6)).join(",")}|${pts.map(c => c.toFixed(5)).join(",")}${ex}` };
      }
      const p = add(mul(x, v.line[0]), y, v.line[1]);
      return { view, p, exclude, key: `${dirKey(view)}|${p.map(c => c.toFixed(6)).join(",")}${ex}` };
    }
  }
  if (v.broken && v.kind !== "section" && v.broken.poly.length >= 6) {
    const { n } = viewAxes(view), { poly, d } = v.broken;
    return { view, p: mul(n, d), poly, key: `${dirKey(view)}|bo|${d.toFixed(6)}|${poly.map(c => c.toFixed(4)).join(",")}` };
  }
  return isShaded(v) ? { view, shade: true, key: `${dirKey(view)}|sh` } : { view, key: dirKey(view) };
}

/** Shaded display styles (FR-DRW-010); section and broken-out views stay line drawings. */
export function isShaded(v: DrawingView): boolean { return (v.style === "shaded" || v.style === "shadedEdges") && v.kind !== "section"; }

/** A component moved for an alternate position: its id and the world transform (3×4 row-major). */
export interface AltReq { view: ViewDir; moves: { comp: string; tf: number[] }[]; key: string }

/**
 * The alternate position lines a view needs (FR-DRW-015), or null: the moved components projected
 * on their own along the view. A detail view shows its parent's.
 */
export function altReq(sheet: Sheet, v: DrawingView, depth = 0): AltReq | null {
  if (v.kind === "detail" && v.parent && depth < 20) { const p = findView(sheet, v.parent); return p ? altReq(sheet, p, depth + 1) : null; }
  if (!v.alt?.length || v.kind === "section") return null;
  const view = viewDir(sheet, v), { x, y, n } = viewAxes(view);
  const moves = v.alt.map(m => ({ comp: m.comp, tf: altTf(x, y, n, m) }));
  return { view, moves, key: `${dirKey(view)}|alt|${moves.map(m => `${m.comp}:${m.tf.map(c => c.toFixed(5)).join(",")}`).join(";")}` };
}

/** A turn by `ang`° about the view normal through `c`, then a move by (du, dv), as a 3×4 transform. */
export function altTf(x: V3, y: V3, n: V3, m: { du: number; dv: number; ang?: number; c?: [number, number] }): number[] {
  const a = (m.ang ?? 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), k = 1 - cs;
  // Rodrigues: R = cos I + sin [n]x + (1 − cos) n nᵀ.
  const R = [
    [cs + n[0] * n[0] * k, n[0] * n[1] * k - n[2] * sn, n[0] * n[2] * k + n[1] * sn],
    [n[1] * n[0] * k + n[2] * sn, cs + n[1] * n[1] * k, n[1] * n[2] * k - n[0] * sn],
    [n[2] * n[0] * k - n[1] * sn, n[2] * n[1] * k + n[0] * sn, cs + n[2] * n[2] * k],
  ];
  const c = m.c ?? [0, 0], P: V3 = add(mul(x, c[0]), y, c[1]), d: V3 = add(mul(x, m.du), y, m.dv);
  const t = [0, 1, 2].map(i => P[i] - (R[i][0] * P[0] + R[i][1] * P[1] + R[i][2] * P[2]) + d[i]);
  return [R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2]];
}

export const dirKey = (d: ViewDir) => [...d.dir, ...d.up].map(v => (Math.abs(v) < 1e-12 ? 0 : v).toFixed(9)).join(",");

/** Standard scales (ISO 5455), largest first. */
export const SCALES: [number, number][] = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [1, 200], [1, 500], [1, 1000]];
export const scaleText = (s: [number, number]) => `${s[0]}:${s[1]}`;
export function parseScale(text: string): [number, number] | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return a > 0 && b > 0 ? [a, b] : null;
}
type Box = [number, number, number, number];
/** Standard 3 views layout: the largest standard scale and the group's bottom-left corner at which front (dx × dz), top (dx × dy) and side (dy × dz)
 *  fit inside `area` with `pad` round each view, clear of the title block `tb` (all sheet mm, y up). The group's empty corner may sit over the
 *  title block, so a big model is not shrunk to the strip above it. Null when nothing fits. */
export function std3Layout(dx: number, dy: number, dz: number, area: Box, tb: Box, third: boolean, gap = 25, pad = 8): { scale: [number, number]; gx: number; gy: number } | null {
  const [x0, y0, x1, y1] = area;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  for (const s of SCALES) {
    const k = s[0] / s[1];
    const W = k * (dx + dy) + gap, H = k * (dz + dy) + gap;
    // Views fill at most 85 % of the room left by the gaps and margins, as before (a small part stays at 1:1).
    if (k * (dx + dy) > (x1 - x0 - gap - 20) * 0.85 || k * (dz + dy) > (y1 - y0 - gap - 20) * 0.85) continue;
    const rects = (gx: number, gy: number): Box[] => {
      const fy = third ? gy : gy + k * dy + gap, ty = third ? gy + k * dz + gap : gy;
      return [[gx, fy, gx + k * dx, fy + k * dz], [gx, ty, gx + k * dx, ty + k * dy], [gx + k * dx + gap, fy, gx + k * dx + gap + k * dy, fy + k * dz]];
    };
    const xs = [cx - W / 2, x0 + pad, x1 - pad - W, tb[0] - pad - W], ys = [cy - H / 2, y1 - pad - H, y0 + pad, tb[3] + pad, (tb[3] + y1 - H) / 2];
    const cands: [number, number][] = [];
    for (const gx of xs) for (const gy of ys) cands.push([gx, gy]);
    cands.sort((a, b) => Math.hypot(a[0] + W / 2 - cx, a[1] + H / 2 - cy) - Math.hypot(b[0] + W / 2 - cx, b[1] + H / 2 - cy));
    for (const [gx, gy] of cands) {
      const ok = rects(gx, gy).every(r => {
        const g: Box = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
        return g[0] >= x0 - 1e-6 && g[1] >= y0 - 1e-6 && g[2] <= x1 + 1e-6 && g[3] <= y1 + 1e-6 && !hit(g, tb);
      });
      if (ok) return { scale: s, gx, gy };
    }
  }
  return null;
}

/** The largest standard scale at which a w × h (model mm) layout fits into W × H (sheet mm). */
export function fitScale(w: number, h: number, W: number, H: number): [number, number] {
  for (const s of SCALES) if (w * s[0] / s[1] <= W && h * s[0] / s[1] <= H) return s;
  return SCALES[SCALES.length - 1];
}
