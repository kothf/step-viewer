// View factors by ray sampling (FRS-thermal FR-TBC-007) against closed-form answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewFactor, exchangeResistance } from "../../src/sim/viewfactor";

/** A W×W square at height z, normal +z (`up`) or −z. */
function square(w: number, z: number, up: boolean, x0 = 0): number[] {
  const A = [x0, 0, z], B = [x0 + w, 0, z], C = [x0 + w, w, z], D = [x0, w, z];
  return up ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
/** Two equal parallel coaxial squares of side W, H apart. */
function parallel(W: number, H: number): number {
  const X = W / H, Y = W / H;
  return (2 / (Math.PI * X * Y)) * (Math.log(Math.sqrt(((1 + X * X) * (1 + Y * Y)) / (1 + X * X + Y * Y)))
    + X * Math.sqrt(1 + Y * Y) * Math.atan(X / Math.sqrt(1 + Y * Y)) + Y * Math.sqrt(1 + X * X) * Math.atan(Y / Math.sqrt(1 + X * X)) - X * Math.atan(X) - Y * Math.atan(Y));
}

test("parallel squares: the closed form within 1 %", () => {
  for (const [W, H] of [[10, 10], [20, 5], [10, 40]]) {
    const v = viewFactor(square(W, 0, true), square(W, H, false));
    const want = parallel(W, H);
    assert.ok(Math.abs(v.fab - want) < 0.01 + 0.01 * want, `W ${W} H ${H}: ${v.fab} vs ${want}`);
    assert.ok(Math.abs(v.areaA - W * W) < 1e-9 && Math.abs(v.fba - v.fab) < 1e-12);
  }
});

test("faces that look away see nothing; a plate in between blocks the view", () => {
  assert.equal(viewFactor(square(10, 0, false), square(10, 10, false)).fab, 0);
  const a = square(10, 0, true), b = square(10, 10, false);
  const open = viewFactor(a, b).fab;
  // a big plate halfway, both faces
  const plate = [...square(40, 5, true, -15).map((v, i) => (i % 3 === 1 ? v - 15 : v)), ...square(40, 5, false, -15).map((v, i) => (i % 3 === 1 ? v - 15 : v))];
  assert.ok(open > 0.15);
  assert.equal(viewFactor(a, b, plate).fab, 0);
  // the same faces listed among every triangle of the model change nothing
  assert.ok(Math.abs(viewFactor(a, b, [...a, ...b]).fab - open) < 1e-12);
});

test("grey exchange resistance: two black faces = 1/(A F)", () => {
  assert.ok(Math.abs(exchangeResistance(1, 1, 100, 100, 0.2) - 1 / 20) < 1e-15);
  assert.equal(exchangeResistance(0.9, 0.9, 100, 100, 0), Infinity);
  // infinite parallel plates (F = 1, equal areas): 1/ε1 + 1/ε2 − 1 over A
  assert.ok(Math.abs(exchangeResistance(0.5, 0.8, 50, 50, 1) * 50 - (1 / 0.5 + 1 / 0.8 - 1)) < 1e-12);
});
