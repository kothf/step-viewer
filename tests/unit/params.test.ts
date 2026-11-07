// Global variables and equations (FR-PAR-001..005).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocStore, newPart } from "../../src/model/doc";
import { evalVars, refreshExprs, renameEverywhere, renameIn, validVarName } from "../../src/model/params";
import type { PartDoc, SketchFeature } from "../../src/model/types";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

function part(): PartDoc {
  const d = newPart();
  const sk: SketchFeature = {
    id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" },
    ents: [{ id: "a", t: "point", x: 0, y: 0 }, { id: "b", t: "point", x: 30, y: 0 }, { id: "l", t: "line", a: "a", b: "b" }],
    rels: [{ id: "r1", t: "horizontal", e: ["l"] }, { id: "r2", t: "fix", e: ["a"] }],
    dims: [{ id: "d1", name: "D1", t: "distance", e: ["l"], val: { v: 30 } }],
  };
  d.features.push(sk, { id: "e1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 10 } });
  return d;
}

test("names", () => {
  assert.ok(validVarName("Width"));
  assert.ok(validVarName("w_2"));
  assert.ok(!validVarName("2w"));
  assert.ok(!validVarName("sqrt"));
  assert.ok(!validVarName("a b"));
});

test("variables evaluate in dependency order, with units and plain numbers", () => {
  const d = part();
  d.vars = [
    { name: "Half", expr: "Width/2", kind: "length" },
    { name: "Width", expr: "2in", kind: "length" },
    { name: "N", expr: "4", kind: "number" },
    { name: "Tilt", expr: "30", kind: "angle" },
    { name: "Len", expr: "D1@Sketch1 * N", kind: "length" },
  ];
  const r = evalVars(d);
  assert.deepEqual(r.errors, {});
  near(r.values.Width as number, 50.8);
  near(r.values.Half as number, 25.4);
  near(r.values.Tilt as number, Math.PI / 6);
  near(r.values.Len as number, 120);
});

test("circular references and unknown names are errors", () => {
  const d = part();
  d.vars = [
    { name: "A", expr: "B+1", kind: "length" },
    { name: "B", expr: "A+1", kind: "length" },
    { name: "C", expr: "Nope*2", kind: "length" },
    { name: "E", expr: "C+1", kind: "length" },
  ];
  const r = evalVars(d);
  assert.equal(r.errors.A.key, "Circular reference");
  assert.equal(r.errors.B.key, "Circular reference");
  assert.equal(r.errors.C.key, "Unknown name “{name}”");
  assert.equal(r.errors.C.params?.name, "Nope");
  assert.equal(r.errors.E.key, "Uses {name}, which has an error");
});

test("changing a variable drives a sketch dimension and an extrude depth", () => {
  const s = new DocStore(part());
  s.normalize = d => { refreshExprs(d); };
  s.change("Equations", d => {
    d.vars = [{ name: "Width", expr: "40", kind: "length" }];
    const sk = d.features[0] as SketchFeature;
    sk.dims[0].val = { v: 0, expr: "Width" };
    const e = d.features[1];
    if (e.type === "extrude") e.depth = { v: 0, expr: "D1@Sketch1/4" };
  });
  const sk = () => s.doc.features[0] as SketchFeature;
  const b = () => sk().ents.find(e => e.id === "b") as { x: number };
  near(sk().dims[0].val.v, 40);
  near(b().x, 40);
  const depth = () => { const e = s.doc.features[1]; return e.type === "extrude" ? e.depth.v : NaN; };
  near(depth(), 10);
  s.change("Equations", d => { d.vars![0].expr = "60"; });
  near(sk().dims[0].val.v, 60);
  near(b().x, 60);
  near(depth(), 15);
  // Undo brings the whole set back.
  s.undo();
  near(depth(), 10);
  near(b().x, 40);
});

test("renaming a dimension or a sketch rewrites the expressions that use it (FR-SK-065)", () => {
  assert.equal(renameIn("D1@Sketch1*2 + D11@Sketch1 + xD1@Sketch1", "D1@Sketch1", "Width@Sketch1"), "Width@Sketch1*2 + D11@Sketch1 + xD1@Sketch1");
  const d = { vars: [{ name: "w", kind: "length", expr: "D1@Sketch1 / 2" }], features: [{ id: "e", type: "extrude", name: "E", depth: { v: 5, expr: "D1@Sketch1" } }] } as unknown as PartDoc;
  renameEverywhere(d, "D1@Sketch1", "D1@Base");
  assert.equal(d.vars![0].expr, "D1@Base / 2");
  assert.equal((d.features[0] as unknown as { depth: { expr: string } }).depth.expr, "D1@Base");
});
