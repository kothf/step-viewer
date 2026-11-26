// Add surroundings: a thermal study with no way out for its heat (a Tube Amp CAD export with heat sources only) gets still air and radiation on every open surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newStudy, hasSurroundings, addSurroundings } from "../../src/sim/types";

test("a study with only heat sources has no surroundings; Add surroundings gives convection and radiation on all open surfaces", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", name: "Heat from package 1", type: "pkgheat", faces: [], parts: [] });
  assert.equal(hasSurroundings(st), false);
  addSurroundings(st);
  assert.equal(hasSurroundings(st), true);
  assert.deepEqual(st.supports.map(s => [s.type, s.all, s.natural ?? false, s.emis ?? null]), [["conv", true, true, null], ["rad", true, false, 0.9]]);
  assert.notEqual(st.supports[0].id, st.supports[1].id);
});

test("insulated faces or radiation between faces alone are no way out; a suppressed convection does not count", () => {
  const st = newStudy([], "thermal");
  st.supports.push({ id: "s1", type: "insul", faces: [] }, { id: "s2", type: "radx", faces: [] }, { id: "s3", type: "conv", faces: [], all: true });
  st.suppressed = ["s3"];
  assert.equal(hasSurroundings(st), false);
  st.suppressed = [];
  assert.equal(hasSurroundings(st), true);
});
