// Section caps under a board thermal map (FR-TMAP-041): the cut of the map's surface and the band along it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capValues, sliceMap } from "../../src/thermal/caps";

// a closed unit cube (12 triangles) whose temperature is 20 + 10·x
const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const tri = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const temp = Array.from({ length: 8 }, (_, i) => 20 + 10 * pos[i * 3]);

test("the plane z = 0.5 cuts the cube's sides in a square with the temperatures of its points", () => {
  const s = sliceMap(pos, tri, temp, null, [0, 0, 1], -0.5, 0.1);
  assert.ok(s.t.length > 20);
  for (let i = 0; i < s.t.length; i++) {
    const x = s.pts[i * 3], y = s.pts[i * 3 + 1], z = s.pts[i * 3 + 2];
    assert.ok(Math.abs(z - 0.5) < 1e-6);
    // every point lies on the square's outline
    assert.ok(Math.min(x, 1 - x, y, 1 - y) < 1e-6);
    assert.ok(Math.abs(s.t[i] - (20 + 10 * x)) < 1e-5);
  }
  // the top and bottom faces are not cut
  assert.equal(sliceMap(pos, tri, temp, [0, 1, 2, 3], [0, 0, 1], -0.5, 0.1).t.length, 0);
});

test("a cap point near the outline takes the nearest temperature, the inside stays without a value", () => {
  const s = sliceMap(pos, tri, temp, null, [0, 0, 1], -0.5, 0.05);
  const q = [0.98, 0.5, 0.5, 0.5, 0.5, 0.5, 0.03, 0.5, 0.5, 2, 2, 0.5];
  const v = capValues(q, s, 0.1);
  assert.ok(Math.abs(v[0] - 30) < 0.2);
  assert.ok(Number.isNaN(v[1]));
  assert.ok(Math.abs(v[2] - 20) < 0.2);
  assert.ok(Number.isNaN(v[3]));
  assert.ok(capValues(q, { pts: new Float32Array(0), t: new Float32Array(0) }, 0.1).every(Number.isNaN));
});
