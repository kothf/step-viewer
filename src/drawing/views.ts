// View geometry on the sheet: orientations, projected view directions (first and
// third angle), scales and alignment (FR-DRW-010/011).
import { viewAxes, type V3, type ViewDir } from "../kernel/drawing";
import type { DrawingView, Orient, Projection, Sheet } from "./types";

/** Named orientations, Z up like the 3D view (front looks along +Y). */
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

/** What the worker computes for a view: a projection along `view`, cut at `p` for a section; `key` caches it. Detail views reuse their parent's. */
export function viewReq(sheet: Sheet, v: DrawingView, depth = 0): { view: ViewDir; p?: V3; poly?: number[]; key: string } {
  if (v.kind === "detail" && v.parent && depth < 20) { const p = findView(sheet, v.parent); if (p) return viewReq(sheet, p, depth + 1); }
  const view = viewDir(sheet, v);
  if (v.kind === "section" && v.parent && v.line) {
    const par = findView(sheet, v.parent);
    if (par) {
      const { x, y } = viewAxes(viewDir(sheet, par));
      const p = add(mul(x, v.line[0]), y, v.line[1]);
      return { view, p, key: `${dirKey(view)}|${p.map(c => c.toFixed(6)).join(",")}` };
    }
  }
  if (v.broken && v.kind !== "section" && v.broken.poly.length >= 6) {
    const { n } = viewAxes(view), { poly, d } = v.broken;
    return { view, p: mul(n, d), poly, key: `${dirKey(view)}|bo|${d.toFixed(6)}|${poly.map(c => c.toFixed(4)).join(",")}` };
  }
  return { view, key: dirKey(view) };
}

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
/** The largest standard scale at which a w × h (model mm) layout fits into W × H (sheet mm). */
export function fitScale(w: number, h: number, W: number, H: number): [number, number] {
  for (const s of SCALES) if (w * s[0] / s[1] <= W && h * s[0] / s[1] <= H) return s;
  return SCALES[SCALES.length - 1];
}
