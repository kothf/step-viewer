// Mouse gestures (FR-UI-024): drag direction to slot, and the stored settings repaired on load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GESTURES, GESTURE_CMDS, GESTURE_RUN, gestureSlot, parseGestures } from "../../src/gestures";

test("a drag picks the slot clockwise from up; short drags pick none", () => {
  const d = 60;
  assert.equal(gestureSlot(0, -d, 8), 0);
  assert.equal(gestureSlot(d, -d, 8), 1);
  assert.equal(gestureSlot(d, 0, 8), 2);
  assert.equal(gestureSlot(d, d, 8), 3);
  assert.equal(gestureSlot(0, d, 8), 4);
  assert.equal(gestureSlot(-d, d, 8), 5);
  assert.equal(gestureSlot(-d, 0, 8), 6);
  assert.equal(gestureSlot(-d, -d, 8), 7);
  assert.equal(gestureSlot(3, GESTURE_RUN - 5, 8), -1);
});

test("with 4 directions only even slots come back, split at the diagonals", () => {
  assert.equal(gestureSlot(50, -40, 4), 2);   // nearer right than up
  assert.equal(gestureSlot(40, -50, 4), 0);
  assert.equal(gestureSlot(-50, 45, 4), 6);
  assert.equal(gestureSlot(-40, 50, 4), 4);
  assert.equal(gestureSlot(-20, -60, 4), 0);  // wraps to up
});

test("stored settings: defaults, unknown commands replaced, 8 kept", () => {
  assert.deepEqual(parseGestures(null), DEFAULT_GESTURES);
  assert.deepEqual(parseGestures("not json"), DEFAULT_GESTURES);
  const c = parseGestures(JSON.stringify({ on: true, n: 8, part: ["view:back", "nonsense"], sketch: ["sk:line", "", 7] }));
  assert.equal(c.on, true);
  assert.equal(c.n, 8);
  assert.equal(c.part[0], "view:back");
  assert.equal(c.part[1], DEFAULT_GESTURES.part[1]);
  assert.equal(c.part.length, 8);
  assert.equal(c.sketch[1], "");
  assert.equal(c.sketch[2], DEFAULT_GESTURES.sketch[2]);
  assert.equal(parseGestures(JSON.stringify({ n: 5 })).n, 4);
});

test("every default slot is a listed command", () => {
  for (const mode of ["part", "sketch"] as const) {
    const ok = new Set(GESTURE_CMDS[mode].map(c => c[0]));
    for (const id of DEFAULT_GESTURES[mode]) assert.ok(ok.has(id), `${mode}: ${id}`);
  }
});
