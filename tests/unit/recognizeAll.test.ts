// Recognize Features (FR-FT-102): fillets, holes, extrudes and the base found in one go, in modelling order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";
import { fullyDefineSketch } from "../../src/sketch/define";
import { solve } from "../../src/sketch/solver";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }];
  return { id, type: "sketch", name: id, plane: { std: "XY" }, ents, rels: [], dims: [] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
const S = (k: number) => `e:side:sl${k}`;
const base = () => [rect("s", 60, 40), { id: "e", type: "extrude", name: "E", sketch: "s", op: "boss", end: "blind", depth: { v: 20 } } as Feature];
const on = (sk: SketchFeature, face: string): SketchFeature => ({ ...sk, plane: { face: { name: face } } });
const cut = (id: string, sketch: string, depth: number, end: "blind" | "through" = "blind"): Feature => ({ id, type: "extrude", name: id, sketch, op: "cut", end, depth: { v: depth } }) as Feature;

const ch = (id: string, k: number) => ({ id, type: "chamfer", name: id, distance: { v: 3 }, edges: [{ faces: ["e:end", S(k)] }] }) as Feature;
const imported = (m: Modeller, feats: Feature[]) => {
  const r = m.evaluate(doc(feats));
  assert.deepEqual(r.statuses.filter(s => !s.ok), []);
  return doc([{ id: "i", type: "import", name: "Imported1", file: "b.brep", brep: m.brepText(r.body!).brep } as Feature]);
};
const vol = (m: Modeller, d: PartDoc) => { const r = m.evaluate(d); assert.deepEqual(r.statuses.filter(s => !s.ok), []); return m.props(r.body!).volume; };

const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);
const types = (fs: Feature[]) => fs.map(f => f.type).join();

test("recognize features: a filleted block with a pocket and a hole comes back as base, cut, hole, fillet (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const pocket = on(rect("q", 20, 10), "e:end");
  const hole: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { face: { name: "e:end" } }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 20, y: 10 }, { id: "ok", t: "circle", c: "oc", r: 4 } as SkEnt] };
  const fil = { id: "f", type: "fillet", name: "F", radius: { v: 5 }, edges: [1, 2, 3, 4].map(k => ({ faces: [S(k), S(k % 4 + 1)] })) } as Feature;
  const imp = imported(m, [...base(), fil, pocket, cut("c1", "q", 5), hole, cut("c2", "o", 10, "through")]);
  const v0 = vol(m, imp);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,sketch,extrude,hole,fillet");
  close(vol(m, doc([...imp.features, ...fs])), v0);
  // The base sketch is the sharp outline: the fillets and the hole are features of their own.
  assert.equal((fs[0] as SketchFeature).ents.filter(e => e.t === "arc" || e.t === "circle").length, 0);
  const h = fs[5] as any, f = fs[6] as any;
  close(h.diameter.v, 8); assert.equal(h.end, "through");
  close(f.radius.v, 5); assert.equal(f.edges.length, 4);
  // Editable: a bigger hole and a smaller fillet change the volume.
  const edit = fs.map(x => x.type === "hole" ? { ...x, diameter: { v: 10 } } as Feature : x.type === "fillet" ? { ...x, radius: { v: 2 } } as Feature : x);
  const v1 = vol(m, doc([...imp.features, ...edit]));
  close(v1, v0 - Math.PI * (25 - 16) * 20 + 4 * (25 - 4) * (1 - Math.PI / 4) * 20, 1e-4);
});

test("recognize features: chamfers along two directions no longer stop the base; a plain block is the base alone (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const pocket = on(rect("q", 20, 10), "e:end");
  const hole: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { face: { name: "e:end" } }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 20, y: 10 }, { id: "ok", t: "circle", c: "oc", r: 4 } as SkEnt] };
  const imp = imported(m, [...base(), ch("h1", 1), ch("h2", 2), pocket, cut("c1", "q", 5), hole, cut("c2", "o", 6)]);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,sketch,extrude,hole,chamfer");
  close((fs[5] as any).depth.v, 6); assert.equal((fs[5] as any).end, "blind");
  assert.equal((fs[6] as any).edges.length, 2);
  close(vol(m, doc([...imp.features, ...fs])), vol(m, imp));
  assert.equal(types(m.recognizeFeatures(imported(m, base()))), "sketch,extrude,delbody");
});

test("recognize features: a shaft with a bore in its end comes back as a revolve and a hole (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 20], [6, 26], [6, 40], [0, 40]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 45 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  const top = { id: "pt", type: "plane", name: "pt", base: { std: "XY" }, mode: "offset", offset: { v: 40 } } as Feature;
  const bore: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { plane: "pt" }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 0, y: 0 }, { id: "ok", t: "circle", c: "oc", r: 2 } as SkEnt] };
  const imp = imported(m, [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature, top, bore,
    { id: "c", type: "extrude", name: "C", sketch: "o", op: "cut", end: "blind", depth: { v: 8 } } as Feature]);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,revolve,delbody,hole");
  close((fs[3] as any).diameter.v, 4); close((fs[3] as any).depth.v, 8);
  close(vol(m, doc([...imp.features, ...fs])), vol(m, imp));
  // Its half section comes back fully defined (the controller runs Fully define sketch on recognised sketches).
  const def = fs.map(f => f.type === "sketch" ? fullyDefineSketch(f, { sizes: true }).sketch : f);
  assert.equal(solve(def[0] as SketchFeature).dof, 0);
  close(vol(m, doc([...imp.features, ...def])), vol(m, imp));
});
