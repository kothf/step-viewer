// Copy and paste features (FR-HIS-014).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newPart } from "../../src/model/doc";
import { canCopy, copyClip, pasteClip, LOST } from "../../src/model/paste";
import type { ExtrudeFeature, PartDoc, SketchFeature } from "../../src/model/types";

function part(): PartDoc {
  const d = newPart();
  const sk: SketchFeature = {
    id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, xAxis: { edge: { faces: ["a", "b"] } as never },
    ents: [{ id: "p", t: "point", x: 1, y: 2 }, { id: "q", t: "point", x: 3, y: 4 }],
    rels: [{ t: "fix", e: ["p"], ext: { faces: ["a", "b"] } as never, dangling: true } as never, { t: "pierce", e: ["q"] } as never],
    dims: [],
  };
  const ex = { id: "e1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", depth: { v: 10 }, end: "upto", upTo: { face: { name: "x" } }, start: "surface", startRef: { name: "y" }, suppressed: true } as unknown as ExtrudeFeature;
  d.features.push(sk, ex);
  return d;
}

test("copy takes an extrude with its sketch, not other features", () => {
  const d = part();
  const c = copyClip(d, "e1")!;
  assert.deepEqual(c.feats.map(f => f.id), ["s1", "e1"]);
  assert.equal(copyClip(d, "nope"), null);
  assert.equal(canCopy(d.features[0]), true);
  assert.equal(canCopy({ id: "f", type: "fillet" } as never), false);
  // The clip is a copy: later edits of the document do not change it.
  (d.features[0] as SketchFeature).ents.length = 0;
  assert.equal((c.feats[0] as SketchFeature).ents.length, 2);
});

test("paste gives new ids and names, links the sketch and drops references that cannot follow", () => {
  const d = part();
  const c = copyClip(d, "e1")!;
  let n = 0;
  const { feats, lost } = pasteClip(d, c, { face: { name: "top", hint: [0, 0, 5] } } as never, p => `${p}${++n}`);
  const [sk, ex] = feats as [SketchFeature, ExtrudeFeature];
  assert.deepEqual(feats.map(f => f.id), ["f_1", "f_2"]);
  assert.equal(sk.name, "Sketch2");
  assert.equal(ex.name, "Extrude2");
  assert.equal(ex.sketch, "f_1");
  assert.deepEqual(sk.plane, { face: { name: "top", hint: [0, 0, 5] } });
  assert.equal(sk.xAxis, undefined);
  assert.equal(sk.rels.length, 1);
  assert.equal(sk.rels[0].t, "fix");
  assert.equal((sk.rels[0] as { ext?: unknown }).ext, undefined);
  assert.equal(ex.end, "blind");
  assert.equal((ex as { upTo?: unknown }).upTo, undefined);
  assert.equal(ex.start, undefined);
  assert.equal(ex.suppressed, undefined);
  assert.deepEqual(new Set(lost), new Set([LOST.xAxis, LOST.onEdge, LOST.pierce, LOST.end, LOST.start]));
  // The source document is untouched.
  assert.equal(d.features.length, 2);
  assert.equal((d.features[1] as ExtrudeFeature).end, "upto");
});

test("a plain sketch pastes with nothing lost", () => {
  const d = newPart();
  d.features.push({ id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents: [], rels: [], dims: [] });
  const { feats, lost } = pasteClip(d, copyClip(d, "s1")!, { std: "YZ" });
  assert.equal(feats.length, 1);
  assert.deepEqual((feats[0] as SketchFeature).plane, { std: "YZ" });
  assert.equal(feats[0].name, "Sketch2");
  assert.deepEqual(lost, []);
});
