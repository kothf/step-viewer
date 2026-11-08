// Configurations (FR-CFG-001/002, AT-P2-4) and reordering (FR-HIS-006, AT-P2-6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocStore, newPart, moved, orderProblem } from "../../src/model/doc";
import { activate, addConfig, applyConfigTable, configTable, parseCsv, removeConfig, renameConfig } from "../../src/model/configs";
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

test("configuration table: export, then a CSV edits values and adds a configuration (FR-CFG-003)", () => {
  const s = new DocStore(part());
  s.normalize = d => { refreshExprs(d); };
  s.change("Add", d => addConfig(d, "Short"));
  s.change("Short", d => { d.vars![0].expr = "40"; d.features.find(f => f.id === "f1")!.suppressed = true; });
  const csv = configTable(s.doc);
  const rows = parseCsv(csv);
  const col = (h: string) => rows[0].indexOf(h);
  assert.equal(rows[0][0], "Configuration");
  assert.deepEqual(rows.slice(1).map(r => r[0]), ["Default", "Short"]);
  assert.equal(rows[1][col("$VAR@L")], "100");
  assert.equal(rows[2][col("$VAR@L")], "40");
  assert.equal(rows[2][col("$STATE@Fillet1")], "S");
  assert.equal(rows[1][col("depth@Extrude1")], "L");
  assert.equal(rows[1][col("count@LPattern1")], "3");
  // Semicolons, quotes, a new configuration and a column that doesn't exist.
  const text = 'Configuration;$VAR@L;$STATE@Fillet1;count@LPattern1;radius@Fillet1;nope@X\nShort;55;U;4;"2.5";1\nLong;250;;6;;\n';
  let res: ReturnType<typeof applyConfigTable> | null = null;
  s.change("Table", d => { res = applyConfigTable(d, text); });
  assert.deepEqual(res!.added, ["Long"]);
  assert.deepEqual(res!.changed, ["Short"]);
  assert.deepEqual(res!.unknown, ["nope@X"]);
  const depth = () => (s.doc.features[1] as Extract<Feature, { type: "extrude" }>).depth.v;
  const f1 = () => s.doc.features.find(f => f.id === "f1") as Extract<Feature, { type: "fillet" }>;
  // Short is active: its row applies at once.
  assert.equal(depth(), 55);
  assert.equal(f1().suppressed, undefined);
  assert.equal(f1().radius.v, 2.5);
  assert.equal((s.doc.features.find(f => f.id === "p1") as Extract<Feature, { type: "lpattern" }>).count, 4);
  s.change("Long", d => activate(d, "Long"));
  assert.equal(depth(), 250);
  assert.equal((s.doc.features.find(f => f.id === "p1") as Extract<Feature, { type: "lpattern" }>).count, 6);
  // Long started from Short's values, so the fillet radius came along.
  assert.equal(f1().radius.v, 2.5);
  // One undo step.
  s.undo(); s.undo();
  assert.equal(s.doc.configs!.length, 2);
  assert.throws(() => applyConfigTable(structuredClone(s.doc), "Configuration\n"));
});
