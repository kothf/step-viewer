// Recognised sketches come back fully defined (FR-FT-102 with FR-SK-045's Fully define sketch), as FeatureWorks gives them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { fullyDefineSketch } from "../../src/sketch/define";
import { solve } from "../../src/sketch/solver";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }];
  return { id, type: "sketch", name: id, plane: { std: "XY" }, ents, rels: [], dims: [] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const vol = (m: Modeller, d: PartDoc) => { const r = m.evaluate(d); assert.deepEqual(r.statuses.filter(s => !s.ok), []); return m.props(r.body!).volume; };
const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);

test("fully define: a free rectangle gets H/V relations and dimensions, and nothing moves", () => {
  const sk = { ...rect("r", 60, 40), ents: rect("r", 60, 40).ents.map(e => e.t === "point" ? { ...e, x: e.x + 7, y: e.y + 3 } : e) };
  const before = solve(sk);
  assert.equal(before.status, "ok"); assert.ok(before.dof > 0);
  const { sketch, added } = fullyDefineSketch(sk);
  assert.ok(added > 0);
  assert.equal(solve(sketch).dof, 0);
  assert.equal(sketch.rels.filter(r => r.t === "horizontal" || r.t === "vertical").length, 4);
  assert.deepEqual(sketch.dims.map(d => d.name), sketch.dims.map((_, i) => `D${i + 1}`));
  assert.equal(sk.dims.length, 0, "the sketch passed in is left alone");
  for (const e of sketch.ents) if (e.t === "point") {
    const o = sk.ents.find(x => x.id === e.id) as SkEnt & { t: "point" };
    close(e.x, o.x); close(e.y, o.y);
  }
});

test("recognised base and pocket sketches are fully defined and rebuild the same body (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const pocket = { ...rect("q", 20, 10), plane: { face: { name: "e:end" } } } as SketchFeature;
  const hole: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { face: { name: "e:end" } }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 20, y: 10 }, { id: "ok", t: "circle", c: "oc", r: 4 } as SkEnt] };
  const src = [rect("s", 60, 40), { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } } as Feature,
    pocket, { id: "c1", type: "extrude", name: "c1", sketch: "q", op: "cut", end: "blind", depth: { v: 5 } } as Feature,
    hole, { id: "c2", type: "extrude", name: "c2", sketch: "o", op: "cut", end: "through", depth: { v: 1 } } as Feature];
  const r = m.evaluate(doc(src));
  const imp = doc([{ id: "i", type: "import", name: "Imported1", file: "b.brep", brep: m.brepText(r.body!).brep } as Feature]);
  const v0 = vol(m, imp);
  const fs = m.recognizeFeatures(imp).map(f => f.type === "sketch" ? fullyDefineSketch(f).sketch : f);
  const sks = fs.filter((f): f is SketchFeature => f.type === "sketch");
  assert.ok(sks.length >= 2);
  for (const sk of sks) {
    assert.equal(solve(sk).dof, 0, `${sk.id} is fully defined`);
    assert.ok(sk.dims.length > 0);
  }
  close(vol(m, doc([...imp.features, ...fs])), v0);
});
