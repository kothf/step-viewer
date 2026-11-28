// Document store, undo/redo and the .mcadprt round trip (AT-P0-1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocStore, newPart, nextName, dependants, setSuppressed } from "../../src/model/doc";
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

test("a part saved rolled back opens rolled back (FR-HIS-012, AT-UX-14)", async () => {
  const s = new DocStore(newPart("Rolled"));
  s.change("Add", d => {
    d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents: [], rels: [], dims: [] });
    d.features.push({ id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 5 } });
    d.features.push({ id: "f2", type: "extrude", name: "Extrude2", sketch: "s1", op: "cut", end: "blind", depth: { v: 2 } });
    d.rollback = 1;
    d.stdHidden = ["XY"];
  });
  const back = await unpackPart((await packPart(s.doc, "test")).buffer as ArrayBuffer);
  assert.equal(back.rollback, 1);
  assert.deepEqual(back.stdHidden, ["XY"]);
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

test("named views stay through undo and redo and are saved with the part (FR-UI-104)", async () => {
  const s = new DocStore(newPart());
  s.change("Add sketch", d => { d.features.push({ id: "s1", type: "sketch", name: nextName(d, "sketch"), plane: { std: "XY" }, ents: [], rels: [], dims: [] }); });
  s.amend(d => { d.views = [{ name: "Front close", t: [0, 0, 0], p: [0, -100, 0], h: 50 }]; });
  assert.equal(s.dirty, true);
  s.undo();
  assert.equal(s.doc.features.length, 0);
  assert.equal(s.doc.views?.[0].name, "Front close");
  s.redo();
  assert.equal(s.doc.views?.length, 1);
  const back = await unpackPart((await packPart(s.doc, "test")).buffer as ArrayBuffer);
  assert.deepEqual(back.views, s.doc.views);
});

test("suppress takes the features that use it along and brings them back (FR-HIS-004)", () => {
  const d = newPart("Sup");
  d.features.push(
    { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents: [], rels: [], dims: [] },
    { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    { id: "h1", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [[0, 0]], kind: "simple", diameter: { v: 6 }, end: "blind", depth: { v: 5 } } as never,
    { id: "p1", type: "lpattern", name: "LPattern1", features: ["h1"], dir: { edge: { faces: ["f1:end", "f1:side:a"] } }, count: 3, spacing: { v: 10 } } as never,
    { id: "c1", type: "chamfer", name: "Chamfer1", edges: [{ faces: ["h1:wall", "f1:end"] }], distance: { v: 1 } } as never,
    { id: "x1", type: "fillet", name: "Fillet1", edges: [{ faces: ["f1:end", "f1:side:a"] }], radius: { v: 2 } } as never,
  );
  // The fillet on the block's edge does not use the hole and stays.
  assert.deepEqual(setSuppressed(d, "h1", true), ["LPattern1", "Chamfer1"]);
  assert.deepEqual(d.features.filter(f => f.suppressed).map(f => f.id), ["h1", "p1", "c1"]);
  assert.equal(d.features.find(f => f.id === "p1")!.supBy, "h1");
  // Unsuppressing the pattern alone brings back the hole it copies, and with it the chamfer.
  assert.deepEqual(setSuppressed(d, "p1", false).sort(), ["Chamfer1", "Hole1"]);
  assert.equal(d.features.some(f => f.suppressed || f.supBy), false);
  // A feature suppressed on its own stays suppressed when its parent comes back.
  setSuppressed(d, "c1", true);
  setSuppressed(d, "h1", true);
  assert.deepEqual(setSuppressed(d, "h1", false), ["LPattern1"]);
  assert.equal(d.features.find(f => f.id === "c1")!.suppressed, true);
});
