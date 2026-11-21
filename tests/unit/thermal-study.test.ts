// A thermal study from a board's STEP and its package (FRS-thermal J5, FR-TBRD-001/002/010/011): the plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_MATERIAL, DEFAULT_STACK, GUESS, K_FR4, boardConductivity, boardPlan, findBoard, guessMaterial } from "../../src/thermal/study";
import type { ModelBody, PartMatch } from "../../src/thermal/match";
import type { ThermalManifest, ThermalPart } from "../../src/thermal/package";
import { findMaterial } from "../../src/tools/materials";

test("board conductivity: copper in parallel along the board, in series through it (FR-TBRD-010)", () => {
  const b = boardConductivity(1.6);
  // 2 × 35 µm at 40 % cover in 1.6 mm
  const share = (0.07 * 0.4) / 1.6;
  assert.ok(Math.abs(b.along - (K_FR4 * (1 - share) + 390 * share)) < 1e-9 && b.along > 7 && b.along < 7.3, `${b.along}`);
  assert.ok(b.through > K_FR4 && b.through < 0.35, `${b.through}`);
  assert.ok(b.density > 1.85 && b.density < 2.1 && b.cp > 900 && b.cp < 1100);
  // no copper: plain laminate; solid copper planes carry much more
  const bare = boardConductivity(1.6, { ...DEFAULT_STACK, cover: 0 });
  assert.ok(Math.abs(bare.along - K_FR4) < 1e-12 && Math.abs(bare.through - K_FR4) < 1e-12);
  assert.ok(boardConductivity(1.6, { layers: 4, copper: 70, cover: 0.9 }).along > 60);
  assert.equal(BOARD_MATERIAL, "PCB (effective)");
});

const body = (name: string, box: ModelBody["box"]): ModelBody => ({ name, box });

test("the board is the body named so, else the largest thin flat one", () => {
  const list = [body("C1", [0, 0, 1.6, 10, 10, 20]), body("", [0, 0, 0, 120, 80, 1.6]), body("shield", [0, 0, 30, 40, 30, 30.5])];
  assert.equal(findBoard(list), 1);
  assert.equal(findBoard(list, new Set([1])), 2);
  assert.equal(findBoard([...list, body("Main PCB", [0, 0, -10, 20, 20, -8])]), 3);
  assert.equal(findBoard([body("block", [0, 0, 0, 10, 10, 10])]), -1);
});

test("materials guessed from what a part is (FR-TBRD-011): every guess is a library material with a conductivity", () => {
  const g = (designator: string, part: string, name = "", more: Partial<ThermalPart> = {}) => guessMaterial({ designator, part, ...more }, name);
  assert.equal(g("R14", "470R 5W"), GUESS.resistor);
  assert.equal(g("V3", "EL84"), GUESS.glass);
  assert.equal(g("C12", "47u 450V electrolytic"), GUESS.can);
  assert.equal(g("C3", "100n"), GUESS.plastic);
  assert.equal(g("Q2", "IRF820", "", { path: "heatsink" }), GUESS.metal);
  assert.equal(g("T1", "output transformer"), GUESS.iron);
  assert.equal(guessMaterial(null, "Heatsink SK104"), GUESS.sink);
  assert.equal(guessMaterial(null, "screw"), GUESS.plastic);
  for (const name of Object.values(GUESS)) assert.ok((findMaterial(name)?.k ?? 0) > 0, name);
});

test("the plan of a board study: board, names, materials and the heat of every part", () => {
  const parts = [
    { id: 1, designator: "V3", bodies: ["V3"], part: "EL84", p: 18.2, limit: 250 },
    { id: 2, designator: "R14", bodies: ["R14"], part: "470R 5W", p: 3.1, limit: 155 },
    { id: 3, designator: "Q9", bodies: ["Q9"], part: "IRF820", p: 4, path: "heatsink" },
  ] as ThermalPart[];
  const man = { parts, settings: { ambient: 40, emissivity: 0.85 } } as ThermalManifest;
  const bodies = [body("", [0, 0, 0, 120, 80, 1.6]), body("V3", [34, 51, 1.6, 56, 73, 61.6]), body("R14", [33, 26, 2, 57, 33, 8.5]), body("standoff", [2, 2, -6, 6, 6, 0])];
  const match = { bodies: new Map([[1, [1]], [2, [2]]]), by: new Map(), missing: [3], changed: [], off: 0, shift: [0, 0, 0] } as PartMatch;
  const plan = boardPlan(man, match, bodies);
  assert.equal(plan.board, 0);
  assert.ok(Math.abs(plan.thickness - 1.6) < 1e-12);
  assert.deepEqual(plan.names, ["PCB", "V3", "R14", ""]);
  assert.deepEqual(plan.mats, ["", GUESS.glass, GUESS.resistor, GUESS.plastic]);
  assert.deepEqual(plan.heat, [{ id: 1, name: "V3", bodies: [1], p: 18.2, limit: 250 }, { id: 2, name: "R14", bodies: [2], p: 3.1, limit: 155 }, { id: 3, name: "Q9", bodies: [], p: 4 }]);
  // a part without a body in the model makes no heat
  assert.ok(Math.abs(plan.power - 21.3) < 1e-9);
  assert.equal(plan.ambient, 40);
  assert.equal(plan.emissivity, 0.85);
});
