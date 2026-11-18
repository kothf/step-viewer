/** Flex (FR-FT-105). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { flexAffine, flexMap, flexPoint } from "../../src/model/flex";
import type { Feature, FlexFeature, PartDoc, SketchFeature, SkEnt, V3 } from "../../src/model/types";
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
const close = (a: number, b: number, rel: number) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);

// A 100 × 20 × 10 bar along X, its middle on the origin: sketch on YZ, extruded mid-plane.
const bar: Feature[] = [rect("s1", 0, 0, 20, 10, { std: "YZ" }), { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "mid", depth: { v: 100 } }];
const flex = (o: Partial<FlexFeature>): FlexFeature => ({ id: "f2", type: "flex", name: "Flex1", bodies: [], kind: "bend", axis: "x", angle: { v: Math.PI / 2 }, ...o });

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  return r;
}
async function volume(m: Modeller, r: ReturnType<Modeller["evaluate"]>) {
  const oc = await occ();
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_2(r.body!.shape, p, 1e-7, false, false);
  const b = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(r.body!.shape, b, false);
  void m;
  return { v: p.Mass(), lo: [b.CornerMin().X(), b.CornerMin().Y(), b.CornerMin().Z()] as V3, hi: [b.CornerMax().X(), b.CornerMax().Y(), b.CornerMax().Z()] as V3 };
}

test("flex map: bend keeps lengths on the neutral line, ends run on rigidly (FR-FT-105)", () => {
  const f = flex({});
  const m = flexMap(f, [[-50, -10, -5], [50, 10, 5]]);
  // The triad (middle) stays; the region is the whole bar; R = 100 / (π/2).
  const R = 100 / (Math.PI / 2);
  const p = flexPoint(m, [50, 0, 0]);
  close(p[0], R * Math.sin(Math.PI / 4), 1e-12);
  close(p[2], R - R * Math.cos(Math.PI / 4), 1e-12);
  // Affine above a trim plane: agrees with the point map past it.
  const m2 = flexMap(flex({ trim1: { v: 20 }, trim2: { v: 20 } }), [[-50, -10, -5], [50, 10, 5]]);
  const { M, t } = flexAffine(m2, m2.s2 + 1);
  for (const q of [[45, 3, 2], [40, -7, 4]] as V3[]) {
    const a = flexPoint(m2, q), b = [0, 1, 2].map(i => M[3 * i] * q[0] + M[3 * i + 1] * q[1] + M[3 * i + 2] * q[2] + t[i]);
    for (let i = 0; i < 3; i++) close(a[i], b[i], 1e-9);
  }
});

test("flex: bend, twist, taper and stretch of a bar keep their exact volumes (FR-FT-105)", async () => {
  const m = new Modeller(await occ());
  const V = 100 * 20 * 10;
  let r = run(m, doc([...bar, flex({})]));
  let q = await volume(m, r);
  close(q.v, V, 1e-5);
  assert.equal(m.props(r.body!).bodies, 1);
  // The ends turned 45° each way: the bar now rises in Z.
  assert.ok(q.hi[2] > 15, `${q.hi}`);
  assert.ok(r.body!.names.includes("f1:end") && r.body!.names.includes("f1:start"), r.body!.names.join());
  // Trim planes 30 in from each end: only the middle 40 bends, the ends stay flat.
  r = run(m, doc([...bar, flex({ trim1: { v: 30 }, trim2: { v: 30 } })]));
  q = await volume(m, r);
  close(q.v, V, 1e-5);
  // Twist 90°: every section turns, the volume stays.
  r = run(m, doc([...bar, flex({ kind: "twist" })]));
  q = await volume(m, r);
  close(q.v, V, 1e-5);
  // Taper to 0.5: area k², ∫(1 − s/2L)² = L(1 + 0.5 + 0.25)/3.
  r = run(m, doc([...bar, flex({ kind: "taper", factor: { v: 0.5 } })]));
  q = await volume(m, r);
  close(q.v, V * (1 + 0.5 + 0.25) / 3, 1e-5);
  // Stretch the middle 40 by 10: exact (affine pieces).
  r = run(m, doc([...bar, flex({ kind: "stretch", distance: { v: 10 }, trim1: { v: 30 }, trim2: { v: 30 } })]));
  q = await volume(m, r);
  close(q.v, V + 10 * 200, 1e-9);
  close(q.hi[0] - q.lo[0], 110, 1e-6);
  // Soft edges (no split): the faces are mapped whole, a little less exactly across the trim planes.
  r = run(m, doc([...bar, flex({ hard: false, trim1: { v: 30 }, trim2: { v: 30 } })]));
  q = await volume(m, r);
  close(q.v, V, 1e-4);
  assert.equal(r.body!.faces.length, 6);
});

test("flex: a round rod bends without a seam problem, a picked body alone flexes (FR-FT-105)", async () => {
  const m = new Modeller(await occ());
  const rod: Feature[] = [circle("s1", 0, 0, 4, { std: "YZ" }), { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "mid", depth: { v: 100 } }];
  let r = run(m, doc([...rod, flex({ angle: { v: Math.PI } })]));
  let q = await volume(m, r);
  close(q.v, Math.PI * 16 * 100, 1e-5);
  // Two bodies: only the picked one bends.
  const other: Feature[] = [rect("s2", 0, 40, 20, 10, { std: "XY" }), { id: "f3", type: "extrude", name: "Extrude2", sketch: "s2", op: "boss", end: "blind", depth: { v: 5 }, merge: false }];
  r = run(m, doc([...rod, ...other, flex({ id: "f4", bodies: [{ name: "f1:end" }] })]));
  q = await volume(m, r);
  close(q.v, Math.PI * 16 * 100 + 1000, 1e-5);
  assert.equal(m.props(r.body!).bodies, 2);
  // Bad input says so.
  const bad = m.evaluate(doc([...rod, flex({ toward: "x" })]));
  assert.equal(bad.statuses.find(s => s.id === "f2")?.ok, false);
});
