// Document store, undo/redo and the .mcadprt round trip (AT-P0-1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocStore, newPart, nextName, dependants } from "../../src/model/doc";
import { packPart, unpackPart } from "../../src/model/file";
import { unzipLimited } from "../../src/model/zip";

test("undo and redo", () => {
  const s = new DocStore(newPart());
  assert.equal(s.dirty, false);
  s.change("Add sketch", d => { d.features.push({ id: "s1", type: "sketch", name: nextName(d, "sketch"), plane: { std: "XY" }, ents: [], rels: [], dims: [] }); });
  s.change("Rename", d => { d.features[0].name = "Base"; });
  assert.equal(s.doc.features[0].name, "Base");
  assert.equal(s.undoLabel, "Rename");
  s.undo();
  assert.equal(s.doc.features[0].name, "Sketch1");
  s.undo();
  assert.equal(s.doc.features.length, 0);
  assert.equal(s.canUndo, false);
  s.redo(); s.redo();
  assert.equal(s.doc.features[0].name, "Base");
  assert.equal(s.dirty, true);
  // No-op changes make no undo step.
  assert.equal(s.change("Nothing", () => {}), false);
});

test("save and open give the same document", async () => {
  const s = new DocStore(newPart("Bracket"));
  s.change("Add", d => {
    d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents: [{ id: "p", t: "point", x: 1.5, y: -2 }], rels: [], dims: [] });
    d.features.push({ id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20, expr: "10*2" } });
  });
  const bytes = await packPart(s.doc, "test");
  const back = await unpackPart(bytes.buffer as ArrayBuffer);
  assert.deepEqual(back, s.doc);
  const files = await unzipLimited(bytes.buffer as ArrayBuffer);
  assert.ok(new TextDecoder().decode(files.get("document.json")!).includes('\n  "features": ['));
  assert.deepEqual(dependants(s.doc, "s1").map(f => f.id), ["f1"]);
});

test("refuses foreign and newer files", async () => {
  const { zip } = await import("../../src/model/zip");
  const newer = await zip([{ name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 99, kind: "part" }) }, { name: "document.json", data: "{}" }]);
  await assert.rejects(unpackPart(newer.buffer as ArrayBuffer), /newer MöbiusCAD/);
  const evil = await zip([{ name: "../x", data: "1" }]);
  await assert.rejects(unpackPart(evil.buffer as ArrayBuffer), /unsafe path/);
});

test("save and open keep every feature type (planes, holes, bodies, imports…)", async () => {
  const s = new DocStore(newPart("All"));
  s.change("Add", d => {
    d.features.push({ id: "p", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 5 } } as never);
    d.features.push({ id: "d", type: "delbody", name: "Body-Delete/Keep1", bodies: [] } as never);
    d.features.push({ id: "i", type: "import", name: "Imported1", file: "a.step", brep: "x" } as never);
    d.features.push({ id: "k", type: "scale", name: "Scale1", bodies: [], about: "origin", factor: { v: 2 } } as never);
  });
  const back = await unpackPart((await packPart(s.doc, "test")).buffer as ArrayBuffer);
  assert.deepEqual(back.features.map(f => f.type), ["plane", "delbody", "import", "scale"]);
  const odd = await packPart({ ...s.doc, features: [{ id: "z", type: "warp", name: "Warp1" } as never] }, "test");
  await assert.rejects(unpackPart(odd.buffer as ArrayBuffer), /Unknown feature type "warp"/);
});
