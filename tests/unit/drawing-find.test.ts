// File ▸ Open drawing: which drawings belong to the open model, read from the drawing file alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { drawingOf, peekDrawing, uniqueDrawings, type FoundDrawing } from "../../src/drawing/findDrawing";
import { packDrawing } from "../../src/drawing/file";
import type { DrawingDoc } from "../../src/drawing/types";

const part = (id: string) => ({ kind: "part", doc: { id }, name: "Bracket" }) as unknown as DrawingDoc["source"];
const asm = (id: string) => ({ kind: "asm", doc: { id }, flat: { id }, name: "Engine" }) as unknown as DrawingDoc["source"];

test("a drawing belongs to its part, assembly or model file", () => {
  assert.ok(drawingOf(part("p1"), { part: "p1" }));
  assert.ok(!drawingOf(part("p1"), { part: "p2" }), "another part");
  assert.ok(!drawingOf(part("p1"), { asm: "p1" }), "an assembly with the same id is not the part");
  assert.ok(drawingOf(asm("a1"), { asm: "a1" }));
  assert.ok(!drawingOf(asm("a1"), { part: "a1" }));
  // A drawing of a model file keeps a STEP copy, so the name matches whatever the file's extension.
  const file = { kind: "file", name: "Shaft.step" } as DrawingDoc["source"];
  assert.ok(drawingOf(file, { file: "shaft.STP" }));
  assert.ok(drawingOf(file, { file: "Shaft.iges" }));
  assert.ok(!drawingOf(file, { file: "Shaft2.step" }));
  assert.ok(!drawingOf(null, { part: "p1" }));
});

test("a drawing file names its model without loading it", async () => {
  const doc = { kind: "drawing", id: "d1", name: "Bracket drawing", sheets: [{ id: "s1", views: [], annots: [] }], props: {}, source: part("p1") } as unknown as DrawingDoc;
  const bytes = await packDrawing(doc, "test");
  const d = await peekDrawing(bytes.slice().buffer as ArrayBuffer);
  assert.equal(d?.id, "d1");
  assert.ok(d && drawingOf(d.source, { part: "p1" }));
  assert.equal(await peekDrawing(new Uint8Array([1, 2, 3]).buffer), null, "not a drawing");
});

test("each drawing is offered once, from the nearest place", () => {
  const f = (id: string, where: FoundDrawing["where"], label = id): FoundDrawing => ({ id, label, where, open: () => {} });
  const u = uniqueDrawings([f("a", "recent"), f("b", "vault"), f("a", "tab"), f("b", "recent"), f("c", "open")]);
  assert.deepEqual(u.map(x => `${x.id}:${x.where}`), ["c:open", "a:tab", "b:vault"]);
});
