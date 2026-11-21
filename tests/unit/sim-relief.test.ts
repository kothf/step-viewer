// Structural analysis: inertia relief (FR-SUP-007). A part held by nothing is solved with its loads balanced by
// the inertia forces of the rigid acceleration they give it.
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

const L = 100, B = 20, T = 10, E = 210000, rho = 7.85e-9, F = 100;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
const study = (comp: number[]) => {
  const st = newStudy([]);
  st.settings.relief = true;
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "x1" }], comp: comp.map(v => ({ v })) });
  return st;
};
// the middle of the bar, the middle of its top and the free far end
const pos = new Float32Array([L / 2, B / 2, T / 2, L / 2, B / 2, T, 0, B / 2, T / 2]), nrm = new Float32Array([0, 0, 1, 0, 0, 1, -1, 0, 0]);
const run = (st: ReturnType<typeof study>, passes = 3) => [...runStatic({ body, mat: { name: "Steel", E, nu: 0.3, rho }, problem: studyProblem(st, body), passes, energyTol: 0, pos, nrm })];

test("inertia relief: a bar pulled at one end is stretched by half the force in its middle", () => {
  const st = study([F, 0, 0]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "gone" }] });
  const pb = studyProblem(st, body);
  // the supports are left out, broken or not
  assert.equal(pb.relief, true);
  assert.equal(pb.fixed.length, 0);
  assert.equal(pb.problems.length, 0);
  const r = run(st).at(-1)!;
  const m = rho * L * B * T;
  assert.ok(Math.abs(r.accel!.a[0] / (F / m) - 1) < 1e-6, `a ${r.accel!.a}`);
  assert.ok(Math.hypot(...r.accel!.alpha) < 1e-6 * (F / m) / L, `alpha ${r.accel!.alpha}`);
  assert.ok(Math.abs(r.accel!.com[0] - L / 2) < 1e-6 && Math.abs(r.accel!.mass / m - 1) < 1e-9);
  // the axial force grows linearly from the free end to the pulled one
  assert.ok(Math.abs(r.vm[0] / (F / 2 / (B * T)) - 1) < 0.03, `vm mid ${r.vm[0]}`);
  assert.ok(r.vm[2] < 0.1 * F / (B * T), `vm at the free end ${r.vm[2]}`);
  // no rigid drift: the bar only stretches, by F L / (2 E A) end to end
  assert.ok(r.maxU < 2 * (F * L) / (2 * E * B * T), `maxU ${r.maxU}`);
  assert.equal(r.reactions.length, 0);
});

test("inertia relief: a free bar pushed sideways at one end bends as beam theory says", () => {
  const passes = run(study([0, 0, F]));
  const r = passes.at(-1)!;
  const m = rho * L * B * T;
  assert.ok(Math.abs(r.accel!.a[2] / (F / m) - 1) < 1e-6);
  // α = M / I about the centre of mass, with the bar's own inertia (not the slender one)
  const Iy = (m * (L * L + T * T)) / 12;
  assert.ok(Math.abs(r.accel!.alpha[1] / (-(F * L) / 2 / Iy) - 1) < 1e-4, `alpha ${r.accel!.alpha}`);
  // bending moment F x² (L − x) / L² from the free end: F L / 8 in the middle
  const sig = ((F * L) / 8) / ((B * T * T) / 6);
  assert.ok(Math.abs(r.vm[1] / sig - 1) < 0.08, `vm top mid ${r.vm[1]} against ${sig}`);
  assert.ok(r.vm[2] < 0.1 * sig, `vm at the free end ${r.vm[2]}`);
  assert.ok(r.maxU < 0.05, `maxU ${r.maxU}`);
  assert.ok(passes.length === 3 && passes[2].change != null && Math.abs(passes[2].change!) < 5, `change ${passes[2].change}`);
});

test("inertia relief: without it a part with no supports is refused; a falling part is not stressed", () => {
  const st = study([F, 0, 0]);
  delete st.settings.relief;
  assert.throws(() => run(st, 1), /E-SIM-FREE/);
  const g = newStudy([]);
  g.settings.relief = true;
  g.loads.push({ id: "l1", type: "gravity", faces: [], comp: [{ v: 0 }, { v: 0 }, { v: -9810 }] });
  const r = run(g, 1).at(-1)!;
  assert.ok(Math.abs(r.accel!.a[2] + 9810) < 1e-6);
  assert.ok(r.maxVm < 1e-6 && r.maxU < 1e-9, `vm ${r.maxVm} u ${r.maxU}`);
});
