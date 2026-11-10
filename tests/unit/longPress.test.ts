// Touch long press (FR-UI-091): which pointer events keep a press waiting, and when it is due.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_PRESS_MS, LONG_PRESS_PX, pressAfter, pressDue } from "../../src/longPress";

const ev = (kind: "down" | "move" | "up", id: number, x: number, y: number, t: number, touch = true) => ({ kind, id, x, y, t, touch });

test("a finger held still becomes due; a mouse press never starts one", () => {
  const p = pressAfter(null, ev("down", 1, 100, 100, 0));
  assert.ok(p);
  assert.equal(pressDue(p, LONG_PRESS_MS - 1), false);
  assert.equal(pressDue(p, LONG_PRESS_MS), true);
  assert.equal(pressAfter(null, ev("down", 1, 100, 100, 0, false)), null);
  assert.equal(pressDue(null, 1e6), false);
});

test("moving away, lifting or a second finger drops the press; a small wobble keeps it", () => {
  const p = pressAfter(null, ev("down", 1, 100, 100, 0))!;
  assert.equal(pressAfter(p, ev("move", 1, 100 + LONG_PRESS_PX - 1, 100, 50)), p);
  assert.equal(pressAfter(p, ev("move", 1, 100, 100 + LONG_PRESS_PX + 1, 50)), null);
  assert.equal(pressAfter(p, ev("move", 2, 500, 500, 50)), p);
  assert.equal(pressAfter(p, ev("up", 1, 100, 100, 50)), null);
  assert.equal(pressAfter(p, ev("down", 2, 300, 300, 50)), null);
});
