// Flat faces made of many triangles (1.733.0): the boundary points of one element in one plane are replaced by a
// few fitted points, so a film or radiation on a finely triangulated face gives what the same face in two triangles gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal } from "../../src/sim/thermal";

const lo = [0, 0, 0], hi = [40, 10, 10];
const box = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 10 && z >= 0 && z <= 10;
// the left face x = 0 (looking out), heated
const left = [0, 0, 0, 0, 10, 10, 0, 10, 0, 0, 0, 0, 0, 0, 10, 0, 10, 10];
/** The top face z = 10 looking up, as nx × ny quads of two triangles each, the quads' corners moved off a plain grid. */
function top(nx: number, ny: number): number[] {
  const P = (i: number, j: number) => {
    const wob = i > 0 && i < nx && j > 0 && j < ny ? 0.3 * Math.sin(7 * i + 3 * j) : 0;
    return [(40 * i) / nx + wob * (40 / nx), (10 * j) / ny + wob * (10 / ny) * 0.5, 10];
  };
  const out: number[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return out;
}

for (const p of [2, 4]) {
  test(`a film on a face of 400 triangles gives what the face in 2 triangles gives (p = ${p})`, () => {
    const run = (t: number[]) => solveThermal({ lo, hi, inside: box, h: 10, p, k: 0.2, sinks: [{ tris: t, h: 2e-5, ambient: 25 }], sources: [{ tris: left, power: 1 }] });
    const a = run(top(1, 1)), b = run(top(20, 10));
    for (const q of [[0, 5, 5], [20, 2, 9], [39, 8, 10], [10, 5, 0]]) assert.ok(Math.abs(a.temp(q[0], q[1], q[2]) - b.temp(q[0], q[1], q[2])) < 1e-9 * a.temp(q[0], q[1], q[2]), `T at ${q}: ${a.temp(q[0], q[1], q[2])} vs ${b.temp(q[0], q[1], q[2])}`);
    assert.ok(Math.abs(b.flows[0].out - 1) < 1e-8, `out ${b.flows[0].out}`);
  });
}

test("radiation on a face of 400 triangles is within a millikelvin of the face in 2 triangles", () => {
  const run = (t: number[]) => solveThermal({ lo, hi, inside: box, h: 10, p: 3, k: 0.2, sinks: [{ tris: t, emissivity: 0.9, ambient: 25 }], sources: [{ tris: left, power: 0.5 }] });
  const a = run(top(1, 1)), b = run(top(20, 10));
  for (const q of [[0, 5, 5], [20, 2, 9], [39, 8, 10]]) assert.ok(Math.abs(a.temp(q[0], q[1], q[2]) - b.temp(q[0], q[1], q[2])) < 1e-3, `T at ${q}: ${a.temp(q[0], q[1], q[2])} vs ${b.temp(q[0], q[1], q[2])}`);
  assert.ok(Math.abs(b.flows[0].out - 0.5) < 1e-5, `out ${b.flows[0].out}`);
});
