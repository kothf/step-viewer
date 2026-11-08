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
