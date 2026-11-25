// Structural analysis: the terms of a held face are summed per element and written once (no enforced displacement),
// or added point by point (with one). Both must give the same answer: a face held is a face moved by nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const L = 100, B = 20, T = 10;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
const run = (support: object) => {
  const st = newStudy([], "static");
  st.supports.push(support as never);
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: [30, -200, 500].map(v => ({ v })) } as never);
  return [...runStatic({ body, mat: { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9 }, problem: studyProblem(st, body), passes: 3, energyTol: 0,
    pos: new Float32Array([L, B / 2, T / 2]), nrm: new Float32Array([1, 0, 0]), cells: 30 })];
};
const near = (a: number, b: number, rel: number, what: string) => assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)), `${what}: ${a} against ${b}`);

test("a held face gives the answer of the same face moved by nothing", () => {
  const held = run({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  const moved = run({ id: "s1", type: "disp", faces: [{ name: "x0" }], dirs: [true, true, true], disp: [0, 0, 0] });
  assert.equal(held.length, 3);
  for (let i = 0; i < 3; i++) {
    near(held[i].maxU, moved[i].maxU, 1e-9, `largest displacement, pass ${i + 1}`);
    near(held[i].maxVm, moved[i].maxVm, 1e-7, `largest stress, pass ${i + 1}`);
    for (let k = 0; k < 3; k++) near(held[i].reactions[0].force[k], moved[i].reactions[0].force[k], 1e-7, `reaction ${k}, pass ${i + 1}`);
  }
  // the beam bends as theory says: tip deflection F L³ / 3 E I for the load across the thin side
  const I = (B * T ** 3) / 12, tip = (500 * L ** 3) / (3 * 210000 * I);
  near(held[2].u[2], tip, 0.03, "tip deflection");
});

test("the held face carries the whole load", () => {
  const st = [...run({ id: "s1", type: "fixed", faces: [{ name: "x0" }] })][2];
  const sum = [0, 1, 2].map(k => st.reactions.reduce((a, r) => a + r.force[k], 0) + [30, -200, 500][k]);
  assert.ok(Math.hypot(...sum) < 1e-6 * 540, `unbalanced ${sum}`);
});
