// Kernel acceptance checks (FRS 16.2, AT-P1-2..8) on the feature evaluator, without the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
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
const circle = (id: string, x: number, y: number, r: number, plane: SketchFeature["plane"]): SketchFeature => ({
  id, type: "sketch", name: id, plane, rels: [], dims: [],
  ents: [{ id: `${id}c`, t: "point", x, y }, { id: `${id}k`, t: "circle", c: `${id}c`, r }],
});
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

function run(m: Modeller, d: PartDoc) {
  const r = m.evaluate(d);
  const bad = r.statuses.filter(s => !s.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  return { ...r, props: r.body ? m.props(r.body) : null };
}

const close = (a: number, b: number, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${a} ≠ ${b}`);

test("bracket: extrude, cut, fillet and edits keep references (AT-P1-2..7)", async () => {
  const m = new Modeller(await occ());
  const s1 = rect("s1", 0, 0, 100, 60);
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  let r = run(m, doc([s1, ex]));
  close(r.props!.volume, 120000);
  assert.equal(r.body!.faces.length, 6);

  const s2 = circle("s2", 0, 0, 5, { face: { name: "f1:end" } });
  const cut: Feature = { id: "f2", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 0 } };
  r = run(m, doc([s1, ex, s2, cut]));
  close(r.props!.volume, 120000 - 500 * Math.PI);

  // The four vertical edges: between neighbouring side faces.
  const sides = ["s1l1", "s1l2", "s1l3", "s1l4"].map(e => `f1:side:${e}`);
  const edges = sides.map((s, i) => ({ faces: [s, sides[(i + 1) % 4]] as [string, string] }));
  const fil: Feature = { id: "f3", type: "fillet", name: "Fillet1", radius: { v: 5 }, edges };
  r = run(m, doc([s1, ex, s2, cut, fil]));
  close(r.props!.volume, 118000);

  // Longer block: the fillets follow the same edges.
  const s1b = rect("s1", 0, 0, 120, 60);
  r = run(m, doc([s1b, ex, s2, cut, fil]));
  close(r.props!.volume, 142000);

  // Bigger hole.
  const s2b = circle("s2", 0, 0, 10, { face: { name: "f1:end" } });
  r = run(m, doc([s1b, ex, s2b, cut, fil]));
  close(r.props!.volume, 144000 - 2000 * Math.PI - 80 * (25 - 6.25 * Math.PI));

  // Chamfer on the hole's top edge: between the top face and the hole wall.
  const ch: Feature = { id: "f4", type: "chamfer", name: "Chamfer1", distance: { v: 1 }, edges: [{ faces: ["f1:end", "f2:side:s2k"] }] };
  r = run(m, doc([s1b, ex, s2b, cut, fil, ch]));
  const withChamfer = 144000 - 2000 * Math.PI - 80 * (25 - 6.25 * Math.PI) - 2 * Math.PI * (10 + 1 / 3) * 0.5;
  close(r.props!.volume, withChamfer);

  // Suppressing the hole: the chamfer loses its edge; the rest stays.
  const r2 = m.evaluate(doc([s1b, ex, s2b, { ...cut, suppressed: true } as Feature, fil, ch]));
  assert.equal(r2.statuses.find(s => s.id === "f4")!.ok, false);
  close(m.props(r2.body!).volume, 144000 - 80 * (25 - 6.25 * Math.PI));

  // And back.
  r = run(m, doc([s1b, ex, s2b, cut, fil, ch]));
  close(r.props!.volume, withChamfer);
});

test("revolve a ring (AT-P1-8)", async () => {
  const m = new Modeller(await occ());
  const s = rect("r", 35, 10, 10, 20, { std: "XZ" });
  // Axis: a construction line along the sketch's y (world Z).
  s.ents.push({ id: "ra", t: "point", x: 0, y: 0 }, { id: "rb", t: "point", x: 0, y: 10 }, { id: "rax", t: "line", a: "ra", b: "rb", cons: true });
  const rev: Feature = { id: "f1", type: "revolve", name: "Revolve1", sketch: "r", op: "boss", axis: "rax", angle: { v: Math.PI * 2 } };
  const r = run(m, doc([s, rev]));
  close(r.props!.volume, Math.PI * (40 * 40 - 30 * 30) * 20);
  const mesh = m.mesh(r.body!, "ring", [0.7, 0.7, 0.7]);
  assert.equal(mesh.brep_faces.length, r.body!.faces.length);
  assert.ok(mesh.index.array.length > 0);
});

test("mid-plane extrude and errors", async () => {
  const m = new Modeller(await occ());
  const s = rect("s", 0, 0, 10, 10);
  const r = run(m, doc([s, { id: "f", type: "extrude", name: "E", sketch: "s", op: "boss", end: "mid", depth: { v: 10 } }]));
  close(r.props!.volume, 1000);
  close(r.props!.com[2], 0);
  // Open contour.
  const open = rect("o", 0, 0, 10, 10);
  open.ents = open.ents.filter(e => e.id !== "ol4");
  const bad = m.evaluate(doc([open, { id: "f", type: "extrude", name: "E", sketch: "o", op: "boss", end: "blind", depth: { v: 5 } }]));
  assert.equal(bad.statuses[1].code, "E-SK-OPEN");
});
