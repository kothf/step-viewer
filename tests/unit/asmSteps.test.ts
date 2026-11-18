// Assembly undo step names (exam #73).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepName } from "../../src/asm/steps";
import { IDENTITY, translation } from "../../src/asm/math";
import type { AsmDoc } from "../../src/asm/types";

const base = (): AsmDoc => ({
  schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 }, parts: {},
  components: [{ id: "p", name: "plate<1>", part: "plate", tf: IDENTITY, fixed: true }, { id: "q", name: "pin<1>", part: "pin", tf: IDENTITY }],
  mates: [{ id: "m1", name: "Concentric1", type: "concentric", a: { comp: "p", face: "h" }, b: { comp: "q", face: "s" } }],
} as AsmDoc);

test("undo steps are named by what changed", () => {
  const a = base();
  const moved = base(); moved.components[1].tf = translation([1, 0, 0]);
  assert.deepEqual(stepName(a, moved), { key: "Move {name}", params: { name: "pin<1>" } });
  const two = base(); two.components[0].tf = translation([0, 1, 0]); two.components[1].tf = translation([1, 0, 0]);
  assert.deepEqual(stepName(a, two), { key: "Move {n} components", params: { n: 2 } });
  const mate = base(); mate.mates!.push({ id: "m2", name: "Coincident1", type: "coincident", a: { comp: "p", face: "t" }, b: { comp: "q", face: "u" } }); mate.components[1].tf = translation([0, 0, 3]);
  assert.deepEqual(stepName(a, mate), { key: "Add {name}", params: { name: "Coincident1" } });
  assert.deepEqual(stepName(mate, a), { key: "Delete {name}", params: { name: "Coincident1" } });
  const ins = base(); ins.components.push({ id: "r", name: "nut<1>", part: "nut", tf: IDENTITY });
  assert.deepEqual(stepName(a, ins), { key: "Insert {name}", params: { name: "nut<1>" } });
  const ed = base(); ed.mates![0].flip = true;
  assert.deepEqual(stepName(a, ed), { key: "Edit {name}", params: { name: "Concentric1" } });
  const hid = base(); hid.components[1].hidden = true;
  assert.deepEqual(stepName(a, hid), { key: "Change {name}", params: { name: "pin<1>" } });
  assert.deepEqual(stepName(a, base()), { key: "Change the assembly" });
});
