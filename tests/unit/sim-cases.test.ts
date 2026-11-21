// Structural analysis: load cases (FR-LOAD-022). Each case solves the study with its own loads; the envelope holds
// the highest values of them all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, envelope } from "../../src/sim/run";
import { caseStudy, newCase, newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 100, B = 20, T = 10, E = 210000;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
const study = () => {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: [{ v: 0 }, { v: 0 }, { v: -100 }] });
  st.loads.push({ id: "l2", type: "force", faces: [{ name: "x1" }], comp: [{ v: 0 }, { v: 150 }, { v: 0 }] });
  return st;
};
// the free end's middle, the middle of the top and a point near the clamp
const pos = new Float32Array([L, B / 2, T / 2, L / 2, B / 2, T, 5, B / 2, T]), nrm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 1]);
const run = (st: ReturnType<typeof study>) => [...runStatic({ body, mat: { name: "Steel", E, nu: 0.3, rho: 7.85e-9 }, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm })].at(-1)!;

test("load cases: names, ids and the loads a case leaves out", () => {
  const st = study();
  const a = newCase(st);
  st.cases = [a];
  const b = newCase(st);
  st.cases.push(b);
  assert.deepEqual([a.id, a.name, b.id, b.name], ["c1", "Case 1", "c2", "Case 2"]);
  b.off = ["l1", "gone"];
  st.suppressed = ["l2"];
  assert.deepEqual(caseStudy(st, a).suppressed, ["l2"]);
  assert.deepEqual(caseStudy(st, b).suppressed, ["l2", "l1"]);
  assert.equal(studyProblem(caseStudy({ ...st, suppressed: [] }, b), body).loads.length, 1);
});

test("load cases: each solves its own loads, together they add up, and the envelope holds the highest", () => {
  const st = study();
  st.cases = [{ id: "c1", name: "Down", off: ["l2"] }, { id: "c2", name: "Side", off: ["l1"] }];
  const down = run(caseStudy(st, st.cases[0])), side = run(caseStudy(st, st.cases[1])), both = run(st);
  // a cantilever: the tip moves down under the first load and sideways under the second
  const I1 = (B * T ** 3) / 12, I2 = (T * B ** 3) / 12;
  assert.ok(Math.abs(down.u[2] / (-100 * L ** 3 / (3 * E * I1)) - 1) < 0.05, `tip down ${down.u[2]}`);
  assert.ok(Math.abs(side.u[1] / (150 * L ** 3 / (3 * E * I2)) - 1) < 0.08, `tip sideways ${side.u[1]}`);
  assert.ok(Math.abs(down.applied.force[2] + 100) < 1e-6 && Math.abs(side.applied.force[1] - 150) < 1e-6);
  // linear: the two cases add up to the study with both loads
  for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(down.u[i] + side.u[i] - both.u[i]) < 1e-6 + 1e-6 * Math.abs(both.u[i]), `u[${i}]`);
  const env = envelope([down, side]);
  for (let i = 0; i < 3; i++) {
    assert.equal(env.vm[i], Math.max(down.vm[i], side.vm[i]));
    const a = Math.hypot(down.u[3 * i], down.u[3 * i + 1], down.u[3 * i + 2]), b = Math.hypot(side.u[3 * i], side.u[3 * i + 1], side.u[3 * i + 2]);
    assert.ok(Math.abs(Math.hypot(env.u[3 * i], env.u[3 * i + 1], env.u[3 * i + 2]) - Math.max(a, b)) < 1e-9);
  }
  assert.equal(env.maxVm, Math.max(down.maxVm, side.maxVm));
  assert.equal(env.maxU, Math.max(down.maxU, side.maxU));
  assert.equal(env.reactions.length, 0);
  assert.ok(env.done);
});
