// Structural analysis, SA4: modal studies of assemblies, and comparing two results (FR-STU-023).
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runModal, type RunInput } from "../../src/sim/run";
import { newStudy, type Study } from "../../src/sim/types";
import { compareRows, noteSummary, parseSummaries, type Summary } from "../../src/sim/compare";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
/** Boxes as the components of an assembly: faces named `<component>@x0` … `<component>@z1`. */
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
const steel = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9, sy: 235 };

function input(m: ReturnType<typeof boxes>, st: Study, asm: boolean, count: number): RunInput {
  return {
    body: m.body, mat: steel, ...(asm ? { regions: m.parts.map(tris => ({ tris, mat: steel })), asm: { gap: 0.1, links: [] } } : {}),
    problem: studyProblem(st, m.body), passes: 3, energyTol: 0, pos: Float32Array.from([0, 0, 0]), nrm: Float32Array.from([1, 0, 0]), modal: { count },
  };
}
const modes = (i: RunInput) => [...runModal(i)].at(-1)!.modes!.filter(m => !m.rigid).map(m => m.hz);

test("AT-SA4-1: two bonded plates vibrate like the one-piece plate", () => {
  const L = 120, B = 40, T = 8, J = 50, g = 0.05;
  const one = boxes([{ id: "a", lo: [0, 0, 0], hi: [L, B, T] }]);
  const two = boxes([{ id: "a", lo: [0, 0, 0], hi: [J, B, T] }, { id: "b", lo: [J + g, 0, 0], hi: [L, B, T] }]);
  const s1 = newStudy([], "modal"), s2 = newStudy([], "modal");
  s1.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  s2.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  const f1 = modes(input(one, s1, false, 4)), f2 = modes(input(two, s2, true, 4));
  assert.equal(f2.length, 4);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(f2[i] / f1[i] - 1) < 0.02, `mode ${i + 1}: ${f2[i]} against ${f1[i]} Hz`);
  // the first mode is the plate bending as a cantilever beam (wide plate: between beam and plate stiffness)
  const beam = (1.875104 ** 2 / (2 * Math.PI * L * L)) * Math.sqrt((steel.E * T * T) / (12 * steel.rho));
  assert.ok(f1[0] > 0.98 * beam && f1[0] < 1.06 * beam, `first ${f1[0]} against the beam's ${beam} Hz`);
});

test("AT-SA4-2: a mass on the tip of a cantilever lowers the first frequency as the beam formula says", () => {
  const L = 150, B = 10, T = 10, M = 0.5e-3;
  const m = boxes([{ id: "a", lo: [0, 0, 0], hi: [L, B, T] }]);
  const st = newStudy([], "modal");
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.masses = [{ id: "m1", type: "mass", faces: [{ name: "a@x1" }], mass: 0.5 }];
  const f = modes(input(m, st, false, 2));
  const I = (B * T ** 3) / 12, bar = L * B * T * steel.rho, hz = Math.sqrt((3 * steel.E * I) / (L ** 3 * (M + (33 / 140) * bar))) / (2 * Math.PI);
  assert.ok(Math.abs(f[0] / hz - 1) < 0.02, `first mode ${f[0]} against ${hz} Hz`);
});

test("FR-STU-023: a result is compared with another study's, and with the one before the last change", () => {
  const a: Summary = { kind: "static", name: "Static 1", key: "1", at: 1, maxU: 0.2, maxVm: 100, sf: 2.35 };
  const b: Summary = { ...a, key: "2", at: 2, maxU: 0.1, maxVm: 80, sf: 2.9375 };
  let store = noteSummary({}, "st1", a);
  assert.equal(store.st1.before, undefined);
  store = noteSummary(store, "st1", { ...a, at: 5 });
  assert.equal(store.st1.before, undefined, "the same state solved again is not a change");
  store = noteSummary(store, "st1", b);
  assert.equal(store.st1.before!.key, "1");
  assert.equal(store.st1.now!.key, "2");
  const rows = compareRows(store.st1.now!, store.st1.before!);
  assert.deepEqual(rows.map(r => r.key), ["maxvm", "maxu", "sf"]);
  assert.ok(Math.abs(rows[0].change! + 20) < 1e-9 && Math.abs(rows[1].change! + 50) < 1e-9 && Math.abs(rows[2].change! - 25) < 1e-9);
  const m1: Summary = { kind: "modal", name: "Modal 1", key: "3", at: 3, mass: 1, freqs: [100, 200, 300] };
  const m2: Summary = { kind: "modal", name: "Modal 2", key: "4", at: 4, mass: 1.5, freqs: [80, 190] };
  const mr = compareRows(m1, m2);
  assert.deepEqual(mr.map(r => r.key), ["mass", "f1", "f2", "f3"]);
  assert.equal(mr[1].change, 25);
  assert.equal(mr[3].b, null);
  assert.equal(mr[3].change, null);
  assert.deepEqual(compareRows(a, m1), []);
  const back = parseSummaries(JSON.stringify({ ...store, bad: { now: { kind: "x" } }, st9: 3 }));
  assert.deepEqual(Object.keys(back), ["st1"]);
  assert.equal(back.st1.before!.maxVm, 100);
  assert.deepEqual(parseSummaries("not json"), {});
});
