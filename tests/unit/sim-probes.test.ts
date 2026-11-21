// Probes (FRS-structural FR-RES-005): a point found again on the plot mesh, and the CSV table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { locate, probeCsv, valueAt } from "../../src/sim/probes";

test("probes: the nearest point of the mesh, inside a triangle, on an edge and at a corner", () => {
  // two triangles of the unit square in z = 0
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], index = [0, 1, 2, 0, 2, 3];
  const at = (p: number[]) => { const l = locate(pos, index, p)!; return { l, q: [0, 1, 2].map(c => valueAt(pos, l, 3, c)) }; };
  const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
  const inside = at([0.7, 0.2, 0.5]);
  assert.ok(near(inside.q, [0.7, 0.2, 0]) && Math.abs(inside.l.d - 0.5) < 1e-12);
  assert.deepEqual(inside.l.i, [0, 1, 2]);
  assert.ok(Math.abs(inside.l.w[0] + inside.l.w[1] + inside.l.w[2] - 1) < 1e-12 && inside.l.w.every(w => w >= 0));
  assert.ok(near(at([0.2, 0.7, -1]).q, [0.2, 0.7, 0]));
  assert.ok(near(at([1.5, 0.4, 0]).q, [1, 0.4, 0]), "beside an edge");
  assert.ok(near(at([-2, -3, 1]).q, [0, 0, 0]), "past a corner");
  assert.ok(near(at([2, 2, 0]).q, [1, 1, 0]));
  assert.ok(near(at([0.5, 0.5, 0]).q, [0.5, 0.5, 0]), "on the shared edge");
  // a value per vertex is read with the same weights
  assert.ok(Math.abs(valueAt([0, 10, 20, 10], inside.l) - (10 * 0.7 + 10 * 0.2)) < 1e-12);
  assert.equal(locate(pos, [], [0, 0, 0]), null);
});

test("probes: the CSV has a row per probe; the safety factor only when the material has a yield strength", () => {
  const csv = probeCsv([{ at: [1, 2, 3], vm: 123.456789, u: [0.3, 0, -0.4], sf: 2 }, { at: [0, 0, 0], vm: 0, u: [0, 0, 0], sf: 5 }]);
  const rows = csv.trim().split("\r\n").map(r => r.split(","));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ["Probe", "X (mm)", "Y (mm)", "Z (mm)", "von Mises (MPa)", "Displacement (mm)", "UX (mm)", "UY (mm)", "UZ (mm)", "Safety factor"]);
  assert.deepEqual(rows[1], ["1", "1", "2", "3", "123.4568", "0.5", "0.3", "0", "-0.4", "2"]);
  assert.equal(probeCsv([{ at: [1, 2, 3], vm: 1, u: [0, 0, 0] }]).split("\r\n")[0].split(",").length, 9);
});
