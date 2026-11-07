// Intersection curve (FR-SK-036): the sketch plane against a face's triangles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cutTriangles, thin } from "../../src/sketch/intersect";
import type { Frame } from "../../src/model/types";

const XY = (z: number): Frame => ({ o: [0, 0, z], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] });

test("a flat face cut by the sketch plane gives one straight chain", () => {
  // The face x = 5, y in [-10, 10], z in [0, 20], as two triangles.
  const tri = [5, -10, 0, 5, 10, 0, 5, 10, 20, 5, -10, 0, 5, 10, 20, 5, -10, 20];
  const cs = cutTriangles(tri, XY(5));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].closed, false);
  const ys = cs[0].pts.map(p => p[1]).sort((a, b) => a - b);
  assert.ok(cs[0].pts.every(p => Math.abs(p[0] - 5) < 1e-9));
  assert.ok(Math.abs(ys[0] + 10) < 1e-9 && Math.abs(ys.at(-1)! - 10) < 1e-9);
  assert.equal(cutTriangles(tri, XY(30)).length, 0);
});

test("a cylinder side cut square to its axis gives one closed chain on the radius", () => {
  const n = 48, r = 7, tri: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n;
    const P = (t: number, z: number) => [r * Math.cos(t), r * Math.sin(t), z];
    tri.push(...P(a, 0), ...P(b, 0), ...P(b, 10), ...P(a, 0), ...P(b, 10), ...P(a, 10));
  }
  const cs = cutTriangles(tri, XY(4));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].closed, true);
  assert.ok(cs[0].pts.length >= n);
  for (const p of cs[0].pts) assert.ok(Math.abs(Math.hypot(p[0], p[1]) - r) < r * (1 - Math.cos(Math.PI / n)) + 1e-9);
  const th = thin(cs[0], 12);
  assert.equal(th.length, 12);
});
