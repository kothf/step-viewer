/**
 * Fully define sketch (FR-SK-045, a CAD app's Fully Define Sketch) as a pure function, shared by the sketch editor
 * and by feature recognition (FR-FT-102), which gives the sketches it makes dimensions the way FeatureWorks does.
 */
import type { SkDim, SkEnt, SketchFeature, SkRel, V2 } from "../model/types";
import { ORIGIN, measureDim, solve, tryAdd } from "./solver";
import { uid } from "../model/doc";

/** The point ids an entity uses. */
export function refPts(e: SkEnt): string[] {
  if (e.t === "point") return [];
  if (e.t === "line") return [e.a, e.b];
  if (e.t === "circle") return [e.c];
  if (e.t === "arc") return [e.c, e.a, e.b];
  if (e.t === "spline") return e.pts.slice();
  if (e.t === "text") return [e.p];
  return [e.c, e.a, e.b, ...(e.p0 ? [e.p0] : []), ...(e.p1 ? [e.p1] : [])];
}

/** The first unused dimension name D1, D2, … */
export function nextDimName(sk: SketchFeature): string {
  const used = new Set(sk.dims.map(d => d.name));
  let n = 1;
  while (used.has(`D${n}`)) n++;
  return `D${n}`;
}

/**
 * Adds horizontal/vertical relations to lines within 1° of the axes, diameters of circles and radii of arcs, then
 * horizontal and vertical dimensions from the origin to each point (centres first, then curve points, then free
 * points; nearest the origin first in each), keeping only items that remove freedom, until nothing is free.
 * With `sizes` (feature recognition, as FeatureWorks dimensions a sketch) the lengths of horizontal and vertical
 * lines come before the origin dimensions, longest first, so a rectangle gets its width and height and one corner's
 * place instead of four distances from the origin.
 * The sketch passed in is left alone; `added` = how many items the returned copy has more.
 */
export function fullyDefineSketch(sk0: SketchFeature, opts: { sizes?: boolean } = {}): { sketch: SketchFeature; added: number } {
  const start = solve(sk0);
  if (start.status !== "ok" || start.dof === 0) return { sketch: sk0, added: 0 };
  let sk = sk0, dof = start.dof, added = 0;
  const take = (item: { rel?: SkRel; dim?: SkDim }) => {
    if (dof === 0) return;
    const r = tryAdd(sk, item);
    if (!r.ok || r.redundant || r.result.dof >= dof) return;
    sk = r.sketch; dof = r.result.dof; added++;
  };
  const P = (id: string): V2 => { if (id === ORIGIN) return [0, 0]; const e = sk.ents.find(x => x.id === id); return e?.t === "point" ? [e.x, e.y] : [0, 0]; };
  const tol = Math.sin(Math.PI / 180);
  for (const e of sk0.ents) {
    if (e.t !== "line" || e.cons) continue;
    if (sk.rels.some(r => (r.t === "horizontal" || r.t === "vertical") && r.e.length === 1 && r.e[0] === e.id)) continue;
    const a = P(e.a), b = P(e.b), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    if (Math.abs(b[1] - a[1]) / L < tol) take({ rel: { id: uid("r"), t: "horizontal", e: [e.id] } });
    else if (Math.abs(b[0] - a[0]) / L < tol) take({ rel: { id: uid("r"), t: "vertical", e: [e.id] } });
  }
  // Box of the sketch, to set the new dimensions out beside it.
  const pts = sk.ents.filter((x): x is SkEnt & { t: "point" } => x.t === "point");
  const xs = [0, ...pts.map(q => q.x)], ys = [0, ...pts.map(q => q.y)];
  const x0 = Math.min(...xs), y0 = Math.min(...ys), size = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0, 1);
  const gap = size * 0.08;
  const dim = (t: SkDim["t"], e: string[], pos: V2) => {
    const d: SkDim = { id: uid("d"), name: "", t, e, val: { v: 0 }, pos };
    d.val.v = measureDim(sk, d);
    if (!isFinite(d.val.v)) return;
    // A point level with (or plumb over) the origin to round-off gets a horizontal (vertical) relation, not a
    // 0.0000004 mm dimension that shows as 0 and cannot be typed to 0 (exam #86), as a CAD app does.
    if (d.val.v < 1e-5 * size) {
      if (t === "hdistance" || t === "vdistance") take({ rel: { id: uid("r"), t: t === "hdistance" ? "vertical" : "horizontal", e: [e[0], e[1]] } });
      return;
    }
    d.name = nextDimName(sk);
    take({ dim: d });
  };
  for (const e of sk0.ents) {
    if (e.cons || (e.t !== "circle" && e.t !== "arc")) continue;
    if (sk.dims.some(d => (d.t === "radius" || d.t === "diameter") && d.e[0] === e.id)) continue;
    const c = P(e.c), r = e.t === "circle" ? e.r : Math.hypot(P(e.a)[0] - c[0], P(e.a)[1] - c[1]);
    dim(e.t === "circle" ? "diameter" : "radius", [e.id], [c[0] + r * 0.9, c[1] + r * 0.9]);
  }
  if (opts.sizes) {
    const cx = (x0 + Math.max(...xs)) / 2, cy = (y0 + Math.max(...ys)) / 2;
    const hv = new Set(sk.rels.filter(r => (r.t === "horizontal" || r.t === "vertical") && r.e.length === 1).map(r => r.e[0]));
    const lines = sk0.ents.filter((e): e is SkEnt & { t: "line" } => e.t === "line" && !e.cons && hv.has(e.id))
      .map(e => { const a = P(e.a), b = P(e.b); return { e, a, b, L: Math.hypot(b[0] - a[0], b[1] - a[1]) }; })
      .sort((p, q) => q.L - p.L);
    for (const { e, a, b, L } of lines) {
      if (dof === 0) break;
      if (sk.dims.some(d => d.t === "distance" && d.e.length === 1 && d.e[0] === e.id)) continue;
      // Text beside the line's middle, on the side away from the middle of the sketch.
      const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let n: V2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      if (n[0] * (m[0] - cx) + n[1] * (m[1] - cy) < 0) n = [-n[0], -n[1]];
      dim("distance", [e.id], [m[0] + n[0] * gap, m[1] + n[1] * gap]);
    }
  }
  // Defining points first, as a CAD app does: arc and circle centres and the ends of construction lines
  // (a slot's centreline), then other curve points, then free points; nearest the origin first in each.
  const centres = new Set(sk.ents.flatMap(x => (x.t === "circle" || x.t === "arc") ? [x.c] : x.t === "line" && x.cons ? [x.a, x.b] : []));
  const onCurve = new Set(sk.ents.filter(x => x.t !== "point" && !x.cons).flatMap(x => refPts(x)));
  const rank = (id: string) => (centres.has(id) ? 0 : onCurve.has(id) ? 1 : 2);
  const order = pts.map(q => ({ q, k: rank(q.id), d: Math.hypot(q.x, q.y) })).sort((a, b) => a.k - b.k || a.d - b.d);
  let nh = 0, nv = 0;
  for (const { q } of order) {
    if (dof === 0) break;
    const n0 = added;
    dim("hdistance", [ORIGIN, q.id], [q.x / 2, y0 - gap * (1 + nh)]);
    if (added > n0) nh++;
    const n1 = added;
    dim("vdistance", [ORIGIN, q.id], [x0 - gap * (1 + nv), q.y / 2]);
    if (added > n1) nv++;
  }
  return { sketch: sk, added };
}
