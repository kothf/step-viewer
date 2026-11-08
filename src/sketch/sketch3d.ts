// 3D sketch (FR-SK-080): a small least-squares solver for points in space, and segment chaining.
import type { Sketch3dFeature, Sk3Seg, V3 } from "../model/types";
import { splineBezierN } from "./spline";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const AX: Record<string, number> = { alongX: 0, alongY: 1, alongZ: 2 };
const PLANE_N: Record<string, number> = { XY: 2, YZ: 0, ZX: 1 };

export interface Solve3d { ok: boolean; pts: Record<string, V3>; dof: number; residual: number }

/** The residuals of every relation and dimension, with points looked up in `P`. */
function residuals(sk: Sketch3dFeature, P: (id: string) => V3): number[] {
  const out: number[] = [];
  const seg = (id: string) => sk.segs.find(s => s.id === id);
  const vec = (id: string): V3 | null => { const s = seg(id); return s && s.t === "line" ? sub(P(s.pts[1]), P(s.pts[0])) : null; };
  for (const r of sk.rels) {
    if (r.t === "coincident") { const d = sub(P(r.e[1]), P(r.e[0])); out.push(...d); continue; }
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
    if (d.t === "length") { const s = seg(d.e[0]); if (s) out.push(len(sub(P(s.pts[s.pts.length - 1]), P(s.pts[0]))) - d.val.v); }
    else out.push(len(sub(P(d.e[1]), P(d.e[0]))) - d.val.v);
  }
  return out;
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
    // dx = -Jᵀ (J Jᵀ + λI)⁻¹ r: the smallest move that fixes the residuals to first order.
    const JJt = J.map(a => J.map(b => a.reduce((s, q, k) => s + q * b[k], 0)));
    let lam = 1e-9, step: number[] | null = null;
    for (let tries = 0; tries < 12 && !step; tries++, lam *= 100) {
      const y = gauss(JJt.map((row, i) => row.map((v, j) => v + (i === j ? lam : 0))), r.map(v => -v));
      if (!y) continue;
      const dx = x.map((_, j) => J.reduce((s, row, i) => s + row[j] * y[i], 0));
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
  return { ok: res < 1e-6, pts, dof, residual: res };
}

/** The segments in one chain, end to end (each with its point ids in path order), or why not. */
export function chain3d(sk: Sketch3dFeature): { order: string[][]; closed: boolean } | { error: string } {
  const segs = sk.segs.filter(s => s.pts.length >= 2);
  if (!segs.length) return { error: "The 3D sketch has no lines or splines." };
  const rest = segs.slice(1);
  let order: string[][] = [segs[0].pts.slice()];
  const ends = () => [order[0][0], order[order.length - 1][order[order.length - 1].length - 1]];
  while (rest.length) {
    const [a, b] = ends();
    const i = rest.findIndex(s => [s.pts[0], s.pts[s.pts.length - 1]].some(q => q === a || q === b));
    if (i < 0) return { error: "A 3D sketch path must be one chain of lines and splines." };
    const s = rest.splice(i, 1)[0].pts.slice(), s0 = s[0], s1 = s[s.length - 1];
    if (s0 === b) order.push(s);
    else if (s1 === b) order.push(s.reverse());
    else if (s1 === a) order = [s, ...order];
    else order = [s.reverse(), ...order];
  }
  // A point where three segments meet is not a chain.
  const count = new Map<string, number>();
  for (const s of segs) for (const q of [s.pts[0], s.pts[s.pts.length - 1]]) count.set(q, (count.get(q) ?? 0) + 1);
  if ([...count.values()].some(n => n > 2)) return { error: "A 3D sketch path must be one chain of lines and splines." };
  const [a, b] = ends();
  return { order, closed: a === b && segs.length > 1 };
}

/** Points along a segment for drawing (splines sampled through their Bézier poles). */
export function segPoints(sk: Sketch3dFeature, s: Sk3Seg, k = 16): V3[] {
  const P = s.pts.map(id => sk.pts.find(p => p.id === id)?.p ?? [0, 0, 0] as V3);
  if (s.t === "line" || P.length < 3) return P;
  const bz = splineBezierN(P);
  const out: V3[] = [];
  for (let i = 0; i + 3 < bz.length; i += 3) for (let j = 0; j < k; j++) {
    const t = j / k, u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push([0, 1, 2].map(c => w[0] * bz[i][c] + w[1] * bz[i + 1][c] + w[2] * bz[i + 2][c] + w[3] * bz[i + 3][c]) as V3);
  }
  out.push(bz[bz.length - 1]);
  return out;
}
