// Nearest package point per model vertex (FRS-thermal FR-TMAP-002): the grid search against brute force.
import { test } from "node:test";
import assert from "node:assert/strict";
import { meanEdges, nearestPoints, pointsByPart, PointGrid } from "../../src/thermal/nearest";

function rand(seed: number) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }

test("the grid finds the same nearest point as brute force, inside and outside its box", () => {
  const r = rand(7), n = 3000, pos = new Float64Array(n * 3);
  // points on two planes of a 40 x 30 x 2 mm board (a surface, as a package is)
  for (let i = 0; i < n; i++) { pos[i * 3] = r() * 40; pos[i * 3 + 1] = r() * 30; pos[i * 3 + 2] = i % 2 ? 2 : 0; }
  const pts = Uint32Array.from({ length: n }, (_, i) => i);
  for (const cell of [0.5, 1.7, 6]) {
    const g = new PointGrid(pos, pts, cell);
    for (let k = 0; k < 400; k++) {
      const x = r() * 60 - 10, y = r() * 50 - 10, z = r() * 10 - 4;
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = (pos[i * 3] - x) ** 2 + (pos[i * 3 + 1] - y) ** 2 + (pos[i * 3 + 2] - z) ** 2; if (d < bd) { bd = d; best = i; } }
      const got = g.nearest(x, y, z);
      const gd = (pos[got * 3] - x) ** 2 + (pos[got * 3 + 1] - y) ** 2 + (pos[got * 3 + 2] - z) ** 2;
      assert.ok(Math.abs(gd - bd) < 1e-9, `cell ${cell}: ${got} at ${gd} vs ${best} at ${bd}`);
    }
  }
});

test("points are kept per part, and a query only sees its own part", () => {
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0];
  const tri = [0, 1, 2, 3, 4, 5], part = [1, 2];
  const by = pointsByPart(tri, part);
  assert.deepEqual([...by.get(1)!].sort(), [0, 1, 2]);
  assert.deepEqual([...by.get(2)!].sort(), [3, 4, 5]);
  // a vertex right next to part 2's points still takes part 1's nearest
  const near = nearestPoints(pos, by.get(1)!, [4.9, 0, 0, 0.1, 0.9, 0]);
  assert.deepEqual([...near], [1, 2]);
  const e = meanEdges(pos, tri, part);
  assert.ok(Math.abs(e.get(1)! - (2 + Math.SQRT2) / 3) < 1e-12);
  assert.equal(new PointGrid(pos, []).nearest(0, 0, 0), -1);
});
