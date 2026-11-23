// Chassis wall (FR-TBC-009): faces held at a temperature or passing heat to ambient through a resistance, and where
// a board package's chassis shares go when its split is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy, itemName, THERMAL_SUPPORTS, isThermalType } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const boxBody = (l: number[], h: number[], comp = "") => {
  const t: number[] = [], f: number[] = [], n: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const q = rectFace(a, end ? h[a] : l[a], l, h, !!end);
    n.push(`${comp ? comp + "@" : ""}${"xyz"[a]}${end}`);
    t.push(...q);
    for (let k = 0; k < q.length / 9; k++) f.push(n.length - 1);
  }
  return { tris: t, face: f, names: n };
};

const L = 100, B = 20, T = 20, K = 0.054;
const bar = boxBody([0, 0, 0], [L, B, T]);
const body = { tris: Float64Array.from(bar.tris), face: Int32Array.from(bar.face), names: bar.names, lo: [0, 0, 0], hi: [L, B, T] };
const pos = new Float32Array([0, B / 2, T / 2, L, B / 2, T / 2]), nrm = new Float32Array([-1, 0, 0, 1, 0, 0]);
const run = (st: ReturnType<typeof newStudy>) => [...runThermal({ body, mat: { name: "Steel", E: 0, nu: 0, rho: 0 }, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, thermal: { k: K, setup: thermalSetup(st, body) } })].at(-1)!;

test("chassis wall: a thermal item named like the others", () => {
  assert.ok(THERMAL_SUPPORTS.includes("chassis") && isThermalType("chassis"));
  assert.equal(itemName(newStudy([], "thermal"), "chassis"), "Chassis wall 1");
});

test("chassis wall by its resistance: the heat leaves there and the wall is ambient + heat × Rth", () => {
  const st = newStudy([], "thermal");
  st.settings.ambient = 30;
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x1" }], value: { v: 10 } });
  st.supports.push({ id: "s1", type: "chassis", faces: [{ name: "x0" }], rth: 2 });
  const set = thermalSetup(st, body);
  assert.equal(set.sinks.length, 1);
  assert.ok(Math.abs(set.sinks[0].h! - 1 / (2 * B * T)) < 1e-15);
  const r = run(st), f = r.thermal!.flows[0];
  assert.ok(Math.abs(f.out - 10) < 0.05, `out ${f.out}`);
  assert.ok(Math.abs(f.mean - 50) < 0.5, `wall ${f.mean}`);
  // the hot end is the wall plus the bar's own drop q L / (k A)
  const drop = (10 * L) / (K * B * T);
  assert.ok(Math.abs(r.thermal!.max - (50 + drop)) < 0.03 * drop, `max ${r.thermal!.max} for ${50 + drop}`);
  // held at a temperature instead
  delete st.supports[0].rth;
  st.supports[0].temp = 45;
  const h = run(st);
  assert.ok(Math.abs(h.thermal!.flows[0].mean - 45) < 0.2 && Math.abs(h.thermal!.flows[0].out - 10) < 0.05);
  // a resistance of 0 is refused
  st.supports[0].rth = 0;
  assert.deepEqual(thermalSetup(st, body).problems, [{ id: "s1", code: "E-TH-VALUE" }]);
});

test("chassis wall faces are not open surfaces", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "x1" }], value: { v: 1 } });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 }, { id: "s2", type: "chassis", faces: [{ name: "x0" }], temp: 40 });
  const set = thermalSetup(st, body);
  assert.equal(set.sinks[0].tris.length, body.tris.length - 18);
  assert.equal(set.sinks[1].temp, 40);
});

test("a package's chassis shares enter the chassis walls when its split is kept (FR-TBRD-003)", () => {
  // a board 60 × 40 × 1.6, a part 10 × 10 × 10 on it, and a chassis wall on both board ends
  const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 15, 1.6], [30, 25, 11.6], "r1");
  const asm = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(i => i + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 11.6] };
  const regs = [{ tris: Float64Array.from(P.tris), mat: { name: "pcb", E: 0, nu: 0, rho: 0 } }, { tris: Float64Array.from(Q.tris), mat: { name: "r", E: 0, nu: 0, rho: 0 } }];
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", split: true, parts: [{ id: 1, name: "Q1", comps: ["r1"], p: 2, board: 0.6, sink: 1, path: "chassis" }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  const go = () => {
    const set = thermalSetup(st, asm, ["pcb", "r1"]);
    return { set, r: [...runThermal({ body: asm, mat: regs[0].mat, problem: studyProblem(st, asm), passes: 2, energyTol: 0, pos, nrm, regions: regs, thermal: { k: 0.0003, setup: set, ks: [0.0003, 0.0003], gap: 0.1 } })].at(-1)! };
  };
  // no wall: the chassis share leaves the model
  const a = go();
  assert.ok(Math.abs(a.r.thermal!.applied - 1) < 0.01, `applied ${a.r.thermal!.applied}`);
  // two walls of 64 mm² each: the 1 W share is put on them by area, and taken away there
  st.supports.push({ id: "s2", type: "chassis", faces: [{ name: "pcb@x0" }, { name: "pcb@x1" }], rth: 3 });
  const b = go(), on = b.set.sources.filter(s => s.tris && s.dom === undefined);
  assert.equal(on.length, 1);
  assert.ok(Math.abs(on[0].power! - 1) < 1e-12);
  assert.ok(Math.abs(b.r.thermal!.applied - 2) < 0.01, `applied ${b.r.thermal!.applied}`);
  const wall = b.r.thermal!.flows[1];
  // most of the share leaves through the wall; a little warms the board and goes to the air
  assert.ok(wall.out > 0.7 && wall.out < 2, `wall takes ${wall.out}`);
  assert.ok(Math.abs(wall.mean - (25 + wall.out * 3)) < 0.05 * wall.out * 3, `wall ${wall.mean}`);
});
