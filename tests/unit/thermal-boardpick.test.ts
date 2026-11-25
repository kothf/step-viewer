// Which component of an assembly a new thermal study treats as its circuit board by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardComponent } from "../../src/thermal/study";

/** A box as 12 triangles (9 numbers each). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const p = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const f = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]], out: number[] = [];
  for (const [a, b, c, d] of f) out.push(...p(a), ...p(b), ...p(c), ...p(a), ...p(c), ...p(d));
  return out;
}

test("a component named PCB, or of a board material, is the board", () => {
  assert.equal(boardComponent([{ name: "Heatsink", tris: box(0, 0, 0, 50, 50, 20) }, { name: "Main PCB<1>", tris: box(0, 0, 0, 10, 10, 10) }]), 1);
  assert.equal(boardComponent([{ name: "Part1<1>", tris: box(0, 0, 0, 5, 5, 5) }, { name: "Part2<1>", material: "PCB (effective)", tris: box(0, 0, 0, 10, 10, 10) }]), 1);
});

test("the largest thin plastic plate under smaller parts is the board", () => {
  const plate = { name: "Part3<1>", material: "FR4", k: 0.3, tris: box(0, 0, 0, 80, 60, 1.6) };
  assert.equal(boardComponent([{ name: "U1<1>", k: 0.6, tris: box(10, 10, 1.6, 20, 20, 3) }, plate]), 1);
  const g10 = { ...plate, material: "Glass epoxy" };
  assert.equal(boardComponent([{ name: "U1<1>", k: 0.6, tris: box(10, 10, 1.6, 20, 20, 3) }, g10]), 1);
});

test("no board: a heatsink with a transistor, a metal plate, a lone part, two equal plates", () => {
  assert.equal(boardComponent([{ name: "Heatsink<1>", k: 200, tris: box(0, 0, 0, 60, 40, 20) }, { name: "Q1<1>", k: 1, tris: box(10, 10, 20, 20, 25, 25) }]), -1);
  assert.equal(boardComponent([{ name: "Base<1>", k: 200, tris: box(0, 0, 0, 80, 60, 2) }, { name: "Q1<1>", k: 1, tris: box(10, 10, 2, 20, 25, 6) }]), -1);
  assert.equal(boardComponent([{ name: "Plate<1>", k: 0.3, tris: box(0, 0, 0, 80, 60, 2) }]), -1);
  assert.equal(boardComponent([{ name: "A<1>", k: 0.3, tris: box(0, 0, 0, 80, 60, 2) }, { name: "B<1>", k: 0.3, tris: box(0, 0, 2, 80, 60, 4) }]), -1);
});
