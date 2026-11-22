// Thermal stress in assemblies (FRS-thermal TH5): each body expands by its own α; where bodies are joined the
// shared traction carries the thermal part, so like bodies grow together unstressed and unlike ones push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, thermalSetup, type RunInput } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function boxes(list: { id: string; lo: number[]; hi: number[] }[]) {
  const tris: number[] = [], face: number[] = [], names: string[] = [], parts: Float64Array[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    const own: number[] = [];
    for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
      const t = rectFace(a, end ? b.hi[a] : b.lo[a], b.lo, b.hi, !!end);
      names.push(`${b.id}@${"xyz"[a]}${end}`);
      own.push(...t);
      for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
    }
    tris.push(...own);
    parts.push(Float64Array.from(own));
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.lo[a]); hi[a] = Math.max(hi[a], b.hi[a]); }
  }
  return { body: { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi }, parts };
}
const steel = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9 }, alu = { name: "Aluminium", E: 70000, nu: 0.3, rho: 2.7e-9 };
const aS = 12e-6, aA = 23e-6;
type St = ReturnType<typeof newStudy>;
function run(m: ReturnType<typeof boxes>, st: St, mats: typeof steel[], alphas: number[], pos: number[], nrm: number[], thermal?: RunInput, passes = 3) {
  const inp: RunInput = {
    body: m.body, mat: mats[0], regions: m.parts.map((tris, i) => ({ tris, mat: mats[i] })), asm: { gap: 0.1 }, problem: studyProblem(st, m.body), passes, energyTol: 0,
    pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), temp: { alpha: alphas[0], alphas, ...(thermal ? { thermal } : {}) },
  };
  return [...runStatic(inp)].at(-1)!;
}
const slide = (st: St, list: string[][]) => list.forEach((fs, i) => st.supports.push({ id: `s${i + 1}`, type: "sliding", faces: fs.map(name => ({ name })) }));

const L = 100, B = 20, T = 10, J = 40;
const bar = boxes([{ id: "a", lo: [0, 0, 0], hi: [J, B, T] }, { id: "b", lo: [J, 0, 0], hi: [L, B, T] }]);

test("thermal stress, assembly: a bar of two like components free to grow grows by α ΔT L, unstressed", () => {
  const st = newStudy([]);
  slide(st, [["a@x0"], ["a@y0", "b@y0"], ["a@z0", "b@z0"]]);
  st.loads.push({ id: "l1", type: "temperature", faces: [], value: { v: 120 } });
  const r = run(bar, st, [steel, steel], [aS, aS], [L, B / 2, T / 2, J / 2, B / 2, T / 2, J + 10, B / 2, T / 2], [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const grow = aS * 100 * L, sig = steel.E * aS * 100;
  assert.ok(Math.abs(r.u[0] / grow - 1) < 2e-3, `end ${r.u[0]} for ${grow}`);
  assert.ok(r.vm[1] < 1e-2 * sig && r.vm[2] < 1e-2 * sig, `vm ${r.vm[1]}, ${r.vm[2]} against ${sig}`);
});

test("thermal stress, assembly: held at both ends, like components are pushed by E α ΔT; unlike ones share one force", () => {
  const st = newStudy([]);
  slide(st, [["a@x0"], ["b@x1"], ["a@y0", "b@y0"], ["a@z0", "b@z0"]]);
  st.loads.push({ id: "l1", type: "temperature", faces: [], value: { v: 120 } });
  const pos = [J / 2, B / 2, T / 2, J + 30, B / 2, T / 2, J, B / 2, T / 2], nrm = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = run(bar, st, [steel, steel], [aS, aS], pos, nrm);
  const sig = steel.E * aS * 100;
  assert.ok(Math.abs(r.vm[0] / sig - 1) < 1e-2 && Math.abs(r.vm[1] / sig - 1) < 1e-2, `vm ${r.vm[0]}, ${r.vm[1]} for ${sig}`);
  // steel and aluminium in series (sideways free; their different sideways growth stresses the joint a little)
  // one axial stress σ = ΔT (αs Ls + αa La) / (Ls/Es + La/Ea)
  const r2 = run(bar, st, [steel, alu], [aS, aA], pos, nrm);
  const s2 = (100 * (aS * J + aA * (L - J))) / (J / steel.E + (L - J) / alu.E);
  assert.ok(Math.abs(r2.vm[0] / s2 - 1) < 3e-2, `steel ${r2.vm[0]} for ${s2}`);
  assert.ok(Math.abs(r2.vm[1] / s2 - 1) < 3e-2, `aluminium ${r2.vm[1]} for ${s2}`);
  // the joint moves towards the stiffer steel: x = J − (σ/Es − αs ΔT) J … = J + J (αs ΔT − σ/Es)
  const ux = J * (aS * 100 - s2 / steel.E);
  // the connection force is the whole stress's: a pushes b by σ A (less its thermal part β ΔT, which D ε holds)
  assert.ok(Math.abs(r.contacts![0].force![0] / (sig * B * T) - 1) < 1e-3, `force ${r.contacts![0].force} for ${sig * B * T}`);
  assert.ok(Math.abs(r2.contacts![0].force![0] / (s2 * B * T) - 1) < 3e-2, `force ${r2.contacts![0].force} for ${s2 * B * T}`);
  assert.ok(Math.abs(r2.u[6] / ux - 1) < 2e-2, `joint ${r2.u[6]} for ${ux}`);
});

test("thermal stress, assembly: a bimetal strip bends as Timoshenko's formula says", () => {
  // steel under aluminium, bonded over the length; held on its root end face, warmed by 100 K
  const Lb = 200, b = 10, t1 = 3, t2 = 3, h = t1 + t2;
  const m = boxes([{ id: "s", lo: [0, 0, 0], hi: [Lb, b, t1] }, { id: "a", lo: [0, 0, t1], hi: [Lb, b, h] }]);
  const st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "s@x0" }, { name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "temperature", faces: [], value: { v: 120 }, ref: 20 });
  const r = run(m, st, [steel, alu], [aS, aA], [Lb, b / 2, t1], [1, 0, 0], undefined, 4);
  // κ = 6 Δα ΔT (1 + m)² / (h (3 (1 + m)² + (1 + m n)(m² + 1/(m n)))), m = t1/t2, n = E1/E2 (plane-stress widths: b ≈ h)
  const mm = t1 / t2, n = steel.E / alu.E;
  const k = (6 * (aA - aS) * 100 * (1 + mm) ** 2) / (h * (3 * (1 + mm) ** 2 + (1 + mm * n) * (mm * mm + 1 / (mm * n))));
  const tip = (k * Lb * Lb) / 2;
  // aluminium on top grows more: the strip curls down
  assert.ok(r.u[2] < 0, `tip ${r.u[2]}`);
  assert.ok(Math.abs(-r.u[2] / tip - 1) < 0.06, `tip ${r.u[2]} for ${-tip}`);
});

test("thermal stress, assembly: temperatures from a thermal study of the assembly", () => {
  // the bar's two components held at 20 and 220 °C at its ends: a linear field, like a one-piece bar
  const th = newStudy([], "thermal");
  th.supports.push({ id: "t1", type: "temp", faces: [{ name: "a@x0" }], temp: 20 }, { id: "t2", type: "temp", faces: [{ name: "b@x1" }], temp: 220 });
  const keys = ["a", "b"];
  const thermal: RunInput = {
    body: bar.body, mat: steel, regions: bar.parts.map(tris => ({ tris, mat: steel })), problem: studyProblem(th, bar.body), passes: 3, energyTol: 0, pos: new Float32Array(3), nrm: new Float32Array(3),
    thermal: { k: 0.054, ks: [0.054, 0.054], setup: thermalSetup(th, bar.body, keys), gap: 0.1 },
  };
  const st = newStudy([]);
  slide(st, [["a@x0"], ["a@y0", "b@y0"], ["a@z0", "b@z0"]]);
  st.loads.push({ id: "l1", type: "temperature", faces: [], from: th.id });
  const r = run(bar, st, [steel, steel], [aS, aS], [L, B / 2, T / 2], [1, 0, 0], thermal);
  const grow = aS * 100 * L;
  assert.ok(Math.abs(r.u[0] / grow - 1) < 2e-2, `end ${r.u[0]} for ${grow}`);
});
