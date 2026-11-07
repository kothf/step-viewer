// Interpolating sketch splines (FR-SK-019): a C2 cubic through the points,
// chord-length parametrised, natural ends (or periodic when closed). The curve
// is kept as cubic Bézier segments: 3n + 1 control points for n segments, the
// same poles the kernel turns into one B-spline edge.
import type { V2 } from "../model/types";

/** Bézier control points of the spline through pts (closed: back to the first point). */
export function splineBezier(pts: V2[], closed = false): V2[] {
  const P = closed ? [...pts, pts[0]] : pts.slice();
  const m = P.length; // knots
  if (m < 2) return P.slice();
  const n = m - 1; // segments
  const h = Array.from({ length: n }, (_, i) => Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) || 1e-9);
  // Unknown derivative at each distinct knot (closed: the last knot is the first).
  const k = closed ? n : m;
  const A = Array.from({ length: k }, () => new Float64Array(k));
  const bx = new Float64Array(k), by = new Float64Array(k);
  const at = (i: number) => (closed ? ((i % k) + k) % k : i);
  for (let i = 0; i < k; i++) {
    const open0 = !closed && i === 0, openN = !closed && i === k - 1;
    if (open0) {
      A[0][0] = 2; if (k > 1) A[0][1] = 1;
      bx[0] = (3 * (P[1][0] - P[0][0])) / h[0]; by[0] = (3 * (P[1][1] - P[0][1])) / h[0];
    } else if (openN) {
      A[i][i - 1] = 1; A[i][i] = 2;
      bx[i] = (3 * (P[i][0] - P[i - 1][0])) / h[i - 1]; by[i] = (3 * (P[i][1] - P[i - 1][1])) / h[i - 1];
    } else {
      const hp = h[at(i - 1)], hn = h[at(i)];
      const pp = P[at(i - 1)], pc = P[i], pn = P[at(i) + 1];
      A[i][at(i - 1)] += hn; A[i][i] += 2 * (hp + hn); A[i][at(i + 1)] += hp;
      bx[i] = 3 * ((hn * (pc[0] - pp[0])) / hp + (hp * (pn[0] - pc[0])) / hn);
      by[i] = 3 * ((hn * (pc[1] - pp[1])) / hp + (hp * (pn[1] - pc[1])) / hn);
    }
  }
  const dx = solveDense(A.map(r => Float64Array.from(r)), bx), dy = solveDense(A, by);
  const D = (i: number): V2 => [dx[at(i)], dy[at(i)]];
  const out: V2[] = [P[0]];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[i + 1], da = D(i), db = D(i + 1);
    out.push([a[0] + (h[i] * da[0]) / 3, a[1] + (h[i] * da[1]) / 3], [b[0] - (h[i] * db[0]) / 3, b[1] - (h[i] * db[1]) / 3], b);
  }
  return out;
}

function solveDense(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length, x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [x[p], x[c]] = [x[c], x[p]]; }
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let j = c; j < n; j++) A[r][j] -= f * A[c][j];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / (A[r][r] || 1e-12);
  }
  return x;
}

/** Points along Bézier segments (k per segment, plus the last point). */
export function bezPts(bz: V2[], k = 16): V2[] {
  const out: V2[] = [];
  for (let s = 0; s + 3 < bz.length; s += 3) {
    const [a, b, c, d] = [bz[s], bz[s + 1], bz[s + 2], bz[s + 3]];
    for (let j = 0; j < k; j++) {
      const t = j / k, u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      out.push([w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]]);
    }
  }
  if (bz.length) out.push(bz[bz.length - 1]);
  return out;
}

/** Nearest point of a polyline to p, and its distance. */
export function nearestOn(line: V2[], p: V2): { q: V2; d: number } {
  let best: V2 = line[0] ?? p, bd = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const ux = b[0] - a[0], uy = b[1] - a[1], l2 = ux * ux + uy * uy || 1e-24;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / l2));
    const q: V2 = [a[0] + ux * t, a[1] + uy * t], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bd) { bd = d; best = q; }
  }
  return { q: best, d: bd };
}
