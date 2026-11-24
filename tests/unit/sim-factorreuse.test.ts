// Structural analysis: a study solved again with other loads only (the next load case, a changed force) puts the
// same matrix together, and takes its factorisation from the solve before. The answers are those of a fresh solve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic } from "../../src/sim/run";
import { reusedFactors, dropFactors } from "../../src/sim/static";
import { matrixKey, BlockMatrix } from "../../src/sim/sparse";
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
const study = (comp: number[], held = "x0") => {
  const st = newStudy([], "static");
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: held }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: comp.map(v => ({ v })) });
  return st;
};
const run = (st: ReturnType<typeof study>) => [...runStatic({ body, mat: { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9 }, problem: studyProblem(st, body), passes: 3, energyTol: 0,
  pos: new Float32Array([L, B / 2, T / 2]), nrm: new Float32Array([1, 0, 0]), cells: 30 })];

test("the fingerprint of a matrix follows every value and the layout", () => {
  const make = () => { const A = new BlockMatrix(2, 2); A.block(0, 0).set([4, 1, 1, 3]); A.block(1, 1).set([5, 0, 0, 6]); A.block(1, 0).set([1, 0, 0, 1]); return A; };
  const a = make(), b = make();
  assert.equal(matrixKey(a), matrixKey(b));
  b.block(1, 0)[3] = 1 + 2 ** -52;
  assert.notEqual(matrixKey(a), matrixKey(b));
  const c = make(); c.block(0, 1);
  assert.notEqual(matrixKey(a), matrixKey(c));
});

test("other loads on the same study take the kept factorisations and give a fresh solve's answers", () => {
  dropFactors();
  const n0 = reusedFactors;
  run(study([0, 0, -100]));
  assert.equal(reusedFactors, n0, "the first solve factors every pass itself");
  const again = run(study([50, 0, 30]));
  assert.equal(reusedFactors, n0 + 3, "each of the three passes took the factor kept from the first solve");
  dropFactors();
  const fresh = run(study([50, 0, 30]));
  assert.equal(reusedFactors, n0 + 3);
  for (let k = 0; k < 3; k++) {
    assert.equal(again[k].energy, fresh[k].energy);
    assert.deepEqual(again[k].u, fresh[k].u);
    assert.deepEqual(again[k].vm, fresh[k].vm);
  }
});

test("another support is another matrix: nothing is taken", () => {
  dropFactors();
  run(study([0, 0, -100]));
  const n0 = reusedFactors;
  run(study([0, 0, -100], "y0"));
  assert.equal(reusedFactors, n0);
});
