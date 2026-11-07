// Assemblies (FRS 10, P4): placing parts, shared sources, files and transforms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { occ } from "./occ";
import { Assembler } from "../../src/kernel/assembly";
import { packAsm, unpackAsm } from "../../src/asm/file";
import { IDENTITY, applyPoint, compose, eulerXYZ, fromPose, invert, rotation, translation } from "../../src/asm/math";
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
