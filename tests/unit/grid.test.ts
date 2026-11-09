// Sketch grid (FR-SK-041): automatic spacing, lines over a box and snapping to the nearest node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRID_MAJOR, autoStep, gridLines, gridStep, snapToGrid } from "../../src/sketch/grid";

test("automatic spacing is the 1-2-5 step at least 12 px apart", () => {
  assert.equal(autoStep(0.1), 2);   // 1.2 mm wanted
  assert.equal(autoStep(0.05), 1);  // 0.6 mm wanted
  assert.equal(autoStep(0.3), 5);   // 3.6 mm wanted
  assert.equal(autoStep(1), 20);    // 12 mm wanted
  assert.ok(Math.abs(autoStep(0.001) - 0.02) < 1e-12);
});

test("a fixed spacing is kept unless the box would need too many lines", () => {
  assert.equal(gridStep(10, 0.5, [[0, 0], [500, 300]]), 10);
  assert.equal(gridStep(1, 0.5, [[0, 0], [1000, 10]], 160), 25); // 1000 lines → ×5 → ×5
  assert.equal(gridStep(0, 0.1, [[0, 0], [100, 100]]), 2);
});

test("grid lines cover the box and mark every fifth line and the axes as major", () => {
  const ls = gridLines([[-3, -1], [12, 4]], 2.5);
  const xs = ls.filter(l => l[0][0] === l[1][0]).map(l => l[0][0]);
  const ys = ls.filter(l => l[0][1] === l[1][1]).map(l => l[0][1]);
  assert.deepEqual(xs, [-2.5, 0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(ys, [0, 2.5]);
  assert.ok(ls.find(l => l[0][0] === 0 && l[1][0] === 0)![2]);
  assert.ok(!ls.find(l => l[0][0] === 2.5)![2]);
  assert.ok(gridLines([[0, 0], [GRID_MAJOR * 2, 0]], 2).find(l => l[0][0] === 10)![2]);
  assert.deepEqual(gridLines([[0, 0], [1, 1]], 0), []);
});

test("snapping goes to the nearest node, keeping a locked coordinate", () => {
  assert.deepEqual(snapToGrid([7.4, -2.6], 5), [5, -5]);
  assert.deepEqual(snapToGrid([7.6, 2.4], 5), [10, 0]);
  assert.deepEqual(snapToGrid([7.6, 3.3], 5, "y"), [10, 3.3]);
  assert.deepEqual(snapToGrid([7.6, 3.3], 5, "x"), [7.6, 5]);
  assert.deepEqual(snapToGrid([1, 1], 0), [1, 1]);
});
