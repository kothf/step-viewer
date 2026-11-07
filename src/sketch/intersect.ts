// Intersection curve (FRS FR-SK-036): where the sketch plane cuts a face of the model.
// Works on the face's triangles: each triangle the plane crosses gives a segment; the
// segments are chained into polylines in sketch coordinates. The caller turns each
// chain into a line, an arc or circle (round faces square to the sketch) or a spline.
import type { Frame, V2 } from "../model/types";

export interface Chain { pts: V2[]; closed: boolean }

/** Chains where the plane of `f` cuts the triangles `tri` (9 numbers per triangle, world mm). */
export function cutTriangles(tri: ArrayLike<number>, f: Frame): Chain[] {
  const n = tri.length / 9;
  let size = 0;
  for (let i = 0; i < tri.length; i++) size = Math.max(size, Math.abs(tri[i]));
  const eps = Math.max(size, 1) * 1e-9;
  const segs: [V2, V2][] = [];
  const d = (k: number) => (tri[k] - f.o[0]) * f.n[0] + (tri[k + 1] - f.o[1]) * f.n[1] + (tri[k + 2] - f.o[2]) * f.n[2];
  const uv = (x: number, y: number, z: number): V2 => {
    const q = [x - f.o[0], y - f.o[1], z - f.o[2]];
    return [q[0] * f.x[0] + q[1] * f.x[1] + q[2] * f.x[2], q[0] * f.y[0] + q[1] * f.y[1] + q[2] * f.y[2]];
  };
  for (let t = 0; t < n; t++) {
    const k = t * 9;
    // Nudge vertices lying on the plane to one side, so each crossing is counted once.
    const ds = [d(k), d(k + 3), d(k + 6)].map(v => (Math.abs(v) < eps ? eps : v));
    const hits: V2[] = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      if ((ds[a] > 0) === (ds[b] > 0)) continue;
      const s = ds[a] / (ds[a] - ds[b]);
      const A = k + 3 * a, B = k + 3 * b;
      hits.push(uv(tri[A] + s * (tri[B] - tri[A]), tri[A + 1] + s * (tri[B + 1] - tri[A + 1]), tri[A + 2] + s * (tri[B + 2] - tri[A + 2])));
    }
    if (hits.length === 2 && Math.hypot(hits[0][0] - hits[1][0], hits[0][1] - hits[1][1]) > 1e-12) segs.push([hits[0], hits[1]]);
  }
  return chain(segs, Math.max(size, 1) * 1e-6);
}

/** Joins segments that share ends into polylines. */
function chain(segs: [V2, V2][], tol: number): Chain[] {
  const key = (p: V2) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
  const at = new Map<string, number[]>();
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k)!.push(i); } });
  const used = new Uint8Array(segs.length);
  const out: Chain[] = [];
  const next = (p: V2) => (at.get(key(p)) ?? []).find(i => !used[i]);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts: V2[] = [segs[i][0], segs[i][1]];
    // Grow forward, then backward.
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? pts[pts.length - 1] : pts[0];
        const j = next(end);
        if (j === undefined) break;
        used[j] = 1;
        const [a, b] = segs[j];
        const other = key(a) === key(end) ? b : a;
        if (forward) pts.push(other); else pts.unshift(other);
      }
    }
    const closed = pts.length > 3 && key(pts[0]) === key(pts[pts.length - 1]);
    if (closed) pts.pop();
    out.push({ pts, closed });
  }
  return out;
}

/** Fewer points along a chain for a spline: at most `max`, evenly by length, keeping the ends. */
export function thin(c: Chain, max = 12): V2[] {
  const p = c.pts;
  if (p.length <= max) return p;
  const len = [0];
  for (let i = 1; i < p.length; i++) len.push(len[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const total = len[len.length - 1] + (c.closed ? Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) : 0);
  const n = c.closed ? max : max - 1;
  const out: V2[] = [];
  let j = 0;
  for (let i = 0; i < (c.closed ? n : n + 1); i++) {
    const s = (total * i) / n;
    while (j < p.length - 1 && len[j + 1] < s) j++;
    out.push(p[Math.min(j, p.length - 1)]);
  }
  if (!c.closed) out[out.length - 1] = p[p.length - 1];
  return out.filter((q, i) => i === 0 || Math.hypot(q[0] - out[i - 1][0], q[1] - out[i - 1][1]) > 1e-9);
}
