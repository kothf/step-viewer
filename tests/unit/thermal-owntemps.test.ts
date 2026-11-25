// A small component that no plot point was given to must not read 0 °C (it showed as the coolest part of a heated board).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownTemps } from "../../src/sim/run";

const tri = (z: number) => [0, 0, z, 1, 0, z, 0, 1, z];

test("a component with no plot points is sampled on its own triangles", () => {
  const domains = [{ tris: tri(0) }, { tris: [...tri(5), ...tri(6)] }];
  const out = [{ min: 40, max: 60, mean: 50 }, { min: Infinity, max: -Infinity, mean: 0 }];
  let asked = 0;
  ownTemps(domains, [10, 0], (pos) => { asked = pos.length / 3; return Array.from({ length: asked }, (_v, i) => 70 + pos[3 * i + 2]); }, out);
  assert.equal(asked, 2, "only the missing component's triangles");
  assert.deepEqual(out[0], { min: 40, max: 60, mean: 50 }, "a found component is left alone");
  assert.equal(out[1].min, 75);
  assert.equal(out[1].max, 76);
  assert.equal(out[1].mean, 75.5);
});

test("nothing sampled: the mean of the found components, never 0 °C", () => {
  const out = [{ min: 40, max: 60, mean: 50 }, { min: 30, max: 40, mean: 34 }, { min: Infinity, max: -Infinity, mean: 0 }];
  ownTemps([{ tris: tri(0) }, { tris: tri(0) }, { tris: [] }], [5, 5, 0], () => [], out);
  assert.deepEqual(out[2], { min: 42, max: 42, mean: 42 });
});
