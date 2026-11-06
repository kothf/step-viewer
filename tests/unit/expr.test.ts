import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, ExprError } from "../../src/model/expr";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("lengths with units and arithmetic", () => {
  near(evaluate("10", "length"), 10);
  near(evaluate("10+2.5", "length"), 12.5);
  near(evaluate("1in", "length"), 25.4);
  near(evaluate("1 in + 10", "length"), 35.4);
  near(evaluate("25.4mm/2", "length"), 12.7);
  near(evaluate("2*(3+4)", "length"), 14);
  near(evaluate("sqrt(2)*10", "length"), Math.sqrt(2) * 10);
  near(evaluate("12,5", "length"), 12.5);
  near(evaluate("1", "length", "in"), 25.4);
  near(evaluate("-3", "length"), -3);
  near(evaluate("2^3", "length"), 8);
  near(evaluate("wall*2", "length", "mm", { wall: 4 }), 8);
});

test("angles", () => {
  near(evaluate("90", "angle"), Math.PI / 2);
  near(evaluate("pi/2 rad", "angle"), Math.PI / 2 * 1);
  near(evaluate("45deg", "angle"), Math.PI / 4);
  near(evaluate("30°", "angle"), Math.PI / 6);
});

test("errors", () => {
  assert.throws(() => evaluate("", "length"), ExprError);
  assert.throws(() => evaluate("10 +", "length"), ExprError);
  assert.throws(() => evaluate("foo", "length"), ExprError);
  assert.throws(() => evaluate("1/0", "length"), ExprError);
  assert.throws(() => evaluate("5deg", "length"), ExprError);
  assert.throws(() => evaluate("alert(1)", "length"), ExprError);
});
