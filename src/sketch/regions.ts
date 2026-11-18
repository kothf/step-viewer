// Selected contours (FR-FT-010): the closed regions a sketch's curves divide the plane into, even when
// they cross or branch (a rectangle with a line across it, two overlapping circles). A CAD app lets the
// user click the regions an extrude or revolve uses; the feature stores one point inside each region,
// and the kernel splits its plane by the exact curves and keeps the pieces holding those points.
//
// Here the curves are sampled into polylines, cut at every crossing and traced as a planar graph: good
// enough to draw the regions and to tell which one a click falls in.
import type { SketchFeature, V2 } from "../model/types";
import { inPolygon, loopPolygon, polyArea, sketchCurves, type Seg } from "./profile";

export interface Region {
  /** Outline, counter-clockwise. */
  outer: V2[];
  /** Islands inside it, clockwise. */
  holes: V2[][];
  /** Area of the outline less the holes. */
  area: number;
}

/** A segment as a polyline from its start to its end (closed curves come back to their first point). */
function polyline(s: Seg): V2[] {
  const p = loopPolygon([s], 32);
  if (s.kind === "line") return [s.a, s.b];
  if (s.kind === "circle" || s.kind === "ellipse") return [...p, p[0]];
  if (s.kind === "spline") { const end = s.bz[s.bz.length - 1]; return [...p, end]; }
  return [...p, s.b];
}

/** The closed regions of a sketch's curves (construction left out, and the `skip` entities), largest first. */
export function sketchRegions(sk: SketchFeature, skip: Set<string> = new Set()): Region[] {
  let segs: Seg[];
  try { segs = sketchCurves(sk).filter(s => !skip.has(s.ent)); } catch { return []; }
  const pieces: [V2, V2][] = [];
  for (const s of segs) {
    const p = polyline(s);
    for (let i = 0; i + 1 < p.length; i++) if (p[i][0] !== p[i + 1][0] || p[i][1] !== p[i + 1][1]) pieces.push([p[i], p[i + 1]]);
  }
  return regionsOf(pieces);
}

/** Regions of a set of line pieces: cut at crossings, dangling ends dropped, faces traced. */
export function regionsOf(pieces: [V2, V2][]): Region[] {
  if (!pieces.length) return [];
  let size = 1;
  for (const [a, b] of pieces) size = Math.max(size, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
  const tol = size * 1e-7 + 1e-9;
  // Every crossing (and touching end) splits both pieces.
  const cuts: number[][] = pieces.map(() => [0, 1]);
  const box = pieces.map(([a, b]) => [Math.min(a[0], b[0]) - tol, Math.min(a[1], b[1]) - tol, Math.max(a[0], b[0]) + tol, Math.max(a[1], b[1]) + tol]);
  for (let i = 0; i < pieces.length; i++) {
    const [a, b] = pieces[i], bi = box[i];
    for (let j = i + 1; j < pieces.length; j++) {
      const bj = box[j];
      if (bi[0] > bj[2] || bj[0] > bi[2] || bi[1] > bj[3] || bj[1] > bi[3]) continue;
      const [c, d] = pieces[j];
      const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      const lr = Math.hypot(r[0], r[1]), ls = Math.hypot(s[0], s[1]);
      if (Math.abs(den) < 1e-12 * lr * ls) {
        // Overlapping collinear pieces: each is cut where the other's ends lie on it.
        const on = (p: V2, q0: V2, v: number[], l: number) => {
          const tt = ((p[0] - q0[0]) * v[0] + (p[1] - q0[1]) * v[1]) / (l * l);
          const off = Math.abs((p[0] - q0[0]) * v[1] - (p[1] - q0[1]) * v[0]) / l;
          return off < tol && tt > 0 && tt < 1 ? tt : null;
        };
        for (const [p, k, q0, v, l] of [[c, i, a, r, lr], [d, i, a, r, lr], [a, j, c, s, ls], [b, j, c, s, ls]] as [V2, number, V2, number[], number][]) {
          const tt = on(p, q0, v, l);
          if (tt !== null) cuts[k].push(tt);
        }
        continue;
      }
      const w = [c[0] - a[0], c[1] - a[1]];
      const t = (w[0] * s[1] - w[1] * s[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
      const et = tol / lr, eu = tol / ls;
      if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
      cuts[i].push(Math.min(1, Math.max(0, t)));
      cuts[j].push(Math.min(1, Math.max(0, u)));
    }
  }
  // Vertices by position (neighbouring cells looked at too, so rounding never splits a joint).
  const ids = new Map<string, number>();
  const pts: V2[] = [];
  const vid = (p: V2) => {
    const kx = Math.round(p[0] / (tol * 10)), ky = Math.round(p[1] / (tol * 10));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const v = ids.get(`${kx + dx}:${ky + dy}`); if (v !== undefined) return v; }
    pts.push(p); ids.set(`${kx}:${ky}`, pts.length - 1); return pts.length - 1;
  };
  const edges = new Set<string>();
  const adj = new Map<number, Set<number>>();
  const link = (u: number, v: number) => {
    if (u === v) return;
    const k = u < v ? `${u}:${v}` : `${v}:${u}`;
    if (edges.has(k)) return;
    edges.add(k);
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u)!.add(v); adj.get(v)!.add(u);
  };
  pieces.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i])].sort((x, y) => x - y);
    let prev = vid(a);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k];
      const v = t >= 1 ? vid(b) : vid([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      link(prev, v);
      prev = v;
    }
  });
  // Dangling ends bound no region.
  const stack = [...adj.keys()].filter(v => adj.get(v)!.size < 2);
  while (stack.length) {
    const v = stack.pop()!;
    const nb = adj.get(v);
    if (!nb) continue;
    for (const u of nb) { adj.get(u)!.delete(v); if (adj.get(u)!.size < 2) stack.push(u); }
    adj.delete(v);
  }
  // Neighbours in counter-clockwise order of direction.
  const order = new Map<number, number[]>();
  for (const [v, nb] of adj) {
    const p = pts[v];
    order.set(v, [...nb].sort((x, y) => Math.atan2(pts[x][1] - p[1], pts[x][0] - p[0]) - Math.atan2(pts[y][1] - p[1], pts[y][0] - p[0])));
  }
  // Face tracing: from u→v, leave v by the edge just clockwise of v→u, so the face stays on the left.
  const seen = new Set<string>();
  const loops: V2[][] = [];
  for (const [u0, nb] of order) for (const v0 of nb) {
    if (seen.has(`${u0}>${v0}`)) continue;
    const loop: V2[] = [];
    let u = u0, v = v0, guard = 0;
    while (!seen.has(`${u}>${v}`) && guard++ < 1e6) {
      seen.add(`${u}>${v}`);
      loop.push(pts[u]);
      const around = order.get(v)!;
      const k = around.indexOf(u);
      const w = around[(k - 1 + around.length) % around.length];
      u = v; v = w;
    }
    loops.push(loop);
  }
  // Counter-clockwise loops are regions; clockwise ones are the outlines of connected groups of curves,
  // which become holes of the smallest region of another group around them.
  const faces = loops.map(l => ({ l, a: polyArea(l) }));
  const outs = faces.filter(f => f.a > tol * tol).sort((x, y) => x.a - y.a);
  const regions: Region[] = outs.map(f => ({ outer: f.l, holes: [], area: f.a }));
  for (const h of faces.filter(f => f.a < -tol * tol)) {
    const q = outsidePoint(h.l);
    const host = regions.find(r => r.area > -h.a && inRegion(q, r));
    if (host) { host.holes.push(h.l); host.area += h.a; }
  }
  return regions.sort((x, y) => y.area - x.area);
}

/** A point just left of a clockwise outline's longest edge: outside the group of curves it goes round. */
function outsidePoint(l: V2[]): V2 {
  let k = 0, best = -1;
  for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d > best) { best = d; k = i; } }
  const a = l[k], b = l[(k + 1) % l.length], e = 1e-4 / (best || 1);
  return [(a[0] + b[0]) / 2 - (b[1] - a[1]) * e * best, (a[1] + b[1]) / 2 + (b[0] - a[0]) * e * best];
}

/** Whether a point lies in a region (inside its outline, outside its holes). */
export function inRegion(p: V2, r: Region) {
  return inPolygon(p, r.outer) && !r.holes.some(h => inPolygon(p, h));
}

/** The region a point falls in (the smallest holding it), or -1. */
export function regionAt(regions: Region[], p: V2) {
  let best = -1;
  regions.forEach((r, i) => { if (inRegion(p, r) && (best < 0 || r.area < regions[best].area)) best = i; });
  return best;
}

/** A point well inside a region (for a click that should stay inside after small edits): the pole of inaccessibility, roughly. */
export function regionPoint(r: Region): V2 {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of r.outer) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; }
  const edgesOf = [r.outer, ...r.holes];
  const dist = (p: V2) => {
    let d = Infinity;
    for (const l of edgesOf) for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
      d = Math.min(d, Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy));
    }
    return d;
  };
  let best: V2 = r.outer[0], bd = -1;
  const n = 24;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const p: V2 = [lo[0] + ((hi[0] - lo[0]) * (i + 0.5)) / (n + 1), lo[1] + ((hi[1] - lo[1]) * (j + 0.5)) / (n + 1)];
    if (!inRegion(p, r)) continue;
    const d = dist(p);
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}
