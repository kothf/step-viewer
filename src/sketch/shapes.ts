// 3-point rectangles and the parallelogram (FR-SK-013, P2), perimeter circle (FR-SK-014, P2).
type V2 = [number, number];
const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const cross2 = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];

/**
 * Corners, in order round the outline, of a 3-point rectangle (first side p1–p2, p3 sets the width), a 3-point centre
 * rectangle (centre p1, middle of a side p2, p3 sets the other half-size) or a parallelogram (p1, p2, p3, then p1 + p3 − p2).
 */
export function quadCorners(kind: "rect3" | "crect3" | "pgram", p1: V2, p2: V2, p3: V2): V2[] | null {
  const u = sub2(p2, p1), l = Math.hypot(u[0], u[1]);
  if (l < 1e-9) return null;
  if (kind === "pgram") return Math.abs(cross2(u, sub2(p3, p2))) < 1e-9 * l * l ? null : [p1, p2, p3, [p1[0] + p3[0] - p2[0], p1[1] + p3[1] - p2[1]]];
  const n: V2 = [-u[1] / l, u[0] / l];
  const h = n[0] * (p3[0] - p1[0]) + n[1] * (p3[1] - p1[1]);
  if (Math.abs(h) < 1e-9) return null;
  const at = (c: V2, k: number): V2 => [c[0] + n[0] * h * k, c[1] + n[1] * h * k];
  if (kind === "rect3") return [p1, p2, at(p2, 1), at(p1, 1)];
  const a: V2 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
  return [at(a, -1), at(p2, -1), at(p2, 1), at(a, 1)];
}

/** What a perimeter circle click touched: a free point, a line (through a, b) or a circle/arc (centre c, radius r). */
export type PerimItem = { k: "p"; p: V2 } | { k: "l"; a: V2; b: V2 } | { k: "c"; c: V2; r: number };

/**
 * Perimeter circle (FR-SK-014, P2): the circle through the free points and tangent to the lines and circles clicked,
 * found by Newton from the circle through the three click points `at`, so it is the solution nearest to where the
 * user clicked. Each tangency keeps the side the start circle is on; `inner[i]` says a circle is touched from inside
 * (one circle contains the other). Null when the clicks are on one line or Newton does not settle.
 */
export function perimeterCircle(items: PerimItem[], at: V2[]): { c: V2; r: number; inner: boolean[] } | null {
  const c0 = circumcentre3(at[0], at[1], at[2]);
  if (!c0) return null;
  let x = [c0[0], c0[1], Math.hypot(at[0][0] - c0[0], at[0][1] - c0[1])];
  const scale = x[2];
  // Fix each tangency's side from the start circle.
  const side = items.map(it => {
    if (it.k === "l") { const u = sub2(it.b, it.a); return Math.sign(cross2(u, sub2(c0, it.a))) || 1; }
    return 0;
  });
  const inner = items.map(it => it.k === "c" && Math.hypot(c0[0] - it.c[0], c0[1] - it.c[1]) < it.r);
  const big = items.map((it, i) => inner[i] && it.k === "c" && x[2] > it.r); // the new circle holds the old one
  const res = (v: number[]) => items.map((it, i) => {
    const c: V2 = [v[0], v[1]], r = v[2];
    if (it.k === "p") return Math.hypot(c[0] - it.p[0], c[1] - it.p[1]) - r;
    if (it.k === "l") { const u = sub2(it.b, it.a), l = Math.hypot(u[0], u[1]); return side[i] * cross2(u, sub2(c, it.a)) / l - r; }
    const d = Math.hypot(c[0] - it.c[0], c[1] - it.c[1]);
    return inner[i] ? (big[i] ? d - (r - it.r) : d - (it.r - r)) : d - (r + it.r);
  });
  for (let k = 0; k < 60; k++) {
    const f = res(x);
    if (Math.hypot(...f) < 1e-10 * scale) break;
    const h = 1e-7 * scale, J = [0, 1, 2].map(j => { const y = x.slice(); y[j] += h; return res(y).map((v, i) => (v - f[i]) / h); });
    // Solve J^T (columns) · dx = -f, 3×3 by Cramer.
    const A = [0, 1, 2].map(i => [J[0][i], J[1][i], J[2][i]]);
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-14) return null;
    const dx = [0, 1, 2].map(j => det(A.map((row, i) => row.map((v, jj) => (jj === j ? -f[i] : v)))) / D);
    let s = 1;
    while (s > 1e-3 && x[2] + s * dx[2] <= 0) s /= 2;
    x = x.map((v, j) => v + s * dx[j]);
  }
  if (x[2] <= 0 || Math.hypot(...res(x)) > 1e-7 * scale) return null;
  return { c: [x[0], x[1]], r: x[2], inner };
}

function circumcentre3(a: V2, b: V2, c: V2): V2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
