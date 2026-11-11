// In-context design (FR-ASM-030): external reference frames and syncing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allCtxRefs, ctxEdgeRefs, ctxFrame, ctxMark, ctxRefs, findCtxEdge, moveEdgeGeo, samePlane, syncCtx } from "../../src/model/context";
import { Modeller } from "../../src/kernel/model";
import type { CtxEdge, CtxRef, EdgeRef, Feature, PartDoc, SketchFeature, SkEnt, V3 } from "../../src/model/types";
import { occ } from "./occ";

const near = (a: V3, b: V3) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9, `${a} ≠ ${b}`);

test("ctxFrame: the frame depends only on the plane", () => {
  const f = ctxFrame({ p: [5, 7, 20], n: [0, 0, 2] });
  near(f.o, [0, 0, 20]); near(f.n, [0, 0, 1]); near(f.x, [1, 0, 0]); near(f.y, [0, 1, 0]);
  // Sliding the point in the plane keeps the frame.
  assert.deepEqual(ctxFrame({ p: [-40, 3, 20], n: [0, 0, 1] }), f);
  const g = ctxFrame({ p: [3, 0, 0], n: [1, 0, 0] });
  near(g.o, [3, 0, 0]); near(g.x, [0, 1, 0]); near(g.y, [0, 0, 1]);
  assert.ok(samePlane({ p: [0, 0, 20], n: [0, 0, 1] }, { p: [9, 9, 20], n: [0, 0, 1] }));
  assert.ok(!samePlane({ p: [0, 0, 20], n: [0, 0, 1] }, { p: [0, 0, 21], n: [0, 0, 1] }));
});

const square = (plane: SketchFeature["plane"]): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `p${k}`, t: "point", x, y });
  return { id: "s", type: "sketch", name: "Sketch1", plane, rels: [], dims: [], ents: [P("1", 0, 0), P("2", 10, 0), P("3", 10, 10), P("4", 0, 10),
    { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

test("in-context sketch: built on the stored plane, follows the face when synced, unless locked", async () => {
  const m = new Modeller(await occ());
  const ref: CtxRef = { comp: "c2", face: "f1:end", host: "c1", p: [3, 4, 20], n: [0, 0, 1] };
  const d = doc([square({ ctx: ref }), { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }]);
  let r = m.evaluate(d);
  assert.deepEqual(r.statuses.filter(s => !s.ok), []);
  let p = m.props(r.body!);
  assert.ok(Math.abs(p.volume - 500) < 1e-6);
  near(p.com.map(v => Math.round(v * 1e9) / 1e9) as V3, [5, 5, 22.5]);
  assert.equal(ctxRefs(d).length, 1);
  // The face moved up 10 mm: the sketch follows.
  let s = syncCtx(d, () => ({ p: [0, 0, 30], n: [0, 0, 1] }));
  assert.equal(s.changed, 1);
  r = m.evaluate(d);
  near(m.props(r.body!).com.map(v => Math.round(v * 1e9) / 1e9) as V3, [5, 5, 32.5]);
  // Same plane: nothing to do; a gone face is reported.
  assert.equal(syncCtx(d, () => ({ p: [7, 7, 30], n: [0, 0, 1] })).changed, 0);
  assert.equal(syncCtx(d, () => null).missing.length, 1);
  // Locked (one reference, or the whole part): it stays.
  ref.locked = true;
  assert.equal(syncCtx(d, () => ({ p: [0, 0, 40], n: [0, 0, 1] })).changed, 0);
  delete ref.locked;
  d.ctxLocked = true;
  s = syncCtx(d, () => ({ p: [0, 0, 40], n: [0, 0, 1] }));
  assert.equal(s.changed, 0);
  assert.equal(ref.p[2], 30);
});

test("converted edges of other components: kept in the part, followed when synced, unless locked", async () => {
  const m = new Modeller(await occ());
  // A 10 mm square on XY whose right side is an edge of component c2 seen at x = 10.
  const line = (x: number) => ({ type: "line", start: [x, 0, 0] as V3, end: [x, 10, 0] as V3, mid: [x, 5, 0] as V3, closed: false });
  const ext: EdgeRef & { ctx: CtxEdge } = { faces: ["f1:side:l2", "f1:end"], hint: [10, 5, 0], ctx: { comp: "c2", host: "c1", label: "Plate", geo: line(10) } };
  const sk = square({ std: "XY" });
  sk.rels.push({ id: "r1", t: "fix", e: ["l2"], ext });
  const d = doc([sk, { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 5 } }]);
  let r = m.evaluate(d);
  assert.deepEqual(r.statuses.filter(s => !s.ok), []);
  assert.ok(Math.abs(m.props(r.body!).volume - 500) < 1e-6);
  assert.equal(ctxEdgeRefs(d).length, 1);
  assert.equal(ctxMark(d, d.features[0]), "open");
  assert.equal(ctxMark(d, d.features[1]), "none");
  const rows = allCtxRefs(d);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "edge");
  assert.equal(rows[0].key, "f1:end|f1:side:l2");
  // The other component moved 5 mm along X: the edge follows, the sketch side with it.
  const s = syncCtx(d, () => null, () => ({ geo: line(15), hint: [15, 5, 0] }));
  assert.equal(s.changed, 1);
  assert.deepEqual(ext.hint, [15, 5, 0]);
  r = m.evaluate(d);
  assert.ok(Math.abs(m.props(r.body!).volume - 750) < 1e-6);
  assert.equal(syncCtx(d, () => null, () => ({ geo: line(15), hint: [15, 5, 0] })).changed, 0);
  assert.equal(syncCtx(d, () => null, () => null).missing.length, 1);
  // Locked from the list: it stays.
  allCtxRefs(d)[0].set(true);
  assert.equal(ext.ctx.locked, true);
  assert.equal(ctxMark(d, d.features[0]), "locked");
  assert.equal(syncCtx(d, () => null, () => ({ geo: line(20), hint: [20, 5, 0] })).changed, 0);
  assert.equal(ext.ctx.geo.start[0], 15);
});

test("findCtxEdge: by face pair, then the middle nearest the hint; moveEdgeGeo keeps the kind", () => {
  const g = (y: number) => ({ type: "line", start: [0, y, 0] as V3, end: [10, y, 0] as V3, mid: [5, y, 0] as V3, closed: false });
  const list = [{ faces: ["a", "b"] as [string, string], geo: g(0) }, { faces: ["b", "a"] as [string, string], geo: g(8) }, { faces: ["a", "c"] as [string, string], geo: g(4) }];
  assert.equal(findCtxEdge(list, { faces: ["a", "b"], hint: [5, 7, 0] })?.geo.mid[1], 8);
  assert.equal(findCtxEdge(list, { faces: ["c", "a"] })?.geo.mid[1], 4);
  assert.equal(findCtxEdge(list, { faces: ["c", "d"] }), null);
  const arc = { type: "circle", start: [5, 0, 0] as V3, end: [5, 0, 0] as V3, mid: [-5, 0, 0] as V3, closed: true, center: [0, 0, 0] as V3, axis: [0, 0, 1] as V3, radius: 5 };
  const moved = moveEdgeGeo(arc, p => [p[0] + 1, p[1], p[2]], d => [d[0], d[2], -d[1]]);
  assert.deepEqual(moved.center, [1, 0, 0]);
  assert.deepEqual(moved.axis, [0, 1, -0]);
  assert.equal(moved.radius, 5);
});
