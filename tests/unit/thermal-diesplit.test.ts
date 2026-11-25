// A board package part with heat bodies and a split (FR-TBRD-003/021): all its power is made in the heat bodies,
// and the share that goes into the board is given up by the part's surface at the board, so the whole power
// crosses from the die to the case before it reaches the leads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { nearPatch } from "../../src/thermal/study";

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

// a board 60 × 40 × 1.6, a case 10 × 10 × 4 standing on it (a poor conductor) and the die on top of the case
const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), C = boxBody([20, 15, 1.6], [30, 25, 5.6], "case"), D = boxBody([20, 15, 5.6], [30, 25, 7.6], "die");
const all = [P, C, D];
const body = {
  tris: Float64Array.from(all.flatMap(x => x.tris)),
  face: Int32Array.from(all.flatMap((x, i) => x.face.map(f => f + 6 * i))),
  names: all.flatMap(x => x.names), lo: [0, 0, 0], hi: [60, 40, 7.6],
};
const mat = { name: "m", E: 0, nu: 0, rho: 0 };
const regs = all.map(x => ({ tris: Float64Array.from(x.tris), mat }));
const pos = new Float32Array([25, 20, 7.6]), nrm = new Float32Array([0, 0, 1]);
const keys = ["pcb", "case", "die"];

function study(hot?: string[]) {
  const st = newStudy([], "thermal");
  st.settings.ambient = 25;
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", split: true, parts: [
    { id: 1, name: "Q1", comps: ["case", "die"], p: 1, board: 0.6, ...(hot ? { hot } : {}) }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  return st;
}

test("nearPatch: the part's triangles at the patch, none far from it", () => {
  const patch = Float64Array.from(rectFace(2, 1.6, [19, 14, 0], [31, 26, 0], true));
  const at = nearPatch(Float64Array.from([...C.tris, ...D.tris]), patch)!;
  // the case's bottom and its four sides (they start at the board); nothing of its top or of the die
  assert.equal(at.length / 9, 10);
  for (let o = 2; o < at.length; o += 3) assert.ok(at[o] <= 5.6);
  assert.equal(nearPatch(Float64Array.from(D.tris), patch), null);
});

test("heat bodies with a split: the whole power in the die, the board share given up at the board", () => {
  const set = thermalSetup(study(["die"]), body, keys);
  assert.deepEqual(set.sources.find(s => !s.tris), { power: 1, doms: [2], id: "l1" });
  const into = set.sources.find(s => s.tris && s.power! > 0)!, out = set.sources.find(s => s.tris && s.power! < 0)!;
  assert.equal(into.power, 0.6);
  assert.equal(into.dom, 0);
  assert.equal(out.power, -0.6);
  assert.equal(out.dom, 1);
  // no heat bodies (or every body one): as before, what is left of the power throughout the part
  const plain = thermalSetup(study(), body, keys);
  assert.equal(plain.sources.length, 2);
  assert.deepEqual(plain.sources.find(s => !s.tris), { power: 0.4, doms: [1, 2], id: "l1" });
  const every = thermalSetup(study(["die", "case"]), body, keys);
  assert.deepEqual(every.sources.find(s => !s.tris), { power: 0.4, doms: [1, 2], id: "l1" });
});

test("the die runs hotter than with only its own share in it, at the same heat balance", () => {
  const st = study(["die"]), set = thermalSetup(st, body, keys);
  const run = (setup: typeof set) => [...runThermal({ body, mat, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, regions: regs,
    thermal: { k: 0.2, setup, ks: [0.0003, 0.0003, 0.1], gap: 0.1 } })].at(-1)!;
  const now = run(set);
  // the way it was: 0.4 W in the die, nothing given up
  const was = run({ ...set, sources: set.sources.filter(s => !(s.tris && s.power! < 0)).map(s => (s.tris ? s : { ...s, power: 0.4 })) });
  for (const r of [now, was]) assert.ok(Math.abs(r.thermal!.applied - 1) < 0.02, `applied ${r.thermal!.applied}`);
  const c = now.thermal!.comps!, w = was.thermal!.comps!;
  assert.ok(Math.abs(c[0].power - 0.6) < 1e-9 && Math.abs(c[1].power + 0.6) < 1e-9 && Math.abs(c[2].power - 1) < 1e-9, `${c.map(x => x.power)}`);
  // 0.6 W more crosses the case (4 mm of k 0.3 W/(m·K) over 100 mm²: 133 K/W) to its foot
  const rise = (c[2].max - c[1].min) - (w[2].max - w[1].min);
  assert.ok(rise > 30, `rise ${rise}`);
});
