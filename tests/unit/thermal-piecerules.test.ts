// Rules of surface pieces by their element's degree (1.742.0): a piece of a surface triangle lies in one cell and
// integrates products of two functions of that cell's element, so with local degrees it needs far fewer points than
// the highest degree's rule gives. Polynomials are integrated exactly either way: the answers agree to rounding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, setPieceRules, type ThermalProblem } from "../../src/sim/thermal";

// a 20-sided column, r 9, z 0..30: its side is many planes, so few of its points are fitted per plane
const N = 20, R = 9, H = 30, cx = 11, cy = 11;
const ring = Array.from({ length: N }, (_, i) => [cx + R * Math.cos(2 * Math.PI * i / N), cy + R * Math.sin(2 * Math.PI * i / N)]);
const side: number[] = [], bottom: number[] = [], top: number[] = [];
for (let i = 0; i < N; i++) {
  const a = ring[i], b = ring[(i + 1) % N];
  side.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], H, a[0], a[1], 0, b[0], b[1], H, a[0], a[1], H);
  bottom.push(cx, cy, 0, b[0], b[1], 0, a[0], a[1], 0);
  top.push(cx, cy, H, a[0], a[1], H, b[0], b[1], H);
}
function inside(x: number, y: number, z: number): boolean {
  if (z < 0 || z > H) return false;
  for (let i = 0; i < N; i++) {
    const a = ring[i], b = ring[(i + 1) % N];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}
const problem = (p: number, degrees?: Uint8Array, grid?: ThermalProblem["grid"]): ThermalProblem => ({
  lo: [0, 0, 0], hi: [22, 22, 30], inside, h: 7.4, p, k: 0.05, grid, degrees,
  sinks: [{ tris: bottom, temp: 20 }, { tris: side, h: 4e-5, ambient: 25 }, { tris: top, h: 2e-5, ambient: 25 }],
  sources: [{ power: 3 }],
});

test("surface pieces integrated by their own element's degree give the same temperatures", () => {
  const first = solveThermal(problem(2));
  const nel = first.grid.elems.length, degrees = Uint8Array.from({ length: nel }, (_, e) => (e % 3 === 0 ? 4 : 2));
  setPieceRules(false);
  const a = solveThermal(problem(4, degrees, first.grid));
  setPieceRules(true);
  const b = solveThermal(problem(4, degrees, first.grid));
  let d = 0, m = 0;
  for (let i = 0; i < a.x.length; i++) { d = Math.max(d, Math.abs(a.x[i] - b.x[i])); m = Math.max(m, Math.abs(a.x[i])); }
  assert.ok(d < 1e-8 * m, `coefficients differ by ${d} of ${m}`);
  for (let i = 0; i < a.flows.length; i++) {
    assert.ok(Math.abs(a.flows[i].out - b.flows[i].out) < 1e-9 * Math.abs(a.flows[i].out) + 1e-12, `flow ${i}`);
    assert.ok(Math.abs(a.flows[i].area - b.flows[i].area) < 1e-10 * a.flows[i].area);
  }
  // the heat balance holds
  const out = b.flows.reduce((s, f) => s + f.out, 0);
  assert.ok(Math.abs(out - b.applied) < 1e-6 * b.applied, `${out} vs ${b.applied}`);
});
