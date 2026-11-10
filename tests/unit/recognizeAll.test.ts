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

test("recognize features: counterbored and countersunk holes come back as Hole Wizard holes, not a hole and a chamfer (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const H = (id: string, pts: [number, number][], o: object) => ({ id, type: "hole", name: id, plane: { face: { name: "e:end" } }, pts, diameter: { v: 4 }, end: "blind", depth: { v: 12 }, ...o }) as Feature;
  const imp = imported(m, [...base(),
    H("h1", [[-20, 10], [-20, -10]], { kind: "cbore", cbDia: { v: 8 }, cbDepth: { v: 4 } }),
    H("h2", [[0, 10]], { kind: "cbore", cbDia: { v: 7 }, cbDepth: { v: 3 }, end: "through", flat: true }),
    H("h3", [[20, 10]], { kind: "csink", csDia: { v: 9 }, csAngle: { v: Math.PI / 2 }, end: "through" }),
    H("h4", [[20, -10]], { kind: "csink", csDia: { v: 8 }, csAngle: { v: (82 * Math.PI) / 180 }, flat: true })]);
  const v0 = vol(m, imp);
  const holes = m.recognizeHoles(imp).holes;
  assert.equal(holes.length, 5);
  assert.equal(holes.filter(h => h.cb).length, 3);
  assert.equal(holes.filter(h => h.cs).length, 2);
  const thru = holes.find(h => h.cb && h.end === "through")!;
  close(thru.cb!.dia, 7); close(thru.cb!.depth, 3); close(thru.diameter, 4);
  const sink = holes.find(h => h.cs && h.end === "blind")!;
  close(sink.cs!.dia, 8); close(sink.cs!.angle, (82 * Math.PI) / 180, 1e-9); close(sink.depth, 12); assert.equal(sink.flat, true);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,hole,hole,hole,hole");
  const kinds = fs.filter(f => f.type === "hole").map(f => `${(f as any).kind}:${(f as any).pts.length}`).sort().join();
  assert.equal(kinds, "cbore:1,cbore:2,csink:1,csink:1");
  close(vol(m, doc([...imp.features, ...fs])), v0);
});

test("recognize features: a cross hole through a shaft comes back as a Through All cut on a standard plane (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 20], [6, 26], [6, 40], [0, 40]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 45 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  // Ø4 across the Ø20 part at z = 10 (along Y) and Ø3 across the Ø12 part at z = 33 (along X).
  const xh: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { std: "XZ" }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 0, y: 10 }, { id: "ok", t: "circle", c: "oc", r: 2 } as SkEnt] };
  const yh: SketchFeature = { id: "p", type: "sketch", name: "p", plane: { std: "YZ" }, rels: [], dims: [],
    ents: [{ id: "pc", t: "point", x: 0, y: 33 }, { id: "pk", t: "circle", c: "pc", r: 1.5 } as SkEnt] };
  const imp = imported(m, [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature,
    xh, { id: "c", type: "extrude", name: "C", sketch: "o", op: "cut", end: "through2", depth: { v: 10 } } as Feature,
    yh, { id: "c2", type: "extrude", name: "C2", sketch: "p", op: "cut", end: "through2", depth: { v: 10 } } as Feature]);
  const v0 = vol(m, imp);
  const H = m.recognizeHoles(imp);
  assert.equal(H.holes.length, 0);
  assert.equal(types(H.cuts ?? []), "sketch,extrude,sketch,extrude");
  close(vol(m, doc([...imp.features, { id: "d", type: "delface", name: "", faces: H.faces } as Feature, ...H.cuts!])), v0, 1e-5);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,revolve,delbody,sketch,extrude,sketch,extrude");
  close(vol(m, doc([...imp.features, ...fs])), v0, 1e-5); // quick volumes are ~4e-6 off on the saddles
  // The cuts are plain sketches with one circle each: a bigger cross hole takes more material.
  const big = fs.map(f => f.type === "sketch" && (f as SketchFeature).ents.some(e => e.t === "circle" && (e as any).r === 2)
    ? { ...f, ents: (f as SketchFeature).ents.map(e => e.t === "circle" ? { ...e, r: 3 } : e) } as Feature : f);
  assert.ok(vol(m, doc([...imp.features, ...big])) < v0 - 100);
});

test("recognize features: blind cross holes in a shaft come back as Hole Wizard holes on a plane tangent to it (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 20], [6, 26], [6, 40], [0, 40]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 45 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  // Ø4 drilled 7 deep with a drill point from the Ø20 part's side (tangent plane 10 from XZ), and Ø3 flat
  // bottomed 5 deep from the other side of the Ø12 part (plane 6 behind YZ, the hole reversed).
  const imp = imported(m, [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature,
    { id: "pa", type: "plane", name: "PA", base: { std: "XZ" }, mode: "offset", offset: { v: 10 } } as Feature,
    { id: "ha", type: "hole", name: "HA", plane: { plane: "pa" }, pts: [[0, 10]], kind: "simple", diameter: { v: 4 }, end: "blind", depth: { v: 7 } } as Feature,
    { id: "pb", type: "plane", name: "PB", base: { std: "YZ" }, mode: "offset", offset: { v: 6 }, flip: true } as Feature,
    { id: "hb", type: "hole", name: "HB", plane: { plane: "pb" }, pts: [[0, 33]], kind: "simple", diameter: { v: 3 }, end: "blind", depth: { v: 5 }, flat: true, flip: true } as Feature]);
  const v0 = vol(m, imp);
  const H = m.recognizeHoles(imp);
  assert.equal(H.holes.length, 0);
  assert.equal(types(H.cuts ?? []), "plane,hole,plane,hole");
  const hs = (H.cuts ?? []).filter(f => f.type === "hole") as any[];
  assert.deepEqual(hs.map(h => [h.diameter.v, Math.round(h.depth.v * 1e6) / 1e6, !!h.flat]).sort((a, b) => a[0] - b[0]), [[3, 5, true], [4, 7, false]]);
  close(vol(m, doc([...imp.features, { id: "d", type: "delface", name: "", faces: H.faces } as Feature, ...H.cuts!])), v0, 1e-5);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,revolve,delbody,plane,hole,plane,hole");
  close(vol(m, doc([...imp.features, ...fs])), v0, 1e-5);
  // The holes stay editable: a deeper hole takes more material.
  const deep = fs.map(f => f.type === "hole" ? { ...f, depth: { v: (f as any).depth.v + 2 } } as Feature : f);
  assert.ok(vol(m, doc([...imp.features, ...deep])) < v0 - 5);
});
