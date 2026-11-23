// Heat entering a board through a part's pads (FR-TBRD-003): the elements under the pads, and their neighbours, start
// a few degrees ahead of the rest (`run.ts` `thermalBoost`), since the temperature peaks there over a few millimetres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runThermal, thermalSetup, thermalBoost, studyProblem, PAD_FINE } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { insideOf, MeshBody } from "../../src/sim/body";

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
// a board 60 × 40 × 1.6 and a part 10 × 10 × 2 standing on it
const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 15, 1.6], [30, 25, 3.6], "u1");
const body = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(i => i + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 3.6] };
const regions = [{ tris: Float64Array.from(P.tris), mat: { name: "pcb", E: 0, nu: 0, rho: 0 } }, { tris: Float64Array.from(Q.tris), mat: { name: "u1", E: 0, nu: 0, rho: 0 } }];
const pos = Float32Array.from([25, 20, 1.6, 50, 35, 0]), nrm = new Float32Array(6);

const study = () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", parts: [{ id: 1, name: "U1", comps: ["u1"], p: 2, board: 1.6,
    into: [{ disc: [21.5, 20, 0.8], w: 0.8 }, { disc: [28.5, 20, 0.8], w: 0.8 }] }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  return st;
};
const input = (fine: boolean) => {
  const st = study(), setup = thermalSetup(st, body, ["pcb", "u1"]);
  if (!fine) for (const s of setup.sources) delete s.fine;
  return { body, mat: regions[0].mat, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, regions, thermal: { k: 0.8e-3, setup, ks: [0.8e-3, 20e-3], gap: 0.1 } };
};

test("pads: the board patches ask for finer elements; those under the pads and their neighbours start ahead", () => {
  const inp = input(true);
  const pads = inp.thermal.setup.sources.filter(s => s.tris);
  assert.equal(pads.length, 2);
  assert.ok(pads.every(s => s.fine === PAD_FINE && s.dom === 0));
  const b = thermalBoost(inp, 4.8, insideOf(new MeshBody(body.tris)), regions.map(r => ({ inside: insideOf(new MeshBody(r.tris)) })))!;
  assert.ok(b, "a boost");
  const under = b.grid.cellOf(21.5, 20, 1.5, 0), far = b.grid.cellOf(55, 5, 0.8, 0);
  assert.equal(b.level[b.grid.cells[under].el], PAD_FINE);
  assert.equal(b.level[b.grid.cells[far].el], 0);
  assert.ok(b.level.some(v => v === PAD_FINE - 1), "neighbours one degree less");
  // no pads, no boost
  assert.equal(thermalBoost(input(false), 4.8, insideOf(new MeshBody(body.tris))), null);
});

test("pads: the peak under the pads comes out hotter (nearer the answer) with the same passes; the heat balance holds", () => {
  const plain = [...runThermal(input(false))].at(-1)!, fine = [...runThermal(input(true))].at(-1)!;
  assert.ok(fine.p > plain.p, `degree ${fine.p} vs ${plain.p}`);
  assert.ok(fine.thermal!.max > plain.thermal!.max, `hottest ${fine.thermal!.max} vs ${plain.thermal!.max}`);
  for (const r of [plain, fine]) assert.ok(Math.abs(r.thermal!.flows[0].out - 2) < 0.01, `out ${r.thermal!.flows[0].out}`);
});
