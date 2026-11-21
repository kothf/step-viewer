import { test } from "node:test";
import assert from "node:assert/strict";
import { componentRows, aloneIndex } from "../../src/sim/comps";

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
