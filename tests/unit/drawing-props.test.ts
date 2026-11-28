// View properties (FR-DRW-017): cosmetic threads (ISO 6410) and shown sketches drawn on a view.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Projection, Topo, V3 } from "../../src/kernel/drawing";
import { placement } from "../../src/drawing/compose";
import { sectionCut, sketchPrims, threadPrims, threadRun } from "../../src/drawing/annot";
import { alignAxis } from "../../src/drawing/views";
import type { ThreadInfo } from "../../src/drawing/items";
import type { DrawingView, Sheet } from "../../src/drawing/types";

const sheet = { id: "s", name: "Sheet1", size: "A3", orientation: "landscape", scale: [1, 1], views: [] } as unknown as Sheet;
const near = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const proj = { vis: [], hid: [], box: [-50, -50, 50, 50] } as unknown as Projection;
const view: DrawingView = { id: "v", name: "Front", orient: "front", x: 200, y: 150 };
const pl = placement(sheet, view, proj, null);
// A Ø10 shaft along x from 0 to 40 with an M6-ish external thread from its x = 0 end, 12 mm long.
const topo: Topo = { edges: [], cyls: [{ o: [0, 0, 0], ax: [1, 0, 0], r: 5, v0: 0, v1: 40, sp: 2 * Math.PI }] };
const thr: ThreadInfo = { id: "t", c: [0, 0, 0], ax: [-1, 0, 0], r: 5, d: 4, L: 12, internal: false };

test("a thread runs from its edge into the cylinder, up to its end when asked", () => {
  const run = threadRun(thr, topo)!;
  assert.deepEqual(run.dir, [1, 0, 0]);
  near(run.L, 12);
  near(threadRun({ ...thr, L: null }, topo)!.L, 40);
  near(threadRun({ ...thr, c: [40, 0, 0] }, topo)!.dir[0], -1);
  assert.equal(threadRun({ ...thr, r: 4 }, topo), null, "no cylinder of that radius");
});

test("seen from the side: two thin lines at the thread diameter and a thick limit line", () => {
  const P = (p: V3): [number, number] => [p[0], p[2]];
  const prims = threadPrims(view, pl, [thr], topo, P, [0, -1, 0]);
  const thin = prims.filter(p => p.t === "l" && p.pen === "thin"), thick = prims.filter(p => p.t === "l" && p.pen === "thick");
  assert.equal(thin.length, 2);
  assert.equal(thick.length, 1);
  const ys = thin.map(p => (p.t === "l" ? Math.abs(p.p[1] - pl.y) : 0));
  for (const y of ys) near(y, 2);
  const lim = thick[0];
  if (lim.t === "l") { near(lim.p[0] - pl.x, 12); near(Math.abs(lim.p[3] - lim.p[1]), 10); }
  // An internal thread is inside the part: dashed, unless the view is a section.
  assert.ok(threadPrims(view, pl, [{ ...thr, internal: true }], topo, P, [0, -1, 0]).every(p => p.t !== "l" || p.pen === "hidden"));
  assert.ok(threadPrims({ ...view, kind: "section" }, pl, [{ ...thr, internal: true }], topo, P, [0, -1, 0]).some(p => p.t === "l" && p.pen === "thin"));
});

test("seen end-on: a thin three-quarter circle, dashed from the far end", () => {
  const P = (p: V3): [number, number] => [p[1], p[2]];
  const near1 = threadPrims(view, pl, [thr], topo, P, [-1, 0, 0]);
  assert.equal(near1.length, 1);
  const a = near1[0];
  assert.ok(a.t === "a" && a.pen === "thin");
  if (a.t === "a") { near(a.r, 2); near(a.a1 - a.a0, 1.5 * Math.PI); }
  const far = threadPrims(view, pl, [thr], topo, P, [1, 0, 0]);
  assert.ok(far[0].t === "a" && far[0].pen === "hidden");
});

test("sketches are thin polylines; a free view has no alignment", () => {
  const prims = sketchPrims(view, pl, [{ id: "s", name: "Sketch1", lines: [[[0, 0, 0], [10, 0, 0], [10, 0, 5]]] }], p => [p[0], p[2]]);
  assert.equal(prims.length, 1);
  assert.ok(prims[0].t === "p" && prims[0].layer === "SKETCH" && prims[0].p.length === 6);
  const pv: DrawingView = { id: "p", name: "Top", parent: "v", side: [0, 1], x: 200, y: 250 };
  assert.equal(alignAxis(pv), "x");
  assert.equal(alignAxis({ ...pv, free: true }), null);
});

test("in a section, a thread the cut misses is hidden behind it or gone with the part cut away (drawings tests A11)", () => {
  const P = (p: V3): [number, number] => [p[0], p[2]];
  const inner = { ...thr, internal: true };
  const sec: DrawingView = { ...view, kind: "section" };
  const pens = (at: "cut" | "behind" | "gone", style?: DrawingView["style"]) => threadPrims({ ...sec, style }, pl, [inner], topo, P, [0, -1, 0], () => at).map(p => p.pen);
  assert.ok(pens("cut").includes("thin") && pens("cut").includes("thick"));
  assert.deepEqual(pens("behind"), [], "a section draws no hidden lines");
  assert.ok(pens("behind", "hlv").length > 0 && pens("behind", "hlv").every(p => p === "hidden"));
  assert.deepEqual(pens("gone", "hlv"), []);
  // A plain view without hidden lines leaves a hidden thread out.
  assert.deepEqual(threadPrims({ ...view, style: "hlr" }, pl, [inner], topo, P, [0, -1, 0]), []);
});

test("sectionCut: where a point lies against a plain and a half section's cut", () => {
  const par: DrawingView = { id: "p", name: "Top", orient: "top", x: 150, y: 150 };
  const plain: DrawingView = { id: "a", name: "A-A", kind: "section", parent: "p", line: [-60, 0, 60, 0], look: 1, x: 150, y: 70, letter: "A" };
  const half: DrawingView = { id: "b", name: "B-B", kind: "section", parent: "p", line: [-25, 25, -25, 0], path: [-25, 25, -25, 0, -45, 0], look: -1, x: 270, y: 150, letter: "B" };
  const sh = { ...sheet, views: [par, plain, half] } as Sheet;
  const a = sectionCut(sh, plain)!, b = sectionCut(sh, half)!;
  assert.equal(sectionCut(sh, par), null);
  assert.equal(a([25, 0, 10], 3), "cut");
  const s1 = a([25, 15, 10], 3), s2 = a([25, -15, 10], 3);
  assert.deepEqual([s1, s2].sort(), ["behind", "gone"]);
  assert.equal(b([-25, 10, 10], 3), "cut");
  assert.notEqual(b([25, 15, 10], 3), "cut");
  // Past the cut leg the half section is not cut: everything there is seen as in a plain view.
  assert.equal(b([25, -15, 10], 3), "behind");
  assert.equal(b([-25, -15, 10], 3), "behind");
});
