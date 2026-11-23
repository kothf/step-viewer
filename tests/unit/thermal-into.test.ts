// A package part's board share entering the board through its pads and the air gap under its body (FR-TBRD-003):
// `PackageHeat.into` regions become one source each on the board's face towards the part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";
import { intoPatch, contactPatch } from "../../src/thermal/study";

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
// a board 60 × 40 × 1.6 and a resistor body 10 × 4 × 4 lying 1 mm above it
const P = boxBody([0, 0, 0], [60, 40, 1.6], "pcb"), Q = boxBody([20, 18, 2.6], [30, 22, 6.6], "r1");
const body = { tris: Float64Array.from([...P.tris, ...Q.tris]), face: Int32Array.from([...P.face, ...Q.face.map(i => i + 6)]), names: [...P.names, ...Q.names], lo: [0, 0, 0], hi: [60, 40, 6.6] };
const area = (t: Float64Array) => { let a = 0; for (let o = 0; o < t.length; o += 9) { const u = [t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]], v = [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]]; a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; } return a; };

test("into: a pad disc and the air gap rectangle cut out of the board's face towards the part", () => {
  const disc = intoPatch(Float64Array.from(P.tris), Float64Array.from(Q.tris), { disc: [15, 20, 1], w: 1 })!;
  assert.ok(Math.abs(area(disc) - Math.PI) < 1e-9, `disc area ${area(disc)}`);
  for (let o = 2; o < disc.length; o += 3) assert.ok(Math.abs(disc[o] - 1.6) < 1e-9);
  const rect = intoPatch(Float64Array.from(P.tris), Float64Array.from(Q.tris), { rect: [20, 18, 30, 22], w: 1 })!;
  assert.ok(Math.abs(area(rect) - 40) < 1e-9);
  // a disc partly off the board keeps only what lies on it; wholly off: nothing
  assert.ok(Math.abs(area(intoPatch(Float64Array.from(P.tris), Float64Array.from(Q.tris), { disc: [0, 20, 1], w: 1 })!) - Math.PI / 2) < 0.02);
  assert.equal(intoPatch(Float64Array.from(P.tris), Float64Array.from(Q.tris), { disc: [100, 100, 1], w: 1 }), null);
  // the whole footprint as before
  assert.ok(Math.abs(area(contactPatch(Float64Array.from(P.tris), Float64Array.from(Q.tris))!) - 11 * 5) < 1e-9);
});

test("into: the board share goes in through the pads and the air gap, scaled to the share; off-board regions under the part", () => {
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "pkgheat", faces: [], board: "pcb", parts: [{ id: 1, name: "R1", comps: ["r1"], p: 2, board: 1.2,
    into: [{ disc: [15, 20, 1], w: 0.4 }, { disc: [35, 20, 1], w: 0.4 }, { rect: [20, 18, 30, 22], w: 0.2 }] }] });
  const s = thermalSetup(st, body, ["pcb", "r1"]), on = s.sources.filter(x => x.tris);
  assert.deepEqual(on.map(x => Math.round(x.power * 1e9) / 1e9), [0.48, 0.48, 0.24]);
  assert.ok(on.every(x => x.dom === 0));
  assert.deepEqual(s.sources.find(x => !x.tris), { power: 0.8, doms: [1], id: "l1" });
  // a pad off the board: its watts go in under the whole part instead
  st.loads[0].parts![0].into![1].disc = [100, 100, 1];
  const t = thermalSetup(st, body, ["pcb", "r1"]), on2 = t.sources.filter(x => x.tris);
  assert.deepEqual(on2.map(x => Math.round(x.power * 1e9) / 1e9), [0.48, 0.24, 0.48]);
  assert.ok(Math.abs(area(on2[2].tris!) - 55) < 1e-9);
  // without into: one patch under the whole part, as before
  delete st.loads[0].parts![0].into;
  const u = thermalSetup(st, body, ["pcb", "r1"]);
  assert.deepEqual(u.sources.filter(x => x.tris).map(x => x.power), [1.2]);
});
