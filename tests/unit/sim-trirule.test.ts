import { test } from "node:test";
import assert from "node:assert/strict";
import { Points, triangleRule, triangleGauss, gridTrianglePoints, TRI_RULE_MAX } from "../../src/sim/quad";

const fact = (n: number) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };

test("triangle rules are exact to their degree and have positive weights inside the triangle", () => {
  const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0];
  const counts = [1, 1, 3, 6, 6, 7, 12, 16, 16];
  for (let deg = 0; deg <= TRI_RULE_MAX; deg++) {
    const P = new Points();
    triangleRule(a, b, c, deg, P);
    assert.equal(P.n, counts[deg], `points at degree ${deg}`);
    for (let i = 0; i < P.n; i++) {
      const x = P.a[4 * i], y = P.a[4 * i + 1], w = P.a[4 * i + 3];
      assert.ok(w > 0 && x > 0 && y > 0 && x + y < 1);
    }
    for (let i = 0; i <= deg; i++) for (let j = 0; i + j <= deg; j++) {
      let s = 0;
      for (let k = 0; k < P.n; k++) s += P.a[4 * k + 3] * P.a[4 * k] ** i * P.a[4 * k + 1] ** j;
      const exact = fact(i) * fact(j) / fact(i + j + 2);
      assert.ok(Math.abs(s - exact) < 2e-14, `x^${i} y^${j} at degree ${deg}: ${s} vs ${exact}`);
    }
  }
});

test("above the symmetric rules the collapsed Gauss rule takes over", () => {
  const a = [0, 0, 0], b = [2, 0, 1], c = [0, 1, 3], P = new Points(), Q = new Points();
  triangleRule(a, b, c, 10, P);
  triangleGauss(a, b, c, 6, Q);
  assert.deepEqual(Array.from(P.a.subarray(0, 4 * P.n)), Array.from(Q.a.subarray(0, 4 * Q.n)));
});

test("points of triangles cut at grid planes integrate polynomials like the collapsed rule, with fewer points", () => {
  const tris = [0.13, 0.2, 0.05, 2.7, 0.4, 0.9, 0.6, 2.3, 1.7, -0.4, 0.1, 0.2, 0.3, 0.2, 0.25, 0.1, 0.6, 0.3];
  const f = (x: number, y: number, z: number) => (1 + x - 0.3 * y) ** 3 * (0.5 + z) ** 2 * (y + 0.2 * x);
  for (const n of [2, 3, 4, 5]) {
    const { pts, tri } = gridTrianglePoints(tris, [-1, -1, -1], 1, n, () => 99);
    assert.equal(tri.length, pts.n);
    let s = 0, area = 0;
    for (let i = 0; i < pts.n; i++) { area += pts.a[4 * i + 3]; if (n >= 4) s += pts.a[4 * i + 3] * f(pts.a[4 * i], pts.a[4 * i + 1], pts.a[4 * i + 2]); }
    // the same pieces by the collapsed rule of high order
    const ref = new Points();
    let pieces = 0;
    for (let t = 0; t < 2; t++) {
      const one = gridTrianglePoints(tris.slice(9 * t, 9 * t + 9), [-1, -1, -1], 1, 1);
      pieces += one.pts.n;
    }
    for (let t = 0; t < 2; t++) triangleGauss(tris.slice(9 * t, 9 * t + 3), tris.slice(9 * t + 3, 9 * t + 6), tris.slice(9 * t + 6, 9 * t + 9), 8, ref);
    let s0 = 0, area0 = 0;
    for (let i = 0; i < ref.n; i++) { area0 += ref.a[4 * i + 3]; s0 += ref.a[4 * i + 3] * f(ref.a[4 * i], ref.a[4 * i + 1], ref.a[4 * i + 2]); }
    assert.ok(Math.abs(area - area0) < 1e-12 * area0);
    if (n >= 4) assert.ok(Math.abs(s - s0) < 1e-11 * Math.abs(s0), `${s} vs ${s0}`);
    if (n <= 5) assert.ok(pts.n < pieces * n * n, "fewer points than n × n per piece");
    // asked for less by the piece: fewer points still
    const low = gridTrianglePoints(tris, [-1, -1, -1], 1, n, () => 2);
    assert.equal(low.pts.n, pieces * 3);
  }
});
