// The summary card of thermal study results (FRS-thermal FR-TRES-002) and power in BTU/h (FR-TLOAD-010).
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSummary } from "../../src/sim/summary";
import { loadValue } from "../../src/sim/values";

test("a part: hottest and coolest are the part, heat balance and error from the last pass", () => {
  const s = thermalSummary({ part: "Bar", min: 31, max: 48.5, applied: 8, flows: [5, 2.99], errors: [null, 1.2, 0.4] });
  assert.deepEqual(s.hot, { name: "Bar", t: 48.5 });
  assert.deepEqual(s.cold, { name: "Bar", t: 31 });
  assert.equal(s.balance!.put, 8);
  assert.ok(Math.abs(s.balance!.off - 0.125) < 1e-9, String(s.balance!.off));
  assert.deepEqual(s.error, { v: 0.4, bound: false });
  assert.equal(s.over, null, "no limits, no line");
  assert.equal(s.life, null);
});

test("components: the hottest and the coolest by name; parts over limits and the shortest life", () => {
  const s = thermalSummary({
    part: "Amp", min: 25, max: 90,
    comps: [{ name: "Board", min: 40, max: 70 }, { name: "Q2", min: 60, max: 90 }, { name: "Heatsink", min: 33, max: 52 }],
    applied: 10, flows: [10], errors: [2, null], over: 1, limited: 3,
    lives: [{ name: "C12", h: 19000 }, { name: "C3", h: 8000 }],
  });
  assert.deepEqual(s.hot, { name: "Q2", t: 90 });
  assert.deepEqual(s.cold, { name: "Heatsink", t: 33 });
  assert.equal(s.balance!.off, 0);
  assert.deepEqual(s.error, { v: 2, bound: true }, "the last pass has no estimate yet: the one before is a bound");
  assert.equal(s.over, 1);
  assert.deepEqual(s.life, { name: "C3", h: 8000 });
});

test("a transient time: no balance or error lines", () => {
  const s = thermalSummary({ part: "Plate", min: 20, max: 41 });
  assert.equal(s.balance, null);
  assert.equal(s.error, null);
  assert.equal(s.hot.t, 41);
});

test("power typed in BTU/h", () => {
  assert.ok(Math.abs(loadValue("10 BTU/h", "heat") - 2.9307107) < 1e-9);
  assert.ok(Math.abs(loadValue("3.412 Btu/h", "pkgheat") - 0.99995849) < 1e-6);
  assert.equal(loadValue("2 W + 500 mW", "heat"), 2.5);
});
