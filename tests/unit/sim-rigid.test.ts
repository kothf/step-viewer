// Structural analysis of assemblies (FR-CON-001): a rigid component moves as a body with its mass, without strain.
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

// a cantilever with a block on its end; the load is on the block's far face
const L = 100, B = 20, T = 10, A = 40, F = 100;
const model = () => boxes([{ id: "a", lo: [0, 0, 0], hi: [L, B, T] }, { id: "b", lo: [L, 0, 0], hi: [L + A, B, T] }]);
const memo = new Map<string, ReturnType<typeof solve0>>();
function solve(rigid: boolean, gravity = false) {
  const k = `${rigid}|${gravity}`;
  if (!memo.has(k)) memo.set(k, solve0(rigid, gravity));
  return memo.get(k)!;
}
function solve0(rigid: boolean, gravity = false) {
  const m = model(), st = newStudy([]);
  st.supports.push({ id: "s1", type: "fixed", faces: [{ name: "a@x0" }] });
  if (gravity) st.loads.push({ id: "l1", type: "gravity", faces: [], comp: [{ v: 0 }, { v: 0 }, { v: -9806.65 }] });
  else st.loads.push({ id: "l1", type: "force", faces: [{ name: "b@x1" }], comp: [{ v: 0 }, { v: 0 }, { v: -F }] });
  // the joint, the block's far end, and a point inside the bar
  const pos = [L, B / 2, T / 2, L + A, B / 2, T / 2, L + A / 2, B / 2, T / 2, L / 2, B / 2, T];
  const nrm = [0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1];
  const inp: RunInput = { body: m.body, mat: steel, regions: m.parts.map((tris, i) => ({ tris, mat: steel, ...(rigid && i === 1 ? { rigid: true } : {}) })), asm: { gap: 0.1 }, problem: studyProblem(st, m.body), passes: 3, energyTol: 0, pos: Float32Array.from(pos), nrm: Float32Array.from(nrm) };
  return [...runStatic(inp)].at(-1)!;
}
const EI = (steel.E * B * T ** 3) / 12;

test("a rigid block on the end of a cantilever: the bar bends as beam theory says, the block only turns", () => {
  const r = solve(true);
  // the bar carries F and the moment F·A at its end
  const d = (F * L ** 3) / (3 * EI) + (F * A * L ** 2) / (2 * EI), th = (F * L ** 2) / (2 * EI) + (F * A * L) / EI;
  const zJoint = r.u[2], zEnd = r.u[5], zMid = r.u[8];
  assert.ok(Math.abs(-zEnd / (d + th * A) - 1) < 0.03, `end ${zEnd} vs ${-(d + th * A)}`);
  // rigid: the middle of the block lies on the line between its ends
  assert.ok(Math.abs(zMid - (zJoint + zEnd) / 2) < 2e-3 * Math.abs(zEnd), `mid ${zMid} vs ${(zJoint + zEnd) / 2}`);
  assert.ok(Math.abs((zEnd - zJoint) / A / -th - 1) < 0.04, `slope ${(zEnd - zJoint) / A} vs ${-th}`);
  // no stress is reported in the rigid block, the bar has its own
  assert.equal(r.vm[1], 0);
  assert.equal(r.vm[2], 0);
  assert.ok(r.vm[3] > 1);
  // the joint carries the load
  const c = r.contacts![0];
  assert.ok(Math.abs(c.force![2] / -F - 1) < 0.02 || Math.abs(c.force![2] / F - 1) < 0.02, `joint force ${c.force}`);
  // and the support the load and its moment
  assert.ok(Math.abs(r.reactions[0].force[2] / F - 1) < 0.01, `reaction ${r.reactions[0].force}`);
});

test("an elastic block bends too, so its end goes further than a rigid one's", () => {
  const rigid = solve(true), soft = solve(false);
  const extra = (F * A ** 3) / (3 * EI);
  assert.ok(Math.abs((soft.u[5] - rigid.u[5]) / -extra - 1) < 0.15, `difference ${soft.u[5] - rigid.u[5]} vs ${-extra}`);
});

test("a rigid component keeps its mass: its weight bends the bar that carries it", () => {
  const r = solve(true, true);
  const g = 9806.65, w = steel.rho * B * T * g, W = w * A;
  // own weight of the bar (w per length) plus the block's weight W at A/2 beyond the end
  const d = (w * L ** 4) / (8 * EI) + (W * L ** 3) / (3 * EI) + (W * (A / 2) * L ** 2) / (2 * EI);
  assert.ok(Math.abs(-r.u[2] / d - 1) < 0.03, `joint ${r.u[2]} vs ${-d}`);
  assert.ok(Math.abs(r.reactions[0].force[2] / (w * (L + A)) - 1) < 0.01, `reaction ${r.reactions[0].force}`);
});
