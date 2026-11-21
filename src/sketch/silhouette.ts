// Silhouette edges of round faces (a CAD app lets sketch dimensions, relations and Convert Entities take them):
// a cylinder or cone lying along the sketch plane, or a sphere, shows an outline that is no model edge. Seen
// along the sketch normal n, the outline of a cylinder/cone is the generator line where the surface normal is
// square to n (on either side of the axis), and of a sphere the circle round its centre. Pure: the faces come
// as triangles in the same coordinates as the result.
import type { V3 } from "../model/types";
import type { ModelEdge } from "./external";

export interface RoundFace {
  /** Surface kind ("cylinder" | "cone" | "sphere"; others give nothing). */
  kind: string;
  axis?: V3;
  center: V3;
  radius?: number;
  /** The face's triangles, 9 numbers each. */
  tris: ArrayLike<number>;
  /** The face's own edges: an outline lying on one of them is a real edge already. */
  edges: { type: string; start: V3; end: V3; center?: V3; radius?: number }[];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));

/** Squared distance from p to the triangle a, b, c (closest point by regions, Ericson). */
function triDist2(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: V3) => { const d = sub(p, q); return dot(d, d); };
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(add(a, mul(ab, d1 / (d1 - d3))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(add(a, mul(ac, d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))));
  const den = 1 / (va + vb + vc);
  return at(add(a, add(mul(ab, vb * den), mul(ac, vc * den))));
}

/** Whether p lies on the faceted face, within `tol`. */
function onFace(f: RoundFace, p: V3, tol: number): boolean {
  const T = f.tris, t2 = tol * tol;
  for (let i = 0; i + 8 < T.length; i += 9) {
    const a: V3 = [T[i], T[i + 1], T[i + 2]], b: V3 = [T[i + 3], T[i + 4], T[i + 5]], c: V3 = [T[i + 6], T[i + 7], T[i + 8]];
    // Cheap box test first.
    if (Math.min(a[0], b[0], c[0]) - tol > p[0] || Math.max(a[0], b[0], c[0]) + tol < p[0]) continue;
    if (Math.min(a[1], b[1], c[1]) - tol > p[1] || Math.max(a[1], b[1], c[1]) + tol < p[1]) continue;
    if (Math.min(a[2], b[2], c[2]) - tol > p[2] || Math.max(a[2], b[2], c[2]) + tol < p[2]) continue;
    if (triDist2(p, a, b, c) <= t2) return true;
  }
  return false;
}

/** A straight model edge from a to b. */
export function lineEdge(a: V3, b: V3): ModelEdge {
  return { type: "line", start: a, end: b, mid: mul(add(a, b), 0.5), closed: false, pts: [...a, ...b] };
}

/** A full circle edge about `axis`. */
export function circleEdge(c: V3, axis: V3, r: number): ModelEdge {
  const u = unit(cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(unit(axis), u);
  const at = (t: number) => add(c, add(mul(u, r * Math.cos(t)), mul(v, r * Math.sin(t))));
  const pts: number[] = [];
  for (let k = 0; k <= 64; k++) pts.push(...at((k / 64) * Math.PI * 2));
  return { type: "circle", start: at(0), end: at(0), mid: at(Math.PI), closed: true, center: c, axis: unit(axis), radius: r, pts };
}

/**
 * The outline edges of a round face seen along n that are not edges of the face already: up to two lines for
 * a cylinder or cone whose axis lies along the plane (each the stretch of the generator that is on the face),
 * one circle for a sphere whose whole outline is on it. Empty for anything else.
 */
export function silhouettes(f: RoundFace, n: V3): ModelEdge[] {
  const N = unit(n), T = f.tris;
  const verts: V3[] = [];
  for (let i = 0; i + 2 < T.length; i += 3) verts.push([T[i], T[i + 1], T[i + 2]]);
  if (!verts.length) return [];
  if (f.kind === "sphere") {
    const r = f.radius ?? 0;
    if (!(r > 0)) return [];
    const ring = circleEdge(f.center, N, r);
    const tol = Math.max(0.03 * r, 1e-6);
    const P = ring.pts!;
    for (let k = 0; k < 64; k += 4) if (!onFace(f, [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]], tol)) return [];
    if (f.edges.some(e => e.center && e.radius && Math.abs(e.radius - r) < tol && len(sub(e.center, f.center)) < tol)) return [];
    return [ring];
  }
  if ((f.kind !== "cylinder" && f.kind !== "cone") || !f.axis) return [];
  const a = unit(f.axis);
  // The axis must lie along the sketch plane, else the outline is not a fixed generator line.
  if (Math.abs(dot(a, N)) > 1e-6) return [];
  const s = unit(cross(a, N));
  // Radius along the axis: ρ = α + β t, fitted to the vertices (all on the surface).
  let st = 0, sr = 0, stt = 0, str = 0, tmin = Infinity, tmax = -Infinity;
  for (const v of verts) {
    const d = sub(v, f.center), t = dot(d, a), rho = len(sub(d, mul(a, t)));
    st += t; sr += rho; stt += t * t; str += t * rho;
    tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
  }
  const m = verts.length, den = m * stt - st * st;
  const beta = f.kind === "cone" && Math.abs(den) > 1e-12 ? (m * str - st * sr) / den : 0;
  const alpha = (sr - beta * st) / m;
  const rhoAt = (t: number) => alpha + beta * t;
  const span = tmax - tmin, R = Math.max(Math.abs(rhoAt(tmin)), Math.abs(rhoAt(tmax)));
  if (!(span > 1e-9) || !(R > 1e-9)) return [];
  const tol = Math.max(0.03 * R, 1e-6 * (1 + span));
  const out: ModelEdge[] = [];
  for (const side of [1, -1]) {
    const at = (t: number): V3 => add(f.center, add(mul(a, t), mul(s, side * rhoAt(t))));
    // The longest stretch of the generator that lies on the face.
    const K = 48;
    let best: [number, number] | null = null, run: number | null = null;
    for (let k = 0; k <= K + 1; k++) {
      const t = tmin + (span * Math.min(k, K)) / K;
      const on = k <= K && onFace(f, at(t), tol);
      if (on && run == null) run = k;
      if (!on && run != null) { const r: [number, number] = [run, k - 1]; if (!best || r[1] - r[0] > best[1] - best[0]) best = r; run = null; }
    }
    if (!best || best[1] === best[0]) continue;
    // Ends found more closely by bisection where the run stops inside the face's extent.
    const edge = (k: number, out: number) => {
      let lo = tmin + (span * k) / K, hi = tmin + (span * out) / K;
      if (out < 0 || out > K) return lo;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (onFace(f, at(mid), tol)) lo = mid; else hi = mid; }
      return lo;
    };
    const p0 = at(edge(best[0], best[0] - 1)), p1 = at(edge(best[1], best[1] + 1));
    // A generator that is an edge of the face already (a fillet's tangent edge, a seam) needs no outline.
    const dir = unit(sub(p1, p0));
    const offLine = (q: V3) => len(cross(sub(q, p0), dir));
    if (f.edges.some(e => e.type === "line" && offLine(e.start) < tol && offLine(e.end) < tol && len(sub(e.start, e.end)) > 0.5 * len(sub(p1, p0)))) continue;
    out.push(lineEdge(p0, p1));
  }
  return out;
}
