// Crop and break views (FR-DRW-015): segments clipped to the crop rectangle, bands left out and closed up.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Projection, Seg2 } from "../../src/kernel/drawing";
import { BREAK_GAP, breakMap, clipHalf, fromSheet, placement, toSheet, trimSegs, viewPrims, viewRect } from "../../src/drawing/compose";
import type { DrawingView, Sheet } from "../../src/drawing/types";

const sheet = { id: "s", name: "Sheet1", size: "A3", orientation: "landscape", scale: [1, 1], views: [] } as unknown as Sheet;
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
// A 200 × 20 bar with a Ø10 hole at u = 50.
const bar: Seg2[] = [
  { k: "l", c: 0, p: [-100, -10, 100, -10] }, { k: "l", c: 0, p: [100, -10, 100, 10] },
  { k: "l", c: 0, p: [100, 10, -100, 10] }, { k: "l", c: 0, p: [-100, 10, -100, -10] },
  { k: "a", c: 0, o: [50, 0], r: 5, a0: 0, a1: 2 * Math.PI },
];
const proj: Projection = { vis: bar, hid: [], box: [-100, -10, 100, 10] } as unknown as Projection;
const view = (extra: Partial<DrawingView>): DrawingView => ({ id: "v", name: "Front", orient: "front", x: 200, y: 150, ...extra });

test("clipHalf keeps one side of a line, splitting lines and arcs", () => {
  const left = clipHalf(bar, 0, 50, true);
  const arcs = left.filter(g => g.k === "a") as Extract<Seg2, { k: "a" }>[];
  // The left half of the circle: from 90° to 270°.
  assert.equal(arcs.length, 1);
  near(arcs[0].a0, Math.PI / 2); near(arcs[0].a1, 3 * Math.PI / 2);
  const bottom = left.find(g => g.k === "l" && g.p[1] === -10 && g.p[3] === -10) as Extract<Seg2, { k: "l" }>;
  assert.deepEqual(bottom.p, [-100, -10, 50, -10]);
  assert.equal(left.filter(g => g.k === "l").length, 3, "the right end is gone");
});

test("crop view: only the rectangle stays and the view box shrinks to it", () => {
  const v = view({ crop: [0, -20, 80, 20] });
  const pl = placement(sheet, v, proj, null);
  assert.deepEqual(pl.box, [0, -10, 80, 10]);
  const segs = trimSegs(v, 1, bar);
  for (const g of segs) if (g.k === "l") for (const u of [g.p[0], g.p[2]]) assert.ok(u >= -1e-9 && u <= 80 + 1e-9);
  assert.ok(segs.some(g => g.k === "a" && Math.abs(g.a1 - g.a0 - 2 * Math.PI) < 1e-9), "the hole is whole inside the crop");
});

test("break view: the band is left out, the far side closes up to the gap, and points map both ways", () => {
  const v = view({ breaks: [{ axis: "u", a: -60, b: 20 }] });
  const s = 1, bm = breakMap(v, s)!;
  const shift = 80 - BREAK_GAP / s;
  assert.deepEqual(bm.fwd(-80, 0), [-80, 0]);
  assert.deepEqual(bm.fwd(50, 3), [50 - shift, 3]);
  for (const u of [-80, -60, -30, 20, 70]) { const [f] = bm.fwd(u, 0); near(bm.inv(f, 0)[0], u); }
  const pl = placement(sheet, v, proj, null);
  near(pl.box[2] - pl.box[0], 200 - shift);
  // The hole moves with the right end; the bottom edge is two pieces.
  const segs = trimSegs(v, s, bar);
  const hole = segs.find(g => g.k === "a") as Extract<Seg2, { k: "a" }>;
  near(hole.o[0], 50 - shift);
  assert.equal(segs.filter(g => g.k === "l" && g.p[1] === -10 && g.p[3] === -10).length, 2);
  // toSheet / fromSheet follow the break, so annotations on the far side stay on their geometry.
  const at = toSheet(pl, 50, 0);
  near(at[0], pl.x + (50 - shift - pl.uc) * pl.s);
  near(fromSheet(pl, at[0], at[1])[0], 50);
  // Two zig-zag break lines are drawn inside the view's width.
  const prims = viewPrims(v, proj, pl), r = viewRect(pl);
  const zig = prims.filter(p => p.t === "p" && p.pen === "thin");
  assert.equal(zig.length, 2);
  for (const z of zig) if (z.t === "p") assert.ok(z.p[0] > r[0] && z.p[0] < r[2]);
});

test("a break narrower than the gap does nothing", () => {
  assert.equal(breakMap(view({ breaks: [{ axis: "v", a: 0, b: 3 }] }), 1), null);
});
