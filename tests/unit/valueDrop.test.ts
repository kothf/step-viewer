// Measured values into numeric inputs (FR-MEA-002): which shown texts are values, and what an input receives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShown } from "../../src/valueDrop";
import { evaluate } from "../../src/model/expr";

test("lengths, diameters, radii and angles parse with their unit", () => {
  assert.deepEqual(parseShown("40.000 mm"), { num: 40, unit: "mm", angle: false, expr: "40.000 mm", base: 40 });
  assert.equal(parseShown("Ø12.500 mm")!.base, 12.5);
  assert.equal(parseShown("R 3.2 mm")!.base, 3.2);
  assert.equal(parseShown("SØ8 mm")!.base, 8);
  assert.equal(parseShown("1.5000 in")!.base, 38.1);
  assert.equal(parseShown("0.25 cm")!.base, 2.5);
  assert.equal(parseShown("−4.5 mm")!.base, -4.5);
  const a = parseShown("30.000°")!;
  assert.equal(a.angle, true);
  assert.equal(a.base, 30);
  assert.equal(a.expr, "30.000°");
});

test("areas, points, masses and words are not values", () => {
  for (const s of ["120.0 mm²", "X 1.000  Y 2.000  Z 3.000", "12.3 g", "Parallel", "", "mm", "40 mm 30 mm"]) assert.equal(parseShown(s), null, s);
});

test("the expression text evaluates back to the base value", () => {
  for (const s of ["40.000 mm", "1.5000 in", "0.25 cm", "2.00000 ft"]) {
    const v = parseShown(s)!;
    assert.ok(Math.abs(evaluate(v.expr, "length") - v.base) < 1e-9, s);
  }
  assert.ok(Math.abs(evaluate(parseShown("30.000°")!.expr, "angle") - Math.PI / 6) < 1e-12);
});
