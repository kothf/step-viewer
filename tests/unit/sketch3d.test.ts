// 3D sketch solver and chaining (FR-SK-080).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chain3d, linePlaneAngle, solve3d } from "../../src/sketch/sketch3d";
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

test("3D sketch: angle dimension, midpoint and on line, inferred axes (1.763.0)", async () => {
  const { inferAxis, onAxis, lineAngle } = await import("../../src/sketch/sketch3d");
  // Two lines from a fixed corner; the second held at 60° to the first, the first along X.
  const s = sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [20, 1, 0] }, { id: "C", p: [5, 15, 3] }],
    segs: [{ id: "a", t: "line", pts: ["A", "B"] }, { id: "b", t: "line", pts: ["A", "C"] }],
    rels: [{ id: "r1", t: "alongX", e: ["a"] }],
    dims: [{ id: "d", t: "angle", e: ["a", "b"], val: { v: Math.PI / 3 } }],
  });
  const r = solve3d(s);
  assert.ok(r.ok);
  near(lineAngle({ ...s, pts: s.pts.map(p => ({ ...p, p: r.pts[p.id] })) }, "a", "b")!, Math.PI / 3);
  // A point held at the middle of a line, another on a line (beyond its end).
  const m = solve3d(sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [10, 10, 10], fixed: true }, { id: "M", p: [1, 2, 3] }, { id: "Q", p: [30, 0, 0] }],
    segs: [{ id: "l", t: "line", pts: ["A", "B"] }],
    rels: [{ id: "r1", t: "midpoint", e: ["M", "l"] }, { id: "r2", t: "onLine", e: ["Q", "l"] }],
  }));
  assert.ok(m.ok);
  near(m.pts.M[0], 5); near(m.pts.M[1], 5); near(m.pts.M[2], 5);
  near(m.pts.Q[0], m.pts.Q[1]); near(m.pts.Q[1], m.pts.Q[2]);
  assert.equal(m.dof, 1); // Q still slides along the line
  // Drawing: 3° off X snaps onto X, 10° off does not; Z is found too.
  assert.equal(inferAxis([0, 0, 0], [40, Math.tan((3 * Math.PI) / 180) * 40, 0]), "alongX");
  assert.equal(inferAxis([0, 0, 0], [40, Math.tan((10 * Math.PI) / 180) * 40, 0]), null);
  assert.equal(inferAxis([1, 2, 3], [1.2, 2, 30]), "alongZ");
  assert.deepEqual(onAxis([1, 2, 3], [40, 2.5, 3.1], "alongX"), [40, 2, 3]);
});

test("3D sketch dimensions follow global variables (1.763.0)", async () => {
  const { refreshExprs } = await import("../../src/model/params");
  const f = sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [10, 0, 0] }],
    segs: [{ id: "l", t: "line", pts: ["A", "B"] }],
    rels: [{ id: "r", t: "alongX", e: ["l"] }],
    dims: [{ id: "d", t: "length", e: ["l"], val: { v: 10, expr: "L" } }],
  });
  const doc = { features: [f], vars: [{ name: "L", expr: "25", kind: "length" }] } as never;
  refreshExprs(doc);
  near(f.dims[0].val.v, 25);
  near(f.pts[1].p[0], 25);
});

test("3D sketch: a changed dimension moves the later end, not the first point (1.763.0)", () => {
  const s = sk({
    pts: [{ id: "A", p: [0, 0, 0] }, { id: "B", p: [40, 0, 0] }, { id: "C", p: [40, 30, 0] }],
    segs: [{ id: "a", t: "line", pts: ["A", "B"] }, { id: "b", t: "line", pts: ["B", "C"] }],
    rels: [{ id: "r1", t: "alongX", e: ["a"] }, { id: "r2", t: "alongY", e: ["b"] }],
    dims: [{ id: "d", t: "length", e: ["b"], val: { v: 50 } }],
  });
  const r = solve3d(s);
  assert.ok(r.ok);
  near(r.pts.A[1], 0, 1); near(r.pts.B[1], 0, 1);
  assert.ok(r.pts.C[1] > 45, `C moved: ${r.pts.C}`);
});

test("3D sketch: fillets round a corner of two lines, tangent joins a spline to a line (FR-SK-080 B12, D6)", async () => {
  const { fillets3d, filletCorner, segPoints } = await import("../../src/sketch/sketch3d");
  const s = sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [30, 0, 0], fixed: true }, { id: "C", p: [30, 20, 0], fixed: true }],
    segs: [{ id: "l1", t: "line", pts: ["A", "B"] }, { id: "l2", t: "line", pts: ["B", "C"] }],
    dims: [{ id: "f", t: "fillet", e: ["B"], val: { v: 5 } }],
  });
  assert.deepEqual(filletCorner(s, "B"), ["l1", "l2"]);
  assert.equal(filletCorner(s, "A"), null);
  const { list, error } = fillets3d(s);
  assert.equal(error, undefined);
  const f = list[0];
  near(f.t1[0], 25); near(f.t2[1], 5); near(f.c[0], 25); near(f.c[1], 5);
  for (const q of f.arc) near(Math.hypot(q[0] - 25, q[1] - 5), 5);
  // The lines end where the arc starts; the sketch keeps the sharp corner (solving is unchanged).
  near(segPoints(s, s.segs[0])[1][0], 25);
  assert.ok(solve3d(s).ok);
  // Too big for the 20 mm line: refused.
  const big = solve3d({ ...s, dims: [{ id: "f", t: "fillet", e: ["B"], val: { v: 25 } }] });
  assert.equal(big.ok, false); assert.ok(big.fillet);
  // Tangent: a spline A–P–B ending where a line B–C starts: the spline's end runs on along the line.
  const t = solve3d(sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "P", p: [10, 8, 0] }, { id: "B", p: [20, 0, 0], fixed: true }, { id: "C", p: [40, 0, 0], fixed: true }],
    segs: [{ id: "s", t: "spline", pts: ["A", "P", "B"] }, { id: "l", t: "line", pts: ["B", "C"] }],
    rels: [{ id: "r", t: "tangent", e: ["s", "l"] }],
  }));
  assert.ok(t.ok);
  const st = sk({ pts: [{ id: "A", p: [0, 0, 0] }, { id: "P", p: t.pts.P }, { id: "B", p: [20, 0, 0] }], segs: [{ id: "s", t: "spline", pts: ["A", "P", "B"] }] });
  const q = segPoints(st, st.segs[0], 64), a = q[q.length - 2], b = q[q.length - 1];
  assert.ok(Math.abs(b[1] - a[1]) / Math.abs(b[0] - a[0]) < 0.02, `end slope ${(b[1] - a[1]) / (b[0] - a[0])}`);
});

test("3D sketch: a point on a standard plane and its distance from one (3D sketch test D7, E6)", () => {
  // A free point: On XY puts it at z = 0, 15 from ZX puts |y| = 15, staying on the side it was drawn.
  const r = solve3d(sk({
    pts: [{ id: "A", p: [4, 12, 3] }],
    rels: [{ id: "r", t: "onPlane", e: ["A"], plane: "XY" }],
    dims: [{ id: "d", t: "planeDist", e: ["A"], plane: "ZX", val: { v: 15 } }],
  }));
  assert.ok(r.ok);
  near(r.pts.A[2], 0); near(r.pts.A[1], 15);
  assert.equal(r.dof, 1);
  const neg = solve3d(sk({ pts: [{ id: "A", p: [0, -12, 0] }], dims: [{ id: "d", t: "planeDist", e: ["A"], plane: "ZX", val: { v: 15 } }] }));
  near(neg.pts.A[1], -15);
  // A fixed point off the plane cannot be put on it.
  const bad = solve3d(sk({ pts: [{ id: "A", p: [0, 0, 5], fixed: true }], rels: [{ id: "r", t: "onPlane", e: ["A"], plane: "XY" }] }));
  assert.equal(bad.ok, false);
});

test("3D sketch: the angle of a line to a standard plane (3D sketch test E7)", () => {
  // A line from a fixed origin, 20 long, at 30° to XY: its end rises to z = 10.
  const r = solve3d(sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [15, 3, 4] }],
    segs: [{ id: "l", t: "line", pts: ["A", "B"] }],
    rels: [{ id: "r", t: "onPlane", e: ["B"], plane: "ZX" }],
    dims: [{ id: "d", t: "planeAngle", e: ["l"], plane: "XY", val: { v: Math.PI / 6 } }, { id: "e", t: "length", e: ["l"], val: { v: 20 } }],
  }));
  assert.ok(r.ok);
  near(r.pts.B[2], 10, 1e-5); near(r.pts.B[1], 0); near(Math.hypot(...r.pts.B), 20, 1e-5);
  assert.equal(r.dof, 0);
  near(linePlaneAngle(sk({ pts: [{ id: "A", p: [0, 0, 0] }, { id: "B", p: r.pts.B }], segs: [{ id: "l", t: "line", pts: ["A", "B"] }] }), "l", "XY")!, Math.PI / 6, 1e-6);
});

test("3D sketch: 3-point arcs, their radius and tangency to a line (3D sketch test B13, E8)", async () => {
  const { arc3, segPoints } = await import("../../src/sketch/sketch3d");
  // Quarter circle R10 in XY about the origin.
  const g = arc3([10, 0, 0], [10 * Math.SQRT1_2, 10 * Math.SQRT1_2, 0], [0, 10, 0])!;
  near(g.r, 10); near(g.sweep, Math.PI / 2); near(g.c[0], 0); near(g.c[1], 0);
  assert.equal(arc3([0, 0, 0], [1, 1, 1], [2, 2, 2]), null);
  // A line along X into an arc tangent to it, radius 15, the arc ending on the YZ... plane x = line end.
  const s = sk({
    pts: [{ id: "A", p: [0, 0, 0], fixed: true }, { id: "B", p: [20, 0, 0] }, { id: "M", p: [30, 4, 0] }, { id: "C", p: [33, 14, 0] }],
    segs: [{ id: "l", t: "line", pts: ["A", "B"] }, { id: "a", t: "arc", pts: ["B", "M", "C"] }],
    rels: [{ id: "r1", t: "alongX", e: ["l"] }, { id: "r2", t: "tangent", e: ["l", "a"] }, { id: "r3", t: "onPlane", e: ["M"], plane: "XY" }, { id: "r4", t: "onPlane", e: ["C"], plane: "XY" }],
    dims: [{ id: "d1", t: "length", e: ["l"], val: { v: 20 } }, { id: "d2", t: "radius", e: ["a"], val: { v: 15 } }],
  });
  const r = solve3d(s);
  assert.ok(r.ok);
  const h = arc3(r.pts.B, r.pts.M, r.pts.C)!;
  near(h.r, 15, 1e-5); near(r.pts.B[0], 20, 1e-6);
  // Tangent: the centre lies square to the line at B, i.e. at x = 20.
  near(h.c[0], 20, 1e-4); near(Math.abs(h.c[1]), 15, 1e-4);
  const pts = segPoints({ ...s, pts: s.pts.map(p => ({ ...p, p: r.pts[p.id] })) }, s.segs[1]);
  assert.ok(pts.length > 8);
  for (const p of pts) near(Math.hypot(p[0] - h.c[0], p[1] - h.c[1], p[2] - h.c[2]), 15, 1e-4);
  const c = chain3d(s);
  assert.ok(!("error" in c));
});
