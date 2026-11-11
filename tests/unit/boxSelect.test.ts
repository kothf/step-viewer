// Box selection in parts (FR-SEL-008): window and crossing tests on screen polylines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCrossing, mergeSel, polyInside, polyTaken, polyTouches, probeGrid, rectOf, segTouches } from "../../src/boxSelect";

const r = rectOf(100, 100, 0, 0);

test("the box is the same whichever corner it starts from; right to left crosses", () => {
  assert.deepEqual(r, { x0: 0, y0: 0, x1: 100, y1: 100 });
  assert.equal(isCrossing(100, 0), true);
  assert.equal(isCrossing(0, 100), false);
});

test("segments touch the box by an end or by passing through it", () => {
  assert.equal(segTouches(r, 50, 50, 200, 200), true);
  assert.equal(segTouches(r, -50, 50, 150, 50), true);
  assert.equal(segTouches(r, -50, -50, -10, 150), false);
  assert.equal(segTouches(r, 150, -10, 210, 50), false);
  assert.equal(segTouches(r, -20, 60, 60, -20), true);
});

test("window takes only polylines wholly inside; crossing those touching", () => {
  const inside = [10, 10, 90, 10, 90, 90], across = [50, 50, 150, 50], out = [150, 150, 200, 200];
  assert.equal(polyInside(r, inside), true);
  assert.equal(polyInside(r, across), false);
  assert.equal(polyTouches(r, across), true);
  assert.equal(polyTouches(r, out), false);
  assert.equal(polyTaken(r, across, false), false);
  assert.equal(polyTaken(r, across, true), true);
});

test("the probe grid covers the box within the limit", () => {
  const g = probeGrid(rectOf(0, 0, 400, 300), 1000);
  assert.ok(g.length <= 1100 && g.length > 500);
  assert.ok(g.every(([x, y]) => x >= 0 && x <= 400 && y >= 0 && y <= 300));
  assert.equal(probeGrid(rectOf(5, 5, 6, 6)).length, 1);
});

test("Ctrl adds to the selection without repeats; a plain box replaces it", () => {
  assert.deepEqual(mergeSel([1, 2], [2, 3], true), [1, 2, 3]);
  assert.deepEqual(mergeSel([1, 2], [3], false), [3]);
});
