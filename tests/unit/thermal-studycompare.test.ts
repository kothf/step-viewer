// Comparing thermal results (FRS-thermal FR-TRES-030): with the study's own result before the last change, or another thermal study.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRows, noteSummary, parseSummaries, type Summary } from "../../src/sim/compare";

const s = (o: Partial<Summary>): Summary => ({ kind: "thermal", name: "T", key: "k", at: 1, ...o });

test("temperatures differ in K, the heat put in in %", () => {
  const rows = compareRows(s({ tmax: 80, tmin: 30, heat: 12 }), s({ tmax: 70, tmin: 30, heat: 10 }));
  assert.deepEqual(rows.map(r => r.key), ["tmax", "tmin", "heat"]);
  assert.equal(rows[0].diff, 10);
  assert.equal(rows[0].change, null);
  assert.equal(rows[1].diff, 0);
  assert.equal(rows[2].change, 20);
  assert.equal(rows[2].diff, undefined);
});

test("components are matched by name, this result's hottest first, then the other's own", () => {
  const rows = compareRows(
    s({ tmax: 90, tmin: 25, comps: [{ name: "Heatsink", max: 60 }, { name: "U1", max: 90 }] }),
    s({ tmax: 95, tmin: 25, comps: [{ name: "U1", max: 95 }, { name: "Fan", max: 40 }, { name: "Heatsink", max: 62 }] }));
  const c = rows.filter(r => r.key.startsWith("c:"));
  assert.deepEqual(c.map(r => r.key), ["c:U1", "c:Heatsink", "c:Fan"]);
  assert.equal(c[0].diff, -5);
  assert.equal(c[1].diff, -2);
  assert.equal(c[2].a, null);
  assert.equal(c[2].diff, null);
});

test("a steady result is not compared with a warm-up or a static one", () => {
  assert.deepEqual(compareRows(s({ tmax: 1 }), s({ kind: "warm", tmax: 2 })), []);
  assert.deepEqual(compareRows(s({ tmax: 1 }), { kind: "static", name: "S", key: "x", at: 1, maxVm: 3 }), []);
});

test("thermal summaries are kept and read back, a new state moving the older one to before", () => {
  let store = noteSummary({}, "st1", s({ key: "a", tmax: 70, tmin: 25, heat: 5, comps: [{ name: "U1", max: 70 }] }));
  store = noteSummary(store, "st1", s({ key: "b", tmax: 75, tmin: 25, heat: 6 }));
  const back = parseSummaries(JSON.stringify(store));
  assert.equal(back.st1.now?.tmax, 75);
  assert.equal(back.st1.before?.tmax, 70);
  assert.deepEqual(back.st1.before?.comps, [{ name: "U1", max: 70 }]);
  assert.equal(parseSummaries(JSON.stringify({ x: { now: { kind: "warm", name: "W", key: "k", at: 1, tmax: 50, comps: [{ name: 3 }] } } })).x.now?.comps?.length, 0);
});
