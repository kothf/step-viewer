/** Dome (FR-FT-103). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt, V3 } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, cx: number, cy: number, w: number, h: number, plane: SketchFeature["plane"] = { std: "XY" }): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", cx - w / 2, cy - h / 2), P("2", cx + w / 2, cy - h / 2), P("3", cx + w / 2, cy + h / 2), P("4", cx - w / 2, cy + h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane, ents, rels: [], dims: [] };
};
const circle = (id: string, x: number, y: number, r: number, plane: SketchFeature["plane"]): SketchFeature => ({
  id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}k`, t: "circle", c: `${id}c`, r }],
});
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  return { ...r, props: r.body ? m.props(r.body) : null };
}

const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);

test("dome: an exact spherical cap, half an ellipsoid and a dent on a round face (FR-FT-103)", async () => {
  const m = new Modeller(await occ());
  const s1 = circle("s1", 0, 0, 10, { std: "XY" });
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const cyl = Math.PI * 100 * 20;
  const dome: Feature = { id: "f2", type: "dome", name: "Dome1", faces: [{ name: "f1:end" }], distance: { v: 4 } };
  let r = run(m, doc([s1, ex, dome]));
  // Spherical cap: πh(3a² + h²)/6.
  close(r.props!.volume, cyl + (Math.PI * 4 * (300 + 16)) / 6, 1e-6);
  assert.equal(r.props!.bodies, 1);
  assert.ok(r.body!.names.includes("f2:dome:0"), r.body!.names.join());
  assert.ok(!r.body!.names.includes("f1:end"), r.body!.names.join());
  // Elliptical: half an ellipsoid, (2/3)πa²h, taller than the radius too.
  r = run(m, doc([s1, ex, { ...dome, elliptical: true }]));
  close(r.props!.volume, cyl + (2 / 3) * Math.PI * 100 * 4, 1e-6);
  r = run(m, doc([s1, ex, { ...dome, elliptical: true, distance: { v: 15 } }]));
  close(r.props!.volume, cyl + (2 / 3) * Math.PI * 100 * 15, 1e-6);
  // Reverse direction: a dent.
  r = run(m, doc([s1, ex, { ...dome, flip: true }]));
  close(r.props!.volume, cyl - (Math.PI * 4 * (300 + 16)) / 6, 1e-6);
  assert.ok(r.body!.names.includes("f2:dome:0"), r.body!.names.join());
});

test("dome: a smooth patch on a rectangular face, peak above the middle (FR-FT-103)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 40, 20);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 } };
  const dome: Feature = { id: "f2", type: "dome", name: "Dome1", faces: [{ name: "f1:end" }], distance: { v: 5 } };
  const r = run(m, doc([s1, ex, dome]));
  assert.equal(r.props!.bodies, 1);
  const v = r.props!.volume;
  // More than the block, less than the block plus the box over the face.
  assert.ok(v > 8000 + 1000 && v < 8000 + 4000, String(v));
  assert.ok(r.body!.names.includes("f2:dome:0"), r.body!.names.join());
  // The peak is the distance above the face, over its middle.
  close(r.props!.box![1][2], 15, 1e-6);
  // Reverse direction takes the same volume out.
  const dent = run(m, doc([s1, ex, { ...dome, flip: true }]));
  close(dent.props!.volume, 8000 - (v - 8000), 1e-6);
  // An elliptical dome needs a round face.
  const bad = m.evaluate(doc([s1, ex, { ...dome, elliptical: true }]));
  assert.equal(bad.statuses.at(-1)!.ok, false);
  // A dome on a curved face is refused.
  const s2 = circle("s2", 0, 0, 10, { std: "XY" });
  const cyl: Feature = { id: "f3", type: "extrude", name: "Extrude2", sketch: "s2", op: "boss", end: "blind", depth: { v: 10 } };
  const curved = m.evaluate(doc([s2, cyl, { id: "f4", type: "dome", name: "Dome2", faces: [{ name: "f3:side:s2k" }], distance: { v: 2 } }]));
  assert.equal(curved.statuses.at(-1)!.ok, false);
});
