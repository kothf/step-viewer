// Thermal studies (FRS-thermal TH2): a study's items become the solver's sinks and sources, and the passes
// converge to the closed-form answers of a bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { typedValue, shownValue } from "../../src/sim/values";

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
// the two ends and the middle of the bar
const pos = new Float32Array([0, B / 2, T / 2, L, B / 2, T / 2, L / 2, B / 2, T / 2]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0, 0]);
const run = (st: ReturnType<typeof newStudy>, tol = 0) => [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 3, energyTol: tol, pos, nrm, thermal: { k: K * 1e-3, setup: thermalSetup(st, body) } })];

test("thermal study: a new one is named and set up for temperatures", () => {
  const st = newStudy([], "thermal");
  assert.equal(st.kind, "thermal");
  assert.equal(st.name, "Thermal 1");
  assert.equal(st.settings.ambient, 25);
  assert.equal(newStudy([st], "thermal").name, "Thermal 2");
});

test("thermal study: heat through a bar between a heated end and a held end", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x0" }], value: { v: 10 } });
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "x1" }], temp: 40 });
  const set = thermalSetup(st, body);
  assert.equal(set.problems.length, 0);
  assert.deepEqual(set.sinkIds, ["s1"]);
  // the structural solver sees none of it
  const pb = studyProblem(st, body);
  assert.equal(pb.fixed.length, 0);
  assert.equal(pb.loads.length, 0);
  const passes = run(st), r = passes.at(-1)!;
  const rise = 10 * L / (K * 1e-3 * B * T);
  assert.ok(Math.abs(r.vm[0] - (40 + rise)) < 1e-3 * rise, `hot end ${r.vm[0]} for ${40 + rise}`);
  assert.ok(Math.abs(r.vm[1] - 40) < 1e-3 * rise, `held end ${r.vm[1]}`);
  assert.ok(Math.abs(r.thermal!.max - (40 + rise)) < 1e-3 * rise && Math.abs(r.thermal!.min - 40) < 1e-3 * rise);
  // flux W/mm² = power over the section, along +X
  assert.ok(Math.abs(r.u[6] / (10 / (B * T)) - 1) < 1e-3, `flux ${r.u[6]}`);
  assert.ok(Math.abs(r.thermal!.applied - 10) < 1e-9 && Math.abs(r.thermal!.flows[0].out - 10) < 1e-6);
  // every pass after the first knows how much the temperatures moved
  for (const p of passes.slice(1)) assert.ok(Number.isFinite(p.change) && p.change! < 0.1, `change ${p.change}`);
  assert.equal(passes[0].change, null);
});

test("thermal study: the passes stop once the temperatures settle", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [], body: true, value: { v: 10 } });
  st.supports.push({ id: "s1", type: "conv", faces: [{ name: "z1" }], h: 40 });
  const passes = run(st, 1), r = passes.at(-1)!;
  assert.equal(passes.length, 2);
  assert.ok(r.converged && r.done);
  // the face gives off all the power: its mean temperature is ambient + P / (h A)
  assert.ok(Math.abs(r.thermal!.flows[0].mean - (25 + 10 / (40e-6 * L * B))) < 0.05, `mean ${r.thermal!.flows[0].mean}`);
  assert.ok(Math.abs(r.thermal!.flows[0].out - 10) < 1e-6);
});

test("thermal study: what is wrong with it is named", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "hflux", faces: [{ name: "x0" }], value: { v: 1000 } });
  assert.throws(() => run(st), /E-TH-NOSINK/);
  st.supports.push({ id: "s1", type: "rad", faces: [{ name: "x1" }], emis: 1.4 });
  assert.deepEqual(thermalSetup(st, body).problems, [{ id: "s1", code: "E-TH-VALUE" }]);
  st.supports[0].emis = 0.9;
  st.supports.push({ id: "s2", type: "conv", faces: [{ name: "gone" }], h: 8 }, { id: "s3", type: "temp", faces: [], temp: 30 });
  assert.deepEqual(thermalSetup(st, body).problems, [{ id: "s2", code: "E-SIM-REF" }, { id: "s3", code: "E-SIM-EMPTY" }]);
  st.suppressed = ["s2", "s3", "l1"];
  assert.throws(() => run(st), /E-TH-NOHEAT/);
});

test("thermal study: radiation and a flux in W/m²", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "hflux", faces: [{ name: "x0" }], value: { v: 2000 } });
  st.supports.push({ id: "s1", type: "rad", faces: [{ name: "x1" }], emis: 0.9, ambient: 20 });
  const r = run(st).at(-1)!;
  const P = 2000e-6 * B * T, Ta = 293.15, Ts = (P / (0.9 * 5.670374419e-14 * B * T) + Ta ** 4) ** 0.25 - 273.15;
  assert.ok(Math.abs(r.thermal!.applied - P) < 1e-9);
  assert.ok(Math.abs(r.vm[1] - Ts) < 0.05, `radiating end ${r.vm[1]} for ${Ts}`);
  assert.ok(r.thermal!.solves > 1);
});

test("thermal values: watts and watts per area with units", () => {
  assert.equal(typedValue("2 kW", "heat", {}).v, 2000);
  assert.equal(typedValue("500 mW", "heat", {}).v, 0.5);
  assert.equal(typedValue("1 W/cm²", "hflux", {}).v, 10000);
  assert.equal(shownValue({ v: 10 }, "heat"), "10");
});

test("thermal exports: CSV headings name temperatures and heat flux in W/m²", async () => {
  const { pathCsv, pathRows } = await import("../../src/sim/path");
  const { probeCsv } = await import("../../src/sim/probes");
  const rows = pathRows([0, 0, 0, 3, 4, 0], [40, 41], [0.001, 0, 0, 0, 0.002, 0], [1, 1]);
  const csv = pathCsv(rows, true).split("\r\n");
  assert.match(csv[0], /Temperature \(°C\).*Heat flux \(W\/m²\)/);
  assert.equal(csv[2], "5,3,4,0,41,0,2000,0,2000");
  assert.match(pathCsv(rows).split("\r\n")[0], /von Mises/);
  const pc = probeCsv([{ at: [1, 2, 3], vm: 55.5, u: [0.001, 0, 0], sf: 2 }], true).split("\r\n");
  assert.equal(pc[0].split(",").length, 9);
  assert.equal(pc[1], "1,1,2,3,55.5,1000,1000,0,0");
});
