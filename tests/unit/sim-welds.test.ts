// Structural analysis of assemblies (FR-CON-022): welds along edges where two components meet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { studyProblem, runStatic, type RunInput } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function boxes(list: { id: string; lo: number[]; hi: number[] }[]) {
  const tris: number[] = [], face: number[] = [], names: string[] = [], parts: Float64Array[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    const own: number[] = [];
    for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
      const t = rectFace(a, end ? b.hi[a] : b.lo[a], b.lo, b.hi, !!end);
      names.push(`${b.id}@${"xyz"[a]}${end}`);
      own.push(...t);
      for (let k = 0; k < t.length / 9; k++) face.push(names.length - 1);
    }
    tris.push(...own);
    parts.push(Float64Array.from(own));
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.lo[a]); hi[a] = Math.max(hi[a], b.hi[a]); }
  }
  return { body: { tris: Float64Array.from(tris), face: Int32Array.from(face), names, lo, hi }, parts };
}
const steel = { name: "Steel", E: 210000, nu: 0.3, rho: 7.85e-9, sy: 235 };


// a small plate lying on a larger one, not joined where they touch, welded along its two short bottom edges
const F = 1000;
const model = () => boxes([{ id: "a", lo: [0, 0, 0], hi: [60, 40, 10] }, { id: "b", lo: [10, 10, 10], hi: [50, 30, 20] }]);
const r2 = Math.SQRT1_2;
const edge = (x: number, into: number) => [x, 10, 10, x, 30, 10, into * r2, 0, r2];
function solve(welds: number[][], load = [F, 0, 0]) {
  const m = model(), st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: load.map(v => ({ v })) });
  const inp: RunInput = {
    body: m.body, mat: steel, regions: m.parts.map(tris => ({ tris, mat: steel })), asm: { gap: 0.1, links: [{ a: 0, b: 1, type: "none" }] },
    welds: welds.map(lines => ({ lines: Float64Array.from(lines) })),
    problem: studyProblem(st, m.body), passes: 2, energyTol: 0, pos: Float32Array.from([50, 20, 15]), nrm: Float32Array.from([1, 0, 0]),
  };
  return [...runStatic(inp)].at(-1)!;
}

test("two welds carry the whole push between plates that are not joined", () => {
  const r = solve([edge(10, 1), edge(50, -1)]);
  assert.equal(r.welds?.length, 2);
  const fx = r.welds![0].force[0] + r.welds![1].force[0];
  assert.ok(Math.abs(fx / F - 1) < 0.01, `sum ${fx}`);
  for (const w of r.welds!) {
    assert.ok(Math.abs(w.length - 20) < 1e-6, `length ${w.length}`);
    assert.ok(w.peak >= w.mean && w.mean > 0.3 * F / 40 && w.peak < 20 * F / 40, `per length ${w.mean} ${w.peak}`);
  }
  assert.ok(r.maxU > 0 && r.maxU < 0.05, `u ${r.maxU}`);
});

test("one straight weld alone is a hinge: the plate can still turn about it", () => {
  assert.throws(() => solve([edge(10, 1)]), /E-SIM-LOOSE: 1/);
});

test("without a weld the upper plate is loose; a weld line beside no other body is refused", () => {
  assert.throws(() => solve([]), /E-SIM-LOOSE/);
  assert.throws(() => solve([[10, 10, 20, 10, 30, 20, r2, 0, -r2]]), /E-SIM-WELD: 0/);
});
