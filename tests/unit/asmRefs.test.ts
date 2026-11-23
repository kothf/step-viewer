// Assemblies that reference their part files: save beside, read the latest, missing files, old embedded files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMoved, memDir, resolveRefs, writeRefs, type RefBase } from "../../src/asm/refs";
import { packPart, unpackPart } from "../../src/model/file";
import { unpackAsm } from "../../src/asm/file";
import { newPart } from "../../src/model/doc";
import { IDENTITY } from "../../src/asm/math";
import type { AsmDoc } from "../../src/asm/types";

const APP = "test";
const part = (name: string) => { const p = newPart(name); p.id = `id-${name}`; return p; };
const asmOf = (names: string[], id = "asm"): AsmDoc => ({
  schema: 1, kind: "assembly", id, name: id, units: { length: "mm", decimals: 2 },
  parts: Object.fromEntries(names.map(n => [`k_${n}`, { name: n, file: `${n}.mcadprt`, doc: part(n) }])),
  components: names.map(n => ({ id: `c_${n}`, name: `${n}<1>`, part: `k_${n}`, tf: IDENTITY })),
} as AsmDoc);
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

test("an old embedded assembly saves its parts beside it and references them", async () => {
  const dir = memDir(), base: RefBase = new Map();
  const r = await writeRefs(asmOf(["Plate", "Pin"]), dir, base, APP, "", "A.mcadasm");
  assert.deepEqual([...dir.files.keys()].sort(), ["Pin.mcadprt", "Plate.mcadprt"]);
  assert.equal(r.doc.parts.k_Plate.link?.path, "Plate.mcadprt");
  assert.ok(r.doc.parts.k_Plate.link?.hash.length === 64);
  assert.equal((await unpackPart(buf(dir.files.get("Pin.mcadprt")!))).id, "id-Pin");
  // nothing changed: a second save writes nothing
  const again = await writeRefs(r.doc, dir, base, APP, "", "A.mcadasm");
  assert.deepEqual(again.written, []);
});

test("a part edited in its own file comes into the assembly on open", async () => {
  const dir = memDir();
  const saved = (await writeRefs(asmOf(["Plate"]), dir, new Map(), APP)).doc;
  const edited = part("Plate");
  edited.props = { material: "edited" } as never;
  dir.files.set("Plate.mcadprt", await packPart(edited, APP));
  const r = await resolveRefs(saved, dir, new Map());
  assert.deepEqual(r.updated, ["Plate"]);
  assert.deepEqual(r.doc.parts.k_Plate.doc.props, { material: "edited" });
  assert.notEqual(r.doc.parts.k_Plate.link!.hash, saved.parts.k_Plate.link!.hash);
  assert.deepEqual(saved.parts.k_Plate.doc.props, {}, "the input is not changed");
  // read again: nothing new
  assert.deepEqual((await resolveRefs(r.doc, dir, new Map())).updated, []);
});

test("a missing file keeps the copy and is reported", async () => {
  const dir = memDir();
  const saved = (await writeRefs(asmOf(["Plate", "Pin"]), dir, new Map(), APP)).doc;
  dir.files.delete("Pin.mcadprt");
  const r = await resolveRefs(saved, dir, new Map());
  assert.deepEqual(r.missing, ["k_Pin"]);
  assert.equal(r.doc.parts.k_Pin.doc.id, "id-Pin");
  // Save writes it again
  const w = await writeRefs(r.doc, dir, new Map(), APP);
  assert.deepEqual(w.written, ["Pin.mcadprt"]);
});

test("a part changed here is written on save; changed here and on disk keeps this version", async () => {
  const dir = memDir(), base: RefBase = new Map();
  let doc = (await writeRefs(asmOf(["Plate"]), dir, base, APP)).doc;
  doc.parts.k_Plate.doc.props = { here: "1" } as never;
  const w = await writeRefs(doc, dir, base, APP);
  assert.deepEqual(w.written, ["Plate.mcadprt"]);
  assert.deepEqual((await unpackPart(buf(dir.files.get("Plate.mcadprt")!))).props, { here: "1" });
  doc = w.doc;
  // both sides change
  doc.parts.k_Plate.doc.props = { here: "2" } as never;
  const other = part("Plate"); other.props = { there: "1" } as never;
  dir.files.set("Plate.mcadprt", await packPart(other, APP));
  const r = await resolveRefs(doc, dir, base);
  assert.deepEqual(r.conflicts, ["Plate"]);
  assert.deepEqual(r.doc.parts.k_Plate.doc.props, { here: "2" });
});

test("another document's file of the same name is not overwritten", async () => {
  const dir = memDir();
  const stranger = part("Plate"); stranger.id = "someone-else";
  dir.files.set("Plate.mcadprt", await packPart(stranger, APP));
  const r = await writeRefs(asmOf(["Plate"]), dir, new Map(), APP);
  assert.equal(r.doc.parts.k_Plate.link?.path, "Plate (2).mcadprt");
  assert.equal((await unpackPart(buf(dir.files.get("Plate.mcadprt")!))).id, "someone-else");
});

test("toolbox fasteners stay inside; sub-assemblies are files with their own references", async () => {
  const dir = memDir();
  const top = asmOf(["Plate"], "top");
  const bolt = part("Bolt"); bolt.id = "fastener:screw:M5x20";
  top.parts.k_bolt = { name: "M5", file: "M5.mcadprt", doc: bolt };
  const sub = asmOf(["Pin"], "sub");
  top.parts.k_sub = { name: "Sub", file: "Sub.mcadasm", doc: part("placeholder"), asm: sub };
  const r = await writeRefs(top, dir, new Map(), APP);
  assert.equal(r.doc.parts.k_bolt.link, undefined);
  assert.deepEqual([...dir.files.keys()].sort(), ["Pin.mcadprt", "Plate.mcadprt", "Sub.mcadasm"]);
  const subFile = await unpackAsm(buf(dir.files.get("Sub.mcadasm")!));
  assert.equal(subFile.parts.k_Pin.link?.path, "Pin.mcadprt");
  // the pin edited on disk reaches the top assembly through the sub-assembly
  const pin = part("Pin"); pin.props = { v: "2" } as never;
  dir.files.set("Pin.mcadprt", await packPart(pin, APP));
  const res = await resolveRefs(r.doc, dir, new Map());
  assert.deepEqual(res.updated, ["Pin"]);
  assert.deepEqual(res.doc.parts.k_sub.asm!.parts.k_Pin.doc.props, { v: "2" });
});

test("a part file renamed or moved in the folder is found by its document", async () => {
  const dir = memDir();
  const saved = (await writeRefs(asmOf(["Plate", "Pin"]), dir, new Map(), APP)).doc;
  // Pin moved into a subfolder, Plate renamed and edited there
  dir.files.set("hw/Pin-old.mcadprt", dir.files.get("Pin.mcadprt")!); dir.files.delete("Pin.mcadprt");
  const plate = part("Plate"); plate.props = { v: "3" } as never;
  dir.files.set("Plate v2.mcadprt", await packPart(plate, APP)); dir.files.delete("Plate.mcadprt");
  const decoy = part("Pin"); decoy.id = "other";
  dir.files.set("Pin.mcadprt.bak/Pin.mcadprt", await packPart(decoy, APP));
  const r = await resolveRefs(saved, dir, new Map());
  assert.deepEqual(r.missing.sort(), ["k_Pin", "k_Plate"]);
  const m = await findMoved(r.doc, dir, r.missing);
  assert.deepEqual(m.found.sort(), ["Pin", "Plate"]);
  assert.equal(m.doc.parts.k_Pin.link?.path, "hw/Pin-old.mcadprt");
  assert.equal(m.doc.parts.k_Plate.link?.path, "Plate v2.mcadprt");
  const again = await resolveRefs(m.doc, dir, new Map());
  assert.deepEqual(again.missing, []);
  assert.deepEqual(again.updated, ["Plate"]);
  assert.deepEqual(again.doc.parts.k_Plate.doc.props, { v: "3" });
});
