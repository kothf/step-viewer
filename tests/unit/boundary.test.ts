/** Boundary Boss/Cut (FRS 2.3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number, plane: SketchFeature["plane"]): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane, ents, rels: [], dims: [] };
};
const circle = (id: string, r: number, plane: SketchFeature["plane"]): SketchFeature => ({
  id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x: 0, y: 0 }, { id: `${id}k`, t: "circle", c: `${id}c`, r }],
});
const curve = (id: string, pts: [number, number, number][]): Feature => ({ id, type: "curve", name: id, kind: "xyz", pts } as Feature);
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);
const pl: Feature = { id: "p1", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 40 } } as Feature;

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  return { ...r, props: r.body ? m.props(r.body) : null };
}

test("boundary boss: straight Direction 2 curves at a square's corners make a box (FRS 2.3)", async () => {
  const m = new Modeller(await occ());
  const a = rect("a", 20, 20, { std: "XY" }), b = rect("b", 20, 20, { plane: "p1" });
  const cs = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y], i) => curve(`c${i}`, [[x, y, 0], [x, y, 20], [x, y, 40]]));
  const bd: Feature = { id: "bd", type: "loft", name: "Boundary-Boss1", op: "boss", boundary: true, profiles: ["a", "b"], guides: cs.map(c => ({ curve: c.id })) } as Feature;
  const r = run(m, doc([a, pl, b, ...cs, bd]));
  close(r.props!.volume, 16000, 1e-4);
  assert.equal(r.props!.bodies, 1);
  for (const n of ["bd:start", "bd:end", "bd:side:0:0", "bd:side:0:3"]) assert.ok(r.body!.names.includes(n), r.body!.names.join());
  // Curves that bow out widen the sides between them.
  const bow = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y], i) => curve(`c${i}`, [[x, y, 0], [x * 1.5, y * 1.5, 20], [x, y, 40]]));
  const r2 = run(m, doc([a, pl, b, ...bow, bd]));
  assert.ok(r2.props!.volume > 16000 * 1.3, String(r2.props!.volume));
  // A cut takes the same shape out of a block.
  const blk: Feature = { id: "x", type: "extrude", name: "Extrude1", sketch: "k", op: "boss", end: "blind", depth: { v: 40 } } as Feature;
  const k = rect("k", 60, 60, { std: "XY" });
  const cut = run(m, doc([k, blk, a, pl, b, ...cs, { ...bd, op: "cut" } as Feature]));
  close(cut.props!.volume, 3600 * 40 - 16000, 1e-4);
});

test("boundary boss: two curves across circles, refused when a curve misses a profile (FRS 2.3)", async () => {
  const m = new Modeller(await occ());
  const a = circle("a", 5, { std: "XY" }), b = circle("b", 5, { plane: "p1" });
  const g = [curve("g0", [[5, 0, 0], [5, 0, 20], [5, 0, 40]]), curve("g1", [[-5, 0, 0], [-5, 0, 20], [-5, 0, 40]])];
  const bd: Feature = { id: "bd", type: "loft", name: "Boundary-Boss1", op: "boss", boundary: true, profiles: ["a", "b"], guides: g.map(c => ({ curve: c.id })) } as Feature;
  const r = run(m, doc([a, pl, b, ...g, bd]));
  close(r.props!.volume, Math.PI * 25 * 40, 2e-3);
  const off = m.evaluate(doc([a, pl, b, curve("g0", [[7, 0, 0], [5, 0, 20], [5, 0, 40]]), g[1], bd]));
  assert.equal(off.statuses.find(s => s.id === "bd")?.code, "E-BND-CROSS");
});
