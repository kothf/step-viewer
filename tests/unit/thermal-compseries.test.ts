// Transient results per component (FRS-thermal FR-TRES-006): each component's highest temperature over time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { componentSeries, timeToReach, transientCsv } from "../../src/sim/transient";

const st = (max: number[]) => max.map(m => ({ min: m ? 20 : 0, max: m, mean: m ? (m + 20) / 2 : 0 }));

test("components come hottest at the end first, empty ones left out", () => {
  const cstats = [st([20, 20, 0]), st([40, 30, 0]), st([50, 70, 0])];
  const s = componentSeries(cstats, ["board", "heatsink", "gone"]);
  assert.deepEqual(s.map(x => x.name), ["heatsink", "board"]);
  assert.deepEqual(Array.from(s[0].v), [20, 30, 70]);
  assert.equal(s[1].d, 0);
  assert.equal(componentSeries([], ["a"]).length, 0);
});

test("time to reach and CSV columns work on component series", () => {
  const times = [0, 10, 20];
  const s = componentSeries([st([20]), st([40]), st([60])], ["R1"]);
  assert.equal(timeToReach(times, s[0].v, 50), 15);
  const csv = transientCsv(times, s.map(c => ({ name: `${c.name} max`, v: c.v })));
  assert.equal(csv.split("\n")[0], '"Time, s","R1 max, °C"');
  assert.equal(csv.split("\n")[3], "20,60");
});
