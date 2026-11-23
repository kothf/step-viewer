// Heat power per item (FRS-thermal FR-TLOAD-001): the value is each picked face's or component's, not the total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}

const L = 100, B = 20, T = 20, K = 54;
const lo = [0, 0, 0], hi = [L, B, T];
const tris: number[] = [], face: number[] = [], names: string[] = [];
for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
  const t = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
  names.push("xyz"[a] + end);
  tris.push(...t);
  for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
}
const body = { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
const pos = new Float32Array([0, B / 2, T / 2, L, B / 2, T / 2]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0]);
const run = (st: ReturnType<typeof newStudy>) => [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, thermal: { k: K * 1e-3, setup: thermalSetup(st, body) } })].at(-1)!;

const study = (each: boolean, faces: string[]) => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: faces.map(name => ({ name })), value: { v: 3 }, each: each || undefined });
  st.supports.push({ id: "s1", type: "conv", faces: [{ name: "z1" }], h: 50, ambient: 25 });
  return st;
};

test("heat power per face: every picked face takes the whole value", () => {
  const set = thermalSetup(study(true, ["x0", "x1"]), body);
  assert.equal(set.problems.length, 0);
  assert.equal(set.sources.length, 2);
  for (const s of set.sources) { assert.equal(s.power, 3); assert.equal(s.tris!.length, 18); }
  const a = run(study(true, ["x0", "x1"])), b = run(study(false, ["x0", "x1"]));
  assert.ok(Math.abs(a.thermal!.applied - 6) < 1e-9, `each ${a.thermal!.applied}`);
  assert.ok(Math.abs(b.thermal!.applied - 3) < 1e-9, `total ${b.thermal!.applied}`);
  // the same as the total of twice the value
  const st = study(false, ["x0", "x1"]); st.loads[0].value = { v: 6 };
  const c = run(st);
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(a.vm[i] - c.vm[i]) < 1e-6, `point ${i}`);
});

test("heat power per face with one face is the plain load", () => {
  const set = thermalSetup(study(true, ["x0"]), body);
  assert.equal(set.sources.length, 1);
  assert.equal(set.sources[0].power, 3);
});

test("heat power per component in an assembly: one source per component", () => {
  const st = newStudy([], "thermal");
  const b2 = { ...body, names: ["a@x0", "a@x1", "b@y0", "b@y1", "a@z0", "b@z1"] };
  st.loads.push({ id: "l1", type: "heat", body: true, each: true, faces: [{ name: "a@x0" }, { name: "b@y0" }, { name: "a@x1" }], value: { v: 2 } });
  const set = thermalSetup(st, b2, ["a", "b", "c"]);
  assert.equal(set.problems.length, 0);
  assert.deepEqual(set.sources.map(s => [s.power, s.doms]), [[2, [0]], [2, [1]]]);
  st.loads[0].each = undefined;
  assert.deepEqual(thermalSetup(st, b2, ["a", "b", "c"]).sources.map(s => [s.power, s.doms]), [[2, [0, 1]]]);
});
