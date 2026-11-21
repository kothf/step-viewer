// Structural analysis: typed load values (FR-LOAD-021).
import test from "node:test";
import assert from "node:assert/strict";
import { loadValue, refreshStudyValues, shownValue, typedValue } from "../../src/sim/values";
import { refreshExprs, renameEverywhere } from "../../src/model/params";
import type { PartDoc } from "../../src/model/types";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test("load values take numbers, expressions, units and variables", () => {
  near(loadValue("1500", "force"), 1500);
  near(loadValue("12,5", "force"), 12.5);
  near(loadValue("2 kN", "force"), 2000);
  near(loadValue("2kN", "force"), 2000);
  near(loadValue("(1 + 0.5) кН", "force"), 1500);
  near(loadValue("100 lbf", "force"), 444.82216152605);
  near(loadValue("30 psi", "pressure"), 0.20684271879504);
  near(loadValue("2 bar", "pressure"), 0.2);
  near(loadValue("500 N·mm", "moment"), 0.5);
  near(loadValue("1 g", "gravity"), 9.80665);
  // a variable named like a unit stays a variable
  near(loadValue("2 * g", "gravity", { g: { v: 3, unit: false } }), 6);
  near(loadValue("3 * F + 10", "force", { F: { v: 200, unit: false } }), 610);
  near(loadValue("2 * F + 0.2 kN", "force", { F: { v: 150, unit: false } }), 500);
  near(loadValue("1 kN + 50 lbf + 3", "force"), 1000 + 222.411080763025 + 3);
  near(loadValue("2,5 Н·м + 500 N·mm", "moment"), 3);
  near(loadValue("1e3 N", "force"), 1000);
  // a length variable gives its millimetres
  near(loadValue("L * 4", "force", { L: 25 }), 100);
  assert.throws(() => loadValue("2 * nope", "force"));
  assert.throws(() => loadValue("", "force"));
  assert.throws(() => loadValue("5 psi", "force"));
});

test("typed values are stored in the solver's units and keep their text only when needed", () => {
  assert.deepEqual(typedValue("250", "force"), { v: 250 });
  assert.deepEqual(typedValue("-9.81", "gravity"), { v: -9810 });
  assert.deepEqual(typedValue("2 kN", "force"), { v: 2000, expr: "2 kN" });
  const m = typedValue("F / 100", "moment", { F: { v: 300, unit: false } });
  near(m.v, 3000);
  assert.equal(m.expr, "F / 100");
  assert.equal(shownValue(m, "moment"), "F / 100");
  assert.equal(shownValue({ v: 3000 }, "moment"), "3");
  assert.equal(shownValue(undefined, "force"), "0");
});

test("load values follow the global variables and their renames", () => {
  const doc = {
    id: "p", name: "P", version: 1, features: [], units: { length: "mm" },
    vars: [{ name: "F", expr: "400", kind: "number" }],
    studies: [{ id: "st1", name: "Static 1", kind: "static", supports: [], settings: { passes: 3, energyTol: 2 },
      loads: [
        { id: "l1", name: "Force 1", type: "force", faces: [], normal: true, value: { v: 0, expr: "2 * F" } },
        { id: "l2", name: "Moment 1", type: "moment", faces: [], comp: [{ v: 0 }, { v: 0, expr: "F / 4" }, { v: 5 }] },
        { id: "l3", name: "Force 2", type: "force", faces: [], normal: true, value: { v: 7, expr: "missing + 1" } },
      ] }],
  } as unknown as PartDoc;
  const failed = refreshExprs(doc);
  const loads = doc.studies![0].loads;
  near(loads[0].value!.v, 800);
  near(loads[1].comp![1].v, 100000);
  assert.equal(loads[1].comp![2].v, 5);
  assert.equal(loads[2].value!.v, 7, "a failed expression keeps its old value");
  assert.deepEqual(failed.map(f => f.key), ["Force 2"]);
  doc.vars![0].expr = "1 kN";
  doc.vars![0].kind = "number";
  renameEverywhere(doc, "F", "Load");
  assert.equal(loads[0].value!.expr, "2 * Load");
  doc.vars![0].name = "Load";
  doc.vars![0].expr = "500";
  assert.equal(refreshStudyValues(doc, { Load: { v: 500, unit: false } }).length, 1);
  near(loads[0].value!.v, 1000);
});
