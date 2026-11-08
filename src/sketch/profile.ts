// Closed regions of a sketch, for extrude and revolve (FRS 8.7).
//
// Non-construction lines and arcs are joined end to end into loops (by position,
// so coincident points with different ids still connect); circles are loops of
// their own. Loops nest by containment: even depth is material, odd depth a hole.
// Crossing curves (regions cut by intersections) are reported, not split.
import type { SketchFeature, SkEnt, V2 } from "../model/types";
import { ellOf, ellParam, ellPts, ellSweep, type Ell } from "./ellipse";
import { bezPts } from "./spline";
import { entBezier, entConic } from "./conic";
import { textLoops } from "./text";

export type Seg =
  | { ent: string; kind: "line"; a: V2; b: V2 }
  /** Arc from a to b around c; ccw tells the direction of travel along the loop. */
  | { ent: string; kind: "arc"; c: V2; r: number; a: V2; b: V2; ccw: boolean }
  | { ent: string; kind: "circle"; c: V2; r: number }
  /** Full ellipse (FR-SK-018). */
  | { ent: string; kind: "ellipse"; el: Ell }
  /** Elliptical arc from a to b; ccw as for arcs. */
  | { ent: string; kind: "earc"; el: Ell; a: V2; b: V2; ccw: boolean }
  /**
   * Spline as cubic Bézier control points in the direction of travel (closed: first = last). A conic also
   * has `rq` = its exact rational quadratic (start, top vertex, end, middle weight), which the kernel uses.
   */
  | { ent: string; kind: "spline"; bz: V2[]; rq?: [V2, V2, V2, number] };

export interface ProfileFace { outer: Seg[]; holes: Seg[][] }
export interface Profile { faces: ProfileFace[]; error?: { code: string; message: string; at?: V2 } }

const pt = (m: Map<string, SkEnt>, id: string): V2 => {
  const p = m.get(id);
  if (!p || p.t !== "point") throw new Error(`Missing point ${id}`);
  return [p.x, p.y];
};

/** Points along a loop (arcs sampled), for area and containment. */
export function loopPolygon(loop: Seg[], n = 24): V2[] {
  const out: V2[] = [];
  for (const s of loop) {
    if (s.kind === "line") out.push(s.a);
    else if (s.kind === "circle") {
      for (let k = 0; k < n * 2; k++) { const t = (k / (n * 2)) * Math.PI * 2; out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]); }
    } else if (s.kind === "spline") out.push(...bezPts(s.bz, Math.max(4, Math.ceil(n / 2))).slice(0, -1));
    else if (s.kind === "ellipse") out.push(...ellPts(s.el, 0, 2 * Math.PI, n * 2).slice(0, -1));
    else if (s.kind === "earc") {
      const ta = ellParam(s.el, s.a), tb = ellParam(s.el, s.b);
      const sw = s.ccw ? ellSweep(ta, tb) : -ellSweep(tb, ta);
      out.push(...ellPts(s.el, ta, sw, n).slice(0, -1));
    } else {
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
      let a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
      if (s.ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
      for (let k = 0; k < n; k++) { const t = a0 + ((a1 - a0) * k) / n; out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]); }
    }
  }
  return out;
}

export function polyArea(p: V2[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return a / 2;
}

export function inPolygon(p: V2, poly: V2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function segsCross(a: V2, b: V2, c: V2, d: V2, tol: number) {
  const o = (p: V2, q: V2, r: V2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol)) && ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol));
}

/** The closed regions of a sketch. */
/** A spline entity's segment, in the direction of travel (a conic keeps its exact form). */
function splineSeg(e: SkEnt & { t: "spline" }, m: Map<string, SkEnt>, forward: boolean): Seg {
  const bz = entBezier(e, q => pt(m, q)), rq = entConic(e, q => pt(m, q));
  if (forward) return { ent: e.id, kind: "spline", bz, ...(rq ? { rq } : {}) };
  return { ent: e.id, kind: "spline", bz: bz.reverse(), ...(rq ? { rq: [rq[2], rq[1], rq[0], rq[3]] as [V2, V2, V2, number] } : {}) };
}

export function sketchProfile(sk: SketchFeature, skip: Set<string> = new Set()): Profile {
  const m = new Map(sk.ents.map(e => [e.id, e] as const));
  const curves = sk.ents.filter(e => !e.cons && !skip.has(e.id) && (e.t === "line" || e.t === "arc" || e.t === "circle" || e.t === "ellipse" || e.t === "spline"));
  const loops: Seg[][] = [];
  // Scale-relative tolerance for joining ends.
  let size = 1;
  for (const e of sk.ents) if (e.t === "point") size = Math.max(size, Math.abs(e.x), Math.abs(e.y));
  const tol = size * 1e-7 + 1e-9;
  const key = (p: V2) => `${Math.round(p[0] / tol)}:${Math.round(p[1] / tol)}`;

  type Open = { ent: SkEnt; a: V2; b: V2 };
  const open: Open[] = [];
  for (const e of curves) {
    if (e.t === "circle") loops.push([{ ent: e.id, kind: "circle", c: pt(m, e.c), r: e.r }]);
    else if (e.t === "line") open.push({ ent: e, a: pt(m, e.a), b: pt(m, e.b) });
    else if (e.t === "arc") open.push({ ent: e, a: pt(m, e.a), b: pt(m, e.b) });
    else if (e.t === "ellipse") {
      const el = ellOf(pt(m, e.c), pt(m, e.a), pt(m, e.b));
      if (e.p0 && e.p1) open.push({ ent: e, a: pt(m, e.p0), b: pt(m, e.p1) });
      else loops.push([{ ent: e.id, kind: "ellipse", el }]);
    } else if (e.t === "spline" && e.pts.length >= 2) {
      if (e.closed && e.pts.length >= 3) loops.push([{ ent: e.id, kind: "spline", bz: entBezier(e, q => pt(m, q)) }]);
      else if (!e.closed) open.push({ ent: e, a: pt(m, e.pts[0]), b: pt(m, e.pts[e.pts.length - 1]) });
    }
  }
  // Nodes by position; snap near ends together.
  const nodes = new Map<string, number[]>();
  const nodeOf = (p: V2) => {
    // Look in the neighbouring cells too, so rounding never splits a joint.
    const kx = Math.round(p[0] / tol), ky = Math.round(p[1] / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const k = `${kx + dx}:${ky + dy}`; if (nodes.has(k)) return k; }
    const k = key(p); nodes.set(k, []); return k;
  };
  const ends = open.map((o, i) => {
    const ka = nodeOf(o.a), kb = nodeOf(o.b);
    nodes.get(ka)!.push(i); nodes.get(kb)!.push(i);
    return [ka, kb] as [string, string];
  });
  for (const [k, list] of nodes) {
    if (list.length !== 2) {
      const [x, y] = k.split(":").map(n => Number(n) * tol);
      return { faces: [], error: list.length < 2
        ? { code: "E-SK-OPEN", message: "The sketch has open contours; this feature needs closed regions.", at: [x, y] }
        : { code: "E-SK-BRANCH", message: "More than two curves meet at one point; a region boundary must be a simple loop.", at: [x, y] } };
    }
  }
  const used = new Array(open.length).fill(false);
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    const loop: Seg[] = [];
    let i = s, from = ends[s][0];
    while (!used[i]) {
      used[i] = true;
      const o = open[i], e = o.ent;
      const forward = ends[i][0] === from;
      const a = forward ? o.a : o.b, b = forward ? o.b : o.a;
      if (e.t === "line") loop.push({ ent: e.id, kind: "line", a, b });
      else if (e.t === "arc") { const c = pt(m, e.c); loop.push({ ent: e.id, kind: "arc", c, r: Math.hypot(o.a[0] - c[0], o.a[1] - c[1]), a, b, ccw: forward }); }
      else if (e.t === "spline") loop.push(splineSeg(e, m, forward));
      else if (e.t === "ellipse") loop.push({ ent: e.id, kind: "earc", el: ellOf(pt(m, e.c), pt(m, e.a), pt(m, e.b)), a, b, ccw: forward });
      const to = forward ? ends[i][1] : ends[i][0];
      const next = nodes.get(to)!.find(j => j !== i || ends[i][0] === ends[i][1]);
      if (next === undefined) break;
      from = to;
      i = next;
    }
    loops.push(loop);
  }
  // Text (FR-SK-020): each glyph contour is a closed loop of its own; letter holes nest like any other.
  for (const e of sk.ents) if (e.t === "text" && !e.cons && !skip.has(e.id)) loops.push(...textLoops(e, pt(m, e.p), textPath(sk.ents, e)));
  // Crossing lines (a figure eight, overlapping rectangles) are not supported yet.
  const lines = loops.flatMap(l => l.filter(s => s.kind === "line")) as Extract<Seg, { kind: "line" }>[];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    if (segsCross(lines[i].a, lines[i].b, lines[j].a, lines[j].b, tol * tol)) {
      return { faces: [], error: { code: "E-SK-SELFX", message: "Sketch curves cross each other; split them so each region has its own boundary." } };
    }
  }
  const polys = loops.map(l => loopPolygon(l));
  const areas = polys.map(p => Math.abs(polyArea(p)));
  const depth = polys.map((p, i) => polys.reduce((n, q, j) => n + (j !== i && areas[j] > areas[i] && inPolygon(p[0], q) ? 1 : 0), 0));
  const faces: ProfileFace[] = [];
  polys.forEach((_p, i) => {
    if (depth[i] % 2) return;
    const holes = polys
      .map((q, j) => ({ q, j }))
      .filter(({ q, j }) => depth[j] === depth[i] + 1 && inPolygon(q[0], polys[i]))
      .map(({ j }) => loops[j]);
    faces.push({ outer: loops[i], holes });
  });
  if (!faces.length) return { faces, error: { code: "E-SK-EMPTY", message: "The sketch has no closed region." } };
  return { faces };
}

/**
 * A sweep path (FR-FT-080): the sketch's curves joined end to end into one chain, open or closed,
 * in the order of travel from a free end.
 */
export function sketchPath(sk: SketchFeature): { segs: Seg[]; closed: boolean; error?: { code: string; message: string } } {
  const m = new Map(sk.ents.map(e => [e.id, e] as const));
  const curves = sk.ents.filter(e => !e.cons && (e.t === "line" || e.t === "arc" || e.t === "circle" || e.t === "ellipse" || e.t === "spline"));
  const fail = (message: string) => ({ segs: [], closed: false, error: { code: "E-SWP-PATH", message } });
  if (!curves.length) return fail("The path sketch has no curves.");
  if (curves.length === 1) {
    const e = curves[0];
    if (e.t === "circle") return { segs: [{ ent: e.id, kind: "circle", c: pt(m, e.c), r: e.r }], closed: true };
    if (e.t === "ellipse" && !(e.p0 && e.p1)) return { segs: [{ ent: e.id, kind: "ellipse", el: ellOf(pt(m, e.c), pt(m, e.a), pt(m, e.b)) }], closed: true };
    if (e.t === "spline" && e.closed) return { segs: [{ ent: e.id, kind: "spline", bz: entBezier(e, q => pt(m, q)) }], closed: true };
  }
  if (curves.some(e => e.t === "circle" || (e.t === "ellipse" && !(e.p0 && e.p1)) || (e.t === "spline" && e.closed))) return fail("A closed curve can only be a path on its own.");
  let size = 1;
  for (const e of sk.ents) if (e.t === "point") size = Math.max(size, Math.abs(e.x), Math.abs(e.y));
  const tol = size * 1e-7 + 1e-9;
  const ends: [V2, V2][] = curves.map(e => e.t === "line" || e.t === "arc" ? [pt(m, e.a), pt(m, e.b)] : e.t === "ellipse" ? [pt(m, e.p0!), pt(m, e.p1!)] : [pt(m, (e as SkEnt & { t: "spline" }).pts[0]), pt(m, (e as SkEnt & { t: "spline" }).pts.at(-1)!)]);
  const same = (p: V2, q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol * 10;
  const deg = (p: V2) => ends.reduce((n, [a, b]) => n + (same(a, p) ? 1 : 0) + (same(b, p) ? 1 : 0), 0);
  for (const [a, b] of ends) if (deg(a) > 2 || deg(b) > 2) return fail("The path branches: more than two curves meet at one point.");
  const free = ends.findIndex(([a, b]) => deg(a) === 1 || deg(b) === 1);
  const used = new Array(curves.length).fill(false);
  let i = free >= 0 ? free : 0;
  let at: V2 = free >= 0 ? (deg(ends[i][0]) === 1 ? ends[i][0] : ends[i][1]) : ends[0][0];
  const segs: Seg[] = [];
  while (i >= 0 && !used[i]) {
    used[i] = true;
    const e = curves[i];
    const forward = same(ends[i][0], at);
    const a = forward ? ends[i][0] : ends[i][1], b = forward ? ends[i][1] : ends[i][0];
    if (e.t === "line") segs.push({ ent: e.id, kind: "line", a, b });
    else if (e.t === "arc") { const c = pt(m, e.c); segs.push({ ent: e.id, kind: "arc", c, r: Math.hypot(ends[i][0][0] - c[0], ends[i][0][1] - c[1]), a, b, ccw: forward }); }
    else if (e.t === "spline") segs.push(splineSeg(e, m, forward));
    else if (e.t === "ellipse") segs.push({ ent: e.id, kind: "earc", el: ellOf(pt(m, e.c), pt(m, e.a), pt(m, e.b)), a, b, ccw: forward });
    at = b;
    i = ends.findIndex(([p, q], j) => !used[j] && (same(p, at) || same(q, at)));
  }
  if (used.some(u => !u)) return fail("The path must be one connected chain of curves.");
  return { segs, closed: free < 0 };
}

/** Every curve of a sketch (not construction) as one segment each, in no particular order (split line). */
export function sketchCurves(sk: SketchFeature): Seg[] {
  const m = new Map(sk.ents.map(e => [e.id, e] as const));
  const out: Seg[] = [];
  for (const e of sk.ents) {
    if (e.cons) continue;
    if (e.t === "line") out.push({ ent: e.id, kind: "line", a: pt(m, e.a), b: pt(m, e.b) });
    else if (e.t === "circle") out.push({ ent: e.id, kind: "circle", c: pt(m, e.c), r: e.r });
    else if (e.t === "arc") { const c = pt(m, e.c), a = pt(m, e.a); out.push({ ent: e.id, kind: "arc", c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), a, b: pt(m, e.b), ccw: true }); }
    else if (e.t === "spline") out.push(splineSeg(e, m, true));
    else if (e.t === "ellipse") {
      const el = ellOf(pt(m, e.c), pt(m, e.a), pt(m, e.b));
      out.push(e.p0 && e.p1 ? { ent: e.id, kind: "earc", el, a: pt(m, e.p0), b: pt(m, e.p1), ccw: true } : { ent: e.id, kind: "ellipse", el });
    } else if (e.t === "text") out.push(...textLoops(e, pt(m, e.p), textPath(sk.ents, e)).flat());
  }
  return out;
}

/**
 * The curve a text follows (FR-SK-020), as a polyline in the direction of travel (reversed by `flip`);
 * undefined when the text is straight or its curve is gone.
 */
export function textPath(ents: SkEnt[], e: Extract<SkEnt, { t: "text" }>): V2[] | undefined {
  if (!e.along) return undefined;
  const m = new Map(ents.map(x => [x.id, x] as const));
  const c = m.get(e.along);
  if (!c) return undefined;
  let out: V2[];
  try {
    if (c.t === "line") out = [pt(m, c.a), pt(m, c.b)];
    else if (c.t === "arc") { const cc = pt(m, c.c), a = pt(m, c.a), b = pt(m, c.b); out = [...loopPolygon([{ ent: c.id, kind: "arc", c: cc, r: Math.hypot(a[0] - cc[0], a[1] - cc[1]), a, b, ccw: true }], 64), b]; }
    else if (c.t === "circle") { out = loopPolygon([{ ent: c.id, kind: "circle", c: pt(m, c.c), r: c.r }], 48); out.push(out[0]); }
    else if (c.t === "spline") { if (c.pts.length < 2) return undefined; const bz = entBezier(c, q => pt(m, q)); out = bezPts(bz, 16); }
    else if (c.t === "ellipse") {
      const el = ellOf(pt(m, c.c), pt(m, c.a), pt(m, c.b));
      if (c.p0 && c.p1) { const ta = ellParam(el, pt(m, c.p0)); out = ellPts(el, ta, ellSweep(ta, ellParam(el, pt(m, c.p1))), 64); }
      else out = ellPts(el, 0, 2 * Math.PI, 96);
    } else return undefined;
  } catch { return undefined; }
  return e.flip ? out.reverse() : out;
}
