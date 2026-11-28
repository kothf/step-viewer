// 3D sketch (FR-SK-080): a small least-squares solver for points in space, and segment chaining.
import type { Sketch3dFeature, Sk3Seg, V3 } from "../model/types";
import { splineBezierN } from "./spline";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const AX: Record<string, number> = { alongX: 0, alongY: 1, alongZ: 2 };
const PLANE_N: Record<string, number> = { XY: 2, YZ: 0, ZX: 1 };

export interface Solve3d { ok: boolean; pts: Record<string, V3>; dof: number; residual: number; /** Why a sketch fillet does not fit the solved points (then `ok` is false). */ fillet?: string }

/** The residuals of every relation and dimension, with points looked up in `P`. */
function residuals(sk: Sketch3dFeature, P: (id: string) => V3): number[] {
  const out: number[] = [];
  const seg = (id: string) => sk.segs.find(s => s.id === id);
  const vec = (id: string): V3 | null => { const s = seg(id); return s && s.t === "line" ? sub(P(s.pts[1]), P(s.pts[0])) : null; };
  for (const r of sk.rels) {
    if (r.t === "coincident") { const d = sub(P(r.e[1]), P(r.e[0])); out.push(...d); continue; }
    if (r.t === "onPlane") { out.push(P(r.e[0])[PLANE_N[r.plane ?? "XY"]]); continue; }
    if (r.t === "midpoint" || r.t === "onLine") {
      // e = [point, line]: the point at the line's middle, or anywhere on the line (through its ends, unbounded).
      const s = seg(r.e[1]);
      if (!s || s.t !== "line") continue;
      const a = P(s.pts[0]), b = P(s.pts[1]), q = P(r.e[0]);
      if (r.t === "midpoint") { out.push(q[0] - (a[0] + b[0]) / 2, q[1] - (a[1] + b[1]) / 2, q[2] - (a[2] + b[2]) / 2); continue; }
      const u = sub(b, a), lu = len(u) || 1e-9, c = cross(sub(q, a), u);
      out.push(c[0] / lu, c[1] / lu, c[2] / lu);
      continue;
    }
    if (r.t === "tangent") {
      // e = [segment, segment] sharing an end: their directions leaving that end are opposite (one runs on from the other).
      const a = seg(r.e[0]), b = seg(r.e[1]);
      const c = a && b ? [a.pts[0], a.pts[a.pts.length - 1]].find(q => q === b.pts[0] || q === b.pts[b.pts.length - 1]) : undefined;
      if (!a || !b || !c) continue;
      const ua = leaving(a, c, P), ub = leaving(b, c, P), la = len(ua) || 1e-9, lb = len(ub) || 1e-9;
      out.push(ua[0] / la + ub[0] / lb, ua[1] / la + ub[1] / lb, ua[2] / la + ub[2] / lb);
      continue;
    }
    const u = vec(r.e[0]);
    if (!u) continue;
    if (r.t in AX) { const k = AX[r.t]; for (let j = 0; j < 3; j++) if (j !== k) out.push(u[j]); }
    else if (r.t === "parallelPlane") out.push(u[PLANE_N[r.plane ?? "XY"]]);
    else {
      const v = vec(r.e[1]);
      if (!v) continue;
      const lu = len(u) || 1e-9, lv = len(v) || 1e-9;
      if (r.t === "parallel") { const c = cross(u, v); out.push(c[0] / lv, c[1] / lv, c[2] / lv); }
      else if (r.t === "perpendicular") out.push(dot(u, v) / lv);
      else if (r.t === "equal") out.push(lu - lv);
    }
  }
  for (const d of sk.dims) {
    if (d.t === "fillet") continue;
    if (d.t === "angle") {
      // The angle between two lines' directions (0..π), as drawn: from the first line's start to end and the second's.
      const u = vec(d.e[0]), v = vec(d.e[1]);
      if (u && v) out.push(Math.atan2(len(cross(u, v)), dot(u, v)) - d.val.v);
      continue;
    }
    if (d.t === "radius") {
      // An arc's radius: the circle through its three points.
      const s = seg(d.e[0]);
      if (s && s.t === "arc" && s.pts.length === 3) { const g = arc3(P(s.pts[0]), P(s.pts[1]), P(s.pts[2])); out.push((g ? g.r : 1e6) - d.val.v); }
      continue;
    }
    if (d.t === "planeAngle") {
      // The angle between a line and a standard plane (0..90°): atan of its part along the plane's normal over the part in it.
      const u = vec(d.e[0]);
      if (u) { const n = PLANE_N[d.plane ?? "XY"], z = Math.abs(u[n]); out.push(Math.atan2(z, Math.hypot(u[(n + 1) % 3], u[(n + 2) % 3])) - d.val.v); }
      continue;
    }
    if (d.t === "planeDist") { out.push(Math.abs(P(d.e[0])[PLANE_N[d.plane ?? "XY"]]) - d.val.v); continue; }
    if (d.t === "length") { const s = seg(d.e[0]); if (s) out.push(len(sub(P(s.pts[s.pts.length - 1]), P(s.pts[0]))) - d.val.v); }
    else out.push(len(sub(P(d.e[1]), P(d.e[0]))) - d.val.v);
  }
  return out;
}

/** The direction a segment leaves its end `c` (a spline's end tangent from its Bézier poles). */
function leaving(s: Sk3Seg, c: string, P: (id: string) => V3): V3 {
  const q = s.pts.map(P), first = s.pts[0] === c;
  if (s.t === "arc" && q.length === 3) {
    const g = arc3(q[0], q[1], q[2]);
    if (g) return first ? cross(g.n, sub(q[0], g.c)) : cross(sub(q[2], g.c), g.n);
  }
  if (s.t !== "spline" || q.length < 3) return first ? sub(q[q.length - 1], q[0]) : sub(q[0], q[q.length - 1]);
  const bz = splineBezierN(q);
  return first ? sub(bz[1], bz[0]) : sub(bz[bz.length - 2], bz[bz.length - 1]);
}

/** A sketch fillet's geometry: the tangent points on its two lines, the centre and points along the arc (`m` = its middle). */
export interface Fillet3 { id: string; pt: string; segs: [string, string]; t1: V3; t2: V3; c: V3; m: V3; r: number; arc: V3[] }

/** The two lines ending at a point, when exactly two segments end there and both are lines (a corner a fillet can round). */
export function filletCorner(sk: Sketch3dFeature, pt: string): [string, string] | null {
  const at = sk.segs.filter(s => s.pts.length >= 2 && (s.pts[0] === pt || s.pts[s.pts.length - 1] === pt));
  return at.length === 2 && at.every(s => s.t === "line") && at[0].pts[0] !== at[0].pts[at[0].pts.length - 1] ? [at[0].id, at[1].id] : null;
}

/**
 * Every sketch fillet's geometry, or the first one that does not fit (a corner that is not two lines, lines in one
 * line, or a radius too big for the lines: the arcs at both ends of a line must leave some of it).
 */
export function fillets3d(sk: Sketch3dFeature): { list: Fillet3[]; error?: string } {
  const list: Fillet3[] = [];
  const P = (id: string): V3 => sk.pts.find(p => p.id === id)?.p ?? [0, 0, 0];
  const used = new Map<string, number>();
  for (const d of sk.dims) {
    if (d.t !== "fillet") continue;
    const pt = d.e[0], corner = filletCorner(sk, pt), r = d.val.v;
    if (!corner) return { list, error: "A sketch fillet needs a corner where two lines meet." };
    const c0 = P(pt), far = corner.map(id => { const s = sk.segs.find(g => g.id === id)!; return P(s.pts[0] === pt ? s.pts[s.pts.length - 1] : s.pts[0]); });
    const u1 = sub(far[0], c0), u2 = sub(far[1], c0), l1 = len(u1), l2 = len(u2);
    if (l1 < 1e-9 || l2 < 1e-9) return { list, error: "A sketch fillet needs a corner where two lines meet." };
    const e1 = u1.map(v => v / l1) as V3, e2 = u2.map(v => v / l2) as V3;
    const th = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
    if (th < 1e-6 || th > Math.PI - 1e-6) return { list, error: "The lines at a sketch fillet's corner are in one line: there is no corner to round." };
    const tl = r / Math.tan(th / 2);
    for (const [id, l] of [[corner[0], l1], [corner[1], l2]] as const) {
      const u = (used.get(id) ?? 0) + tl;
      if (u > l * (1 - 1e-9)) return { list, error: "The fillet radius is too big for the lines at the corner." };
      used.set(id, u);
    }
    const t1 = c0.map((v, k) => v + e1[k] * tl) as V3, t2 = c0.map((v, k) => v + e2[k] * tl) as V3;
    const bis = [e1[0] + e2[0], e1[1] + e2[1], e1[2] + e2[2]] as V3, lb = len(bis);
    const c = c0.map((v, k) => v + (bis[k] / lb) * (r / Math.sin(th / 2))) as V3;
    const m = c.map((v, k) => v - (bis[k] / lb) * r) as V3;
    // Points along the arc from t1 to t2 (turning in the plane of the two lines).
    const a = sub(t1, c), b = sub(t2, c), sw = Math.PI - th, n = 24, arc: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const s = (sw * i) / n, w1 = Math.sin(sw - s) / Math.sin(sw), w2 = Math.sin(s) / Math.sin(sw);
      arc.push(c.map((v, k) => v + w1 * a[k] + w2 * b[k]) as V3);
    }
    list.push({ id: d.id, pt, segs: corner, t1, t2, c, m, r, arc });
  }
  return { list };
}

/** The axis a line from `a` to `b` lies within `tol` radians of (a CAD app's automatic Along X/Y/Z while drawing), else null. */
export function inferAxis(a: V3, b: V3, tol = (4 * Math.PI) / 180): "alongX" | "alongY" | "alongZ" | null {
  const u = sub(b, a), l = len(u);
  if (l < 1e-6) return null;
  let best = -1, k = -1;
  for (let j = 0; j < 3; j++) if (Math.abs(u[j]) / l > best) { best = Math.abs(u[j]) / l; k = j; }
  return best >= Math.cos(tol) ? (["alongX", "alongY", "alongZ"] as const)[k] : null;
}

/** `b` moved onto the axis line through `a` (its coordinates across the axis made equal to a's). */
export function onAxis(a: V3, b: V3, ax: "alongX" | "alongY" | "alongZ"): V3 {
  const k = AX[ax];
  return [0, 1, 2].map(j => (j === k ? b[j] : a[j])) as V3;
}

/** The angle between two lines of the sketch (radians, 0..π), or null when one is not a line. */
export function lineAngle(sk: Sketch3dFeature, l1: string, l2: string): number | null {
  const P = (id: string) => sk.pts.find(p => p.id === id)?.p ?? [0, 0, 0] as V3;
  const vec = (id: string): V3 | null => { const s = sk.segs.find(g => g.id === id); return s && s.t === "line" ? sub(P(s.pts[1]), P(s.pts[0])) : null; };
  const u = vec(l1), v = vec(l2);
  return u && v ? Math.atan2(len(cross(u, v)), dot(u, v)) : null;
}

/** The angle (0..π/2) between a line of the sketch and a standard plane; null when it is not a line. */
export function linePlaneAngle(sk: Sketch3dFeature, l: string, plane: "XY" | "YZ" | "ZX"): number | null {
  const P = (id: string) => sk.pts.find(p => p.id === id)?.p ?? [0, 0, 0] as V3;
  const s = sk.segs.find(g => g.id === l);
  if (!s || s.t !== "line") return null;
  const u = sub(P(s.pts[1]), P(s.pts[0])), n = PLANE_N[plane];
  return Math.atan2(Math.abs(u[n]), Math.hypot(u[(n + 1) % 3], u[(n + 2) % 3]));
}

/** Solves A x = b (A square) by Gaussian elimination; null when singular. */
function gauss(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
  return x;
}

function rank(J: number[][], cols: number): number {
  const M = J.map(r => r.slice());
  let rk = 0;
  for (let c = 0; c < cols && rk < M.length; c++) {
    let p = rk;
    for (let r = rk + 1; r < M.length; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-8) continue;
    [M[p], M[rk]] = [M[rk], M[p]];
    for (let r = rk + 1; r < M.length; r++) { const f = M[r][c] / M[rk][c]; for (let j = c; j < cols; j++) M[r][j] -= f * M[rk][j]; }
    rk++;
  }
  return rk;
}

/**
 * Moves the free points as little as possible (damped minimum-norm Gauss-Newton) so every relation
 * and dimension holds. `ok` is false when they cannot all hold; `dof` counts the free directions left.
 */
export function solve3d(sk: Sketch3dFeature): Solve3d {
  const free = sk.pts.filter(p => !p.fixed);
  const idx = new Map(free.map((p, i) => [p.id, i]));
  const x = free.flatMap(p => [...p.p]);
  const n = sk.pts.length, order = new Map(sk.pts.map((p, i) => [p.id, i]));
  const wt = free.flatMap(p => { const w = Math.min(1e8, 50 ** (n - 1 - (order.get(p.id) ?? 0))); return [w, w, w]; });
  const fixed = new Map(sk.pts.filter(p => p.fixed).map(p => [p.id, p.p]));
  const at = (xs: number[]) => (id: string): V3 => { const i = idx.get(id); return i == null ? (fixed.get(id) ?? [0, 0, 0]) : [xs[3 * i], xs[3 * i + 1], xs[3 * i + 2]]; };
  const jac = (xs: number[], r0: number[]) => {
    const J = r0.map(() => new Array(xs.length).fill(0));
    for (let j = 0; j < xs.length; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(xs[j]));
      const xp = xs.slice(); xp[j] += h;
      const rp = residuals(sk, at(xp));
      for (let i = 0; i < r0.length; i++) J[i][j] = (rp[i] - r0[i]) / h;
    }
    return J;
  };
  let r = residuals(sk, at(x));
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, q) => s + q * q, 0));
  for (let it = 0; it < 100 && norm(r) > 1e-10 && x.length; it++) {
    const J = jac(x, r);
    // dx = -W⁻¹Jᵀ (J W⁻¹Jᵀ + λI)⁻¹ r: the smallest weighted move that fixes the residuals to first order. Points drawn
    // earlier weigh more, so a changed dimension moves the later end, as in other CAD apps (not the whole sketch).
    const JJt = J.map(a => J.map(b => a.reduce((s, q, k) => s + (q * b[k]) / wt[k], 0)));
    let lam = 1e-9, step: number[] | null = null;
    for (let tries = 0; tries < 12 && !step; tries++, lam *= 100) {
      const y = gauss(JJt.map((row, i) => row.map((v, j) => v + (i === j ? lam : 0))), r.map(v => -v));
      if (!y) continue;
      const dx = x.map((_, j) => J.reduce((s, row, i) => s + row[j] * y[i], 0) / wt[j]);
      const xn = x.map((v, j) => v + dx[j]);
      const rn = residuals(sk, at(xn));
      if (norm(rn) < norm(r)) { step = xn; r = rn; }
    }
    if (!step) break;
    x.splice(0, x.length, ...step);
  }
  const res = norm(r);
  const P = at(x);
  const pts: Record<string, V3> = {};
  for (const p of sk.pts) pts[p.id] = P(p.id);
  const dof = x.length - (r.length && x.length ? rank(jac(x, r), x.length) : 0);
  const fillet = sk.dims.some(d => d.t === "fillet") ? fillets3d({ ...sk, pts: sk.pts.map(p => ({ ...p, p: pts[p.id] })) }).error : undefined;
  return { ok: res < 1e-6 && !fillet, pts, dof, residual: res, ...(fillet ? { fillet } : {}) };
}

/** The segments in one chain, end to end (each with its point ids in path order), or why not. */
export function chain3d(sk: Sketch3dFeature): { order: string[][]; closed: boolean } | { error: string } {
  const segs = sk.segs.filter(s => s.pts.length >= 2);
  if (!segs.length) return { error: "The 3D sketch has no lines, arcs or splines." };
  const rest = segs.slice(1);
  let order: string[][] = [segs[0].pts.slice()];
  const ends = () => [order[0][0], order[order.length - 1][order[order.length - 1].length - 1]];
  while (rest.length) {
    const [a, b] = ends();
    const i = rest.findIndex(s => [s.pts[0], s.pts[s.pts.length - 1]].some(q => q === a || q === b));
    if (i < 0) return { error: "A 3D sketch path must be one chain of lines, arcs and splines." };
    const s = rest.splice(i, 1)[0].pts.slice(), s0 = s[0], s1 = s[s.length - 1];
    if (s0 === b) order.push(s);
    else if (s1 === b) order.push(s.reverse());
    else if (s1 === a) order = [s, ...order];
    else order = [s.reverse(), ...order];
  }
  // A point where three segments meet is not a chain.
  const count = new Map<string, number>();
  for (const s of segs) for (const q of [s.pts[0], s.pts[s.pts.length - 1]]) count.set(q, (count.get(q) ?? 0) + 1);
  if ([...count.values()].some(n => n > 2)) return { error: "A 3D sketch path must be one chain of lines, arcs and splines." };
  const [a, b] = ends();
  return { order, closed: a === b && segs.length > 1 };
}

/** The circle through three points as an arc from `a` through `m` to `e`: centre, radius, normal (a → m → e runs counter-clockwise about it), start axis `u`, `v` = n × u and the sweep (0..2π); null when the points lie on one line. */
export function arc3(a: V3, m: V3, e: V3): { c: V3; r: number; n: V3; u: V3; v: V3; sweep: number } | null {
  const ab = sub(m, a), ac = sub(e, a), w = cross(ab, ac), w2 = dot(w, w);
  const size = Math.max(len(ab), len(ac));
  if (w2 < 1e-18 * size ** 4 || size < 1e-12) return null;
  // Circumcentre: a + (|ac|² (w × ab) + |ab|² (ac × w)) / (2 |w|²).
  const t1 = cross(w, ab), t2 = cross(ac, w), k1 = dot(ac, ac), k2 = dot(ab, ab);
  const c: V3 = [0, 1, 2].map(j => a[j] + (k1 * t1[j] + k2 * t2[j]) / (2 * w2)) as V3;
  const r = len(sub(a, c)), lw = Math.sqrt(w2), n: V3 = [w[0] / lw, w[1] / lw, w[2] / lw];
  const d = sub(a, c), u: V3 = [d[0] / r, d[1] / r, d[2] / r], v = cross(n, u);
  const q = sub(e, c);
  let sweep = Math.atan2(dot(q, v), dot(q, u));
  if (sweep <= 0) sweep += 2 * Math.PI;
  return { c, r, n, u, v, sweep };
}

/** The point at angle `t` from the start of an `arc3` arc. */
export function arcAt(g: { c: V3; r: number; u: V3; v: V3 }, t: number): V3 {
  const x = g.r * Math.cos(t), y = g.r * Math.sin(t);
  return [0, 1, 2].map(j => g.c[j] + x * g.u[j] + y * g.v[j]) as V3;
}

/** Points along a segment for drawing (splines sampled through their Bézier poles). */
export function segPoints(sk: Sketch3dFeature, s: Sk3Seg, k = 16): V3[] {
  const P = s.pts.map(id => sk.pts.find(p => p.id === id)?.p ?? [0, 0, 0] as V3);
  if (s.t === "arc" && P.length === 3) {
    const g = arc3(P[0], P[1], P[2]);
    if (!g) return [P[0], P[2]];
    const n = Math.max(8, Math.ceil((g.sweep / (Math.PI / 2)) * k));
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) out.push(arcAt(g, (g.sweep * i) / n));
    return out;
  }
  if (s.t === "line" || P.length < 3) {
    // A line ends where a sketch fillet at its corner starts.
    if (s.t === "line" && sk.dims.some(d => d.t === "fillet")) {
      const fl = fillets3d(sk);
      if (!fl.error) for (const f of fl.list) {
        if (f.pt === s.pts[0]) P[0] = f.segs[0] === s.id ? f.t1 : f.t2;
        if (f.pt === s.pts[s.pts.length - 1]) P[P.length - 1] = f.segs[0] === s.id ? f.t1 : f.t2;
      }
    }
    return P;
  }
  const bz = splineBezierN(P);
  const out: V3[] = [];
  for (let i = 0; i + 3 < bz.length; i += 3) for (let j = 0; j < k; j++) {
    const t = j / k, u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push([0, 1, 2].map(c => w[0] * bz[i][c] + w[1] * bz[i + 1][c] + w[2] * bz[i + 2][c] + w[3] * bz[i + 3][c]) as V3);
  }
  out.push(bz[bz.length - 1]);
  return out;
}
