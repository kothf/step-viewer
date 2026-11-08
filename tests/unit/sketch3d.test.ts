// 3D sketch solver and chaining (FR-SK-080).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chain3d, solve3d } from "../../src/sketch/sketch3d";
import type { Sketch3dFeature } from "../../src/model/types";

const sk = (part: Partial<Sketch3dFeature>): Sketch3dFeature => ({ id: "k", type: "sketch3d", name: "3DSketch1", pts: [], segs: [], rels: [], dims: [], ...part });
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("3D sketch: relations along axes, dimensions, parallel to a plane, conflicts (FR-SK-080)", () => {
  // An L in space: A fixed at the origin, B along X 30 long, C along Z from B, 20 long.
  const s = sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [28, 1, 2] }, { id: "C", p: [27, 3, 18] }],
    segs: [{ id: "l1", t: "line", pts: ["A", "B"] }, { id: "l2", t: "line", pts: ["B", "C"] }],
    rels: [{ id: "r1", t: "alongX", e: ["l1"] }, { id: "r2", t: "alongZ", e: ["l2"] }],
    dims: [{ id: "d1", t: "length", e: ["l1"], val: { v: 30 } }, { id: "d2", t: "length", e: ["l2"], val: { v: 20 } }],
  });
  const r = solve3d(s);
  assert.ok(r.ok);
  near(r.pts.B[0], 30); near(r.pts.B[1], 0); near(r.pts.B[2], 0);
  near(r.pts.C[0], 30); near(r.pts.C[1], 0); near(Math.abs(r.pts.C[2]), 20);
  assert.equal(r.dof, 0);
  // Without the second length the end of l2 can still slide along Z.
  assert.equal(solve3d({ ...s, dims: s.dims.slice(0, 1) }).dof, 1);
  // Parallel to XY: the line keeps its z.
  const p = solve3d(sk({ pts: [{ id: "A", p: [0, 0, 5], fixed: true }, { id: "B", p: [10, 3, 9] }], segs: [{ id: "l", t: "line", pts: ["A", "B"] }], rels: [{ id: "r", t: "parallelPlane", e: ["l"], plane: "XY" }] }));
  assert.ok(p.ok); near(p.pts.B[2], 5); assert.equal(p.dof, 2);
  // Perpendicular and equal lines; coincident points.
  const q = solve3d(sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [10, 0, 0], fixed: true }, { id: "C", p: [1, 0, 0] }, { id: "D", p: [2, 7, 1] }],
    segs: [{ id: "a", t: "line", pts: ["A", "B"] }, { id: "b", t: "line", pts: ["C", "D"] }],
    rels: [{ id: "r1", t: "coincident", e: ["C", "A"] }, { id: "r2", t: "perpendicular", e: ["a", "b"] }, { id: "r3", t: "equal", e: ["a", "b"] }],
  }));
  assert.ok(q.ok); near(q.pts.C[0], 0); near(q.pts.D[0], 0); near(Math.hypot(q.pts.D[1], q.pts.D[2]), 10);
  // Conflict: a 10 mm line along X between fixed points 20 apart.
  const bad = solve3d(sk({ pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [20, 0, 0], fixed: true }], segs: [{ id: "l", t: "line", pts: ["A", "B"] }], dims: [{ id: "d", t: "length", e: ["l"], val: { v: 10 } }] }));
  assert.equal(bad.ok, false);
});

test("3D sketch: chaining segments into a path", () => {
  const pts = ["A", "B", "C", "D"].map((id, i) => ({ id, p: [i, 0, 0] as [number, number, number] }));
  const c = chain3d(sk({ pts, segs: [{ id: "2", t: "line", pts: ["C", "B"] }, { id: "1", t: "line", pts: ["A", "B"] }, { id: "3", t: "spline", pts: ["C", "D"] }] }));
  assert.ok(!("error" in c));
  const flat = c.order.map(s => [s[0], s[s.length - 1]]);
  for (let i = 1; i < flat.length; i++) assert.equal(flat[i][0], flat[i - 1][1]);
  assert.equal(c.closed, false);
  // A branch is not a chain.
  const br = chain3d(sk({ pts, segs: [{ id: "1", t: "line", pts: ["A", "B"] }, { id: "2", t: "line", pts: ["B", "C"] }, { id: "3", t: "line", pts: ["B", "D"] }] }));
  assert.ok("error" in br);
});
