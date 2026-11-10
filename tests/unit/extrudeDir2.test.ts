// Extrude Direction 2 with its own end condition (FR-FT-011).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { hasDir2, dir2Apart, dir2Feature, type ExtrudeFeature, type Feature, type PartDoc, type SketchFeature, type SkEnt } from "../../src/model/types";
import { featureRefs } from "../../src/model/doc";
import { occ } from "./occ";

const rect = (id: string, cx: number, cy: number, w: number, h: number, plane: SketchFeature["plane"] = { std: "XY" }): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", cx - w / 2, cy - h / 2), P("2", cx + w / 2, cy - h / 2), P("3", cx + w / 2, cy + h / 2), P("4", cx - w / 2, cy + h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane, ents, rels: [], dims: [] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.equal(bad.length, 0, JSON.stringify(bad));
  return { ...r, props: r.body ? m.props(r.body) : null };
}
const close = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

const block = rect("s1", 0, 0, 100, 60);
const ex1: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
const pl: Feature = { id: "p", type: "plane", name: "Plane1", base: { std: "XY" }, mode: "offset", offset: { v: 30 } };
const pad = rect("s2", -30, 0, 10, 10, { plane: "p" });

test("which extrudes go both ways, and how Direction 2 becomes a one-way extrude", () => {
  const f = ex1 as ExtrudeFeature;
  assert.equal(hasDir2(f), false);
  assert.equal(hasDir2({ ...f, depth2: { v: 5 } }), true);
  assert.equal(dir2Apart({ ...f, depth2: { v: 5 } }), false, "blind both ways stays one prism");
  // A stale depth2 under another end condition (older files) does not switch Direction 2 on.
  assert.equal(hasDir2({ ...f, end: "through", depth2: { v: 5 } }), false);
  assert.equal(hasDir2({ ...f, end: "through", depth2: { v: 5 }, end2: "blind" }), true);
  assert.equal(hasDir2({ ...f, end: "mid", depth2: { v: 5 }, end2: "through" }), false);
  const g = dir2Feature({ ...f, end: "through", depth2: { v: 7 }, end2: "upto", upTo2: { std: "XY" }, upTo: { std: "YZ" }, draft: { angle: { v: 0.1 } } });
  assert.equal(g.end, "upto");
  assert.deepEqual(g.upTo, { std: "XY" });
  assert.equal(g.depth.v, 7);
  assert.equal(g.flip, true);
  assert.equal(g.draft, undefined);
  assert.equal(g.end2, undefined);
  assert.equal(g.upTo2, undefined);
  // Direction 2's references are parents of the feature.
  const refs = featureRefs({ ...f, end: "blind", depth2: { v: 7 }, end2: "body", upToBody2: { name: "f9:end" } });
  assert.ok(refs.faces.includes("f9:end"));
});

test("Direction 2 up to next, up to face and through all (FR-FT-011)", async () => {
  const m = new Modeller(await occ());
  const base = 100 * 60 * 20;
  // A pad on a plane 10 above the block: 5 up, and Direction 2 down to the block.
  const next: Feature = { id: "f2", type: "extrude", name: "Pad", sketch: "s2", op: "boss", end: "blind", depth: { v: 5 }, depth2: { v: 1 }, end2: "next" };
  let r = run(m, doc([block, ex1, pl, pad, next]));
  close(r.props!.volume, base + 100 * 15);
  const names = r.body!.names;
  assert.equal(names.filter(n => n === "f2:end").length, 1);
  // The side faces of both directions are joined again, as one two-way prism would give.
  assert.equal(names.filter(n => n.startsWith("f2:side:")).length, 4, names.join(" "));
  assert.equal(r.props!.bodies ?? 1, 1);
  // The same up to the block's top face.
  r = run(m, doc([block, ex1, pl, pad, { ...next, end2: "upto", upTo2: { face: { name: "f1:end" } } } as Feature]));
  close(r.props!.volume, base + 100 * 15);
  // Up to body.
  r = run(m, doc([block, ex1, pl, pad, { ...next, end2: "body", upToBody2: { name: "f1:end" } } as Feature]));
  close(r.props!.volume, base + 100 * 15);
  // Offset from surface: 2 short of the top face.
  r = run(m, doc([block, ex1, pl, pad, { ...next, end2: "offset", upTo2: { face: { name: "f1:end" } }, upToOffset2: { v: 2 } } as Feature]));
  close(r.props!.volume, base + 100 * 13);
  // A cut from the plane: through all both ways is through all down plus a blind Direction 2 up.
  const hole = rect("s3", 30, 0, 10, 10, { plane: "p" });
  r = run(m, doc([block, ex1, pl, hole, { id: "f3", type: "extrude", name: "Cut", sketch: "s3", op: "cut", end: "through", depth: { v: 1 }, depth2: { v: 5 }, end2: "blind" }]));
  close(r.props!.volume, base - 100 * 20);
  // Direction 1 up to next with a blind Direction 2: the cut stops at the next face below.
  const deep = rect("s4", 30, 0, 10, 10, { face: { name: "f1:end" } });
  r = run(m, doc([block, ex1, deep, { id: "f4", type: "extrude", name: "Cut", sketch: "s4", op: "cut", end: "blind", depth: { v: 8 }, depth2: { v: 3 }, end2: "through" }]));
  close(r.props!.volume, base - 100 * 8);
});

test("an older file with a stale Direction 2 depth under another end keeps one direction", async () => {
  const m = new Modeller(await occ());
  const old: Feature = { id: "f2", type: "extrude", name: "Pad", sketch: "s2", op: "boss", end: "next", depth: { v: 5 }, depth2: { v: 4 }, flip: true };
  const r = run(m, doc([block, ex1, pl, pad, old]));
  close(r.props!.volume, 100 * 60 * 20 + 100 * 10);
});
