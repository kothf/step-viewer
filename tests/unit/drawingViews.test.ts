// Drawing files keep the lines each view was last drawn with (views.json), shown while the views are projected again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { packDrawing, savedViewsText, unpackDrawing } from "../../src/drawing/file";
import type { DrawingDoc } from "../../src/drawing/types";
import type { Projection } from "../../src/kernel/drawing";

const doc = {
  kind: "drawing", id: "d1", name: "Bracket drawing", props: {},
  source: { kind: "part", doc: { id: "p1" }, name: "Bracket" },
  sheets: [{ id: "s1", views: [{ id: "v1" }, { id: "v2" }], annots: [] }],
} as unknown as DrawingDoc;
const proj = (x: number): Projection => ({ vis: [[0, 0, x + 1 / 3, 2]], hid: [], box: [0, 0, x, 2], ms: 12 } as unknown as Projection);

test("views on a sheet keep their exact lines in the file, rounded; previews and removed views are left out", async () => {
  const shown = new Map<string, { dir: string; proj: Projection }>([
    ["v1", { dir: '{"d":[0,0,1]}', proj: { ...proj(10), cutEdges: [{}] } as unknown as Projection }],
    ["v2", { dir: "top", proj: { ...proj(5), preview: true } as unknown as Projection }],
    ["gone", { dir: "x", proj: proj(3) }],
  ]);
  const text = savedViewsText(doc, shown);
  assert.ok(text);
  const bytes = await packDrawing(doc, "test", undefined, text);
  const back = await unpackDrawing(bytes.slice().buffer as ArrayBuffer);
  assert.deepEqual(Object.keys(back.views ?? {}), ["v1"]);
  const v1 = back.views!.v1;
  assert.equal(v1.dir, '{"d":[0,0,1]}', "the direction key is kept as it was");
  assert.deepEqual(v1.proj.vis, [[0, 0, 10.3333, 2]]);
  assert.equal((v1.proj as { cutEdges?: unknown }).cutEdges, undefined);
  assert.equal(savedViewsText(doc, new Map()), null);
  // Files without the entry open as before.
  assert.equal((await unpackDrawing((await packDrawing(doc, "test")).slice().buffer as ArrayBuffer)).views, undefined);
});
