// A body's hottest point may lie inside it (1.757.0): a heated body between two cooled ones is hottest at its
// middle, which no point of the plot mesh near its ends reads. The run samples points inside every body too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thermalSetup, runThermal, studyProblem, innerPoints, innerTemps, INNER_GRID } from "../../src/sim/run";
import { newStudy } from "../../src/sim/types";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
function bar(x0: number, x1: number, comp: string) {
  const l = [x0, 0, 0], h = [x1, 10, 10], t: number[] = [], f: number[] = [], n: string[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) {
    const q = rectFace(a, end ? h[a] : l[a], l, h, !!end);
    n.push(`${comp}@${"xyz"[a]}${end}`);
    t.push(...q);
    for (let k = 0; k < q.length / 9; k++) f.push(n.length - 1);
  }
  return { tris: t, face: f, names: n };
}

test("inside points: a grid over the box, only the ones the body holds", () => {
  const P = innerPoints([{ inside: () => true, tris: bar(0, 10, "a").tris }, { inside: (x: number) => x < 25, tris: bar(20, 30, "b").tris }, { inside: () => true, tris: [] }]);
  const n = INNER_GRID ** 3;
  assert.equal(P.of.filter(d => d === 0).length, n);
  assert.equal(P.of.filter(d => d === 1).length, (n / INNER_GRID) * Math.floor(INNER_GRID / 2));
  assert.equal(P.of.filter(d => d === 2).length, 0);
  // a point another body's field was read at does not count; one hotter than the surface does
  const out = [{ min: 30, max: 40, mean: 35 }, { min: 30, max: 40, mean: 35 }, { min: 1, max: 2, mean: 1 }] as { min: number; max: number; mean: number; deep?: boolean }[];
  innerTemps(P, pos => ({ temp: Array.from({ length: pos.length / 3 }, (_v, i) => (P.of[i] === 0 ? 45 : 90)), dom: Array.from(P.of, d => (d === 1 ? 0 : d)) }), out);
  assert.deepEqual(out[0], { min: 30, max: 45, mean: 35, deep: true });
  assert.deepEqual(out[1], { min: 30, max: 40, mean: 35 });
});

test("a heated body between two cooled ones reports the temperature at its middle", () => {
  const A = bar(0, 30, "c1"), B = bar(30, 70, "c2"), C = bar(70, 100, "c3");
  const body = { tris: Float64Array.from([...A.tris, ...B.tris, ...C.tris]), face: Int32Array.from([...A.face, ...B.face.map(i => i + 6), ...C.face.map(i => i + 12)]), names: [...A.names, ...B.names, ...C.names], lo: [0, 0, 0], hi: [100, 10, 10] };
  const mat = { name: "m", E: 0, nu: 0, rho: 0 };
  const regions = [A, B, C].map(r => ({ tris: Float64Array.from(r.tris), mat }));
  const st = newStudy([], "thermal");
  st.loads.push({ id: "l1", type: "heat", faces: [{ name: "c2@y0" }], value: { v: 2 }, body: true });
  st.supports.push({ id: "s1", type: "temp", faces: [{ name: "c1@x0" }, { name: "c3@x1" }], temp: 20 });
  // the plot mesh sees the heated bar only beside its ends
  const pos = new Float32Array([0, 5, 5, 31, 0, 5, 69, 0, 5, 100, 5, 5]), nrm = new Float32Array([-1, 0, 0, 0, -1, 0, 0, -1, 0, 1, 0, 0]);
  const r = [...runThermal({ body, mat, problem: studyProblem(st, body), passes: 2, energyTol: 0, pos, nrm, regions, thermal: { k: 0.2, setup: thermalSetup(st, body, ["c1", "c2", "c3"]), ks: [0.2, 0.02, 0.2], gap: 0.1 } })].at(-1)!;
  // 1 W leaves each way: 1.5 K over each cooled bar, then q L² / 8k = 5 K to the middle of the heated one
  const c = r.thermal!.comps![1];
  assert.ok(Math.abs(c.max - 26.5) < 0.05, `middle ${c.max}`);
  assert.equal(c.deep, true);
  assert.ok(Math.max(r.vm[1], r.vm[2]) < 22.5, `surface points ${r.vm[1]}, ${r.vm[2]}`);
  // a cooled bar: 20 °C at the held end, 21.5 at the joint (its innermost points are 2.1 mm short of it)
  const c0 = r.thermal!.comps![0];
  assert.ok(c0.max > 21.3 && c0.max < 21.5, `cooled bar ${c0.max}`);
});
