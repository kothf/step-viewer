// Structural analysis: bodies of one part with their own materials. Each body keeps its stiffness and density;
// the bodies are joined where they touch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, runModal, domainsOf, type RunInput } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function box(lo: number[], hi: number[]) {
  const tris: number[] = [], face: number[] = [], names: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
    names.push("xyz"[a] + end);
    tris.push(...t);
    for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
  }
  return { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
}

const L = 100, B = 20, T = 10, F = 1000, A = B * T;
const steel = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9, sy: 235 }, alu = { name: "Aluminium", E: 70000, nu: 0.33, rho: 2.7e-9, sy: 100 };
const body = box([0, 0, 0], [L, B, T]);
// steel from 0 to 40, aluminium from 40 to 100: the joint is not on a cell face
const J = 40, regions = [{ tris: box([0, 0, 0], [J, B, T]).tris, mat: steel }, { tris: box([J, 0, 0], [L, B, T]).tris, mat: alu }];
// the middle of each body, either side of the joint, the far end
const pos = new Float32Array([J / 2, B / 2, T, (J + L) / 2, B / 2, T, J - 1, B / 2, T, J + 1, B / 2, T, L, B / 2, T / 2]);
const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0]);
const input = (st: ReturnType<typeof newStudy>, reg = regions, passes = 3): RunInput => ({ body, mat: steel, regions: reg, problem: studyProblem(st, body), passes, energyTol: 0, pos, nrm });

test("bodies with one material are solved as one piece", () => {
  const st = newStudy([]);
  assert.equal(domainsOf(input(st, [{ tris: regions[0].tris, mat: steel }, { tris: regions[1].tris, mat: { ...steel } }])), undefined);
  assert.equal(domainsOf(input(st))!.length, 2);
});

test("a bar of steel and aluminium in tension stretches as two springs in a row", () => {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "sliding", faces: [{ name: "x0" }] }, { id: "s2", type: "sliding", faces: [{ name: "y0" }] }, { id: "s3", type: "sliding", faces: [{ name: "z0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: [{ v: F }, { v: 0 }, { v: 0 }] });
  const r = [...runStatic(input(st))].at(-1)!;
  const u1 = (F * J) / (steel.E * A), u2 = u1 + (F * (L - J)) / (alu.E * A);
  // each body in its own domain
  assert.deepEqual(Array.from(r.dom!), [0, 1, 0, 1, 1]);
  assert.ok(Math.abs(r.u[12] / u2 - 1) < 0.01, `end ${r.u[12]} vs ${u2}`);
  // in the middle of each body (the different Poisson's ratios disturb the field beside the joint)
  assert.ok(Math.abs(r.u[0] / (u1 / 2) - 1) < 0.02, `middle of the steel ${r.u[0]}`);
  assert.ok(Math.abs(r.u[3] / ((u1 + u2) / 2) - 1) < 0.02, `middle of the aluminium ${r.u[3]}`);
  assert.ok(r.u[6] < u1 * 1.05 && r.u[9] > u1 * 0.95 && r.u[9] > r.u[6]);
  // the same stress in both, F / A
  for (const i of [0, 1]) assert.ok(Math.abs(r.vm[i] / (F / A) - 1) < 0.02, `vm ${i} ${r.vm[i]}`);
  // and as stiff as the formula says: energy F u / 2
  assert.ok(Math.abs(r.energy / (F * u2 / 2) - 1) < 0.01, `energy ${r.energy}`);
});

test("each body weighs by its own density", () => {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  st.loads.push({ id: "g", type: "gravity", faces: [], comp: [{ v: 0 }, { v: 0 }, { v: -9810 }] });
  const r = [...runStatic(input(st, regions, 2))].at(-1)!;
  const w = 9810 * B * T * (steel.rho * J + alu.rho * (L - J));
  assert.ok(Math.abs(r.reactions[0].force[2] / w - 1) < 0.01, `reaction ${r.reactions[0].force[2]} vs ${w}`);
});

test("a bimetal cantilever: the first frequency lies between the all-steel and all-aluminium ones and the mass is the sum", () => {
  const st = newStudy([], "modal");
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  const run = (reg?: typeof regions, passes = 2) => [...runModal({ ...input(st, reg, passes), modal: { count: 2 } })].at(-1)!;
  // layered across the thickness: steel below, aluminium on top
  const lay = [{ tris: box([0, 0, 0], [L, B, T / 2]).tris, mat: steel }, { tris: box([0, 0, T / 2], [L, B, T]).tris, mat: alu }];
  const both = run(lay), one = run(undefined, 1);
  assert.ok(Math.abs(both.mass! / (L * B * T / 2 * (steel.rho + alu.rho)) - 1) < 1e-6, `mass ${both.mass}`);
  // composite beam: EI about the neutral axis of the transformed section, mass per length of both layers
  const n = alu.E / steel.E, h = T / 2;
  const yb = (h * h / 2 + n * h * (h + h / 2)) / (h + n * h);
  const EI = steel.E * B * (h ** 3 / 12 + h * (yb - h / 2) ** 2 + n * (h ** 3 / 12 + h * (1.5 * h - yb) ** 2));
  const f = (1.8751 ** 2 / (2 * Math.PI)) * Math.sqrt(EI / ((steel.rho + alu.rho) * B * h * L ** 4));
  const f1 = both.modes!.map(m => m.hz).sort((a, b) => a - b)[0];
  assert.ok(Math.abs(f1 / f - 1) < 0.04, `f1 ${f1} vs ${f}`);
  assert.ok(Math.abs(one.modes![0].hz / f1 - 1) > 0.02);
});
