// Power cases in a thermal study (FRS-thermal FR-TSTU-005): each case solves its own heat sources with the same
// cooling, and the envelope keeps the hottest of them at every point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem, envelope } from "../../src/sim/run";
import { newStudy, newCase, caseStudy } from "../../src/sim/types";

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

test("power cases: each case heats with its own sources, the envelope is the hottest of them", () => {
  const st = newStudy([], "thermal");
  // 10 W into the left end, 4 W into the right end; the bar's bottom is held at 30 °C
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x0" }], value: { v: 10 } }, { id: "l2", type: "heat", faces: [{ name: "x1" }], value: { v: 4 } });
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "z0" }], temp: 30 });
  const idle = newCase(st); idle.off = ["l1"]; st.cases = [idle];
  const full = newCase(st); st.cases.push(full);
  assert.deepEqual([idle.name, full.name], ["Case 1", "Case 2"]);
  // a case leaves its unticked loads out and keeps the cooling
  const sIdle = caseStudy(st, idle);
  assert.deepEqual(sIdle.suppressed, ["l1"]);
  assert.equal(thermalSetup(sIdle, body).sinkIds.length, 1);
  const a = run(sIdle), b = run(caseStudy(st, full));
  assert.ok(Math.abs(a.thermal!.applied - 4) < 1e-9 && Math.abs(b.thermal!.applied - 14) < 1e-9);
  // heat at the right end only: that end is hotter than the left one; with both, the left end is the hottest
  assert.ok(a.vm[1] > a.vm[0], `idle ${a.vm[0]} ${a.vm[1]}`);
  assert.ok(b.vm[0] > b.vm[1] && b.thermal!.max > a.thermal!.max);
  // linear: the full case is the idle case plus the left source alone
  const left = { ...st, suppressed: ["l2"] }, c = run(left);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs((b.vm[i] - 30) - (a.vm[i] - 30) - (c.vm[i] - 30)) < 1e-3 * (b.vm[i] - 30), `superposition at ${i}`);
  // the envelope of idle and left-only: at each point the hotter one
  const env = envelope([a, c]);
  for (let i = 0; i < 3; i++) assert.equal(env.vm[i], Math.max(a.vm[i], c.vm[i]));
  assert.equal(env.thermal!.max, Math.max(a.thermal!.max, c.thermal!.max));
  assert.equal(env.thermal!.min, Math.min(a.thermal!.min, c.thermal!.min));
  assert.equal(env.thermal!.flows.length, 0);
});
