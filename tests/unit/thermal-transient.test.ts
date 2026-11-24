// Transient thermal (FRS-thermal TH4, AT-TH4-1/2): time stepping against the lumped warm-up curve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, transientThermal } from "../../src/sim/thermal";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const lo = [0, 0, 0], hi = [40, 10, 10];
const box = (x: number, y: number, z: number) => x >= 0 && x <= 40 && y >= 0 && y <= 10 && z >= 0 && z <= 10;
const skin = [0, 1, 2].flatMap(a => [...rectFace(a, lo[a], lo, hi, false), ...rectFace(a, hi[a], lo, hi, true)]);
// aluminium: 200 W/(m·K), 2.7 g/cm³, 900 J/(kg·K); air film 10 W/(m²·K)
const k = 0.2, rc = 2.7e-6 * 900, h = 1e-5, A = 1800, V = 4000;
const base = { lo, hi, inside: box, h: 10, p: 2, k, sinks: [{ tris: skin, h, ambient: 20 }] };

test("a block heated by a step of power follows the lumped curve (AT-TH4-1)", () => {
  const P = 1, tau = (rc * V) / (h * A), rise = P / (h * A);
  const times = Array.from({ length: 21 }, (_v, i) => i * 150);
  const got: number[] = [];
  let flowEnd = 0, putEnd = 0;
  const r = transientThermal({ ...base, sources: [{ power: P }] }, {
    rc: [rc], t0: 20, times, factor: () => 1,
    frame: (_k, _t, sample, flows, put) => { got.push(sample([20, 5, 5]).temp[0]); flowEnd = flows[0].out; putEnd = put; },
  });
  assert.equal(got.length, times.length);
  assert.ok(Math.abs(got[0] - 20) < 1e-9);
  times.forEach((t, i) => {
    const want = 20 + rise * (1 - Math.exp(-t / tau));
    assert.ok(Math.abs(got[i] - want) <= 0.02 * rise, `t ${t}: ${got[i]} vs ${want}`);
  });
  assert.ok(Math.abs(r.capacity - rc * V) < 1e-9 * rc * V);
  // nearly settled at the end: what the film takes is close to what is put in
  assert.ok(putEnd === P && flowEnd > 0.99 * P * (1 - Math.exp(-3000 / tau)) - 0.02, `flow ${flowEnd}`);
  assert.ok(r.steps >= 20 && r.steps <= 2000, `steps ${r.steps}`);
  // and the steady solve agrees with where it heads
  const s = solveThermal({ ...base, sources: [{ power: P }] });
  assert.ok(Math.abs(s.temp(20, 5, 5) - (20 + rise)) < 0.01 * rise);
});

test("a 50 % duty cycle settles into a band around the half-power steady value (AT-TH4-2)", () => {
  const P = 2, tau = (rc * V) / (h * A), half = 20 + (0.5 * P) / (h * A), period = 60;
  const end = 6 * tau, times = Array.from({ length: 401 }, (_v, i) => (i * end) / 400);
  const got: number[] = [];
  transientThermal({ ...base, sources: [{ power: P }] }, {
    rc: [rc], t0: 20, times, maxStep: period / 8,
    factor: (_i, t) => (t % period < period / 2 ? 1 : 0),
    frame: (_k, _t, sample) => { got.push(sample([20, 5, 5]).temp[0]); },
  });
  const tail = got.slice(-60), mean = tail.reduce((a, v) => a + v, 0) / tail.length;
  const lo2 = Math.min(...tail), hi2 = Math.max(...tail);
  assert.ok(Math.abs(mean - half) < 0.02 * (half - 20), `mean ${mean} vs ${half}`);
  // the ripple: about P/2 × period/2 / C either way, far smaller than the rise
  assert.ok(hi2 - lo2 > 0.5 && hi2 - lo2 < 0.1 * (half - 20), `band ${lo2}..${hi2}`);
});

test("no heat capacity is refused", () => {
  assert.throws(() => transientThermal({ ...base, sources: [{ power: 1 }] }, { rc: [0], t0: 20, times: [0, 10], factor: () => 1, frame: () => {} }), /E-TH-NOCP/);
});

// ---- the study layer: a bar with a duty-cycled heater, run through runTransient ----
import { thermalSetup, runTransient, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { outputTimes, profileFactor, profileStep, parseProfile, timeToReach, transientCsv } from "../../src/sim/transient";

const bar = (() => {
  const lo2 = [0, 0, 0], hi2 = [100, 20, 20], tris: number[] = [], face: number[] = [], names: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const t = rectFace(a, end ? hi2[a] : lo2[a], lo2, hi2, !!end);
    names.push("xyz"[a] + end);
    tris.push(...t);
    for (let k2 = 0; k2 < t.length / 9; k2++) face.push(names.length - 1);
  }
  return { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo: lo2, hi: hi2 };
})();

test("transient study: steady passes, then the run in time; a step heater and the curve's frames", () => {
  const st = newStudy([], "thermal");
  st.settings.transient = { end: 600, out: 60 };
  st.loads.push({ id: "l1", type: "heat", faces: [], body: true, value: { v: 20 }, profile: { kind: "step", at: 60 } });
  st.supports.push({ id: "s1", type: "conv", faces: [{ name: "z1" }], h: 50 });
  const set = thermalSetup(st, bar);
  assert.equal(set.sources[0].id, "l1");
  const pos = new Float32Array([50, 10, 10]), nrm = new Float32Array([0, 0, 0]);
  const passes = [...runTransient({ body: bar, mat: { name: "Al", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, bar), passes: 3, energyTol: 0, pos, nrm, thermal: { k: 0.2, setup: set, transient: { rc: 2.43e-3, t0: 25, end: 600, out: 60, profiles: { l1: st.loads[0].profile! } } } })];
  assert.equal(passes.length, 3);
  assert.ok(!passes[0].done && !passes[1].done && passes[2].done);
  const tr = passes[2].transient!;
  assert.deepEqual(tr.times, outputTimes(600, 60));
  assert.equal(tr.frames.length, 11);
  // off for the first minute: still at the start temperature
  assert.ok(Math.abs(tr.frames[1][0] - 25) < 1e-6, `${tr.frames[1][0]}`);
  // then warming: lumped, rc V dT/dt ≈ P at first (the film takes little yet)
  const C = 2.43e-3 * 100 * 20 * 20, slope = (tr.frames[2][0] - tr.frames[1][0]) / 60;
  assert.ok(slope > 0.8 * (20 / C) && slope < 20 / C * 1.01, `slope ${slope} vs ${20 / C}`);
  for (let i = 2; i < 11; i++) assert.ok(tr.max[i] > tr.max[i - 1]);
  assert.ok(tr.steady! > tr.max[10]);
  assert.equal(passes[2].vm[0], tr.frames[10][0]);
  assert.ok(Math.abs(tr.put[10] - 20) < 1e-9 && tr.put[0] === 0);
});

test("transient study: profiles, output times, time to reach, CSV", () => {
  assert.equal(profileFactor(undefined, 5), 1);
  assert.equal(profileFactor({ kind: "step", at: 10 }, 5), 0);
  assert.equal(profileFactor({ kind: "duty", on: 2, period: 10 }, 11), 1);
  assert.equal(profileFactor({ kind: "duty", on: 2, period: 10 }, 13), 0);
  assert.equal(profileFactor({ kind: "table", pts: [[0, 0], [10, 1]] }, 5), 0.5);
  assert.equal(profileFactor({ kind: "table", pts: [[0, 0], [10, 1]] }, 50), 1);
  assert.equal(profileStep({ kind: "duty", on: 2, period: 10 }), 0.5);
  assert.deepEqual(outputTimes(100, 30), [0, 30, 60, 90, 100]);
  assert.equal(outputTimes(10000, 1).length, 201);
  assert.deepEqual(parseProfile("0 0\n60, 1; 120 0.5"), [[0, 0], [60, 1], [120, 0.5]]);
  assert.equal(parseProfile("0 0\n-1 1"), null);
  assert.equal(parseProfile("10 0\n5 1"), null);
  assert.equal(timeToReach([0, 10, 20], [20, 40, 60], 50), 15);
  assert.equal(timeToReach([0, 10], [20, 40], 80), null);
  assert.equal(transientCsv([0, 10], [{ name: "P1", v: [20, 30.5] }]), '"Time, s","P1, °C"\n0,20\n10,30.5\n');
});

test("a radiating block follows the lumped curve, without a new matrix at every step", () => {
  const P = 0.75, eps = 0.9, sig = 5.670374419e-14, Ts = 293.15;
  const times = Array.from({ length: 21 }, (_v, i) => i * 300);
  // the lumped equation rc V dT/dt = P − ε σ A (T⁴ − Ts⁴), by small Runge-Kutta steps
  const want: number[] = [20];
  const F = (T: number) => (P - eps * sig * A * (T ** 4 - Ts ** 4)) / (rc * V);
  let T = Ts;
  for (let i = 1; i < times.length; i++) {
    for (let s = 0; s < 300; s++) { const k1 = F(T), k2 = F(T + 0.5 * k1), k3 = F(T + 0.5 * k2), k4 = F(T + k3); T += (k1 + 2 * k2 + 2 * k3 + k4) / 6; }
    want.push(T - 273.15);
  }
  const got: number[] = [];
  const r = transientThermal({ ...base, sinks: [{ tris: skin, emissivity: eps, ambient: 20 }], sources: [{ power: P }] }, {
    rc: [rc], t0: 20, times, factor: () => 1,
    frame: (_k, _t, sample) => { got.push(sample([20, 5, 5]).temp[0]); },
  });
  const rise = want[want.length - 1] - 20;
  assert.ok(rise > 30, `rise ${rise}`);
  times.forEach((t, i) => assert.ok(Math.abs(got[i] - want[i]) <= 0.02 * rise, `t ${t}: ${got[i]} vs ${want[i]}`));
  // the films are linearised again only after a move of two step allowances, so matrices are fewer than steps
  assert.ok(r.solves < 0.6 * r.steps, `matrices ${r.solves}, steps ${r.steps}`);
});
