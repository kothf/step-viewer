// Structural analysis: the memory estimate (FR-SOL-020, NFR-SIM-005). The stiffness matrix of a pass is sized
// before it is built: over the budget the first pass refuses with what it needs, and a later pass is not started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, runModal } from "../../src/sim/run";
import { MEMORY_LIMIT, topEigen } from "../../src/sim/static";
import { newStudy } from "../../src/sim/types";

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
const study = (kind: "static" | "modal" = "static") => {
  const st = newStudy([], kind);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  if (kind === "static") st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: [{ v: 0 }, { v: 0 }, { v: -100 }] });
  return st;
};
const input = (st: ReturnType<typeof study>, passes: number, memory?: number) => ({ body, mat: { name: "Steel", E, nu: 0.3, rho: 7.85e-9 }, problem: studyProblem(st, body), passes, energyTol: 0,
  pos: new Float32Array([L, B / 2, T / 2]), nrm: new Float32Array([1, 0, 0]), cells: 30, ...(memory ? { memory } : {}) });

test("memory: each pass reports what its matrix took, and the estimate of the next degree is the next pass's", () => {
  const r = [...runStatic(input(study(), 3))];
  assert.equal(r.length, 3);
  assert.ok(r.every(p => p.memory! > 0 && !p.capped));
  assert.ok(r[0].memory! < r[1].memory! && r[1].memory! < r[2].memory!);
  assert.ok(r[2].memory! < MEMORY_LIMIT / 10, `a small bar is far under the budget: ${r[2].memory}`);
  // every element has its own block and two per neighbour: at least dofs²/elements × 8 bytes
  for (const p of r) assert.ok(p.memory! >= (8 * p.dofs * p.dofs) / p.cells);
});

test("memory: over the budget the first pass refuses and names the megabytes", () => {
  assert.throws(() => [...runStatic(input(study(), 3, 1000))], /E-SIM-MEMORY: \d+/);
});

test("memory: a later pass that would not fit is not started, and the pass before says so", () => {
  const all = [...runStatic(input(study(), 3))];
  // room for pass 2, not for pass 3
  const budget = (all[1].memory! + all[2].memory!) / 2;
  const r = [...runStatic(input(study(), 3, budget))];
  assert.equal(r.length, 2);
  assert.ok(!r[0].capped && r[0].done === false);
  assert.equal(r[1].capped, Math.ceil(all[2].memory! / 2 ** 20));
  assert.equal(r[1].done, true);
  assert.equal(r[1].energy, all[1].energy);
  // local passes too: room for the three whole-body passes only
  const more = [...runStatic(input(study(), 5))];
  if (more.length > 3) {
    const cut = [...runStatic(input(study(), 5, (more[2].memory! + more[3].memory!) / 2))];
    assert.equal(cut.length, 3);
    assert.ok(cut[2].capped! > 0 && cut[2].done);
  }
});

test("memory: a modal study stops the same way", () => {
  const all = [...runModal({ ...input(study("modal"), 2), modal: { count: 3 } })];
  assert.equal(all.length, 2);
  const r = [...runModal({ ...input(study("modal"), 2, (all[0].memory! + all[1].memory!) / 2), modal: { count: 3 } })];
  assert.equal(r.length, 1);
  assert.ok(r[0].capped! > 0 && r[0].done);
  assert.equal(r[0].modes!.length, all[0].modes!.length);
});

test("faces that share a name are picked as one: a load on the name is spread over all of them", () => {
  // the loaded end in two halves that carry one name, as the two walls of a hole cut by a slot do
  const tr: number[] = [], fc: number[] = [], nm: string[] = [];
  const add = (name: string, t: number[]) => { nm.push(name); tr.push(...t); for (let k = 0; k < t.length / 9; k++) fc.push(nm.length - 1); };
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    if (a === 0 && end === 1) {
      add("x1", rectFace(0, L, [0, 0, 0], [L, B / 2, T], true));
      add("x1", rectFace(0, L, [0, B / 2, 0], [L, B, T], true));
    } else add("xyz"[a] + end, rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end));
  }
  const split = { tris: Float64Array.from(tr), face: Int32Array.from(fc), names: nm, lo, hi };
  const whole = studyProblem(study(), body), halves = studyProblem(study(), split);
  assert.equal(halves.problems.length, 0);
  assert.equal(halves.loads[0].tris!.length, 2 * whole.loads[0].tris!.length);
  const a = [...runStatic(input(study(), 1))][0], b = [...runStatic({ ...input(study(), 1), body: split, problem: halves })][0];
  assert.ok(Math.abs(b.energy / a.energy - 1) < 1e-6, `energy ${b.energy} vs ${a.energy}`);
});

// The penalty of a cut element is measured: twice the largest λ of T x = λ K x (T = the element's boundary flux
// energy, K = its strain energy). K has a null space (rigid motions) on which T is zero too.
test("the measured penalty: the largest ratio of flux to strain energy of an element", () => {
  const n = 5, q = [[1, 2, 0, 1, 0], [0, 1, 3, 0, 1], [2, 0, 1, 1, 0], [0, 0, 1, 2, 1], [1, 1, 0, 0, 2]];
  const k = [4, 2, 1, 0.5, 0], t = [4, 6, 0.5, 5, 0];
  // K = Q diag(k) Qᵀ, T = Q diag(t) Qᵀ: the ratios are 1, 3, 0.5 and 10
  const K = new Float64Array(n * n), T = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let m = 0; m < n; m++) {
    K[i * n + j] += q[i][m] * k[m] * q[j][m];
    T[i * n + j] += q[i][m] * t[m] * q[j][m];
  }
  const lam = topEigen(T, K, n);
  assert.ok(Math.abs(lam - 10) < 1e-3, `largest ratio ${lam}`);
});
