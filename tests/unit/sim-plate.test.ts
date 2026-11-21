// Structural analysis SA2 (AT-SA2-3): the free thin square plate of the NAFEMS free vibration set (FV12),
// scaled to 1000 × 1000 × 5 mm: E = 200 GPa, nu = 0.3, rho = 8000 kg/m³. Reference 1.622, 2.360, 2.922,
// 4.233, 4.233 Hz for the 10 m plate; frequencies go with t / L², so ×10 here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveStatic } from "../../src/sim/static";

const L = 1000, T = 5, E = 200000, rho = 8e-9;
const lo = [0, 0, -T / 2], hi = [L, L, T / 2];
const inside = (x: number, y: number, z: number) => x >= -1e-12 && x <= L + 1e-12 && y >= -1e-12 && y <= L + 1e-12 && Math.abs(z) <= T / 2 + 1e-12;
const REF = [16.22, 23.60, 29.22, 42.33, 42.33];

test("free thin square plate: the first five elastic frequencies match the benchmark", () => {
  let start: Float64Array[] | undefined, grid;
  const H = Number(process.env.PLATE_H ?? 250);
  for (const p of [2, 3, 4]) {
    const t0 = Date.now();
    const r = solveStatic({ lo, hi, inside, h: H, p, grid, mat: { E, nu: 0.3, rho }, fixed: [], loads: [], modal: { count: 11, start } });
    grid = r.grid; start = r.space;
    const m = r.modes!, el = m.filter(v => !v.rigid).map(v => v.hz);
    console.log(`p ${p} dofs ${r.dofs} ${Date.now() - t0} ms rigid ${m.filter(v => v.rigid).length}`, el.map(v => v.toFixed(2)).join(" "));
    if (p === 4) {
      assert.equal(m.filter(v => v.rigid).length, 6);
      REF.forEach((f, i) => assert.ok(Math.abs(el[i] / f - 1) < 0.02, `mode ${i + 1}: ${el[i]} vs ${f}`));
    }
  }
});
