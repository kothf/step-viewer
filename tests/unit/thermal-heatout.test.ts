// Where each component's heat goes (FRS-thermal FR-TRES-005): to the air, by radiation, to fixed temperatures and
// to its neighbours, adding up to the heat made in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { balanceCsv } from "../../src/thermal/csv";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
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

// a board 60 × 40 × 1.6 with a block 10 × 10 × 10 on it that makes 2 W
const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 15, 1.6], [30, 25, 11.6], "r1");
const asm = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(i => i + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 11.6] };
const regs = [{ tris: Float64Array.from(P.tris), mat: { name: "pcb", E: 0, nu: 0, rho: 0 } }, { tris: Float64Array.from(Q.tris), mat: { name: "r", E: 0, nu: 0, rho: 0 } }];
const pos = new Float32Array([0, 20, 0.8, 25, 20, 11.6]), nrm = new Float32Array([-1, 0, 0, 0, 0, 1]);

function go(st: ReturnType<typeof newStudy>) {
  const set = thermalSetup(st, asm, ["pcb", "r1"]);
  return [...runThermal({ body: asm, mat: regs[0].mat, problem: studyProblem(st, asm), passes: 2, energyTol: 0, pos, nrm, regions: regs, thermal: { k: 0.02, setup: set, ks: [0.02, 0.02], gap: 0.1 } })].at(-1)!;
}

test("each component's heat leaves by air, radiation, fixed temperatures and its neighbours", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "r1@z1" }], body: true, value: { v: 2 } });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 }, { id: "s2", type: "rad", faces: [], all: true, emis: 0.8 }, { id: "s3", type: "temp", faces: [{ name: "pcb@x0" }], temp: 25 });
  const r = go(st), T = r.thermal!, [b, q] = T.comps!;
  assert.ok(Math.abs(q.power - 2) < 1e-9 && b.power === 0);
  for (const c of [b, q]) {
    const sum = c.conv! + c.rad! + c.held! + c.cond!;
    assert.ok(Math.abs(sum - c.power) < 0.03 * 2, `made ${c.power}, leaves ${sum}`);
  }
  // the block passes heat to the board, which takes it in
  assert.ok(q.cond! > 0.3 && Math.abs(q.cond! + b.cond!) < 1e-9, `block ${q.cond}, board ${b.cond}`);
  assert.ok(q.conv! > 0 && q.rad! > 0 && b.conv! > 0 && b.rad! > 0);
  // only the board touches the fixed temperature
  assert.equal(q.held, 0);
  assert.ok(b.held! > 0.1, `board to the fixed end ${b.held}`);
  // the components' shares add up to each sink's flow
  const [conv, rad, held] = T.flows;
  assert.ok(Math.abs(b.conv! + q.conv! - conv.out) < 1e-9 && Math.abs(b.rad! + q.rad! - rad.out) < 1e-9 && Math.abs(b.held! + q.held! - held.out) < 1e-9);
  // the CSV lists them
  const csv = balanceCsv({ applied: T.applied, flows: [], comps: [{ name: "r1", ...q }] });
  assert.match(csv, /Component to the air,r1,/);
  assert.match(csv, /Component conducted to neighbours,r1,/);
});
