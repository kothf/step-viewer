// Element matrices from moments (`src/sim/moments.ts`) equal the sums over the integration points they replace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Basis, basisSize } from "../../src/sim/basis";
import { conductFromMoments, degreeOf, massFromMoments, momentTables, momentsAdd, momentsClear, momentsPoint } from "../../src/sim/moments";

/** Points with weights in and a little outside the element (an aggregated element has points beyond its cube). */
function points(n: number, seed: number) {
  let s = seed;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const a = new Float64Array(4 * n);
  for (let i = 0; i < n; i++) { a[4 * i] = 10 + 6 * (r() - 0.5); a[4 * i + 1] = -3 + 5 * (r() - 0.5); a[4 * i + 2] = 2 + 4.4 * (r() - 0.5); a[4 * i + 3] = 0.2 + r(); }
  return a;
}
const c = [10, -3, 2], s = 2;

function worst(A: Float64Array, B: Float64Array) {
  let d = 0, m = 0;
  for (let i = 0; i < A.length; i++) { d = Math.max(d, Math.abs(A[i] - B[i])); m = Math.max(m, Math.abs(B[i])); }
  return d / m;
}

for (const p of [1, 2, 4, 6]) {
  test(`conduction from moments equals the sum over the points, degree ${p}`, () => {
    const bas = new Basis(p), nb = bas.n, pts = points(300, 7 + p), k = [1.5, 0.2, 30];
    const want = new Float64Array(nb * nb);
    for (let q = 0; q < 300; q++) {
      bas.eval(pts[4 * q], pts[4 * q + 1], pts[4 * q + 2], c, s);
      const w = pts[4 * q + 3], g = bas.g;
      for (let a = 0; a < nb; a++) for (let b = 0; b < nb; b++) want[a * nb + b] += w * (k[0] * g[3 * a] * g[3 * b] + k[1] * g[3 * a + 1] * g[3 * b + 1] + k[2] * g[3 * a + 2] * g[3 * b + 2]);
    }
    const T = momentTables(p), got = new Float64Array(nb * nb);
    momentsClear(T);
    momentsAdd(T, pts, 0, 300, c, s, Math.max(0, 2 * p - 2));
    conductFromMoments(T, got, nb, s, k[0], k[1], k[2]);
    momentsClear(T);
    assert.ok(worst(got, want) < 1e-11, `off by ${worst(got, want)}`);
  });

  test(`products of functions from weighted moments equal the sum over the points, degree ${p}`, () => {
    const bas = new Basis(p), nb = bas.n, pts = points(200, 31 + p);
    const want = new Float64Array(nb * nb);
    const T = momentTables(p), got = new Float64Array(nb * nb);
    momentsClear(T);
    for (let q = 0; q < 200; q++) {
      bas.eval(pts[4 * q], pts[4 * q + 1], pts[4 * q + 2], c, s);
      const w = pts[4 * q + 3] * (1 + 0.3 * Math.sin(q)), v = bas.v;
      for (let a = 0; a < nb; a++) for (let b = 0; b < nb; b++) want[a * nb + b] += w * v[a] * v[b];
      momentsPoint(T, pts[4 * q], pts[4 * q + 1], pts[4 * q + 2], w, c, s, 2 * p);
    }
    massFromMoments(T, got, nb);
    momentsClear(T);
    assert.ok(worst(got, want) < 1e-11, `off by ${worst(got, want)}`);
  });
}

test("an element of a lower degree takes the leading functions of the tables", () => {
  const p = 5, low = 3, bas = new Basis(p), nb = basisSize(low), pts = points(150, 99);
  assert.equal(degreeOf(nb), low);
  const want = new Float64Array(nb * nb);
  for (let q = 0; q < 150; q++) {
    bas.eval(pts[4 * q], pts[4 * q + 1], pts[4 * q + 2], c, s, nb);
    const w = pts[4 * q + 3], g = bas.g;
    for (let a = 0; a < nb; a++) for (let b = 0; b < nb; b++) want[a * nb + b] += w * (g[3 * a] * g[3 * b] + g[3 * a + 1] * g[3 * b + 1] + g[3 * a + 2] * g[3 * b + 2]);
  }
  const T = momentTables(p), got = new Float64Array(nb * nb);
  momentsClear(T);
  momentsAdd(T, pts, 0, 150, c, s, 2 * low - 2);
  conductFromMoments(T, got, nb, s, 1, 1, 1);
  momentsClear(T);
  assert.ok(worst(got, want) < 1e-11, `off by ${worst(got, want)}`);
});
