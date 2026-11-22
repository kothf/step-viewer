// Bolted joints in thermal studies (FRS-thermal FR-TCON-003): the conductance a bolted pair passes heat by.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkConductance, BOLTED_TCC, DEFAULT_TCC, THERMAL_LINK_TYPES } from "../../src/sim/types";
import { fastenerPart } from "../../src/asm/fasteners";

test("a bolted joint passes heat by its own default conductance unless one is typed", () => {
  assert.equal(linkConductance({ type: "bolted" }), BOLTED_TCC * 1e-6);
  assert.equal(linkConductance({ type: "bolted", h: 20000 }), 20000 * 1e-6);
  assert.equal(linkConductance({ type: "resist" }), DEFAULT_TCC * 1e-6);
  assert.notEqual(BOLTED_TCC, DEFAULT_TCC);
});

test("bolted and perfect links are thermal choices a structural study leaves out", () => {
  for (const k of ["bolted", "perfect", "resist", "pad"]) assert.ok(THERMAL_LINK_TYPES.has(k), k);
  for (const k of ["none", "sliding", "adhesive"]) assert.ok(!THERMAL_LINK_TYPES.has(k), k);
});

test("toolbox parts are steel that conducts heat", () => {
  const m = fastenerPart("iso4762", "M6", 16).material;
  assert.ok(m && m.k && m.k > 40 && m.cp && m.cp > 400, JSON.stringify(m));
});
