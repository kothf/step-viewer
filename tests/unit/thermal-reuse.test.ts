// Matrix reuse (FRS-thermal FR-TSOL-021): a solve where only powers, ambients or fixed temperatures changed reuses
// the grid, matrix and factorisation of the one before, and gives what a fresh solve gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { dropReuse, reusedSolves } from "../../src/sim/thermal";
import * as thermal from "../../src/sim/thermal";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const lo = [0, 0, 0], hi = [100, 20, 20];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
const pos = new Float32Array([0, 10, 10, 100, 10, 10, 50, 10, 10]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0, 0]);
const study = (power: number, held: number, ambient: number, h = 10) => {
  const st = newStudy([], "thermal");
  st.settings.ambient = ambient;
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x0" }], value: { v: power } });
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "x1" }], temp: held });
  st.supports.push({ id: "s2", type: "conv", faces: [{ name: "y0" }, { name: "y1" }], h });
  return st;
};
const run = (st: ReturnType<typeof newStudy>) => [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 3, energyTol: 0, pos, nrm, thermal: { k: 0.054, setup: thermalSetup(st, body) } })];
const used = () => (thermal as unknown as { reusedSolves: number }).reusedSolves;

test("a second solve with other powers, ambient and fixed temperature reuses every pass's factorisation", () => {
  dropReuse();
  const n0 = used();
  run(study(10, 40, 25));
  assert.equal(used(), n0, "the first solve builds everything");
  const again = run(study(25, 60, 35));
  assert.equal(used(), n0 + 3, "all three passes reused");
  dropReuse();
  const fresh = run(study(25, 60, 35));
  for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) assert.ok(Math.abs(again[k].vm[i] - fresh[k].vm[i]) < 1e-9, `pass ${k} point ${i}: ${again[k].vm[i]} vs ${fresh[k].vm[i]}`);
  assert.ok(Math.abs(again[2].thermal!.applied - 25) < 1e-9);
  const out = again[2].thermal!.flows.reduce((a, f) => a + f.out, 0);
  assert.ok(Math.abs(out - 25) < 1e-6, `heat out ${out}`);
});

test("a change to a film coefficient builds the matrix again", () => {
  dropReuse();
  run(study(10, 40, 25));
  const n0 = used();
  run(study(10, 40, 25, 30));
  assert.equal(used(), n0);
  assert.ok(typeof reusedSolves === "number");
});
