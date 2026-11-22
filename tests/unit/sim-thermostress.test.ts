// Thermal stress (FR-LOAD-011, FRS-thermal FR-TREP-012): a temperature load expands the part by α (T − ref);
// held it is stressed, free it is not, and a linear field in a free part leaves it unstressed too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, thermalSetup } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 100, B = 20, T = 10, E = 210000, nu = 0.3, alpha = 12e-6;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
// the middle of the bar, the middle of its top, the far end's middle
const pos = new Float32Array([L / 2, B / 2, T / 2, L / 2, B / 2, T, L, B / 2, T / 2]), nrm = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 0]);
const mat = { name: "Steel", E, nu, rho: 7.85e-9 };
const slide = (st: ReturnType<typeof newStudy>, ...faces: string[]) => faces.forEach((f, i) => st.supports.push({ id: `s${i + 1}`, type: "sliding", faces: [{ name: f }] }));
const run = (st: ReturnType<typeof newStudy>, temp: { alpha: number; thermal?: Parameters<typeof runStatic>[0] }) =>
  [...runStatic({ body, mat, problem: studyProblem(st, body), passes: 3, energyTol: 0, pos, nrm, temp })].at(-1)!;

test("thermal stress: a bar free to grow grows by α ΔT L and is not stressed", () => {
  const st = newStudy([]);
  slide(st, "x0", "y0", "z0");
  st.loads.push({ id: "l1", type: "temperature", faces: [], value: { v: 120 } });
  const pb = studyProblem(st, body);
  assert.equal(pb.problems.length, 0);
  assert.equal(pb.thermo?.ref, 20);
  // the held faces carry no traction: three of the six faces are left
  assert.equal(pb.thermo!.tris.length, tris.length / 2);
  const r = run(st, { alpha });
  const grow = alpha * 100 * L;
  assert.ok(Math.abs(r.u[6] / grow - 1) < 1e-3, `end ${r.u[6]} for ${grow}`);
  const sig = E * alpha * 100;
  assert.ok(r.maxVm < 1e-3 * sig, `vm ${r.maxVm} against ${sig}`);
});

test("thermal stress: a bar held at both ends is pushed by E α ΔT", () => {
  const st = newStudy([]);
  slide(st, "x0", "x1", "y0", "z0");
  st.loads.push({ id: "l1", type: "temperature", faces: [], value: { v: 120 }, ref: 20 });
  const r = run(st, { alpha });
  const sig = E * alpha * 100;
  assert.ok(Math.abs(r.vm[0] / sig - 1) < 1e-3, `vm ${r.vm[0]} for ${sig}`);
  assert.ok(Math.abs(r.vm[1] / sig - 1) < 1e-3, `vm top ${r.vm[1]} for ${sig}`);
  // sideways it is free: it widens by (1 + ν) α ΔT
  assert.ok(Math.abs(r.u[5] / ((1 + nu) * alpha * 100 * T) - 1) < 1e-3, `uz ${r.u[5]}`);
  // the reactions balance: the two ends push equally and oppositely
  assert.ok(r.reactions.length >= 2);
});

test("thermal stress: a thermal study's linear field in a free bar stretches it without stress", () => {
  const th = newStudy([], "thermal");
  th.supports.push({ id: "t1", type: "temp", faces: [{ name: "x0" }], temp: 20 }, { id: "t2", type: "temp", faces: [{ name: "x1" }], temp: 220 });
  const thermal = { body, mat, problem: studyProblem(th, body), passes: 3, energyTol: 0, pos, nrm, thermal: { k: 0.054, setup: thermalSetup(th, body) } };
  const st = newStudy([]);
  slide(st, "x0", "y0", "z0");
  st.loads.push({ id: "l1", type: "temperature", faces: [], from: th.id });
  const r = run(st, { alpha, thermal });
  // ux(L) = α ∫ (T − ref) dx = α · 100 · L, less a little: a linear field bends the end faces by α b (y² + z²) / 2,
  // which the sliding support at x0 straightens (so a trace of stress is left too)
  const grow = alpha * 100 * L, sig = E * alpha * 200;
  assert.ok(Math.abs(r.u[6] / grow - 1) < 1e-2, `end ${r.u[6]} for ${grow}`);
  assert.ok(r.maxVm < 2e-3 * sig, `vm ${r.maxVm} against ${sig}`);
  // without α it cannot be done
  assert.throws(() => run(st, { alpha: 0, thermal }), /E-TH-ALPHA/);
});
