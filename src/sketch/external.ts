// External references of a sketch (FR-SK-035, FR-SK-064): converted model edges keep an
// "On edge" relation (a fix relation with `ext`) to the edge they came from. On every rebuild
// the kernel finds the edge again and moves the sketch curve onto it; when the edge is gone
// the relation is marked dangling and the curve stays where it was.
import type { Frame, SkEnt, SketchFeature, V2, V3 } from "../model/types";

/** A model edge in world millimetres (the viewer's EdgeInfo, or one built from an OCCT edge). */
export interface ModelEdge { type: string; start: V3; end: V3; mid: V3; closed: boolean; center?: V3; axis?: V3; radius?: number; pts?: number[] }

/** An edge projected into sketch coordinates. */
export type ExtGeo = { t: "line"; a: V2; b: V2 } | { t: "circle"; c: V2; r: number } | { t: "arc"; c: V2; a: V2; b: V2 }
  | { t: "spline"; pts: V2[]; closed: boolean };

/** `n` points evenly spaced along a polyline (closed: round the loop, the first not repeated). */
export function resample(line: V2[], n: number, closed: boolean): V2[] {
  const P = closed ? [...line, line[0]] : line;
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = cum[cum.length - 1], out: V2[] = [];
  const m = closed ? n : n - 1;
  for (let k = 0, j = 1; k < n; k++) {
    const s = L * k / m;
    while (j < P.length - 1 && cum[j] < s) j++;
    const u = (s - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
    out.push([P[j - 1][0] + (P[j][0] - P[j - 1][0]) * u, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * u]);
  }
  return out;
}

/** Any other edge seen on the sketch plane: an interpolating spline through points spread along its projection. */
function curveOf(ed: ModelEdge, f: Frame): ExtGeo | null {
  const raw = ed.pts;
  if (!raw || raw.length < 6) return null;
  const line: V2[] = [];
  for (let k = 0; k + 2 < raw.length; k += 3) line.push(uvOf(f, [raw[k], raw[k + 1], raw[k + 2]]));
  let closed = ed.closed;
  if (closed && line.length > 2 && Math.hypot(line[0][0] - line.at(-1)![0], line[0][1] - line.at(-1)![1]) < 1e-9) line.pop();
  let len = 0, span = 0;
  for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  for (const q of line) span = Math.max(span, Math.hypot(q[0] - line[0][0], q[1] - line[0][1]));
  // Seen end-on (a curve square to the sketch) or squashed to a line: nothing to draw as a spline.
  if (len < 1e-6 || span < 1e-6 * (1 + len)) return null;
  if (closed && line.length < 3) closed = false;
  {
    // Seen edge-on (a curve lying in a plane square to the sketch): a straight line between its farthest points.
    const a = line[0], b = line.reduce((m, q) => Math.hypot(q[0] - a[0], q[1] - a[1]) > Math.hypot(m[0] - a[0], m[1] - a[1]) ? q : m, line.at(-1)!), d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let far = 0, lo = 0, hi = 0;
    const u: V2 = d ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [1, 0];
    for (const q of line) {
      const s = (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1];
      far = Math.max(far, Math.abs((q[0] - a[0]) * u[1] - (q[1] - a[1]) * u[0]));
      lo = Math.min(lo, s); hi = Math.max(hi, s);
    }
    if (d && far < 1e-6 * (1 + len)) return { t: "line", a: [a[0] + u[0] * lo, a[1] + u[1] * lo], b: [a[0] + u[0] * hi, a[1] + u[1] * hi] };
  }
  return { t: "spline", pts: resample(line, closed ? 16 : 12, closed), closed };
}

export const uvOf = (f: Frame, w: V3): V2 => {
  const q = [w[0] - f.o[0], w[1] - f.o[1], w[2] - f.o[2]];
  return [q[0] * f.x[0] + q[1] * f.x[1] + q[2] * f.x[2], q[0] * f.y[0] + q[1] * f.y[1] + q[2] * f.y[2]];
};

/**
 * Straight edges, and circles and arcs square to the sketch, as sketch geometry; other curves (splines,
 * ellipses, tilted circles) as a spline through points along their projection when the edge carries its
 * polyline `pts`; null otherwise or when the edge is seen end-on.
 */
export function projectEdge(ed: ModelEdge, f: Frame): ExtGeo | null {
  if (ed.type === "line") {
    const a = uvOf(f, ed.start), b = uvOf(f, ed.end);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 ? null : { t: "line", a, b };
  }
  const round = (ed.type === "circle" || ed.type === "arc") && ed.center && ed.radius && ed.axis;
  if (!round) return curveOf(ed, f);
  const ax = ed.axis!;
  if (Math.abs(ax[0] * f.n[0] + ax[1] * f.n[1] + ax[2] * f.n[2]) < 1 - 1e-6) return curveOf(ed, f);
  const c = uvOf(f, ed.center!);
  if (ed.closed) return { t: "circle", c, r: ed.radius! };
  const a = uvOf(f, ed.start), b = uvOf(f, ed.end), m = uvOf(f, ed.mid);
  const ang = (q: V2) => Math.atan2(q[1] - c[1], q[0] - c[0]);
  const sw = (x: number, y: number) => { let k = y - x; while (k <= 0) k += Math.PI * 2; return k; };
  const ccw = sw(ang(a), ang(m)) < sw(ang(a), ang(b));
  return { t: "arc", c, a: ccw ? a : b, b: ccw ? b : a };
}

/** Puts a sketch curve onto projected edge geometry; false when the kinds differ (a line cannot follow a circle). */
export function applyExt(sk: SketchFeature, ent: SkEnt, g: ExtGeo): boolean {
  const pt = (id: string) => sk.ents.find(e => e.id === id && e.t === "point") as (SkEnt & { t: "point" }) | undefined;
  const set = (id: string, q: V2) => { const p = pt(id); if (p) { p.x = q[0]; p.y = q[1]; } return !!p; };
  if (ent.t === "line" && g.t === "line") {
    const a = pt(ent.a), b = pt(ent.b);
    if (!a || !b) return false;
    // Keep the curve's direction: each end goes to the nearer end of the edge.
    const d = (p: { x: number; y: number }, q: V2) => Math.hypot(p.x - q[0], p.y - q[1]);
    const swap = d(a, g.b) + d(b, g.a) < d(a, g.a) + d(b, g.b);
    return set(ent.a, swap ? g.b : g.a) && set(ent.b, swap ? g.a : g.b);
  }
  if (ent.t === "circle" && g.t === "circle") { ent.r = g.r; return set(ent.c, g.c); }
  if (ent.t === "arc" && g.t === "arc") return set(ent.c, g.c) && set(ent.a, g.a) && set(ent.b, g.b);
  if (ent.t === "spline" && g.t === "spline" && !!ent.closed === g.closed) {
    let q = resample(g.pts, ent.pts.length, g.closed);
    // Keep the curve's direction, as for lines.
    if (!g.closed) { const a = pt(ent.pts[0]); if (a && Math.hypot(a.x - q.at(-1)![0], a.y - q.at(-1)![1]) < Math.hypot(a.x - q[0][0], a.y - q[0][1])) q = q.reverse(); }
    return ent.pts.every((id, i) => set(id, q[i]));
  }
  return false;
}

/** How many On edge relations of a sketch have lost their edge. */
export const danglingCount = (sk: SketchFeature) => sk.rels.filter(r => r.ext && r.dangling).length;

/**
 * Pierce (FR-SK-051): where a model edge crosses the sketch plane, in sketch coordinates, the crossing
 * nearest `near` when there are several. Straight edges count as infinite lines and arcs as whole circles;
 * other curves use their polyline `pts` (the rebuild then finds the exact point). Null when the edge
 * lies in the plane or never reaches it.
 */
export function piercePoint(ed: ModelEdge & { pts?: ArrayLike<number> }, f: Frame, near: V2): V2 | null {
  const h = (w: V3) => (w[0] - f.o[0]) * f.n[0] + (w[1] - f.o[1]) * f.n[1] + (w[2] - f.o[2]) * f.n[2];
  const hits: V3[] = [];
  const size = 1 + Math.hypot(ed.start[0] - ed.end[0], ed.start[1] - ed.end[1], ed.start[2] - ed.end[2]) + (ed.radius ?? 0);
  if (ed.type === "line") {
    const ha = h(ed.start), hb = h(ed.end);
    if (Math.abs(ha - hb) < 1e-9 * size) return null;
    const s = ha / (ha - hb);
    hits.push([0, 1, 2].map(k => ed.start[k] + (ed.end[k] - ed.start[k]) * s) as V3);
  } else if ((ed.type === "circle" || ed.type === "arc") && ed.center && ed.axis && ed.radius) {
    // Points of the circle c + r(u cos t + v sin t): h(c) + r(hu cos t + hv sin t) = 0.
    const ax = ed.axis, c = ed.center, r = ed.radius;
    const pick = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nu = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map(x => x / l); };
    const u = nu(cr(ax, pick)), v = nu(cr(ax, u));
    const dn = (a: number[]) => a[0] * f.n[0] + a[1] * f.n[1] + a[2] * f.n[2];
    const hc = h(c), hu = r * dn(u), hv = r * dn(v), m = Math.hypot(hu, hv);
    if (m < 1e-9 * size || Math.abs(hc) > m) return null;
    const phi = Math.atan2(hv, hu), d = Math.acos(Math.max(-1, Math.min(1, -hc / m)));
    for (const t of [phi + d, phi - d]) hits.push([0, 1, 2].map(k => c[k] + r * (u[k] * Math.cos(t) + v[k] * Math.sin(t))) as V3);
  } else if (ed.pts && ed.pts.length >= 6) {
    const p = ed.pts;
    for (let i = 0; i + 5 < p.length; i += 3) {
      const a: V3 = [p[i], p[i + 1], p[i + 2]], b: V3 = [p[i + 3], p[i + 4], p[i + 5]];
      const ha = h(a), hb = h(b);
      if ((ha > 0) === (hb > 0) && ha !== 0) continue;
      if (Math.abs(ha - hb) < 1e-12) continue;
      const s = ha / (ha - hb);
      hits.push([0, 1, 2].map(k => a[k] + (b[k] - a[k]) * s) as V3);
    }
  }
  let best: V2 | null = null, bd = Infinity;
  for (const w of hits) {
    const q = uvOf(f, w), d = Math.hypot(q[0] - near[0], q[1] - near[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
