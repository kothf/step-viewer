// Configurations (FR-CFG-001/002, AT-P2-4) and reordering (FR-HIS-006, AT-P2-6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocStore, newPart, moved, orderProblem } from "../../src/model/doc";
import { activate, addConfig, removeConfig, renameConfig } from "../../src/model/configs";
import { refreshExprs } from "../../src/model/params";
import type { Feature, PartDoc } from "../../src/model/types";

function part(): PartDoc {
  const d = newPart();
  d.vars = [{ name: "L", expr: "100", kind: "length" }];
  d.features.push(
    { id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" }, ents: [], rels: [], dims: [] },
    { id: "e1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 100, expr: "L" } },
    { id: "s2", type: "sketch", name: "Sketch2", plane: { face: { name: "e1:end" } }, ents: [], rels: [], dims: [] },
    { id: "c1", type: "extrude", name: "Cut1", sketch: "s2", op: "cut", end: "through", depth: { v: 10 } },
    { id: "f1", type: "fillet", name: "Fillet1", radius: { v: 2 }, edges: [{ faces: ["e1:side:a", "e1:end"] }] },
    { id: "p1", type: "lpattern", name: "LPattern1", features: ["c1"], spacing: { v: 10 }, count: 3 },
  );
  return d;
}

test("configurations keep their own values, suppression and material", () => {
  const s = new DocStore(part());
  s.normalize = d => { refreshExprs(d); };
  const depth = () => (s.doc.features[1] as Extract<Feature, { type: "extrude" }>).depth.v;
  s.change("Add", d => addConfig(d, "Short"));
  assert.deepEqual(s.doc.configs!.map(c => c.name), ["Default", "Short"]);
  assert.equal(s.doc.config, "Short");
  // Changes made in Short stay in Short.
  s.change("Short values", d => {
    d.vars![0].expr = "40";
    d.features.find(f => f.id === "f1")!.suppressed = true;
    (d.features.find(f => f.id === "p1") as Extract<Feature, { type: "lpattern" }>).count = 5;
    d.material = { name: "Steel", density: 7.85 };
  });
  assert.equal(depth(), 40);
  s.change("Switch", d => activate(d, "Default"));
  assert.equal(depth(), 100);
  assert.equal(s.doc.vars![0].expr, "100");
  assert.equal(s.doc.features.find(f => f.id === "f1")!.suppressed, undefined);
  assert.equal((s.doc.features.find(f => f.id === "p1") as Extract<Feature, { type: "lpattern" }>).count, 3);
  assert.equal(s.doc.material, undefined);
  s.change("Switch", d => activate(d, "Short"));
  assert.equal(depth(), 40);
  assert.equal(s.doc.features.find(f => f.id === "f1")!.suppressed, true);
  assert.equal(s.doc.material?.name, "Steel");
  // Undo goes back to Default.
  s.undo();
  assert.equal(s.doc.config, "Default");
  assert.equal(depth(), 100);
  // Rename and remove.
  s.change("Rename", d => { assert.ok(renameConfig(d, "Short", "Stub")); assert.ok(!renameConfig(d, "Stub", "Default")); });
  s.change("Remove", d => removeConfig(d, "Stub"));
  assert.equal(s.doc.configs, undefined);
  assert.equal(depth(), 100);
});

test("reorder: a fillet can move above a cut it does not use; a feature can't move above its parent", () => {
  const d = part();
  // Fillet1 above Cut1 (and its sketch): fine.
  const a = moved(d.features, ["f1"], 2);
  assert.deepEqual(a.map(f => f.id), ["s1", "e1", "f1", "s2", "c1", "p1"]);
  assert.equal(orderProblem(a), null);
  // Cut1 above its sketch: refused, Cut1 uses Sketch2.
  const b = moved(d.features, ["c1"], 2);
  assert.equal(orderProblem(b)?.feature.id, "c1");
  assert.equal(orderProblem(b)?.parent.id, "s2");
  // The pattern above the cut it copies: refused.
  const c = moved(d.features, ["p1"], 3);
  assert.equal(orderProblem(c)?.feature.id, "p1");
  // Sketch2 sits on Extrude1's end face: it can't go first.
  const e = moved(d.features, ["s2", "c1"], 0);
  assert.equal(orderProblem(e)?.parent.id, "e1");
});
