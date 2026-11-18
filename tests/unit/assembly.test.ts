// Assemblies (FRS 10, P4): placing parts, shared sources, files and transforms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { occ } from "./occ";
import { Assembler } from "../../src/kernel/assembly";
import { packAsm, unpackAsm } from "../../src/asm/file";
import { activateConfig, addConfig, deleteConfig, partUsed } from "../../src/asm/configs";
import { IDENTITY, applyPoint, compose, eulerXYZ, fromPose, invert, poseAngles, rotation, translation } from "../../src/asm/math";
import type { AsmDoc } from "../../src/asm/types";
import type { Feature, PartDoc } from "../../src/model/types";

const box = (name: string, w: number, h: number, d: number): PartDoc => ({
  schema: 1, kind: "part", id: `d_${name}`, name, units: { length: "mm", decimals: 2 }, props: {}, rollback: null,
  features: [
    { id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [
      { id: "a", t: "point", x: 0, y: 0 }, { id: "b", t: "point", x: w, y: 0 }, { id: "c", t: "point", x: w, y: h }, { id: "d", t: "point", x: 0, y: h },
      { id: "l1", t: "line", a: "a", b: "b" }, { id: "l2", t: "line", a: "b", b: "c" }, { id: "l3", t: "line", a: "c", b: "d" }, { id: "l4", t: "line", a: "d", b: "a" }] },
    { id: "x", type: "extrude", name: "Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: d } },
  ] as Feature[],
});

const asm = (): AsmDoc => ({
  schema: 1, kind: "assembly", id: "a1", name: "Asm1", units: { length: "mm", decimals: 2 },
  parts: { plate: { name: "Plate", file: "Plate.mcadprt", doc: box("Plate", 40, 20, 5) }, block: { name: "Block", file: "Block.mcadprt", doc: box("Block", 10, 10, 10) } },
  components: [
    { id: "c1", name: "Plate<1>", part: "plate", tf: IDENTITY, fixed: true },
    { id: "c2", name: "Block<1>", part: "block", tf: translation([0, 0, 5]) },
    { id: "c3", name: "Block<2>", part: "block", tf: compose(translation([30, 10, 5]), rotation([0, 0, 0], [0, 0, 1], Math.PI / 2)) },
  ],
});

test("transforms: compose, invert, pose round trip", () => {
  const t = compose(translation([1, 2, 3]), rotation([0, 0, 0], [0, 0, 1], Math.PI / 2));
  const p = applyPoint(t, [1, 0, 0]);
  assert.ok(Math.hypot(p[0] - 1, p[1] - 3, p[2] - 3) < 1e-12);
  const back = applyPoint(invert(t), p);
  assert.ok(Math.hypot(back[0] - 1, back[1], back[2]) < 1e-12);
  const pose = fromPose([5, 6, 7], [10, 20, 30]);
  const e = eulerXYZ(pose);
  assert.ok(Math.abs(e[0] - 10) < 1e-9 && Math.abs(e[1] - 20) < 1e-9 && Math.abs(e[2] - 30) < 1e-9, String(e));
});

test("Move panel angles: typed X turn kept at ±90° about Y (bug: it was read back as 0)", () => {
  const typed: [number, number, number] = [60, -90, 90];
  const tf = fromPose([1, 2, 3], typed);
  assert.equal(eulerXYZ(tf)[0], 0); // what the panel used to show
  assert.deepEqual(poseAngles(tf, typed), typed);
  // a changed rotation (a drag or a mate) drops the typed angles
  const other = fromPose([1, 2, 3], [0, 30, 0]);
  assert.ok(Math.abs(poseAngles(other, typed)[1] - 30) < 1e-9);
  // typing Z after that keeps the X turn: the rotation still matches [60, -90, 90 + 15]
  const next = fromPose([1, 2, 3], [60, -90, 105]);
  assert.notDeepEqual(next.slice(0, 11), tf.slice(0, 11));
});

test("assembly: components place their parts; one source per part; mass properties add up", async () => {
  const a = new Assembler(await occ());
  const doc = asm();
  const { placed, statuses } = a.evaluate(doc);
  assert.ok(statuses.every(s => s.ok));
  assert.equal(placed.length, 3);
  const pr = a.props(placed)!;
  assert.ok(Math.abs(pr.volume - (4000 + 2000)) < 1e-6, String(pr.volume));
  // Plate centre (20,10,2.5)×4000; blocks at (5,5,10) and, turned 90° about Z then moved, (25,15,10).
  const want = [(20 * 4000 + 5 * 1000 + 25 * 1000) / 6000, (10 * 4000 + 5 * 1000 + 15 * 1000) / 6000, (2.5 * 4000 + 10 * 2000) / 6000];
  assert.ok(Math.hypot(pr.com[0] - want[0], pr.com[1] - want[1], pr.com[2] - want[2]) < 1e-6, JSON.stringify(pr.com));
  // The mesh follows the transform.
  const m = placed[2].mesh(), P = m.attributes.position.array;
  let minX = Infinity;
  for (let i = 0; i < P.length; i += 3) minX = Math.min(minX, P[i]);
  assert.ok(Math.abs(minX - 20) < 1e-6, String(minX));
  // Suppressed components drop out; a broken part reports its error.
  doc.components[1].suppressed = true;
  doc.parts.block.doc.features[1] = { ...doc.parts.block.doc.features[1], sketch: "nope" } as Feature;
  const r = a.evaluate(doc);
  assert.equal(r.placed.length, 1);
  assert.equal(r.statuses.find(s => s.id === "c3")!.ok, false);
});

test("assembly files: save and open give the same document", async () => {
  const doc = asm();
  const back = await unpackAsm((await packAsm(doc, "test")).buffer as ArrayBuffer);
  assert.deepEqual(back, JSON.parse(JSON.stringify(doc)));
  const bad = { ...doc, components: [{ ...doc.components[0], part: "missing" }] };
  await assert.rejects(unpackAsm((await packAsm(bad, "test")).buffer as ArrayBuffer), /damaged/);
});

test("AT-P4-4: interference finds a 1 mm overlap with the right volume; touching is not interference", async () => {
  const a = new Assembler(await occ());
  const d = asm();
  // Block<1> sits on the plate (touching); Block<2> sinks 1 mm into it.
  d.components[2].tf = translation([25, 5, 4]);
  const { placed } = a.evaluate(d);
  const pairs = a.interference(placed);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a, pairs[0].b], ["c1", "c3"]);
  assert.ok(Math.abs(pairs[0].volume - 100) < 1e-6, String(pairs[0].volume));
  assert.ok(pairs[0].position.length >= 36 * 3);
  const touching = a.interference(placed, true);
  assert.equal(touching.length, 2);
});

test("a round-off sliver between coincident faces is touching, not interference (exam #83)", async () => {
  const a = new Assembler(await occ());
  const d = asm();
  // Block<2> sits 2e-5 mm into the plate: 0.002 mm³ of overlap, 2e-5 mm thick.
  d.components[2].tf = translation([25, 5, 5 - 2e-5]);
  const { placed } = a.evaluate(d);
  assert.equal(a.interference(placed).length, 0);
  assert.equal(a.interference(placed, true).length, 2);
  // 0.01 mm in is still interference.
  d.components[2].tf = translation([25, 5, 5 - 0.01]);
  const pairs = a.interference(a.evaluate(d).placed);
  assert.equal(pairs.length, 1);
  assert.ok(Math.abs(pairs[0].volume - 1) < 1e-6, String(pairs[0].volume));
});

test("FR-ASM-031: instances share one analysis of their part, moved rigidly", async () => {
  const { analyzeMesh } = await import("../../src/topology");
  const { transformPart } = await import("../../src/asm/light");
  const a = new Assembler(await occ());
  const { placed } = a.evaluate(asm());
  // The two blocks share a source; the second is turned 90° about Z and moved.
  assert.equal(placed[1].src, placed[2].src);
  const first = analyzeMesh(placed[1].mesh() as never), direct = analyzeMesh(placed[2].mesh() as never);
  const shared = transformPart(transformPart(first, invert(placed[1].tf)), placed[2].tf);
  const near = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4;
  assert.ok(near(shared.bboxMin, direct.bboxMin) && near(shared.bboxMax, direct.bboxMax), JSON.stringify([shared.bboxMin, direct.bboxMin]));
  assert.equal(shared.faces.length, direct.faces.length);
  assert.equal(shared.edges.length, direct.edges.length);
  shared.faces.forEach((f, i) => {
    const g = direct.faces[i];
    assert.equal(f.type, g.type);
    assert.ok(near(f.centroid, g.centroid) && Math.abs(f.area - g.area) < 1e-6, `face ${i}`);
    if (f.normal) assert.ok(near(f.normal, g.normal!), `normal ${i}`);
  });
  shared.edges.forEach((e, i) => assert.ok(near(e.mid, direct.edges[i].mid) && Math.abs(e.length - direct.edges[i].length) < 1e-6, `edge ${i}`));
  assert.ok(Math.abs(shared.volume - direct.volume) < 1e-6 && near(shared.com, direct.com));
});

test("FR-ASM-021: clearance check lists pairs closer than the minimum with their nearest points", async () => {
  const a = new Assembler(await occ());
  const doc = asm();
  const { placed } = a.evaluate(doc);
  const all = a.clearance(placed, 1000);
  assert.ok(all.length >= 1);
  assert.ok(all.every((p, i) => i === 0 || p.distance >= all[i - 1].distance));
  for (const p of all) assert.ok(Math.abs(Math.hypot(p.p1[0] - p.p2[0], p.p1[1] - p.p2[1], p.p1[2] - p.p2[2]) - p.distance) < 1e-6);
  assert.equal(a.clearance(placed, 1e-9).filter(p => p.distance > 1e-6).length, 0);
  // The two blocks stand 10 mm apart (x 0..10 and 20..30): in at 12 mm, out at 9 mm.
  const gap = (min: number) => a.clearance(placed, min).find(p => p.a === "c2" && p.b === "c3");
  assert.ok(Math.abs((gap(12)?.distance ?? -1) - 10) < 1e-6, JSON.stringify(gap(12)));
  assert.equal(gap(9), undefined);
});

test("FR-ASM-027: an assembly hole through all cuts every component it reaches; a cut extrude only those in scope", async () => {
  const a = new Assembler(await occ());
  // Block<1> (10 × 10 × 10) stands on the plate (40 × 20 × 5) at the origin; Block<2> is elsewhere.
  const doc = asm();
  doc.features = [{ id: "af1", name: "Hole1", type: "hole", ref: { comp: "c2", face: "x:end" }, at: [5, 5, 10], n: [0, 0, 1], x: [1, 0, 0], dia: 4 }];
  const vol = (d: AsmDoc) => { const r = a.evaluate(d); return Object.fromEntries(r.placed.map(p => [p.id, a.props([p])!.volume])); };
  const v = vol(doc);
  const hole = Math.PI * 4;
  assert.ok(Math.abs(v.c2 - (1000 - hole * 10)) < 1e-6, String(v.c2));
  assert.ok(Math.abs(v.c1 - (4000 - hole * 5)) < 1e-6, String(v.c1));
  assert.ok(Math.abs(v.c3 - 1000) < 1e-9, String(v.c3));
  assert.deepEqual(a.featureStatus, [{ id: "af1", ok: true, cut: ["c1", "c2"], message: undefined }]);
  // The hole's wall is a named face of the cut components (so it can be mated to).
  const placed = a.evaluate(doc).placed;
  assert.ok(placed.find(p => p.id === "c1")!.body.names.some(n => n.startsWith("af1:t")));
  // A 6 mm deep 4 × 2 cut from the block's top (z = 15) stops above the plate (z = 5): only the block is cut.
  doc.features = [{ id: "af2", name: "Cut1", type: "cut", ref: { comp: "c2", face: "x:end" }, at: [5, 5, 10], n: [0, 0, 1], x: [1, 0, 0], w: 4, h: 2, depth: 6, comps: ["c2", "c1"] }];
  const w = vol(doc);
  assert.ok(Math.abs(w.c2 - (1000 - 48)) < 1e-6 && Math.abs(w.c1 - 4000) < 1e-9, JSON.stringify(w));
  assert.deepEqual(a.featureStatus[0].cut, ["c2"]);
  // Scoped to the plate alone, that cut reaches nothing: the feature reports it.
  doc.features[0].comps = ["c1"];
  vol(doc);
  assert.equal(a.featureStatus[0].ok, false);
});

test("FR-ASM-026: assembly configurations swap suppression, part entries, mate values and feature suppression", () => {
  const doc = asm();
  doc.parts.block2 = { ...doc.parts.block, doc: { ...doc.parts.block.doc, id: "d_block2" } };
  doc.mates = [{ id: "m1", name: "Distance1", type: "distance", a: { comp: "c1", face: "x:end" }, b: { comp: "c2", face: "x:start" }, value: 0 }];
  doc.features = [{ id: "af1", name: "Hole1", type: "hole", ref: { comp: "c1", face: "x:end" }, at: [5, 5, 5], n: [0, 0, 1], x: [1, 0, 0], dia: 2 }];
  const id = addConfig(doc, "Long", "cf_long");
  assert.equal(doc.configs?.length, 2);
  assert.equal(doc.activeConfig, id);
  // In "Long": block 2 suppressed, block 1 uses the other part entry, the mate 5 mm, the hole off.
  doc.components[2].suppressed = true;
  doc.components[1].part = "block2";
  doc.mates[0].value = 5;
  doc.features[0].suppressed = true;
  activateConfig(doc, "cf_default");
  assert.ok(!doc.components[2].suppressed && doc.components[1].part === "block" && doc.mates[0].value === 0 && !doc.features[0].suppressed);
  // block2 is still needed by "Long", so it must not be dropped as unused.
  assert.ok(partUsed(doc, "block2"));
  activateConfig(doc, "cf_long");
  assert.ok(doc.components[2].suppressed && doc.components[1].part === "block2" && doc.mates[0].value === 5 && doc.features[0].suppressed);
  // Deleting the active one goes back to Default; the last one cannot go.
  assert.ok(deleteConfig(doc, "cf_long"));
  assert.equal(doc.activeConfig, "cf_default");
  assert.equal(doc.components[1].part, "block");
  assert.ok(!partUsed(doc, "block2"));
  assert.ok(!deleteConfig(doc, "cf_default"));
});
