// External references of a sketch (FR-SK-035, FR-SK-064): converted model edges keep an
// "On edge" relation (a fix relation with `ext`) to the edge they came from. On every rebuild
// the kernel finds the edge again and moves the sketch curve onto it; when the edge is gone
// the relation is marked dangling and the curve stays where it was.
import type { Frame, SkEnt, SketchFeature, V2, V3 } from "../model/types";

/** A model edge in world millimetres (the viewer's EdgeInfo, or one built from an OCCT edge). */
export interface ModelEdge { type: string; start: V3; end: V3; mid: V3; closed: boolean; center?: V3; axis?: V3; radius?: number }

/** An edge projected into sketch coordinates. */
export type ExtGeo = { t: "line"; a: V2; b: V2 } | { t: "circle"; c: V2; r: number } | { t: "arc"; c: V2; a: V2; b: V2 };

export const uvOf = (f: Frame, w: V3): V2 => {
  const q = [w[0] - f.o[0], w[1] - f.o[1], w[2] - f.o[2]];
  return [q[0] * f.x[0] + q[1] * f.x[1] + q[2] * f.x[2], q[0] * f.y[0] + q[1] * f.y[1] + q[2] * f.y[2]];
};

/** Straight edges, and circles and arcs square to the sketch, as sketch geometry; other curves give null. */
export function projectEdge(ed: ModelEdge, f: Frame): ExtGeo | null {
  if (ed.type === "line") {
    const a = uvOf(f, ed.start), b = uvOf(f, ed.end);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 ? null : { t: "line", a, b };
  }
  const round = (ed.type === "circle" || ed.type === "arc") && ed.center && ed.radius && ed.axis;
  if (!round) return null;
  const ax = ed.axis!;
  if (Math.abs(ax[0] * f.n[0] + ax[1] * f.n[1] + ax[2] * f.n[2]) < 1 - 1e-6) return null;
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
