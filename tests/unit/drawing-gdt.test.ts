// Geometric tolerance frames: which characteristics take datums.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GSYMS, takesDatums } from "../../src/drawing/gdt";

test("form tolerances relate to no datum (drawings tests C5)", () => {
  assert.deepEqual(GSYMS.filter(s => !takesDatums(s)), ["straight", "flat", "circ", "cyl"]);
  assert.ok(takesDatums("perp") && takesDatums("pos") && takesDatums("pline"));
});
