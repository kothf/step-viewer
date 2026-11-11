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

test("recognize features: cross holes at an angle come back on a plane at an angle about a standard axis (FR-FT-102, FR-REF-002)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 20], [6, 26], [6, 40], [0, 40]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 45 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  const shaft: Feature[] = [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature];
  // Ø4 right through at 30° to X in the XZ plane, through (0, 0, 10); Ø3 drilled 4 deep at 45° round the
  // Ø12 part (axis along Z, so square to Z) at z = 33, from the plane tangent to it.
  const pa = { id: "pa", type: "plane", name: "PA", base: { std: "YZ" }, mode: "angle", offset: { v: 0 }, angle: { v: Math.PI / 6 }, about: { std: "Y" } } as Feature;
  const pb = { id: "pb", type: "plane", name: "PB", base: { std: "YZ" }, mode: "angle", offset: { v: 0 }, angle: { v: Math.PI / 4 }, about: { std: "Z" } } as Feature;
  const pc = { id: "pc", type: "plane", name: "PC", base: { plane: "pb" }, mode: "offset", offset: { v: 6 } } as Feature;
  const F = m.evaluate(doc([...shaft, pa, pb, pc])).frames;
  const at = (fr: { o: number[]; x: number[]; y: number[] }, p: number[]): [number, number] => {
    const q = p.map((v, i) => v - fr.o[i]);
    return [q[0] * fr.x[0] + q[1] * fr.x[1] + q[2] * fr.x[2], q[0] * fr.y[0] + q[1] * fr.y[1] + q[2] * fr.y[2]];
  };
  const [ax, ay] = at(F.pa, [0, 0, 10]);
  const xh: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { plane: "pa" }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: ax, y: ay }, { id: "ok", t: "circle", c: "oc", r: 2 } as SkEnt] };
  const plain = vol(m, doc(shaft));
  const hb = (flip: boolean) => ({ id: "hb", type: "hole", name: "HB", plane: { plane: "pc" }, pts: [at(F.pc, [0, 0, 33])], kind: "simple", diameter: { v: 3 }, end: "blind", depth: { v: 4 }, flat: true, ...(flip ? { flip: true } : {}) }) as Feature;
  const flip = vol(m, doc([...shaft, pa, pb, pc, hb(false)])) > plain - 1;
  const imp = imported(m, [...shaft, pa, xh, { id: "c", type: "extrude", name: "C", sketch: "o", op: "cut", end: "through2", depth: { v: 10 } } as Feature, pb, pc, hb(flip)]);
  const v0 = vol(m, imp);
  assert.ok(v0 < plain - 100);
  const H = m.recognizeHoles(imp);
  assert.equal(H.holes.length, 0);
  assert.equal(types(H.cuts ?? []), "plane,plane,hole,plane,sketch,extrude");
  const angled = (H.cuts ?? []).filter(f => f.type === "plane" && (f as any).mode === "angle") as any[];
  assert.deepEqual(angled.map(p => p.about.std).sort(), ["Y", "Z"]);
  close(vol(m, doc([...imp.features, { id: "d", type: "delface", name: "", faces: H.faces } as Feature, ...H.cuts!])), v0, 1e-5);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,revolve,delbody,plane,plane,hole,plane,sketch,extrude");
  close(vol(m, doc([...imp.features, ...fs])), v0, 1e-5);
});

test("recognize features: a cross hole at a compound angle comes back on a plane about an axis where a plane about Z meets XY (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 30], [0, 30]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 35 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  const shaft: Feature[] = [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature];
  // Ø4 through (0, 0, 15): 35° round the shaft and 20° up from square to it.
  const p1 = { id: "p1", type: "plane", name: "P1", base: { std: "YZ" }, mode: "angle", offset: { v: 0 }, angle: { v: 35 * Math.PI / 180 }, about: { std: "Z" } } as Feature;
  const a1 = { id: "a1", type: "axis", name: "A1", mode: "planes", planes: [{ std: "XY" }, { plane: "p1" }] } as Feature;
  const p2 = { id: "p2", type: "plane", name: "P2", base: { plane: "p1" }, mode: "angle", offset: { v: 0 }, angle: { v: 20 * Math.PI / 180 }, about: { axis: "a1" } } as Feature;
  const F = m.evaluate(doc([...shaft, p1, a1, p2])).frames.p2;
  const n = F.n;
  assert.ok(Math.abs(n[2]) > 0.2 && Math.abs(n[0]) > 0.2 && Math.abs(n[1]) > 0.2, `compound normal ${n}`);
  const q = [0, 0, 15].map((v, i) => v - F.o[i]);
  const dt = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const xh: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { plane: "p2" }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: dt(q, F.x), y: dt(q, F.y) }, { id: "ok", t: "circle", c: "oc", r: 2 } as SkEnt] };
  const plain = vol(m, doc(shaft));
  const imp = imported(m, [...shaft, p1, a1, p2, xh, { id: "c", type: "extrude", name: "C", sketch: "o", op: "cut", end: "through2", depth: { v: 10 } } as Feature]);
  const v0 = vol(m, imp);
  assert.ok(v0 < plain - 200);
  const H = m.recognizeHoles(imp);
  assert.equal(types(H.cuts ?? []), "plane,axis,plane,sketch,extrude");
  close(vol(m, doc([...imp.features, { id: "d", type: "delface", name: "", faces: H.faces } as Feature, ...H.cuts!])), v0, 1e-5);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,plane,axis,plane,sketch,extrude");
  close(vol(m, doc([...imp.features, ...fs])), v0, 1e-5);
});

test("recognize features: keyways in a shaft come back as a tangent plane, a slot sketch and a blind cut (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 40], [0, 40]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 45 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  // A 6 wide slot with round ends, centres 14 apart (z 13 to 27), in the frame of the plane it is sketched on.
  const slot = (id: string, pl: string, x0: number): SketchFeature => ({ id, type: "sketch", name: id, plane: { plane: pl }, rels: [], dims: [], ents: [
    { id: `${id}c1`, t: "point", x: x0, y: 13 }, { id: `${id}c2`, t: "point", x: x0, y: 27 },
    { id: `${id}a1`, t: "point", x: x0 + 3, y: 13 }, { id: `${id}a2`, t: "point", x: x0 + 3, y: 27 }, { id: `${id}b1`, t: "point", x: x0 - 3, y: 13 }, { id: `${id}b2`, t: "point", x: x0 - 3, y: 27 },
    { id: `${id}l1`, t: "line", a: `${id}a1`, b: `${id}a2` }, { id: `${id}l2`, t: "line", a: `${id}b2`, b: `${id}b1` },
    { id: `${id}r1`, t: "arc", c: `${id}c2`, a: `${id}a2`, b: `${id}b2` }, { id: `${id}r2`, t: "arc", c: `${id}c1`, a: `${id}b1`, b: `${id}a1` }] as SkEnt[] });
  // One keyway 3.5 deep from the plane tangent at y = -10, one 3 deep from x = -10 (that cut reversed).
  const imp = imported(m, [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature,
    { id: "pa", type: "plane", name: "PA", base: { std: "XZ" }, mode: "offset", offset: { v: 10 } } as Feature, slot("ka", "pa", 0),
    { id: "ca", type: "extrude", name: "CA", sketch: "ka", op: "cut", end: "blind", depth: { v: 3.5 } } as Feature,
    { id: "pb", type: "plane", name: "PB", base: { std: "YZ" }, mode: "offset", offset: { v: 10 }, flip: true } as Feature, slot("kb", "pb", 0),
    { id: "cb", type: "extrude", name: "CB", sketch: "kb", op: "cut", end: "blind", depth: { v: 3 }, flip: true } as Feature]);
  const v0 = vol(m, imp);
  const E = m.recognizeExtrudes(imp);
  assert.equal(types(E), "sketch,extrude,delbody,plane,sketch,extrude,plane,sketch,extrude");
  assert.deepEqual(E.filter(f => f.type === "extrude" && (f as any).op === "cut").map(f => +(f as any).depth.v.toFixed(6)).sort(), [3, 3.5]);
  close(vol(m, doc([...imp.features, ...E])), v0, 1e-5);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,plane,sketch,extrude,plane,sketch,extrude");
  close(vol(m, doc([...imp.features, ...fs])), v0, 1e-5);
  // The keyway stays editable: deeper takes more material.
  const deep = fs.map(f => f.type === "extrude" && (f as any).op === "cut" ? { ...f, depth: { v: (f as any).depth.v + 1 } } as Feature : f);
  assert.ok(vol(m, doc([...imp.features, ...deep])) < v0 - 50);
});

test("recognize features: a keyway running out through the shaft's end comes back as plane + sketch + blind cut (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const xy: [number, number][] = [[0, 0], [10, 0], [10, 40], [0, 40]];
  const ents: SkEnt[] = xy.map(([x, y], i) => ({ id: `rp${i}`, t: "point", x, y }) as SkEnt);
  xy.forEach((_, i) => ents.push({ id: `rl${i}`, t: "line", a: `rp${i}`, b: `rp${(i + 1) % xy.length}` }));
  ents.push({ id: "ra", t: "point", x: 0, y: -5 }, { id: "rb", t: "point", x: 0, y: 45 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  // A 6 wide keyway with a round end at z = 28 that runs out past the shaft's end at z = 40.
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `k${k}`, t: "point", x, y });
  const key: SketchFeature = { id: "k", type: "sketch", name: "k", plane: { plane: "pa" }, rels: [], dims: [], ents: [
    P("c", 0, 28), P("a1", 3, 28), P("a2", 3, 45), P("b2", -3, 45), P("b1", -3, 28),
    { id: "kl1", t: "line", a: "ka1", b: "ka2" }, { id: "kl2", t: "line", a: "ka2", b: "kb2" }, { id: "kl3", t: "line", a: "kb2", b: "kb1" },
    { id: "kr", t: "arc", c: "kc", a: "kb1", b: "ka1" }] as SkEnt[] };
  const imp = imported(m, [{ id: "r", type: "sketch", name: "r", plane: { std: "XZ" }, ents, rels: [], dims: [] },
    { id: "v", type: "revolve", name: "V", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } } as Feature,
    { id: "pa", type: "plane", name: "PA", base: { std: "XZ" }, mode: "offset", offset: { v: 10 } } as Feature, key,
    { id: "ca", type: "extrude", name: "CA", sketch: "k", op: "cut", end: "blind", depth: { v: 3.5 } } as Feature]);
  const v0 = vol(m, imp);
  const E = m.recognizeExtrudes(imp);
  assert.equal(types(E), "sketch,extrude,delbody,plane,sketch,extrude");
  assert.deepEqual(E.filter(f => f.type === "extrude" && (f as any).op === "cut").map(f => +(f as any).depth.v.toFixed(6)), [3.5]);
  close(vol(m, doc([...imp.features, ...E])), v0, 1e-5);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,plane,sketch,extrude");
  close(vol(m, doc([...imp.features, ...fs])), v0, 1e-5);
});

test("recognize features: a block with a variable radius fillet comes back as base and variable fillet (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const vf = { id: "f", type: "fillet", name: "F", variable: true, radius: { v: 5 }, edges: [{ faces: [S(1), S(2)], r: 2, r2: 6 }] } as Feature;
  const imp = imported(m, [...base(), vf]);
  const v0 = vol(m, imp);
  const fs = m.recognizeFeatures(imp);
  assert.equal(types(fs), "sketch,extrude,delbody,fillet");
  const f = fs[3] as Extract<Feature, { type: "fillet" }>;
  assert.equal(f.variable, true);
  close(Math.min(f.edges[0].r!, f.edges[0].r2!), 2, 1e-4); close(Math.max(f.edges[0].r!, f.edges[0].r2!), 6, 1e-4);
  close(vol(m, doc([...imp.features, ...fs])), v0);
});

test("recognize features: a bent tube comes back as path and profile sketches and a Sweep (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const path: SketchFeature = { id: "pt", type: "sketch", name: "pt", plane: { std: "XZ" }, rels: [], dims: [], ents: [
    { id: "q1", t: "point", x: 0, y: 0 }, { id: "q2", t: "point", x: 0, y: 40 }, { id: "q3", t: "point", x: 20, y: 60 }, { id: "q4", t: "point", x: 60, y: 60 }, { id: "qc", t: "point", x: 20, y: 40 },
    { id: "w1", t: "line", a: "q1", b: "q2" }, { id: "w2", t: "arc", c: "qc", a: "q3", b: "q2" } as SkEnt, { id: "w3", t: "line", a: "q3", b: "q4" }] };
  for (const inner of [0, 3]) {
    const prof: SketchFeature = { id: "pr", type: "sketch", name: "pr", plane: { std: "XY" }, rels: [], dims: [], ents: [
      { id: "pc", t: "point", x: 0, y: 0 }, { id: "pk", t: "circle", c: "pc", r: 5 } as SkEnt, ...(inner ? [{ id: "pi", t: "circle", c: "pc", r: inner } as SkEnt] : [])] };
    const imp = imported(m, [path, prof, { id: "sw", type: "sweep", name: "S", op: "boss", profile: "pr", path: { sketch: "pt" } } as Feature]);
    const v0 = vol(m, imp);
    const fs = m.recognizeFeatures(imp);
    assert.equal(types(fs), "sketch,sketch,sweep,delbody", `inner ${inner}`);
    close(vol(m, { ...imp, features: [...imp.features, ...fs] }), v0, 1e-5);
  }
});

test("recognize features: a bent bar of any line/arc profile comes back as a Sweep (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const path: SketchFeature = { id: "pt", type: "sketch", name: "pt", plane: { std: "XZ" }, rels: [], dims: [], ents: [
    { id: "q1", t: "point", x: 0, y: 0 }, { id: "q2", t: "point", x: 0, y: 40 }, { id: "q3", t: "point", x: 20, y: 60 }, { id: "q4", t: "point", x: 60, y: 60 }, { id: "qc", t: "point", x: 20, y: 40 },
    { id: "w1", t: "line", a: "q1", b: "q2" }, { id: "w2", t: "arc", c: "qc", a: "q3", b: "q2" } as SkEnt, { id: "w3", t: "line", a: "q3", b: "q4" }] };
  const poly = (pts: [number, number][]): SkEnt[] => [
    ...pts.map(([x, y], k) => ({ id: `r${k}`, t: "point", x, y }) as SkEnt),
    ...pts.map((_, k) => ({ id: `l${k}`, t: "line", a: `r${k}`, b: `r${(k + 1) % pts.length}` }) as SkEnt)];
  // An obround: two lines and two half circles (the bends make tori).
  const slot: SkEnt[] = [
    { id: "s1", t: "point", x: -6, y: -3 }, { id: "s2", t: "point", x: 6, y: -3 }, { id: "s3", t: "point", x: 6, y: 3 }, { id: "s4", t: "point", x: -6, y: 3 },
    { id: "c1", t: "point", x: 6, y: 0 }, { id: "c2", t: "point", x: -6, y: 0 },
    { id: "m1", t: "line", a: "s1", b: "s2" }, { id: "m2", t: "arc", c: "c1", a: "s2", b: "s3" } as SkEnt, { id: "m3", t: "line", a: "s3", b: "s4" }, { id: "m4", t: "arc", c: "c2", a: "s4", b: "s1" } as SkEnt];
  // A square on its corner (the bends make cones), and a flat bar, which is an L-shaped extrude with two fillets.
  const cases: [string, SkEnt[], string][] = [
    ["obround", slot, "sketch,sketch,sweep,delbody"],
    ["diamond", poly([[0, -5], [5, 0], [0, 5], [-5, 0]]), "sketch,sketch,sweep,delbody"],
    ["flat bar", poly([[-2, -8], [2, -8], [2, 8], [-2, 8]]), "sketch,extrude,delbody,sketch,extrude,fillet,fillet"]];
  for (const [name, ents, want] of cases) {
    const prof: SketchFeature = { id: "pr", type: "sketch", name: "pr", plane: { std: "XY" }, rels: [], dims: [], ents };
    const imp = imported(m, [path, prof, { id: "sw", type: "sweep", name: "S", op: "boss", profile: "pr", path: { sketch: "pt" } } as Feature]);
    const v0 = vol(m, imp);
    const fs = m.recognizeFeatures(imp);
    assert.equal(types(fs), want, name);
    close(vol(m, { ...imp, features: [...imp.features, ...fs] }), v0, 1e-5);
  }
});

test("recognize features: a lofted body comes back as a Loft between its end faces (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const top = { id: "pl", type: "plane", name: "P", base: { std: "XY" }, mode: "offset", offset: { v: 30 } } as Feature;
  const poly = (pre: string, pts: [number, number][]): SkEnt[] => [
    ...pts.map(([x, y], k) => ({ id: `${pre}p${k}`, t: "point", x, y }) as SkEnt),
    ...pts.map((_, k) => ({ id: `${pre}l${k}`, t: "line", a: `${pre}p${k}`, b: `${pre}p${(k + 1) % pts.length}` }) as SkEnt)];
  const circle: SkEnt[] = [{ id: "cc", t: "point", x: 2, y: 1 }, { id: "ci", t: "circle", c: "cc", r: 6 } as SkEnt];
  const rect = poly("a", [[-10, -6], [10, -6], [10, 6], [-10, 6]]);
  const cases: [string, SkEnt[], SkEnt[], string[]][] = [
    ["rectangle to circle", rect, circle, []],
    ["square to a turned smaller square", poly("a", [[-8, -8], [8, -8], [8, 8], [-8, 8]]), poly("b", [[0, -5], [5, 0], [0, 5], [-5, 0]]), ["ap0", "bp0"]]];
  for (const [name, a, b, con] of cases) {
    const s1: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [], ents: a };
    const s2: SketchFeature = { id: "s2", type: "sketch", name: "s2", plane: { plane: "pl" }, rels: [], dims: [], ents: b };
    const imp = imported(m, [top, s1, s2, { id: "lf", type: "loft", name: "L", op: "boss", profiles: ["s1", "s2"], ...(con.length ? { connectors: con } : {}) } as Feature]);
    const v0 = vol(m, imp);
    const fs = m.recognizeFeatures(imp);
    assert.equal(types(fs), "sketch,sketch,loft,delbody", name);
    close(vol(m, { ...imp, features: [...imp.features, ...fs] }), v0, 1e-5);
  }
});

test("recognize features: a coil spring comes back as a circle sketch, a Helix and a circular Sweep (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const lift = { id: "pl", type: "plane", name: "P", base: { std: "XY" }, mode: "offset", offset: { v: 8 } } as Feature;
  const cases: [string, Feature[], Record<string, unknown>, string][] = [
    ["right-handed, from a plane 8 mm up", [lift], { plane: "pl" }, "plane,sketch,helix,sweep,delbody"],
    ["left-handed about X, reversed, starting at 1 rad", [], { std: "YZ" }, "sketch,helix,sweep,delbody"],
    // Skew axes: tilted 30° about X, 6 mm up from that plane; a compound angle (25° about Z, then 40° about where it meets XY).
    ["tilted in a standard plane", [{ id: "t1", type: "plane", name: "T", base: { std: "XY" }, mode: "angle", offset: { v: 0 }, angle: { v: Math.PI / 6 }, about: { std: "X" } } as Feature,
      { id: "t2", type: "plane", name: "U", base: { plane: "t1" }, mode: "offset", offset: { v: 6 } } as Feature], { plane: "t2" }, "plane,plane,sketch,helix,sweep,delbody"],
    ["at a compound angle", [{ id: "q1", type: "plane", name: "Q", base: { std: "YZ" }, mode: "angle", offset: { v: 0 }, angle: { v: (25 * Math.PI) / 180 }, about: { std: "Z" } } as Feature,
      { id: "qa", type: "axis", name: "A", mode: "planes", planes: [{ std: "XY" }, { plane: "q1" }] } as Feature,
      { id: "q2", type: "plane", name: "R", base: { plane: "q1" }, mode: "angle", offset: { v: 0 }, angle: { v: (40 * Math.PI) / 180 }, about: { axis: "qa" } } as Feature], { plane: "q2" }, "plane,axis,plane,sketch,helix,sweep,delbody"]];
  for (const [name, lead, plane, want] of cases) {
    const left = "std" in plane || name.startsWith("at a");
    const s1: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: plane as SketchFeature["plane"], rels: [], dims: [], ents: [{ id: "c", t: "point", x: 3, y: 2 }, { id: "k", t: "circle", c: "c", r: 10 } as SkEnt] };
    const hx = { id: "h1", type: "helix", name: "H", sketch: "s1", mode: "pitchRev", pitch: { v: 5 }, revs: { v: 3.5 }, height: { v: 15 }, ...(left ? { cw: true, reverse: true, start: { v: 1 } } : {}) } as Feature;
    const imp = imported(m, [...lead, s1, hx, { id: "w1", type: "sweep", name: "S", op: "boss", circular: { v: 2 }, path: { helix: "h1" } } as Feature]);
    const v0 = vol(m, imp);
    const fs = m.recognizeFeatures(imp);
    assert.equal(types(fs), want, name);
    const h = fs.find(f => f.type === "helix") as Feature & { pitch: { v: number }; revs: { v: number }; cw?: boolean };
    assert.equal(h.pitch.v, 5, name);
    assert.equal(h.revs.v, 3.5, name);
    assert.equal(!!h.cw, left, name);
    close(vol(m, { ...imp, features: [...imp.features, ...fs] }), v0, 1e-6);
  }
});
