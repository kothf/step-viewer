// A board package's heatsink share (FR-TBRD-003, FR-TBC-008, FR-TBRD-004): with the package's split kept, the
// share goes into the heatsink body the part touches, under the part, and the heatsink carries it away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { facingPatch } from "../../src/thermal/study";

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

// a board 60 × 40 × 1.6, a part 10 × 10 × 10 standing on it, and a heatsink block against the part's +X side
// (clear of the board), much larger than the part
const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 15, 1.6], [30, 25, 11.6], "q1"), H = boxBody([30, 5, 3], [50, 35, 23], "hs");
const all = [P, Q, H];
const body = {
  tris: Float64Array.from(all.flatMap(x => x.tris)),
  face: Int32Array.from(all.flatMap((x, i) => x.face.map(f => f + 6 * i))),
  names: all.flatMap(x => x.names), lo: [0, 0, 0], hi: [60, 40, 23],
};
const mat = { name: "m", E: 0, nu: 0, rho: 0 };
const regs = all.map(x => ({ tris: Float64Array.from(x.tris), mat }));
const pos = new Float32Array([25, 20, 11.6]), nrm = new Float32Array([0, 0, 1]);

test("facingPatch: the heatsink's face under the part, not its far faces or its sides", () => {
  const patch = facingPatch(H.tris, Q.tris)!;
  assert.ok(patch);
  let area = 0;
  for (let o = 0; o < patch.length; o += 9) {
    for (let k = 0; k < 9; k += 3) {
      assert.equal(patch[o + k], 30, "on the face at x = 30");
      assert.ok(patch[o + k + 1] >= 14 - 1e-9 && patch[o + k + 1] <= 26 + 1e-9 && patch[o + k + 2] >= 3 - 1e-9 && patch[o + k + 2] <= 12.6 + 1e-9);
    }
    const u = [3, 4, 5].map(i => patch[o + i] - patch[o + i - 3]), v = [6, 7, 8].map(i => patch[o + i] - patch[o + i - 6]);
    area += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  // the part's side grown by 1 mm, cut at the heatsink's foot (z = 3): 12 × 9.6
  assert.ok(Math.abs(area - 12 * 9.6) < 1e-6, `area ${area}`);
  // a body nowhere near
  assert.equal(facingPatch(boxBody([100, 100, 100], [110, 110, 110], "far").tris, Q.tris), null);
});

test("a heatsink part's share enters the heatsink it touches; none found, it stays in the part", () => {
  const st = newStudy([], "thermal");
  st.settings.ambient = 25;
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", split: true, parts: [
    { id: 3, name: "Q1", comps: ["q1"], p: 3, board: 0.5, sink: 2, path: "heatsink" },
    { id: 9, name: "HS1", comps: ["hs"], p: 0 }] });
  st.supports.push({ id: "s1", type: "conv", faces: [], all: true, h: 10 });
  const keys = ["pcb", "q1", "hs"];
  const set = thermalSetup(st, body, keys);
  assert.deepEqual(set.heatsinks, { 3: { comp: "hs", w: 2 } });
  const sink = set.sources.find(s => s.dom === 2)!, board = set.sources.find(s => s.dom === 0)!;
  assert.equal(sink.power, 2);
  assert.equal(board.power, 0.5);
  for (let o = 0; o < sink.tris!.length; o += 3) assert.equal(sink.tris![o], 30);
  assert.deepEqual(set.sources.find(s => !s.tris), { power: 0.5, doms: [1], id: "l1" });
  const r = [...runThermal({ body, mat, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, regions: regs,
    thermal: { k: 0.2, setup: set, ks: [0.0003, 0.0003, 0.2], gap: 0.1 } })].at(-1)!;
  const c = r.thermal!.comps!;
  assert.ok(Math.abs(c[2].power - 2) < 1e-9 && Math.abs(c[0].power - 0.5) < 1e-9 && Math.abs(c[1].power - 0.5) < 1e-9);
  assert.ok(Math.abs(r.thermal!.applied - 3) < 0.02, `applied ${r.thermal!.applied}`);
  // what leaves the three components adds up to the heat put in, most of it off the heatsink
  assert.ok(Math.abs(c[0].out! + c[1].out! + c[2].out! - 3) < 0.03, `out ${c.map(x => x.out)}`);
  assert.ok(c[2].out! > 1, `heatsink ${c[2].out}`);
  // the package's split not kept: the whole power is made in the part
  st.loads[0].split = false;
  const plain = thermalSetup(st, body, keys);
  assert.equal(plain.heatsinks, undefined);
  assert.deepEqual(plain.sources, [{ power: 3, doms: [1], id: "l1" }]);
  // no heatsink in the model: its share stays in the part
  st.loads[0].split = true;
  const two = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(f => f + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 11.6] };
  const none = thermalSetup(st, two, ["pcb", "q1"]);
  assert.equal(none.heatsinks, undefined);
  assert.deepEqual(none.sources.find(s => !s.tris), { power: 2.5, doms: [1], id: "l1" });
});
