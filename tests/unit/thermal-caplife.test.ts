// Capacitor life on study results (FRS-thermal FR-TBRD-022): a rated life at the part's limit gives hours by the 10 °C rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardPlan, partTemps } from "../../src/thermal/study";
import type { ThermalManifest } from "../../src/thermal/package";

const maxOf = (c: string) => ({ c1: 85, c2: 105, c3: 115 } as Record<string, number>)[c];

test("an electrolytic with a rated life at its limit gets its life at the solved temperature", () => {
  const [a, b, c] = partTemps([
    { name: "C1", p: 0, comps: ["c1"], limit: 105, life: 2000 },
    { name: "C2", p: 0, comps: ["c2"], limit: 105, life: 2000 },
    { name: "C3", p: 0, comps: ["c3"], limit: 105, life: 2000 },
  ], maxOf);
  assert.equal(a.life, 8000); // 20 °C cooler: twice doubled
  assert.equal(b.life, 2000);
  assert.equal(c.life, 1000);
  assert.equal(c.over, true);
});

test("no life without a limit or without a rated life", () => {
  const [a, b] = partTemps([{ name: "C1", p: 0, comps: ["c1"], life: 2000 }, { name: "C2", p: 0, comps: ["c2"], limit: 105 }], maxOf);
  assert.equal(a.life, undefined);
  assert.equal(b.life, undefined);
});

test("the board plan carries the package's rated life", () => {
  const man = { format: "tubecad-thermal", version: 1, settings: {}, parts: [{ id: 1, designator: "C5", p: 0.1, limit: 105, ratedLife: 5000, stepBodies: [] }, { id: 2, designator: "R1", p: 1, limit: 155, stepBodies: [] }] } as unknown as ThermalManifest;
  const plan = boardPlan(man, { bodies: new Map([[1, [0]], [2, [1]]]) } as never, [{ name: "C5", box: [0, 0, 0, 5, 5, 10] }, { name: "R1", box: [10, 0, 0, 15, 5, 3] }] as never);
  assert.equal(plan.heat.find(h => h.name === "C5")?.life, 5000);
  assert.equal(plan.heat.find(h => h.name === "R1")?.life, undefined);
});
