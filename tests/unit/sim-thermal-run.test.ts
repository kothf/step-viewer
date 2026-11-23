// Thermal studies (FRS-thermal TH2): a study's items become the solver's sinks and sources, and the passes
// converge to the closed-form answers of a bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, runTransient, studyProblem, faceSizes } from "../../src/sim/run";
import { newStudy, enclosureFactor } from "../../src/sim/types";
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

// ---- assemblies (TH3): two bars end to end, each a component with its own conductivity ----
function barBody(x0: number, x1: number, comp: string) {
  const l = [x0, 0, 0], h = [x1, B, T], t: number[] = [], f: number[] = [], n: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const q = rectFace(a, end ? h[a] : l[a], l, h, !!end);
    n.push(`${comp}@${"xyz"[a]}${end}`);
    t.push(...q);
    for (let k = 0; k < q.length / 9; k++) f.push(n.length - 1);
  }
  return { tris: t, face: f, names: n };
}
const A1 = barBody(0, 60, "c1"), A2 = barBody(60, L, "c2");
const asmBody = { tris: Float64Array.from([...A1.tris, ...A2.tris]), face: Int32Array.from([...A1.face, ...A2.face.map(i => i + 6)]), names: [...A1.names, ...A2.names], lo, hi };
const regions = [{ tris: Float64Array.from(A1.tris), mat: { name: "a", E: 0, nu: 0, rho: 0 } }, { tris: Float64Array.from(A2.tris), mat: { name: "b", E: 0, nu: 0, rho: 0 } }];
const K1 = 0.2, K2 = 0.02;

test("thermal study of an assembly: components in series, a pad between them, heat made in one (AT-TH3-4, AT-TH3-8)", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "c2@x1" }], value: { v: 4 } });
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "c1@x0" }], temp: 20 });
  const go = (links?: { a: number; b: number; type: "none" | "resistance"; h?: number }[]) => [...runThermal({ body: asmBody, mat: regions[0].mat, problem: studyProblem(st, asmBody), passes: 2, energyTol: 0, pos, nrm, regions,
    thermal: { k: K1, setup: thermalSetup(st, asmBody, ["c1", "c2"]), ks: [K1, K2], gap: 0.1, links } })].at(-1)!;
  const r = go(), area = B * T, hot = 20 + (4 * 60) / (K1 * area) + (4 * 40) / (K2 * area);
  assert.ok(Math.abs(r.vm[1] - hot) < 2e-3 * hot, `hot end ${r.vm[1]} for ${hot}`);
  assert.deepEqual([...r.dom!], [0, 1, 0]);
  const C = r.thermal!.contacts!;
  assert.equal(C.length, 1);
  assert.ok(Math.abs(Math.abs(C[0].heat) - 4) < 0.02, `contact heat ${C[0].heat}`);
  assert.equal(r.thermal!.comps!.length, 2);
  assert.ok(r.thermal!.comps![1].max > r.thermal!.comps![0].max);
  // a 0.5 mm pad of 3 W/(m·K)
  const h = 3e-3 / 0.5, p = go([{ a: 0, b: 1, type: "resistance", h }]), step = 4 / (h * area);
  assert.ok(Math.abs(p.vm[1] - r.vm[1] - step) < 0.03 * step, `pad adds ${p.vm[1] - r.vm[1]} for ${step}`);
  // no contact: nothing cools the second bar
  assert.throws(() => go([{ a: 0, b: 1, type: "none" }]), /E-TH-LOOSE: 1/);
  // the heat made throughout the component a picked face is on
  st.loads[0] = { id: "l1", type: "heat", faces: [{ name: "c2@y0" }], value: { v: 4 }, body: true };
  const set = thermalSetup(st, asmBody, ["c1", "c2"]);
  assert.deepEqual(set.sources, [{ power: 4, doms: [1], id: "l1" }]);
  const v = go();
  assert.ok(Math.abs(v.thermal!.comps![1].power - 4) < 1e-9 && v.thermal!.comps![0].power === 0);
  assert.ok(Math.abs(v.thermal!.flows[0].out - 4) < 0.02, `out ${v.thermal!.flows[0].out}`);
  // no cooling at all: stopped before solving, naming every component (FR-TBC-012)
  st.supports = [];
  assert.throws(() => go(), /^Error: E-TH-NOSINK: 0,1$/);
});

test("a board study: heat from the package, cooling of every open surface, a heatsink by its resistance (FR-TLOAD-004, FR-TBC-008)", () => {
  const st = newStudy([], "thermal");
  st.settings.ambient = 30;
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], parts: [
    { id: 1, name: "R1", comps: ["c2"], p: 2 }, { id: 2, name: "C1", comps: ["c1"], p: 0.005 }, { id: 3, name: "R2", comps: ["c1"], p: 1, off: true }, { id: 4, name: "Q9", comps: [], p: 5 }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  const set = thermalSetup(st, asmBody, ["c1", "c2"]);
  // parts under 10 mW, left out or without a body make no heat
  assert.deepEqual(set.sources, [{ power: 2, doms: [1], id: "l1" }]);
  assert.equal(set.sinks.length, 1);
  assert.ok(set.sinks[0].free && set.sinks[0].tris.length === asmBody.tris.length && set.problems.length === 0);
  const r = [...runThermal({ body: asmBody, mat: regions[0].mat, problem: studyProblem(st, asmBody), passes: 2, energyTol: 0, pos, nrm, regions,
    thermal: { k: K1, setup: set, ks: [K1, K2], gap: 0.1 } })].at(-1)!;
  const open = 2 * (L * B + L * T + B * T), f = r.thermal!.flows[0];
  // the faces where the two bars meet are not cooled
  assert.ok(Math.abs(f.area - open) < 1e-3 * open, `open area ${f.area} for ${open}`);
  assert.ok(Math.abs(f.out - 2) < 0.01, `out ${f.out}`);
  assert.ok(Math.abs(f.mean - (30 + 2 / (10e-6 * open))) < 0.2 * (2 / (10e-6 * open)), `mean ${f.mean}`);
  // a heatsink of 5 K/W on the first bar's end: its face leaves the open surfaces, and takes nearly all the heat
  st.supports.push({ id: "s2", type: "conv", faces: [{ name: "c1@x0" }], rth: 5 });
  const two = thermalSetup(st, asmBody, ["c1", "c2"]);
  assert.equal(two.sinks[0].tris.length, asmBody.tris.length - 18);
  assert.ok(Math.abs(two.sinks[1].h! - 1 / (5 * B * T)) < 1e-12);
  const h = [...runThermal({ body: asmBody, mat: regions[0].mat, problem: studyProblem(st, asmBody), passes: 2, energyTol: 0, pos, nrm, regions,
    thermal: { k: K1, setup: two, ks: [K1, K2], gap: 0.1 } })].at(-1)!;
  const [air, sink] = h.thermal!.flows;
  assert.ok(Math.abs(air.out + sink.out - 2) < 0.01 && sink.out > 0.3, `air ${air.out}, heatsink ${sink.out}`);
  // the heatsink's own face is at ambient + its heat × Rth
  assert.ok(Math.abs(sink.mean - (30 + sink.out * 5)) < 0.05 * sink.out * 5, `heatsink face ${sink.mean} for ${30 + sink.out * 5}`);
  assert.ok(h.thermal!.max < r.thermal!.max);
  st.supports[1].rth = 0;
  assert.deepEqual(thermalSetup(st, asmBody, ["c1", "c2"]).problems, [{ id: "s2", code: "E-TH-VALUE" }]);
});

test("heat paths of a board study: where a part's heat goes, and the package's split kept (FR-TBRD-003)", () => {
  const boxBody = (l: number[], h: number[], comp: string) => {
    const t: number[] = [], f: number[] = [], n: string[] = [];
    for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
      const q = rectFace(a, end ? h[a] : l[a], l, h, !!end);
      n.push(`${comp}@${"xyz"[a]}${end}`);
      t.push(...q);
      for (let k = 0; k < q.length / 9; k++) f.push(n.length - 1);
    }
    return { tris: t, face: f, names: n };
  };
  // a board 60 × 40 × 1.6 and a part 10 × 10 × 10 standing on it
  const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 15, 1.6], [30, 25, 11.6], "r1");
  const body = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(i => i + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 11.6] };
  const regs = [{ tris: Float64Array.from(P.tris), mat: { name: "pcb", E: 0, nu: 0, rho: 0 } }, { tris: Float64Array.from(Q.tris), mat: { name: "r", E: 0, nu: 0, rho: 0 } }];
  const st = newStudy([], "thermal");
  st.settings.ambient = 25;
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", parts: [{ id: 1, name: "R1", comps: ["r1"], p: 2, board: 1.2, sink: 0.5, path: "chassis" }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  const solve = () => {
    const set = thermalSetup(st, body, ["pcb", "r1"]);
    return { set, r: [...runThermal({ body, mat: regs[0].mat, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, regions: regs, thermal: { k: 0.0003, setup: set, ks: [0.0003, 0.0003], gap: 0.1 } })].at(-1)! };
  };
  // without a board there is no split: all the heat is made in the part; what leaves each component adds up to the heat put in
  delete st.loads[0].board;
  const a = solve(), ca = a.r.thermal!.comps!;
  assert.deepEqual(a.set.sources, [{ power: 2, doms: [1], id: "l1" }]);
  assert.ok(Math.abs(ca[1].power - 2) < 1e-9 && ca[0].power === 0);
  assert.ok(Math.abs(ca[0].out! + ca[1].out! - 2) < 0.02, `out ${ca[0].out} + ${ca[1].out}`);
  // the part conducts some of its heat into the board, the board loses it to the air
  assert.ok(ca[0].out! > 0.1 && ca[1].out! < 2, `board ${ca[0].out}, part ${ca[1].out}`);
  // with a board the split is always kept, even saved off (1.712): 1.2 W enters the board under the part, 0.5 W goes
  // to the chassis, 0.3 W is made in the part
  st.loads[0].board = "pcb";
  st.loads[0].split = false;
  const b = solve(), patch = b.set.sources.find(s => s.tris)!;
  assert.equal(b.set.sources.length, 2);
  assert.equal(patch.power, 1.2);
  assert.equal(patch.dom, 0);
  for (let o = 0; o < patch.tris.length; o += 3) {
    assert.ok(Math.abs(patch.tris[o + 2] - 1.6) < 1e-9, "on the board's top face");
    assert.ok(patch.tris[o] >= 0 && patch.tris[o] <= 60);
  }
  assert.deepEqual(b.set.sources.find(s => !s.tris), { power: 2 - 1.2 - 0.5, doms: [1], id: "l1" });
  const cb = b.r.thermal!.comps!;
  assert.ok(Math.abs(cb[0].power - 1.2) < 1e-9 && Math.abs(cb[1].power - 0.3) < 1e-9);
  assert.ok(Math.abs(b.r.thermal!.applied - 1.5) < 0.01, `applied ${b.r.thermal!.applied}`);
});

test("thermal study: natural convection from every open surface, face sizes, enclosure and gravity (FR-TBC-004/010/011)", () => {
  // the bar's faces: x ends 20 × 20, y sides 100 × 20, z faces 100 × 20
  const all = Array.from({ length: body.face.length }, (_, i) => i);
  const z = faceSizes(body, all, [0, 0, -1]);
  const at = (f: string) => body.face.indexOf(names.indexOf(f));
  assert.equal(z.lv[at("x0")], 20);
  assert.ok(Math.abs(z.lh[at("x0")] - 400 / 80) < 1e-9);
  assert.ok(Math.abs(z.lh[at("z1")] - 2000 / 240) < 1e-9);
  // gravity along X: the y sides are 100 high now
  assert.equal(faceSizes(body, all, [-1, 0, 0]).lv[at("y0")], 100);
  assert.equal(enclosureFactor({ passes: 3, energyTol: 0 }), 1);
  assert.equal(enclosureFactor({ passes: 3, energyTol: 0, enclosure: "closed" }), 0.55);
  assert.equal(enclosureFactor({ passes: 3, energyTol: 0, enclosure: "custom", factor: 0.7 }), 0.7);
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [], body: true, value: { v: 2 } });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, natural: true });
  const set = thermalSetup(st, body);
  assert.equal(set.problems.length, 0);
  assert.ok(set.sinks[0].natural && set.sinks[0].natural.factor === 1);
  const open = run(st).at(-1)!;
  assert.ok(Math.abs(open.thermal!.flows[0].out - 2) < 1e-4, `out ${open.thermal!.flows[0].out}`);
  const h = open.thermal!.flows[0].h! * 1e6;
  assert.ok(h > 3 && h < 10, `mean h ${h}`);
  // the same bar in a closed chassis runs hotter
  st.settings.enclosure = "closed";
  const closed = run(st).at(-1)!;
  assert.ok(closed.thermal!.max > open.thermal!.max + 5, `${closed.thermal!.max} vs ${open.thermal!.max}`);
});

test("a board warm-up gives each component's temperatures at every output time (part temperatures and the report need them)", () => {
  const boxBody = (l: number[], h: number[], comp: string) => {
    const t: number[] = [], f: number[] = [], n: string[] = [];
    for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
      const q = rectFace(a, end ? h[a] : l[a], l, h, !!end);
      n.push(`${comp}@${"xyz"[a]}${end}`);
      t.push(...q);
      for (let k = 0; k < q.length / 9; k++) f.push(n.length - 1);
    }
    return { tris: t, face: f, names: n };
  };
  const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 15, 1.6], [30, 25, 11.6], "r1");
  const body = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(i => i + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 11.6] };
  const regs = [{ tris: Float64Array.from(P.tris), mat: { name: "pcb", E: 0, nu: 0, rho: 0 } }, { tris: Float64Array.from(Q.tris), mat: { name: "r", E: 0, nu: 0, rho: 0 } }];
  const st = newStudy([], "thermal");
  st.settings.ambient = 25;
  st.settings.transient = { end: 600, out: 120 };
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", parts: [{ id: 1, name: "R1", comps: ["r1"], p: 2 }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  const set = thermalSetup(st, body, ["pcb", "r1"]);
  const pts = new Float32Array([5, 5, 1.6, 55, 35, 1.6, 25, 20, 11.6, 25, 15, 6]), nn = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, -1, 0]);
  const passes = [...runTransient({ body, mat: regs[0].mat, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos: pts, nrm: nn, regions: regs,
    thermal: { k: 0.0003, setup: set, ks: [0.0003, 0.0003], gap: 0.1, transient: { rc: 2e-3, rcs: [2e-3, 3e-3], t0: 25, end: 600, out: 120, profiles: {} } } })];
  const last = passes.at(-1)!, tr = last.transient!, steady = passes.at(-2)!.thermal!.comps!;
  assert.equal(tr.cstats?.length, tr.times.length);
  const c = last.thermal!.comps!;
  assert.equal(c.length, 2);
  // the part is hotter than the board, both warm with time, and the rows carry the steady powers
  assert.ok(c[1].max > c[0].max && c[1].min <= c[1].mean && c[1].mean <= c[1].max, JSON.stringify(c));
  assert.ok(tr.cstats![1][1].max < tr.cstats!.at(-1)![1].max);
  assert.ok(Math.abs(c[1].power - steady[1].power) < 1e-9 && Math.abs(c[1].power - 2) < 1e-9);
  assert.equal(c[1].max, tr.comps!.at(-1)![1]);
});
