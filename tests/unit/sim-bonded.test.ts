// Structural analysis of a multibody part (FRS-structural AT-SA2-5): two bodies that touch are analysed
// bonded and give the same static and modal results as the same shape made as one body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Modeller } from "../../src/kernel/model";
import { simGeometry, faceTris } from "../../src/kernel/simgeo";
import { MeshBody, insideOf } from "../../src/sim/body";
import { solveStatic } from "../../src/sim/static";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const P = (k: string, x: number, y: number): SkEnt => ({ id: k, t: "point", x, y });
function rect(id: string, x0: number, x1: number): SketchFeature {
  return {
    id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [],
    ents: [P("p1", x0, -10), P("p2", x1, -10), P("p3", x1, 10), P("p4", x0, 10),
      { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" },
      { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }],
  };
}
const ext = (id: string, sketch: string, merge?: boolean): Feature =>
  ({ id, type: "extrude", name: id, sketch, op: "boss", end: "blind", depth: { v: 10 }, ...(merge === false ? { merge: false } : {}) });
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "b", name: "bar", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

test("two touching bodies are bonded: same tip deflection and first frequency as one body (AT-SA2-5)", async () => {
  const oc = await occ();
  const E = 210000, rho = 7.85e-9;
  const run = (d: PartDoc, want: number) => {
    const m = new Modeller(oc);
    const r = m.evaluate(d);
    assert.ok(r.body);
    const b = m.bonded(r.body!);
    assert.equal(b.parts, want);
    assert.equal(b.solids, 1);
    const geo = simGeometry(oc, b.body.shape, b.body.faces, 0.002, 0.05);
    const inside = insideOf(new MeshBody(geo.tris));
    const pick = (n: string) => { const s = new Set<number>(); b.body.names.forEach((x, i) => { if (x === n) s.add(i); }); assert.equal(s.size, 1, n); return s; };
    const fixed = [{ tris: faceTris(geo, pick("f1:side:l4")) }];
    const st = solveStatic({ lo: geo.lo, hi: geo.hi, inside, h: 10, p: 3, mat: { E, nu: 0.3 }, fixed, loads: [{ tris: faceTris(geo, pick(want === 2 ? "f2:side:l2" : "f1:side:l2")), force: [0, 0, -100] }] });
    const mo = solveStatic({ lo: geo.lo, hi: geo.hi, inside, h: 10, p: 3, mat: { E, nu: 0.3, rho }, fixed, loads: [], modal: { count: 2 } });
    return { tip: -st.disp(99.999, 0, 5)[2], hz: mo.modes![0].hz, vol: st.grid.volume, faces: b.body.faces.length };
  };
  const one = run(doc([rect("s1", 0, 100), ext("f1", "s1")]), 1);
  const two = run(doc([rect("s1", 0, 40), ext("f1", "s1"), rect("s2", 40, 100), ext("f2", "s2", false)]), 2);
  console.log(JSON.stringify({ one, two }));
  // the contact faces are gone; the four long sides stay split in two
  assert.equal(two.faces, 10);
  assert.ok(Math.abs(two.vol - one.vol) / one.vol < 1e-6);
  assert.ok(Math.abs(two.tip - one.tip) / one.tip < 0.02, `tip ${two.tip} vs ${one.tip}`);
  assert.ok(Math.abs(two.hz - one.hz) / one.hz < 0.02, `hz ${two.hz} vs ${one.hz}`);
});

test("bodies apart stay apart: the study is refused", async () => {
  const oc = await occ();
  const m = new Modeller(oc);
  const r = m.evaluate(doc([rect("s1", 0, 40), ext("f1", "s1"), rect("s2", 50, 100), ext("f2", "s2", false)]));
  const b = m.bonded(r.body!);
  assert.deepEqual([b.parts, b.solids], [2, 2]);
});
