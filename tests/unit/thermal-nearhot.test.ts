// Electrolytics next to a hot part (FRS-thermal FR-TBRD-023).
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxGap, isElectrolytic, nearHot, NEAR_GAP, problems, type PartStat, type ThermalPart } from "../../src/thermal/package";

test("box gap is the shortest distance between the boxes, 0 when they touch", () => {
  assert.equal(boxGap([0, 0, 0, 1, 1, 1], [1, 0, 0, 2, 1, 1]), 0);
  assert.equal(boxGap([0, 0, 0, 1, 1, 1], [4, 5, 0, 5, 6, 1]), 5);
});

test("an electrolytic is one with a life figure or named so", () => {
  assert.ok(isElectrolytic({ part: "47u 450V", life: 19000 }));
  assert.ok(isElectrolytic({ part: "100u electrolytic" }));
  assert.ok(!isElectrolytic({ part: "100n X7R" }));
});

test("each electrolytic gets the nearest part over 1 W within 10 mm; cool or far parts do not count", () => {
  const out = nearHot([
    { id: 1, box: [0, 0, 0, 10, 10, 10], p: 0.05, elyt: true },
    { id: 2, box: [14, 0, 0, 20, 10, 10], p: 3, elyt: false }, // 4 mm away, 3 W
    { id: 3, box: [-8, 0, 0, -2, 10, 10], p: 5, elyt: false }, // 2 mm away, 5 W: the nearest
    { id: 4, box: [0, -3, 0, 10, -1, 10], p: 0.9, elyt: false }, // close but under 1 W
    { id: 5, box: [40, 0, 0, 50, 10, 10], p: 0.1, elyt: true }, // nothing hot near
    { id: 6, box: [62, 0, 0, 70, 10, 10], p: 20, elyt: false }, // 12 mm from 5: too far
  ]);
  assert.deepEqual(out, [{ cap: 1, hot: 3, gap: 2, p: 5 }]);
});

test("the problems list warns about such a capacitor after the parts over their limits", () => {
  const parts: ThermalPart[] = [
    { id: 1, designator: "C1", bodies: [], part: "220u", p: 0.02, life: 50000, limit: 105 },
    { id: 2, designator: "R1", bodies: [], part: "1k 3W", p: 2.5, limit: 100 },
  ];
  const stats = new Map<number, PartStat>([
    [1, { tris: 4, min: 50, max: 64, at: [5, 5, 10], box: [0, 0, 0, 10, 10, 10] }],
    [2, { tris: 4, min: 90, max: 110, at: [18, 5, 3], box: [16, 0, 0, 20, 10, 6] }],
  ]);
  const ps = problems({ manifest: { parts } as never }, stats);
  assert.deepEqual(ps.map(p => p.kind), ["over", "near"]);
  assert.deepEqual({ id: ps[1].id, gap: ps[1].value, hot: ps[1].hot, p: ps[1].p, limit: ps[1].limit }, { id: 1, gap: 6, hot: 2, p: 2.5, limit: NEAR_GAP });
});
