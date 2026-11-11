// Instances to skip in the view (FR-FT-070/071): the kernel reports where each pattern instance lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane: { std: "XY" }, ents, rels: [], dims: [] };
};
const hole: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [],
  ents: [{ id: "c", t: "point", x: 30, y: 0 }, { id: "k", t: "circle", c: "c", r: 4 }] };
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const base: Feature[] = [rect("s1", 100, 100),
  { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
  hole, { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } }];

test("pattern instance dots: every instance, skipped ones too, at the material the seed cut", async () => {
  const m = new Modeller(await occ());
  const lp: Feature = { id: "p", type: "lpattern", name: "LPattern1", features: ["f2"], dir: { edge: { faces: ["f1:side:s1l2", "f1:end"] } }, spacing: { v: 15 }, count: 3, skip: ["2"] };
  let r = m.evaluate(doc([...base, lp]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  let sp = r.spots.p;
  assert.deepEqual(sp.map(s => s.key), ["1", "2"]);
  // Through all: the dot sits half way down the 20 mm plate, not in the middle of the long tool.
  for (const s of sp) assert.ok(Math.abs(s.p[2] - 10) < 1e-3, `z ${s.p[2]}`);
  assert.ok(Math.abs(Math.hypot(sp[1].p[0] - sp[0].p[0], sp[1].p[1] - sp[0].p[1]) - 15) < 1e-3);
  assert.ok(Math.abs(Math.abs(sp[0].p[0]) - 30) < 1e-3, `x ${sp[0].p[0]}`);

  const cp: Feature = { id: "q", type: "cpattern", name: "CPattern1", features: ["f2"], axis: { std: "Z" }, count: 4, angle: { v: 2 * Math.PI }, equal: true, skip: ["3"] };
  r = m.evaluate(doc([...base, cp]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  sp = r.spots.q;
  assert.deepEqual(sp.map(s => s.key), ["1", "2", "3"]);
  for (const s of sp) { assert.ok(Math.abs(Math.hypot(s.p[0], s.p[1]) - 30) < 1e-3); assert.ok(Math.abs(s.p[2] - 10) < 1e-3); }
  // Cached rebuild keeps them.
  r = m.evaluate(doc([...base, cp]));
  assert.equal(r.spots.q.length, 3);
});

test("linear pattern up to distance and seed only; circular pattern direction 2 (FR-FT-070/071)", async () => {
  const m = new Modeller(await occ());
  const hole = Math.PI * 16 * 20, plate = 100 * 100 * 20;
  const vol = (fs: Feature[]) => { const r = m.evaluate(doc([...base, ...fs])); assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses)); return { v: m.props(r.body!).volume, r }; };
  const dir = { edge: { faces: ["f1:side:s1l2", "f1:end"] as [string, string] } }, dir2 = { edge: { faces: ["f1:side:s1l1", "f1:end"] as [string, string] } };
  // Up to distance 30 with 3 instances = spacing 15.
  let { v, r } = vol([{ id: "p", type: "lpattern", name: "L", features: ["f2"], dir, spacing: { v: 30 }, count: 3, total: true }]);
  assert.ok(Math.abs(v - (plate - 3 * hole)) < 1e-3, `${v}`);
  assert.ok(Math.abs(Math.hypot(r.spots.p[1].p[0] - r.spots.p[0].p[0], r.spots.p[1].p[1] - r.spots.p[0].p[1]) - 15) < 1e-3);
  // Two directions 3 × 2 = 6 holes; seed only in direction 2 = 3 + 1.
  const two = { id: "p", type: "lpattern", name: "L", features: ["f2"], dir, spacing: { v: 15 }, count: 3, dir2, spacing2: { v: 15 }, count2: 2 } as Feature;
  ({ v } = vol([two]));
  assert.ok(Math.abs(v - (plate - 6 * hole)) < 1e-3, `${v}`);
  ({ v, r } = vol([{ ...two, seedOnly: true } as Feature]));
  assert.ok(Math.abs(v - (plate - 4 * hole)) < 1e-3, `${v}`);
  assert.deepEqual(r.spots.p.map(s => s.key).sort(), ["0,1", "1,0", "2,0"]);
  // Circular: 3 at 30° one way, direction 2 symmetric = 2 more the other way; 5 holes.
  const cp = { id: "q", type: "cpattern", name: "C", features: ["f2"], axis: { std: "Z" }, count: 3, angle: { v: Math.PI / 6 }, equal: false, dir2: true, sym: true } as Feature;
  ({ v, r } = vol([cp]));
  assert.ok(Math.abs(v - (plate - 5 * hole)) < 1e-3, `${v}`);
  assert.deepEqual(r.spots.q.map(s => s.key), ["1", "2", "-1", "-2"]);
  // Own count and skip a direction 2 instance.
  ({ v } = vol([{ ...cp, sym: false, count2: 4, angle2: { v: Math.PI / 8 }, equal2: false, skip: ["-2"] } as Feature]));
  assert.ok(Math.abs(v - (plate - 5 * hole)) < 1e-3, `${v}`);
  // Full turn both ways: direction 2 copies on direction 1 ones are left out.
  ({ v, r } = vol([{ ...cp, count: 4, angle: { v: 2 * Math.PI }, equal: true } as Feature]));
  assert.ok(Math.abs(v - (plate - 4 * hole)) < 1e-3, `${v}`);
});
