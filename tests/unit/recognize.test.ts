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

const on = (sk: SketchFeature, face: string): SketchFeature => ({ ...sk, plane: { face: { name: face } } });
const cut = (id: string, sketch: string, depth: number, end: "blind" | "through" = "blind"): Feature => ({ id, type: "extrude", name: id, sketch, op: "cut", end, depth: { v: depth } }) as Feature;
const boss = (id: string, sketch: string, depth: number): Feature => ({ id, type: "extrude", name: id, sketch, op: "boss", end: "blind", depth: { v: depth } }) as Feature;

test("feature recognition: a pocket, a through cut and a boss come back as extrudes (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  // A rounded pocket: rectangle 20 × 10 with its corners filleted in the sketch is not needed; a slot shape does.
  const slot: SketchFeature = { id: "k", type: "sketch", name: "k", plane: { face: { name: "e:end" } }, rels: [], dims: [], ents: [
    { id: "ka", t: "point", x: -22, y: 4 }, { id: "kb", t: "point", x: -12, y: 4 }, { id: "kc", t: "point", x: -12, y: 12 }, { id: "kd", t: "point", x: -22, y: 12 },
    { id: "k1", t: "point", x: -12, y: 8 }, { id: "k2", t: "point", x: -22, y: 8 },
    { id: "kl1", t: "line", a: "ka", b: "kb" }, { id: "kl2", t: "line", a: "kc", b: "kd" },
    { id: "ka1", t: "arc", c: "k1", a: "kb", b: "kc" }, { id: "ka2", t: "arc", c: "k2", a: "kd", b: "ka" }] as SkEnt[] };
  const sq = on(rect("q", 10, 8), "e:end"), bs = on(rect("b", 12, 6), "e:end");
  bs.ents = bs.ents.map(e => e.t === "point" ? { ...e, x: e.x + 18, y: e.y - 10 } : e);
  const src = [...base(), slot, cut("c1", "k", 5), sq, cut("c2", "q", 10, "through"), bs, boss("b1", "b", 7)];
  const imp = imported(m, src);
  const v0 = vol(m, imp);
  const feats = m.recognizeExtrudes(imp, false);
  assert.equal(feats.map(f => f.type).join(), "delface,sketch,extrude,sketch,extrude,sketch,extrude");
  const ex = feats.filter(f => f.type === "extrude") as any[];
  assert.deepEqual(ex.map(f => `${f.op}:${f.end}`).sort(), ["boss:blind", "cut:blind", "cut:through"]);
  close(ex.find(f => f.op === "boss").depth.v, 7);
  close(ex.find(f => f.op === "cut" && f.end === "blind").depth.v, 5);
  const sl = feats.find(f => f.type === "sketch" && (f as SketchFeature).ents.some(e => e.t === "arc")) as SketchFeature;
  assert.equal(sl.ents.filter(e => e.t === "arc").length, 2);
  close(vol(m, doc([...imp.features, feats[0]])), 60 * 40 * 20);
  close(vol(m, doc([...imp.features, ...feats])), v0);
  // Editable: a deeper pocket takes more away.
  const deeper = feats.map(f => f.type === "extrude" && (f as any).op === "cut" && (f as any).end === "blind" ? { ...f, depth: { v: 8 } } as Feature : f);
  assert.ok(vol(m, doc([...imp.features, ...deeper])) < v0 - 1);
});

test("feature recognition: round holes and plain blocks give no extrudes (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  assert.equal(m.recognizeExtrudes(imported(m, base()), false).length, 0);
  const circle: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { face: { name: "e:end" } }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 5, y: 5 }, { id: "ok", t: "circle", c: "oc", r: 4 } as SkEnt] };
  assert.equal(m.recognizeExtrudes(imported(m, [...base(), circle, cut("c", "o", 6)]), false).length, 0);
  // A round boss is an extrude.
  const up = m.recognizeExtrudes(imported(m, [...base(), circle, boss("b", "o", 6)]), false);
  assert.equal(up.map(f => f.type).join(), "delface,sketch,extrude");
  assert.ok((up[1] as SketchFeature).ents.some(e => e.t === "circle" && Math.abs(e.r - 4) < 1e-9));
});

test("feature recognition: a pocket in the floor of a pocket and a hole-shaped cut in a boss come back in order (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const outer = on(rect("q", 30, 20), "e:end"), inner = { ...rect("r", 10, 6), plane: { face: { name: "c1:end" } } } as SketchFeature;
  const bs = on(rect("b", 12, 6), "e:end");
  bs.ents = bs.ents.map(e => e.t === "point" ? { ...e, x: e.x + 22, y: e.y } : e);
  const stepped = imported(m, [...base(), outer, cut("c1", "q", 6), inner, cut("c2", "r", 4)]);
  const v0 = vol(m, stepped);
  close(v0, 60 * 40 * 20 - 30 * 20 * 6 - 10 * 6 * 4);
  const feats = m.recognizeExtrudes(stepped, false);
  assert.equal(feats.map(f => f.type).join(), "delface,delface,sketch,extrude,sketch,extrude");
  const ex = feats.filter(f => f.type === "extrude") as any[];
  close(ex[0].depth.v, 6); close(ex[1].depth.v, 4);
  close(vol(m, doc([...stepped.features, feats[0], feats[1]])), 60 * 40 * 20);
  close(vol(m, doc([...stepped.features, ...feats])), v0);
  // A boss with a square pocket in its top: the pocket comes off first and goes back on last.
  const top = { ...rect("t", 4, 3), plane: { face: { name: "b1:end" } } } as SketchFeature;
  top.ents = top.ents.map(e => e.t === "point" ? { ...e, x: e.x + 22, y: e.y } : e);
  const bossed = imported(m, [...base(), bs, boss("b1", "b", 7), top, cut("c3", "t", 5)]);
  const v1 = vol(m, bossed);
  const fb = m.recognizeExtrudes(bossed, false);
  assert.equal(fb.map(f => f.type === "extrude" ? (f as any).op : f.type).join(), "delface,delface,sketch,boss,sketch,cut");
  close(vol(m, doc([...bossed.features, ...fb])), v1);
});

test("feature recognition: a step and a slot open to the side come back as blind cuts (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  // A slot across the top, open at both ends.
  const across = on(rect("q", 12, 60), "e:end");
  const slotted = imported(m, [...base(), across, cut("c1", "q", 5)]);
  const v0 = vol(m, slotted);
  close(v0, 60 * 40 * 20 - 12 * 40 * 5);
  const fs = m.recognizeExtrudes(slotted, false);
  assert.equal(fs.map(f => f.type === "extrude" ? `${(f as any).op}:${(f as any).end}` : f.type).join(), "delface,sketch,cut:blind");
  close((fs[2] as any).depth.v, 5);
  close(vol(m, doc([...slotted.features, fs[0]])), 60 * 40 * 20);
  close(vol(m, doc([...slotted.features, ...fs])), v0);
  // A notch at one edge, with a round inner end.
  const notch: SketchFeature = { id: "k", type: "sketch", name: "k", plane: { face: { name: "e:end" } }, rels: [], dims: [], ents: [
    { id: "ka", t: "point", x: 10, y: -4 }, { id: "kb", t: "point", x: 40, y: -4 }, { id: "kc", t: "point", x: 40, y: 4 }, { id: "kd", t: "point", x: 10, y: 4 },
    { id: "k0", t: "point", x: 10, y: 0 },
    { id: "kl1", t: "line", a: "ka", b: "kb" }, { id: "kl2", t: "line", a: "kb", b: "kc" }, { id: "kl3", t: "line", a: "kc", b: "kd" },
    { id: "ka1", t: "arc", c: "k0", a: "kd", b: "ka" }] as SkEnt[] };
  const notched = imported(m, [...base(), notch, cut("c2", "k", 7)]);
  const v1 = vol(m, notched);
  const fn = m.recognizeExtrudes(notched, false);
  assert.equal(fn.map(f => f.type).join(), "delface,sketch,extrude");
  close((fn[2] as any).depth.v, 7);
  assert.equal((fn[1] as SketchFeature).ents.filter(e => e.t === "arc").length, 1);
  close(vol(m, doc([...notched.features, fn[0]])), 60 * 40 * 20);
  close(vol(m, doc([...notched.features, ...fn])), v1);
});

test("feature recognition: notches cut right through at an edge come back as through cuts (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  const types = (fs: Feature[]) => fs.map(f => f.type === "extrude" ? `${(f as any).op}:${(f as any).end}` : f.type).join();
  const moved = (sk: SketchFeature, dx: number, dy: number) => ({ ...sk, ents: sk.ents.map(e => e.t === "point" ? { ...e, x: e.x + dx, y: e.y + dy } : e) }) as SketchFeature;
  // A square notch in the middle of one side.
  const notched = imported(m, [...base(), moved(on(rect("q", 10, 12), "e:end"), 0, 20), cut("c1", "q", 30, "through")]);
  const v0 = vol(m, notched);
  close(v0, 60 * 40 * 20 - 10 * 6 * 20);
  const fs = m.recognizeExtrudes(notched, false);
  assert.equal(types(fs), "delface,sketch,cut:through");
  close(vol(m, doc([...notched.features, fs[0]])), 60 * 40 * 20);
  close(vol(m, doc([...notched.features, ...fs])), v0);
  // A corner cut away: the sketch closes at the corner the sides would meet in.
  const corner = imported(m, [...base(), moved(on(rect("q", 20, 20), "e:end"), 30, 20), cut("c1", "q", 30, "through")]);
  const v1 = vol(m, corner);
  close(v1, 60 * 40 * 20 - 10 * 10 * 20);
  const fc = m.recognizeExtrudes(corner, false);
  assert.equal(types(fc), "delface,sketch,cut:through");
  assert.equal((fc[1] as SketchFeature).ents.filter(e => e.t === "line").length, 4);
  close(vol(m, doc([...corner.features, fc[0]])), 60 * 40 * 20);
  close(vol(m, doc([...corner.features, ...fc])), v1);
  // A half-round notch.
  const round: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { face: { name: "e:end" } }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 0, y: 20 }, { id: "ok", t: "circle", c: "oc", r: 6 } as SkEnt] };
  const scooped = imported(m, [...base(), round, cut("c1", "o", 30, "through")]);
  const v2 = vol(m, scooped);
  const fr = m.recognizeExtrudes(scooped, false);
  assert.equal(types(fr), "delface,sketch,cut:through");
  assert.equal((fr[1] as SketchFeature).ents.filter(e => e.t === "arc").length, 1);
  close(vol(m, doc([...scooped.features, ...fr])), v2);
});

test("feature recognition: the base of an imported prism comes back as a sketch with an extrude (FR-FT-102)", async () => {
  const m = new Modeller(await occ());
  // A plain block: one sketch, one extrude as a new body, and the imported body deleted.
  const block = imported(m, base());
  const fb = m.recognizeExtrudes(block);
  assert.equal(fb.map(f => f.type).join(), "sketch,extrude,delbody");
  assert.equal((fb[0] as SketchFeature).ents.filter(e => e.t === "line").length, 4);
  assert.equal((fb[1] as any).merge, false);
  const rb = m.evaluate(doc([...block.features, ...fb]));
  assert.deepEqual(rb.statuses.filter(s => !s.ok), []);
  assert.equal(m.props(rb.body!).bodies, 1);
  close(m.props(rb.body!).volume, 60 * 40 * 20);
  // Editable: the block's depth is the new extrude's.
  close(vol(m, doc([...block.features, ...fb.map(f => f.type === "extrude" ? { ...f, depth: { v: 10 } } as Feature : f)])), 60 * 40 * 10);
  // With a pocket, a round hole and a notch: no Delete Face, the finds go on the new body.
  const pocket = on(rect("q", 20, 10), "e:end");
  const hole: SketchFeature = { id: "o", type: "sketch", name: "o", plane: { face: { name: "e:end" } }, rels: [], dims: [],
    ents: [{ id: "oc", t: "point", x: 20, y: 10 }, { id: "ok", t: "circle", c: "oc", r: 4 } as SkEnt] };
  const notch = on(rect("n", 10, 12), "e:end");
  notch.ents = notch.ents.map(e => e.t === "point" ? { ...e, x: e.x, y: e.y + 20 } : e);
  const part = imported(m, [...base(), pocket, cut("c1", "q", 5), hole, cut("c2", "o", 10, "through"), notch, cut("c3", "n", 10, "through")]);
  const v0 = vol(m, part);
  const fp = m.recognizeExtrudes(part);
  assert.equal(fp.slice(0, 3).map(f => f.type).join(), "sketch,extrude,delbody");
  assert.ok(!fp.some(f => f.type === "delface"));
  // The round hole stays in the base sketch as a circle.
  assert.equal((fp[0] as SketchFeature).ents.filter(e => e.t === "circle").length, 1);
  assert.deepEqual((fp.filter(f => f.type === "extrude") as any[]).slice(1).map(f => `${f.op}:${f.end}`).sort(), ["cut:blind", "cut:through"]);
  const rp = m.evaluate(doc([...part.features, ...fp]));
  assert.deepEqual(rp.statuses.filter(s => !s.ok), []);
  assert.equal(m.props(rp.body!).bodies, 1);
  close(m.props(rp.body!).volume, v0);
  // A chamfer along one edge still leaves a prism (seen from the side); chamfers along two directions do not,
  // and such a body keeps the Delete Face way.
  const ch = (id: string, k: number) => ({ id, type: "chamfer", name: id, distance: { v: 3 }, edges: [{ faces: ["e:end", S(k)] }] }) as Feature;
  const one = imported(m, [...base(), ch("h1", 1), pocket, cut("c1", "q", 5)]);
  const f1 = m.recognizeExtrudes(one);
  assert.equal(f1.map(f => f.type).join(), "sketch,extrude,delbody,sketch,extrude");
  assert.equal((f1[0] as SketchFeature).ents.filter(e => e.t === "line").length, 5);
  close(vol(m, doc([...one.features, ...f1])), vol(m, one));
  const odd = imported(m, [...base(), ch("h1", 1), ch("h2", 2), pocket, cut("c1", "q", 5)]);
  assert.equal(m.recognizeExtrudes(odd).map(f => f.type).join(), "delface,sketch,extrude");
});
