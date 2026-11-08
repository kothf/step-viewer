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
