// Structural analysis: local accuracy on picked faces (FR-SOL-012). The elements meeting the faces start
// some degrees higher, so the first pass is already better there, and the later passes keep the lead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, boostOf } from "../../src/sim/run";
import { makeGrid } from "../../src/sim/grid";
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
const study = () => {
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: [{ v: 0 }, { v: 0 }, { v: -100 }] });
  return st;
};
const run = (st: ReturnType<typeof study>, passes: number) => [...runStatic({ body, mat: { name: "Steel", E, nu: 0.3, rho: 7.85e-9 }, problem: studyProblem(st, body), passes, energyTol: 0,
  pos: new Float32Array([L, B / 2, T / 2]), nrm: new Float32Array([1, 0, 0]) })];

test("local accuracy: the picked faces' elements start higher and the first pass gains from it", () => {
  const plain = run(study(), 2);
  const st = study();
  st.refine = [{ id: "r1", type: "refine", faces: [{ name: "x0" }], level: 2 }];
  const pb = studyProblem(st, body);
  assert.equal(pb.refine?.length, 1);
  assert.equal(pb.refine![0].level, 2);
  const fine = run(st, 2);
  // pass 1: degree 4 at the clamped end, 2 elsewhere: more unknowns than the plain pass, fewer than degree 4 everywhere
  assert.equal(fine[0].p, 4);
  assert.ok(fine[0].dofs > plain[0].dofs && fine[0].cells === plain[0].cells, `${fine[0].dofs} vs ${plain[0].dofs}`);
  assert.ok(fine[0].dofs < 0.6 * (plain[0].dofs / 10) * 35, "only the elements at the face are raised");
  // the energy of a force-loaded part grows towards the exact one: the refined pass is nearer
  assert.ok(fine[0].energy > plain[0].energy && fine[1].energy >= plain[1].energy, `${fine[0].energy} ${plain[0].energy} ${fine[1].energy} ${plain[1].energy}`);
  assert.ok(Math.abs(fine[1].energy / plain[1].energy - 1) < 0.02);
  // the end deflection stays that of the bar
  const I = (B * T ** 3) / 12, d = (100 * L ** 3) / (3 * E * I);
  assert.ok(Math.abs(-fine[1].u[2] / d - 1) < 0.03, `${fine[1].u[2]} vs ${d}`);
});

test("local accuracy: items left out, without faces or on a face that is gone; levels are kept to 1..3", () => {
  const st = study();
  st.refine = [{ id: "r1", type: "refine", faces: [{ name: "x0" }], level: 9 }, { id: "r2", type: "refine", faces: [], level: 1 }, { id: "r3", type: "refine", faces: [{ name: "gone" }], level: 1 },
    { id: "r4", type: "refine", faces: [{ name: "x1" }], level: 1 }];
  st.suppressed = ["r4"];
  const pb = studyProblem(st, body);
  assert.deepEqual(pb.problems, [{ id: "r2", code: "E-SIM-EMPTY" }, { id: "r3", code: "E-SIM-REF" }]);
  assert.deepEqual(pb.refine!.map(r => r.level), [3]);
  const grid = makeGrid(lo, hi, 10, (x, y, z) => x >= 0 && x <= L && y >= 0 && y <= B && z >= 0 && z <= T, { q: 3, depth: 3, fit: 5 });
  const boost = boostOf(grid, pb.refine!);
  const at = grid.elems.map((e, i) => [e.c[0], boost[i]]);
  assert.ok(at.every(([x, b]) => (x < 10) === (b === 3)), JSON.stringify(at.slice(0, 12)));
});
