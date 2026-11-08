import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXyz } from "../../src/model/curves";

test("XYZ points from CSV and text (FR-FT-085)", () => {
  assert.deepEqual(parseXyz("x,y,z\n0,0,0\n1.5, 2, 3\n\n# note\n4 5 6\n7\t8\t9"), [[0, 0, 0], [1.5, 2, 3], [4, 5, 6], [7, 8, 9]]);
  // Semicolons with decimal commas; two values give z = 0; scaling to millimetres.
  assert.deepEqual(parseXyz("1,5;2;3\n4;5", 10), [[15, 20, 30], [40, 50, 0]]);
  assert.deepEqual(parseXyz("a;b;c\nfoo"), []);
});
