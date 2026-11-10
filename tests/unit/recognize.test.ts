// Feature recognition on imported bodies (FR-FT-102): fillets and chamfers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { ChamferFeature, Feature, FilletFeature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }];
  return { id, type: "sketch", name: id, plane: { std: "XY" }, ents, rels: [], dims: [] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);
function vol(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  assert.deepEqual(r.statuses.filter(s => !s.ok), []);
  return m.props(r.body!).volume;
}
const S = (k: number) => `e:side:sl${k}`;
const base = () => [rect("s", 60, 40), { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } } as Feature];
const imported = (m: Modeller, feats: Feature[]) => {
  const r = m.evaluate(doc(feats));
  assert.deepEqual(r.statuses.filter(s => !s.ok), []);
  return doc([{ id: "i", type: "import", name: "Imported1", file: "b.brep", brep: m.brepText(r.body!).brep } as Feature]);
};

test("feature recognition: fillets and a chamfer on an imported block (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const src = [...base(),
    { id: "f", type: "fillet", name: "F", radius: { v: 5 }, edges: [{ faces: [S(1), S(2)] }, { faces: [S(2), S(3)] }] } as Feature,
    { id: "c", type: "chamfer", name: "C", distance: { v: 2 }, edges: [{ faces: ["e:end", S(4)] }] } as Feature];
  const imp = imported(m, src);
  const v0 = vol(m, imp);
  const feats = m.recognizeBlends(imp);
  assert.equal(feats.map(f => f.type).join(), "delface,chamfer,fillet");
  const ch = feats[1] as ChamferFeature, fi = feats[2] as FilletFeature;
  close(fi.radius.v, 5); assert.equal(fi.edges.length, 2);
  close(ch.distance.v, 2); assert.equal(ch.edges.length, 1);
  close(vol(m, doc([...imp.features, feats[0]])), 60 * 40 * 20);
  close(vol(m, doc([...imp.features, ...feats])), v0);
});

test("feature recognition: a fillet round filleted corners comes off first (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const src = [...base(),
    { id: "f", type: "fillet", name: "F", radius: { v: 5 }, edges: [1, 2, 3, 4].map(k => ({ faces: [S(k), S(k % 4 + 1)] })) } as Feature,
    { id: "g", type: "fillet", name: "G", radius: { v: 2 }, edges: [{ faces: ["e:end", S(1)] }] } as Feature];
  const imp = imported(m, src);
  const v0 = vol(m, imp);
  const feats = m.recognizeBlends(imp);
  assert.equal(feats.map(f => f.type).join(), "delface,delface,fillet,fillet");
  const big = feats[2] as FilletFeature, small = feats[3] as FilletFeature;
  close(big.radius.v, 5); assert.equal(big.edges.length, 4);
  close(small.radius.v, 2); assert.equal(small.edges.length, 8);
  close(vol(m, doc([...imp.features, feats[0], feats[1]])), 60 * 40 * 20);
  close(vol(m, doc([...imp.features, ...feats])), v0);
});

test("feature recognition: a plain block and a hexagon bar have no blends (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  assert.equal(m.recognizeBlends(imported(m, base())).length, 0);
  const hex: SketchFeature = { id: "h", type: "sketch", name: "h", plane: { std: "XY" }, rels: [], dims: [], ents: [
    ...[0, 1, 2, 3, 4, 5].map(k => ({ id: `p${k}`, t: "point", x: 10 * Math.cos(k * Math.PI / 3), y: 10 * Math.sin(k * Math.PI / 3) }) as SkEnt),
    ...[0, 1, 2, 3, 4, 5].map(k => ({ id: `l${k}`, t: "line", a: `p${k}`, b: `p${(k + 1) % 6}` }) as SkEnt)] };
  const bar = imported(m, [hex, { id: "e", type: "extrude", name: "E", sketch: "h", op: "boss", end: "blind", depth: { v: 30 } } as Feature]);
  assert.equal(m.recognizeBlends(bar).length, 0);
});

test("feature recognition: a chamfer on a round edge comes back as a chamfer (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const circle: SketchFeature = { id: "s", type: "sketch", name: "s", plane: { std: "XY" }, rels: [], dims: [],
    ents: [{ id: "c", t: "point", x: 0, y: 0 }, { id: "k", t: "circle", c: "c", r: 15 } as SkEnt] };
  const ext = { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } } as Feature;
  const names = m.evaluate(doc([circle, ext])).body!.names;
  const side = names.find(n => n.startsWith("e:side"))!;
  const imp = imported(m, [circle, ext, { id: "c", type: "chamfer", name: "C", distance: { v: 3 }, edges: [{ faces: ["e:end", side] }] } as Feature]);
  const v0 = vol(m, imp);
  const feats = m.recognizeBlends(imp);
  assert.equal(feats.map(f => f.type).join(), "delface,chamfer");
  close((feats[1] as ChamferFeature).distance.v, 3);
  close(vol(m, doc([...imp.features, ...feats])), v0);
  // The size can then be changed like any chamfer's.
  (feats[1] as ChamferFeature).distance = { v: 5 };
  assert.ok(vol(m, doc([...imp.features, ...feats])) < v0 - 100);
});

test("feature recognition: a two-distance chamfer keeps its two distances, also under a later fillet (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const cham = { id: "c", type: "chamfer", name: "C", mode: "two", distance: { v: 3 }, distance2: { v: 7 }, edges: [{ faces: ["e:end", S(4)] }] } as Feature;
  const imp = imported(m, [...base(), cham]);
  const v0 = vol(m, imp);
  const feats = m.recognizeBlends(imp);
  assert.equal(feats.map(f => f.type).join(), "delface,chamfer");
  const ch = feats[1] as ChamferFeature;
  assert.equal(ch.mode, "two");
  assert.deepEqual([ch.distance.v, ch.distance2!.v].map(v => Math.round(v * 1e6) / 1e6).sort((a, b) => a - b), [3, 7]);
  close(vol(m, doc([...imp.features, ...feats])), v0);
  // A fillet between the chamfer and the side comes off first; the chamfer under it still comes back the right way round.
  const face = m.evaluate(doc([...base(), cham])).body!.names.find(n => n.startsWith("c:"))!;
  const imp2 = imported(m, [...base(), cham, { id: "f", type: "fillet", name: "F", radius: { v: 1 }, edges: [{ faces: [face, S(4)] }] } as Feature]);
  const v2 = vol(m, imp2);
  const feats2 = m.recognizeBlends(imp2);
  assert.equal(feats2.map(f => f.type).join(), "delface,delface,chamfer,fillet");
  assert.equal((feats2[2] as ChamferFeature).mode, "two");
  close(vol(m, doc([...imp2.features, ...feats2])), v2);
});
