// Feature scope (FR-FT-007): a cut or a merged boss acts only on the picked bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  const ents: SkEnt[] = [
    P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` },
  ];
  return { id, type: "sketch", name: id, plane: { std: "XY" }, ents, rels: [], dims: [] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });
// Two plates stacked at z = 0 as separate bodies, and a hole sketch on the top one.
const base: Feature[] = [rect("s1", 100, 100),
  { id: "f1", type: "extrude", name: "Top", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
  rect("s3", 100, 100),
  { id: "f3", type: "extrude", name: "Bottom", sketch: "s3", op: "boss", end: "blind", depth: { v: 20 }, flip: true, merge: false },
  { id: "s2", type: "sketch", name: "s2", plane: { face: { name: "f1:end" } }, rels: [], dims: [],
    ents: [{ id: "c", t: "point", x: 30, y: 0 }, { id: "k", t: "circle", c: "c", r: 4 }] }];
const hole = Math.PI * 16 * 20;

test("feature scope: a through cut takes only the picked body; empty scope = all", async () => {
  const m = new Modeller(await occ());
  const cut = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } } as Feature;
  let r = m.evaluate(doc([...base, cut]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  assert.equal(m.props(r.body!).bodies, 2);
  assert.ok(Math.abs(m.props(r.body!).volume - (400000 - 2 * hole)) < 1e-3, `${m.props(r.body!).volume}`);
  r = m.evaluate(doc([...base, { ...cut, scope: [{ name: "f3:start" }] } as Feature]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  assert.equal(m.props(r.body!).bodies, 2);
  assert.ok(Math.abs(m.props(r.body!).volume - (400000 - hole)) < 1e-3, `${m.props(r.body!).volume}`);
  r = m.evaluate(doc([...base, { ...cut, scope: [] } as Feature]));
  assert.ok(Math.abs(m.props(r.body!).volume - (400000 - 2 * hole)) < 1e-3, `${m.props(r.body!).volume}`);
});

test("feature scope: a boss merges only with the picked body", async () => {
  const m = new Modeller(await occ());
  // A pad on top crossing nothing but the top plate: merged with the bottom plate only, it stays a body of its own.
  const pad: Feature = { id: "f4", type: "extrude", name: "Pad", sketch: "s2", op: "boss", end: "blind", depth: { v: 5 }, scope: [{ name: "f3:start" }] } as Feature;
  let r = m.evaluate(doc([...base, pad]));
  assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
  assert.equal(m.props(r.body!).bodies, 3);
  r = m.evaluate(doc([...base, { ...pad, scope: [{ name: "f1:end" }] } as Feature]));
  assert.equal(m.props(r.body!).bodies, 2);
});
