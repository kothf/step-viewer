// Volume heat in a thermal study (FRS-thermal FR-TLOAD-003): W/m³ made throughout the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { loadValue } from "../../src/sim/values";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 100, B = 20, T = 20, K = 54;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
// the left end, the right end and the middle
const pos = new Float32Array([0, B / 2, T / 2, L, B / 2, T / 2, L / 2, B / 2, T / 2]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0, 0]);
const run = (st: ReturnType<typeof newStudy>) => [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 3, energyTol: 0, pos, nrm, thermal: { k: K * 1e-3, setup: thermalSetup(st, body) } })].at(-1)!;

test("volume heat: W/m³ times the volume, the same as that power made throughout the body", () => {
  // 1e5 W/m³ in 100 × 20 × 20 mm = 4e-5 m³ → 4 W; both ends held at 30 °C, the sides insulated
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "vheat", faces: [], value: { v: 1e5 } });
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "x0" }, { name: "x1" }], temp: 30 });
  const set = thermalSetup(st, body);
  assert.equal(set.problems.length, 0);
  assert.equal(set.sources[0].density, 1e-4);
  const a = run(st);
  assert.ok(Math.abs(a.thermal!.applied - 4) < 1e-9, `applied ${a.thermal!.applied}`);
  // a slab with uniform heat: the middle rises q L² / (8 k) above the ends
  const rise = (1e-4 * L * L) / (8 * K * 1e-3);
  assert.ok(Math.abs(a.vm[2] - 30 - rise) < 0.01 * rise, `middle ${a.vm[2] - 30} vs ${rise}`);
  assert.ok(Math.abs(a.vm[0] - 30) < 0.02 * rise && Math.abs(a.vm[1] - 30) < 0.02 * rise);
  // the same as 4 W of Heat power throughout the body
  const st2 = newStudy([], "thermal");
  st2.loads.push({ id: "l1", type: "heat", body: true, faces: [], value: { v: 4 } });
  st2.supports = st.supports;
  const b = run(st2);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.vm[i] - b.vm[i]) < 1e-6, `point ${i}`);
});

test("volume heat: typed units", () => {
  assert.equal(loadValue("0.1 W/cm³", "vheat"), 1e5);
  assert.equal(loadValue("2 kW/m3", "vheat"), 2000);
  assert.equal(loadValue("1 Вт/см³", "vheat"), 1e6);
});
