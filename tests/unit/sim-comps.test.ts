import { test } from "node:test";
import assert from "node:assert/strict";
import { componentRows, aloneIndex, isoIndex, vertexParts, withoutParts, moveWithParts } from "../../src/sim/comps";
import { hotCsv, loadBalance, stlBytes } from "../../src/sim/exports";

test("FR-CON-030: highest stress, displacement and safety factor per component", () => {
  const dom = [0, 0, 1, 1, 1, 3];
  const vm = [10, 40, 5, 80, 20, 7];
  const u = [0, 0, 1, 0, 2, 0, 3, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0];
  const rows = componentRows(dom, vm, u, 4, [200, 0, 0, 70]);
  assert.deepEqual(rows.map(r => r.d), [0, 1, 3], "a domain with no point on the surface has no row");
  assert.equal(rows[0].maxVm, 40); assert.equal(rows[0].at, 1); assert.equal(rows[0].maxU, 2); assert.equal(rows[0].sf, 5);
  assert.equal(rows[1].maxVm, 80); assert.equal(rows[1].at, 3); assert.equal(rows[1].maxU, 3); assert.equal(rows[1].sf, null);
  assert.equal(rows[2].sf, 10); assert.equal(rows[2].n, 1);
});

test("FR-CON-030: a component alone keeps the triangle order", () => {
  const index = new Uint32Array([0, 1, 2, 2, 3, 4, 3, 4, 5]);
  const dom = [0, 0, 0, 1, 1, 1];
  const a = aloneIndex(index, dom, 1);
  assert.equal(a.length, index.length);
  assert.deepEqual([...a.slice(0, 3)], [0, 0, 0], "a triangle of another component is degenerate");
  assert.deepEqual([...a.slice(3, 6)], [2, 2, 2], "a triangle across two components too");
  assert.deepEqual([...a.slice(6)], [3, 4, 5]);
});

test("FR-CON-031: the plot's points know their part, and move or go with it", () => {
  // two parts of 3 vertices each; refinement added vertex 6 (part 0), 7 (part 1) and 8, a midpoint of midpoints (part 1)
  const index = new Uint32Array([0, 1, 6, 6, 1, 2, 3, 4, 7, 7, 8, 5, 8, 7, 4]);
  const of = vertexParts(index, [3, 3], 10);
  assert.deepEqual([...of], [0, 0, 0, 1, 1, 1, 0, 1, 1, -1], "midpoints take their triangle's part; an unused vertex has none");
  const ix = withoutParts(index, of, [false, true]);
  assert.deepEqual([...ix.slice(0, 6)], [0, 1, 6, 6, 1, 2], "the shown part's triangles stay");
  assert.deepEqual([...ix.slice(6)], [3, 3, 3, 7, 7, 7, 8, 8, 8], "the other part's are degenerate, in place");
  const pos = new Float32Array(30);
  for (let i = 0; i < 10; i++) pos[3 * i] = i;
  // part 1: a quarter turn about Z, then 10 along Z
  const tf = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1];
  moveWithParts(pos, of, [null, tf]);
  assert.deepEqual([...pos.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...pos.slice(6, 9)], [2, 0, 0], "a part that is not moved stays");
  assert.deepEqual([...pos.slice(9, 12)], [0, 3, 10], "a point turns and moves with its part");
  assert.deepEqual([...pos.slice(27)], [9, 0, 0], "a point of no part stays");
  const n = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
  moveWithParts(n, of, [null, tf], true);
  assert.deepEqual([...n.slice(9)], [0, 1, 0], "a direction only turns");
});

test("FR-RES-007: iso-clipping keeps the triangles that reach the value", () => {
  const index = Uint32Array.from([0, 1, 2, 1, 2, 3, 3, 4, 5]), val = [1, 2, 3, 4, 5, 6];
  assert.deepEqual([...isoIndex(index, val, 4, true)], [0, 0, 0, 1, 2, 3, 3, 4, 5]);
  assert.deepEqual([...isoIndex(index, val, 2, false)], [0, 1, 2, 1, 2, 3, 3, 3, 3]);
  assert.deepEqual([...isoIndex(Uint32Array.from([0, 0, 0]), val, 0, true)], [0, 0, 0], "a triangle already left out stays out");
});

test("FR-REP-003, FR-RES-006: hot spots as CSV, the deformed shape as STL, and the load balance", () => {
  assert.equal(hotCsv([{ at: [1, 2.0000001, 3], vm: 123.456789, singular: false }, { at: [0, 0, 0], vm: 900, singular: true }]),
    "Hot spot,X (mm),Y (mm),Z (mm),von Mises (MPa),Singularity\r\n1,1,2,3,123.4568,no\r\n2,0,0,0,900,yes\r\n");
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], u = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  const stl = stlBytes(pos, [0, 1, 2, 3, 3, 3], u, 2), dv = new DataView(stl.buffer);
  assert.equal(stl.length, 84 + 50);
  assert.equal(dv.getUint32(80, true), 1, "the degenerate triangle is skipped");
  assert.equal(dv.getFloat32(84 + 12 + 12 + 8, true), 2, "the second corner is moved by scale × u");
  const n = [0, 1, 2].map(k => dv.getFloat32(84 + 4 * k, true));
  assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-6 && n[1] === 0 && n[0] < 0 && n[2] > 0, `normal ${n}`);
  const b = loadBalance([{ force: [0, 0, 60], moment: [1, 0, 0] }, { force: [0, 0, 40.05], moment: [2, 0, 0] }], { force: [0, 0, -100] });
  assert.deepEqual(b.force.map(x => Number(x.toFixed(6))), [0, 0, 100.05]);
  assert.deepEqual(b.moment, [3, 0, 0]);
  assert.ok(Math.abs(b.off! - (100 * 0.05) / 100.05) < 1e-9);
  assert.equal(loadBalance([], { force: [0, 0, -100] }).off, null);
});
