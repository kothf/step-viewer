// A warm-up after its steady passes (1.746.0): the cells, matrix and surface points the last steady pass made are the
// warm-up's own, so it takes them (`keepBuild` / `takeBuild` → `TransientRun.built`) instead of making them again.
// The answers must be the same numbers, and a set-up of another problem must not be taken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepBuild, solveThermal, takeBuild, transientThermal, type ThermalDomain, type ThermalProblem } from "../../src/sim/thermal";

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

const pLo = [0, 0, 0], pHi = [40, 30, 3], bLo = [11, 9, 3], bHi = [23, 19, 14];
const pf = boxFaces(pLo, pHi), bf = boxFaces(bLo, bHi);
const plate: ThermalDomain = { inside: boxIn(pLo, pHi), k: 0.02, tris: pf.flat() };
const block: ThermalDomain = { inside: boxIn(bLo, bHi), k: 0.2, tris: bf.flat() };
const all = [...pf.flat(), ...bf.flat()];
const inside = (x: number, y: number, z: number) => plate.inside(x, y, z) || block.inside(x, y, z);

function problem(): ThermalProblem {
  return {
    lo: [0, 0, 0], hi: [40, 30, 14], inside, h: 6, p: 2, k: 0, domains: [plate, block],
    sinks: [
      { tris: all, free: true, ambient: 25, natural: { factor: 1, down: [0, 0, -1], lv: new Array(all.length / 9).fill(12), lh: new Array(all.length / 9).fill(8) } },
      { tris: all, free: true, ambient: 25, emissivity: 0.9 },
    ],
    sources: [{ power: 2, doms: [1] }],
  };
}
const times = [0, 60, 120, 300, 600];
const at = [17, 14, 14, 5, 5, 3];
function warm(pb: ThermalProblem, built?: unknown) {
  const temps: number[][] = [], outs: number[] = [];
  const r = transientThermal(pb, {
    rc: [2e-3, 2.4e-3], t0: 25, times, factor: () => 1, built,
    frame: (_k, _t, sample, flows) => { temps.push([...sample(at).temp]); outs.push(flows.reduce((a, f) => a + f.out, 0)); },
  });
  return { temps, outs, steps: r.steps, solves: r.solves };
}

test("a warm-up on the steady pass's set-up gives the same frames as one that makes its own", () => {
  const pb = problem();
  const plain = warm(pb);
  keepBuild(true);
  const st = solveThermal(pb);
  const built = takeBuild();
  keepBuild(false);
  assert.ok(built, "the steady solve kept its set-up");
  assert.equal(takeBuild(), null, "given once");
  const kept = warm(pb, built);
  assert.deepEqual(kept.temps, plain.temps);
  assert.deepEqual(kept.outs, plain.outs);
  assert.equal(kept.steps, plain.steps);
  // the warm-up heads for the steady answer: what leaves at the end is most of the 2 W, and it started at none
  assert.ok(Math.abs(plain.outs[0]) < 1e-9 && plain.outs[4] > 0.3 && plain.outs[4] < 2, `out ${plain.outs}`);
  assert.ok(Math.abs(st.flows.reduce((a, f) => a + f.out, 0) - 2) < 1e-6);
});

test("a set-up of another problem is not taken, and none is kept unless asked", () => {
  const pb = problem();
  solveThermal(pb);
  assert.equal(takeBuild(), null);
  keepBuild(true);
  solveThermal(pb);
  const built = takeBuild();
  keepBuild(false);
  // other sinks (a different ambient): the warm-up must make its own set-up
  const other = problem();
  other.sinks = other.sinks.map(s => ({ ...s, ambient: 40 }));
  const a = warm(other, built), b = warm(other);
  assert.deepEqual(a.temps, b.temps);
  assert.ok(Math.abs(a.temps[4][0] - warm(pb).temps[4][0]) > 1, "the other ambient shows");
  // a higher degree than the kept one's
  const p3 = { ...pb, p: 3 };
  assert.deepEqual(warm(p3, built).temps, warm(p3).temps);
});
