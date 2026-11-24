// Structural analysis: the many quadrature points of a flat face inside one cell are replaced by a few fitted ones
// (fitPlanePoints). They must integrate every polynomial of the degree asked for as the points they replace do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Points, fitPlanePoints } from "../../src/sim/quad";

test("fitted points of a tilted flat patch integrate polynomials like the points they replace", () => {
  // an L-shaped patch in the plane x + 2y + 2z = 3, sampled densely
  const n = [1 / 3, 2 / 3, 2 / 3], u = [2 / 3, -2 / 3, 1 / 3], v = [2 / 3, 1 / 3, -2 / 3], o = [1, 1, 0];
  const src = new Points(), idx: number[] = [];
  const N = 60;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = (i + 0.5) / N, b = (j + 0.5) / N;
    if (a > 0.5 && b > 0.4) continue;
    idx.push(src.n);
    src.push(o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2], 1 / (N * N));
  }
  const q = 9, F = fitPlanePoints(src, idx, n, q, 1e-12)!;
  assert.ok(F && F.n <= q * q && F.n < src.n / 10, `${F?.n} points for ${src.n}`);
  const sum = (P: Points, f: (x: number, y: number, z: number) => number, only?: number[]) => {
    let s = 0;
    for (const k of only ?? Array.from({ length: P.n }, (_x, i) => i)) s += P.a[4 * k + 3] * f(P.a[4 * k], P.a[4 * k + 1], P.a[4 * k + 2]);
    return s;
  };
  for (const f of [() => 1, (x: number) => x, (x: number, y: number, z: number) => x * y * z, (x: number, y: number, z: number) => x ** 3 * y ** 2 * z ** 3 - 2 * y ** 8 + z ** 5 * x]) {
    const a = sum(src, f, idx), b = sum(F, f);
    assert.ok(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a)), `${a} vs ${b}`);
  }
  // every fitted point lies in the plane
  for (let k = 0; k < F.n; k++) assert.ok(Math.abs(F.a[4 * k] + 2 * F.a[4 * k + 1] + 2 * F.a[4 * k + 2] - 3) < 1e-12);
  // too few points to gain, or points along a line: left as they are
  assert.equal(fitPlanePoints(src, idx.slice(0, 50), n, q, 1e-12), null);
});
