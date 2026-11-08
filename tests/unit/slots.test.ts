// Arc slots (FR-SK-017).
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, tryAdd } from "../../src/sketch/solver";
import { centreArcAxis, threePointArcAxis, arcSlotCorners, arcSlotEnts, arcSlotHalfWidth, arcSlotOutline } from "../../src/sketch/slots";
import type { SketchFeature, SkEnt, SkDim } from "../../src/model/types";

type V2 = [number, number];
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

function build(ax: NonNullable<ReturnType<typeof centreArcAxis>>, w: number): { sk: SketchFeature; ids: ReturnType<typeof arcSlotEnts> } {
  const c = arcSlotCorners(ax, w);
  const pts: Record<string, V2> = { o: ax.o, c1: ax.c1, c2: ax.c2, o1: c.o1, o2: c.o2, i1: c.i1, i2: c.i2 };
  const ents: SkEnt[] = Object.entries(pts).map(([id, p]) => ({ id, t: "point", x: p[0], y: p[1] }));
  let n = 0;
  const ids = arcSlotEnts({ o: "o", c1: "c1", c2: "c2", o1: "o1", o2: "o2", i1: "i1", i2: "i2" }, k => `${k}${n++}`);
  return { sk: { id: "s", type: "sketch", name: "S", plane: { std: "XY" }, ents: [...ents, ...ids.ents], rels: ids.rels, dims: [] }, ids };
}

test("centerpoint arc slot: consistent, six degrees of freedom, width and radius drive it", () => {
  const ax = centreArcAxis([0, 0], [120, 0], [0, 200])!;
  near(ax.c2[0], 0); near(ax.c2[1], 120);
  const w = arcSlotHalfWidth(ax, [0, 128]);
  near(w, 8);
  const { sk, ids } = build(ax, w);
  let r = solve(sk);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 6, "centre 2 + radius + start + sweep + width");
  const dim = (t: SkDim["t"], v: number, e: string): SkDim => ({ id: `d${e}`, name: "D", t, e: [e], val: { v } });
  let a = tryAdd(sk, { dim: dim("diameter", 10, ids.cap1) });
  assert.ok(a.ok && !a.redundant);
  a = tryAdd(a.sketch, { dim: dim("radius", 100, ids.centre) });
  assert.ok(a.ok && !a.redundant);
  r = solve(a.sketch);
  assert.equal(r.status, "ok");
  assert.equal(r.dof, 4);
  const P = (id: string) => { const e = a.sketch.ents.find(x => x.id === id)!; return e.t === "point" ? [e.x, e.y] : [NaN, NaN]; };
  const d = (p: string, q: string) => Math.hypot(P(p)[0] - P(q)[0], P(p)[1] - P(q)[1]);
  near(d("o", "c1"), 100, 1e-5); near(d("o", "c2"), 100, 1e-5);
  near(d("o", "o1"), 105, 1e-5); near(d("o", "i2"), 95, 1e-5); near(d("c2", "o2"), 5, 1e-5);
});

test("3-point arc slot runs counter-clockwise through the middle point", () => {
  // Clicked clockwise: start (0, 50), end (50, 0), through a point on the short arc.
  const ax = threePointArcAxis([0, 50], [50, 0], [50 * Math.SQRT1_2, 50 * Math.SQRT1_2])!;
  assert.ok(ax.swapped);
  near(ax.r, 50, 1e-3); near(ax.o[0], 0, 1e-3); near(ax.o[1], 0, 1e-3);
  assert.deepEqual(ax.c1, [50, 0]);
  const out = arcSlotOutline(ax, 5);
  assert.equal(out.length, 5);
  // The centre line passes the 45° point.
  const mid = out[4][24];
  near(Math.atan2(mid[1], mid[0]), Math.PI / 4, 1e-6);
  const { sk } = build(ax, 5);
  assert.equal(solve(sk).status, "ok");
  assert.equal(threePointArcAxis([0, 0], [1, 1], [2, 2]), null);
});

test("3-point rectangles and the parallelogram (FR-SK-013): corners and degrees of freedom", async () => {
  const { quadCorners } = await import("../../src/sketch/shapes");
  const r = quadCorners("rect3", [0, 0], [30, 40], [-8, 6])!;
  // Side 50 along (0.6, 0.8), width 10 on the left.
  near(Math.hypot(r[3][0], r[3][1]), 10); near(r[3][0] * 30 + r[3][1] * 40, 0);
  near(r[2][0] - r[1][0], r[3][0]); near(r[2][1] - r[1][1], r[3][1]);
  const c = quadCorners("crect3", [5, 5], [15, 5], [0, 8])!;
  assert.deepEqual(c.map(q => q.map(v => Math.round(v * 1e6) / 1e6)), [[-5, 2], [15, 2], [15, 8], [-5, 8]]);
  const g = quadCorners("pgram", [0, 0], [10, 0], [14, 5])!;
  assert.deepEqual(g[3], [4, 5]);
  assert.equal(quadCorners("pgram", [0, 0], [10, 0], [20, 0]), null);
  assert.equal(quadCorners("rect3", [0, 0], [10, 0], [5, 0]), null);
  const quad = (q: V2[], rels: [string, ...string[]][]) => {
    const ents: SkEnt[] = q.map((p, i) => ({ id: `p${i}`, t: "point", x: p[0], y: p[1] }));
    for (let i = 0; i < 4; i++) ents.push({ id: `l${i}`, t: "line", a: `p${i}`, b: `p${(i + 1) % 4}` });
    return solve({ id: "s", type: "sketch", name: "S", plane: { std: "XY" }, ents, rels: rels.map(([t, ...e], i) => ({ id: `r${i}`, t: t as never, e })), dims: [] }).dof;
  };
  assert.equal(quad(r, [["perpendicular", "l0", "l1"], ["parallel", "l0", "l2"], ["parallel", "l1", "l3"]]), 5);
  assert.equal(quad(g, [["parallel", "l0", "l2"], ["parallel", "l1", "l3"]]), 6);
});

test("perimeter circle (FR-SK-014): tangent to lines and circles, through points, nearest to the clicks", async () => {
  const { perimeterCircle } = await import("../../src/sketch/shapes");
  // Incircle of the 3-4-5 triangle (0,0) (40,0) (0,30): r = 10 at (10, 10).
  const tri = perimeterCircle([{ k: "l", a: [0, 0], b: [40, 0] }, { k: "l", a: [40, 0], b: [0, 30] }, { k: "l", a: [0, 30], b: [0, 0] }], [[12, 0], [18, 16], [0, 9]])!;
  near(tri.c[0], 10, 1e-6); near(tri.c[1], 10, 1e-6); near(tri.r, 10, 1e-6);
  // Clicked outside the triangle beyond the hypotenuse: the excircle there, r = 30 at (30, 30).
  const ex = perimeterCircle([{ k: "l", a: [0, 0], b: [40, 0] }, { k: "l", a: [40, 0], b: [0, 30] }, { k: "l", a: [0, 30], b: [40, 60] }], [[45, 0], [24, 12], [10, 37.5]]);
  assert.ok(ex && ex.r > 0);
  // Two points and a circle touched from outside: |c - c1| = r + 5.
  const pc = perimeterCircle([{ k: "p", p: [0, 0] }, { k: "p", p: [20, 0] }, { k: "c", c: [10, 30], r: 5 }], [[0, 0], [20, 0], [10, 24]])!;
  near(pc.c[0], 10, 1e-6); near(Math.hypot(pc.c[0] - 10, pc.c[1] - 30), pc.r + 5, 1e-6); near(Math.hypot(pc.c[0], pc.c[1]), pc.r, 1e-6);
  assert.deepEqual(pc.inner, [false, false, false]);
  // A circle inside a bigger one, touching it from inside and passing through two points.
  const ic = perimeterCircle([{ k: "c", c: [0, 0], r: 50 }, { k: "p", p: [0, 10] }, { k: "p", p: [0, -10] }], [[48, 1], [0, 10], [0, -10]])!;
  assert.deepEqual(ic.inner, [true, false, false]);
  near(Math.hypot(...ic.c) + ic.r, 50, 1e-6);
  assert.equal(perimeterCircle([{ k: "p", p: [0, 0] }, { k: "p", p: [1, 0] }, { k: "p", p: [2, 0] }], [[0, 0], [1, 0], [2, 0]]), null);
});
