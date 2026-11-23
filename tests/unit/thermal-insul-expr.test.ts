// Insulated faces (FR-TBC-002) and power over time by an expression of t (FR-TLOAD-005).
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, runTransient, studyProblem } from "../../src/sim/run";
import { newStudy, itemName, THERMAL_SUPPORTS, isThermalType } from "../../src/sim/types";
import { exprProblem, exprShare, profileBreaks, profileFactor, profileStep, profileText } from "../../src/sim/transient";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const L = 100, B = 20, T = 20;
const body = (() => {
  const lo = [0, 0, 0], hi = [L, B, T], tris: number[] = [], face: number[] = [], names: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const q = rectFace(a, end ? hi[a] : lo[a], lo, hi, !!end);
    names.push("xyz"[a] + end);
    tris.push(...q);
    for (let k = 0; k < q.length / 9; k++) face.push(names.length - 1);
  }
  return { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi };
})();
const area = (tris: Float64Array) => { let s = 0; for (let i = 0; i < tris.length; i += 9) { const u = [0, 1, 2].map(j => tris[i + 3 + j] - tris[i + j]), v = [0, 1, 2].map(j => tris[i + 6 + j] - tris[i + j]); s += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]); } return s; };
const pos = new Float32Array([0, B / 2, T / 2, L, B / 2, T / 2]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0]);

test("insulated: a thermal item named like the others, with no condition of its own", () => {
  assert.ok(THERMAL_SUPPORTS.includes("insul") && isThermalType("insul"));
  assert.equal(itemName(newStudy([], "thermal"), "insul"), "Insulated 1");
  const st = newStudy([], "thermal");
  st.supports.push({ id: "s1", type: "insul", faces: [{ name: "x0" }] });
  const set = thermalSetup(st, body);
  assert.equal(set.sinks.length, 0);
  assert.deepEqual(set.problems, []);
  // a face that is gone is reported
  st.supports[0].faces = [{ name: "gone" }];
  assert.deepEqual(thermalSetup(st, body).problems, [{ id: "s1", code: "E-SIM-REF" }]);
});

test("insulated faces are left out of all open surfaces, and the heat leaves by the rest", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x1" }], value: { v: 5 } });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 20 });
  const whole = thermalSetup(st, body).sinks[0];
  st.supports.push({ id: "s2", type: "insul", faces: [{ name: "x0" }, { name: "z0" }] });
  const set = thermalSetup(st, body);
  assert.equal(set.sinks.length, 1);
  const total = 2 * (L * B + L * T + B * T);
  assert.ok(Math.abs(area(whole.tris) - total) < 1e-6);
  assert.ok(Math.abs(area(set.sinks[0].tris) - (total - B * T - L * B)) < 1e-6);
  // the insulated end stays hotter than with it cooled, and all the heat still leaves
  const run = (s: typeof st) => [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(s, body), passes: 2, energyTol: 0, pos, nrm, thermal: { k: 0.054, setup: thermalSetup(s, body) } })].at(-1)!;
  const ins = run(st);
  assert.ok(Math.abs(ins.thermal!.flows[0].out - 5) < 0.05, `out ${ins.thermal!.flows[0].out}`);
  const st2 = structuredClone(st);
  st2.suppressed = ["s2"];
  const open = run(st2);
  assert.ok(ins.thermal!.max > open.thermal!.max, `${ins.thermal!.max} vs ${open.thermal!.max}`);
});

test("expression profile: share of the power by t, its checks and how it is shown", () => {
  assert.ok(Math.abs(exprShare("0.5 + 0.5*sin(2*pi*t/60)", 15) - 1) < 1e-12);
  assert.ok(Math.abs(exprShare("min(1, t/120)", 60) - 0.5) < 1e-12);
  const p = { kind: "expr" as const, f: "0.5*sin(2*pi*t/60)" };
  assert.ok(Math.abs(profileFactor(p, 15) - 0.5) < 1e-12);
  assert.equal(profileFactor(p, 45), 0); // below 0 counts as 0
  assert.equal(profileFactor({ kind: "expr", f: "1 +" }, 3), 0);
  assert.equal(exprProblem("min(1, t/120)"), null);
  assert.equal(exprProblem(""), "Empty expression");
  assert.ok(exprProblem("1 +"));
  assert.ok(exprProblem("sqrt(t - 100)")); // NaN at early times
  assert.equal(profileStep(p, 800), 2);
  assert.deepEqual(profileBreaks(p), []);
  assert.equal(profileText(p, s => s), "P × (0.5*sin(2*pi*t/60))");
});

test("expression profile in a transient run: a ramp warms as the lumped body says", () => {
  const st = newStudy([], "thermal");
  st.settings.transient = { end: 600, out: 60 };
  st.loads.push({ id: "l1", type: "heat", faces: [], body: true, value: { v: 20 }, profile: { kind: "expr", f: "min(1, t/300)" } });
  st.supports.push({ id: "s1", type: "conv", faces: [{ name: "z1" }], h: 2 });
  const set = thermalSetup(st, body), p1 = new Float32Array([50, 10, 10]), n1 = new Float32Array([0, 0, 0]);
  const tr = [...runTransient({ body, mat: { name: "Al", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos: p1, nrm: n1, thermal: { k: 0.2, setup: set, transient: { rc: 2.43e-3, t0: 25, end: 600, out: 60, profiles: { l1: st.loads[0].profile! } } } })].at(-1)!.transient!;
  // a weak film takes little: C dT/dt = P t / 300, so the rise is P t² / (600 C)
  const C = 2.43e-3 * L * B * T;
  for (const i of [1, 2, 3]) {
    const t = tr.times[i], want = (20 * t * t) / (600 * C), got = tr.frames[i][0] - 25;
    assert.ok(Math.abs(got - want) < 0.03 * want, `t ${t}: ${got} vs ${want}`);
  }
  assert.ok(tr.frames.at(-1)![0] > tr.frames[5][0]);
});
