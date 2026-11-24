// Function values kept at surface points (1.741.0): films, radiation and natural convection are linearised again every
// Newton step and every time step, and what a point gives whatever the temperatures are (the functions' values, the
// Legendre values of its moments) is made once per plan. The answers must be the same numbers as without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveThermal, setFilmValues, type ThermalDomain, type ThermalProblem } from "../../src/sim/thermal";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function boxFaces(lo: number[], hi: number[]): number[][] {
  const f: number[][] = [];
  for (let a = 0; a < 3; a++) f.push(rectFace(a, lo[a], lo, hi, false), rectFace(a, hi[a], lo, hi, true));
  return f;
}
const boxIn = (lo: number[], hi: number[]) => (x: number, y: number, z: number) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];

// a plate with a block standing on it (the block's foot covers part of the plate's top)
const pLo = [0, 0, 0], pHi = [40, 30, 3], bLo = [11, 9, 3], bHi = [23, 19, 14];
const pf = boxFaces(pLo, pHi), bf = boxFaces(bLo, bHi);
const plate: ThermalDomain = { inside: boxIn(pLo, pHi), k: 0.02, tris: pf.flat() };
const block: ThermalDomain = { inside: boxIn(bLo, bHi), k: 0.2, tris: bf.flat() };
const all = [...pf.flat(), ...bf.flat()];
const down = [0, 0, -1];

function problem(p: number): ThermalProblem {
  // natural convection face by face (each its own sink, as a board study makes them) and radiation from everything open
  const faces = [...pf, ...bf];
  return {
    lo: [0, 0, 0], hi: [40, 30, 14], inside: (x, y, z) => plate.inside(x, y, z) || block.inside(x, y, z), h: 6, p, k: 0, domains: [plate, block],
    sinks: [
      ...faces.map((t, i) => ({ tris: t, free: true, ambient: 25, natural: { factor: 1, down, lv: new Array(t.length / 9).fill(10 + i), lh: new Array(t.length / 9).fill(8) } })),
      { tris: all, free: true, ambient: 25, emissivity: 0.9 },
    ],
    sources: [{ power: 2, doms: [1] }],
  };
}

test("kept function values at surface points give the same answer as evaluating them every step", () => {
  for (const p of [2, 3]) {
    setFilmValues(0);
    const a = solveThermal(problem(p));
    setFilmValues(24e6);
    const b = solveThermal(problem(p));
    assert.ok(b.iterations > 1 && b.iterations === a.iterations);
    assert.deepEqual([...b.x], [...a.x], `p ${p}: coefficients`);
    assert.deepEqual(b.flows.map(f => f.out), a.flows.map(f => f.out));
    assert.deepEqual(b.flows.map(f => f.mean), a.flows.map(f => f.mean));
    assert.deepEqual(b.flows.map(f => f.h), a.flows.map(f => f.h));
  }
  // a budget too small for the second sink: some plans keep values, the others do not
  setFilmValues(3000);
  const c = solveThermal(problem(2));
  setFilmValues(24e6);
  const d = solveThermal(problem(2));
  assert.deepEqual([...c.x], [...d.x]);
  assert.deepEqual(c.flows.map(f => f.out), d.flows.map(f => f.out));
});
