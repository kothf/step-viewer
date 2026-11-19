import { test } from "node:test";
import assert from "node:assert/strict";
import { canPaint, paintFormat } from "../../src/drawing/formatPaint";
import type { Annot, DimAnnot, NoteAnnot } from "../../src/drawing/types";

const dim = (o: Partial<DimAnnot>): DimAnnot => ({ id: "d", t: "dim", view: "v", k: "h", refs: [], pos: [0, 0], ...o });

test("a dimension's precision, tolerance and arrows go to another dimension; its value text and place stay", () => {
  const src = dim({ id: "a", prec: 3, tol: { t: "sym", up: 0.1 }, ends: "open", txt: "SRC" });
  const dst = dim({ id: "b", pos: [5, 6], txt: "KEEP", horiz: true });
  assert.equal(paintFormat(src, dst), true);
  assert.equal(dst.prec, 3);
  assert.deepEqual(dst.tol, { t: "sym", up: 0.1 });
  assert.equal(dst.ends, "open");
  assert.equal(dst.horiz, undefined, "a property the source lacks is removed");
  assert.equal(dst.txt, "KEEP");
  assert.deepEqual(dst.pos, [5, 6]);
  src.tol!.up = 0.2;
  assert.equal(dst.tol!.up, 0.1, "copied, not shared");
  assert.equal(paintFormat(src, dst), true);
  assert.equal(paintFormat(src, dst), false, "nothing left to change");
});

test("only the same kind of annotation takes the format", () => {
  const note: NoteAnnot = { id: "n", t: "note", pos: [0, 0], text: "x", border: "box" };
  assert.equal(paintFormat(dim({ id: "a", prec: 1 }), note as Annot), false);
  const n2: NoteAnnot = { id: "n2", t: "note", pos: [1, 1], text: "y" };
  assert.equal(paintFormat(note, n2), true);
  assert.equal(n2.border, "box");
  assert.equal(n2.text, "y");
  assert.equal(canPaint(note), true);
  assert.equal(canPaint({ id: "g", t: "gtol" } as unknown as Annot), false);
});

import { alignDim, spaceDims } from "../../src/drawing/dimAlign";
import type { DimAnnot as D } from "../../src/drawing/types";
const dd = (id: string, k: D["k"], pos: [number, number], view = "v"): D => ({ id, t: "dim", view, k, refs: [], pos });

test("Align puts a horizontal dimension on the other's line; mixed kinds or views are refused", () => {
  const a = dd("a", "h", [0, 22]), b = dd("b", "h", [40, 31]);
  assert.equal(alignDim(a, b), true);
  assert.deepEqual(b.pos, [40, 22]);
  assert.equal(alignDim(a, b), false);
  assert.equal(alignDim(a, dd("c", "v", [0, 0])), false);
  assert.equal(alignDim(a, dd("e", "h", [0, 5], "w")), false);
});

test("Space evenly rows the dimensions round a view 10 and then 8 sheet mm apart, nearest first", () => {
  // A view 100 × 20 at 1:2: rows at 10 mm = 20 model mm and 8 mm = 16 model mm.
  const box: [number, number, number, number] = [-50, -10, 50, 10];
  const ds = [dd("top2", "h", [0, 60]), dd("top1", "h", [0, 13]), dd("left", "v", [-52, 0]), dd("below", "h", [0, -11]), dd("on", "h", [0, 0])];
  const moved = spaceDims(ds, box, 0.5);
  const at = (id: string) => ds.find(d => d.id === id)!.pos;
  assert.deepEqual(at("top1"), [0, 30]);
  assert.deepEqual(at("top2"), [0, 46]);
  assert.deepEqual(at("below"), [0, -30]);
  assert.deepEqual(at("left"), [-70, 0]);
  assert.deepEqual(at("on"), [0, 0]);
  assert.equal(moved.length, 4);
});
