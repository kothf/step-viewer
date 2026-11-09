// Quick snaps (FR-SK-046): quadrants, intersections, tangent points, perpendicular feet and the stored preferences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SNAPS, arcCurve, intersections, parseSnaps, perpendicularFoot, quadrants, tangentPoints, type SnapCurve } from "../../src/sketch/snaps";

const close = (a: number[], b: number[], tol = 1e-9) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < tol), `${a} vs ${b}`);
const sorted = (ps: number[][]) => ps.map(p => p.map(x => Math.round(x * 1e9) / 1e9)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test("quadrants of a circle and of an arc", () => {
  const c: SnapCurve & { k: "c" } = { id: "c", k: "c", c: [1, 2], r: 3 };
  assert.deepEqual(sorted(quadrants(c)), sorted([[4, 2], [1, 5], [-2, 2], [1, -1]]));
  // Arc from 45° to 135° ccw holds only the top quadrant.
  const s = Math.SQRT1_2 * 3;
  const a = arcCurve("a", [0, 0], [s, s], [-s, s]) as SnapCurve & { k: "c" };
  assert.deepEqual(sorted(quadrants(a)), [[0, 3]]);
});

test("line-line, line-circle and circle-circle intersections", () => {
  const l1: SnapCurve = { id: "1", k: "l", a: [0, 0], b: [10, 10] };
  const l2: SnapCurve = { id: "2", k: "l", a: [0, 10], b: [10, 0] };
  close(intersections(l1, l2)[0], [5, 5]);
  // Segments that would cross only beyond their ends.
  assert.equal(intersections(l1, { id: "3", k: "l", a: [20, 0], b: [30, -10] }).length, 0);
  const c: SnapCurve = { id: "c", k: "c", c: [0, 0], r: 5 };
  assert.deepEqual(sorted(intersections({ id: "h", k: "l", a: [-10, 3], b: [10, 3] }, c)), [[-4, 3], [4, 3]]);
  assert.deepEqual(sorted(intersections(c, { id: "d", k: "c", c: [8, 0], r: 5 })), [[4, -3], [4, 3]]);
  // The upper half arc keeps only the upper crossing.
  const up = arcCurve("u", [0, 0], [5, 0], [-5, 0]);
  assert.deepEqual(sorted(intersections(up, { id: "d", k: "c", c: [8, 0], r: 5 })), [[4, 3]]);
  assert.equal(intersections(c, { id: "far", k: "c", c: [20, 0], r: 5 }).length, 0);
});

test("tangent points from an outside point", () => {
  const c: SnapCurve & { k: "c" } = { id: "c", k: "c", c: [0, 0], r: 5 };
  const ts = tangentPoints([10, 0], c);
  assert.equal(ts.length, 2);
  for (const q of ts) {
    assert.ok(Math.abs(Math.hypot(...q) - 5) < 1e-9);
    // Radius square to the tangent line.
    assert.ok(Math.abs(q[0] * (10 - q[0]) + q[1] * (0 - q[1])) < 1e-9);
  }
  assert.equal(tangentPoints([1, 1], c).length, 0);
});

test("perpendicular foot", () => {
  close(perpendicularFoot([3, 7], { id: "l", k: "l", a: [0, 0], b: [10, 0] })!, [3, 0]);
  close(perpendicularFoot([20, 4], { id: "l", k: "l", a: [0, 0], b: [10, 0] })!, [20, 0]);
  assert.equal(perpendicularFoot([5, 0], { id: "l", k: "l", a: [0, 0], b: [10, 0] }), null);
});

test("stored snap preferences", () => {
  assert.deepEqual([...parseSnaps(null)], DEFAULT_SNAPS);
  assert.deepEqual([...parseSnaps('["mid","bogus","hv"]')], ["mid", "hv"]);
  assert.deepEqual([...parseSnaps("{bad")], DEFAULT_SNAPS);
  assert.deepEqual([...parseSnaps("[]")], []);
});
