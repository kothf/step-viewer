// The "looks like a board" hint (FRS-thermal FR-TPKG-005): which models count as circuit boards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeBoard, DESIGNATOR } from "../../src/thermal/study";
import type { ModelBody } from "../../src/thermal/match";

const box = (x: number, y: number, z: number, at = 0): ModelBody["box"] => [at, 0, 0, at + x, y, z];

test("a body named board or PCB is a board", () => {
  assert.ok(looksLikeBoard([{ name: "Main PCB", box: box(10, 10, 10) }]));
  assert.ok(looksLikeBoard([{ name: "плата", box: box(10, 10, 10) }]));
  assert.ok(!looksLikeBoard([{ name: "Keyboard", box: box(10, 10, 10) }, { name: "Cover", box: box(10, 10, 10) }]));
});

test("three or more parts named by designators make a board", () => {
  const parts = ["R1", "C12", "U101_1", "Housing"].map(n => ({ name: n, box: box(5, 5, 5) }));
  assert.ok(looksLikeBoard(parts));
  assert.ok(!looksLikeBoard(parts.slice(1)), "two designators are not enough");
  assert.ok(DESIGNATOR.test("Q2") && DESIGNATOR.test("R14 (1)") && !DESIGNATOR.test("Shaft2x") && !DESIGNATOR.test("Bracket"));
});

test("a thin flat body larger than every other body is a board", () => {
  const plate = { name: "Solid1", box: box(100, 80, 1.6) };
  const caps = [{ name: "Solid2", box: box(10, 10, 12, 5) }, { name: "Solid3", box: box(20, 6, 8, 30) }];
  assert.ok(looksLikeBoard([plate, ...caps]));
  assert.ok(!looksLikeBoard([plate]), "a lone plate is a sheet, not a board");
  assert.ok(!looksLikeBoard([plate, { name: "Solid4", box: box(120, 90, 30) }]), "a body with a larger footprint");
  assert.ok(!looksLikeBoard([{ name: "Block", box: box(100, 80, 40) }, ...caps]), "nothing thin and flat");
  assert.ok(!looksLikeBoard([]));
});
