// Cells cut ahead by helper workers (`par.ts`): the grid made from them is the grid made without them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGrid, usePrepared } from "../../src/sim/grid";
import { parHandle, parState, prepareCells, type ParMsg, type ParPool } from "../../src/sim/par";
import { insideOf, MeshBody } from "../../src/sim/body";

function rectFace(axis: number, at: number, lo: number[], hi: number[], out: boolean): number[] {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[axis] = at; p[a1] = u; p[a2] = v; return p; };
  const A = P(lo[a1], lo[a2]), B = P(hi[a1], lo[a2]), C = P(hi[a1], hi[a2]), D = P(lo[a1], hi[a2]);
  return out ? [...A, ...B, ...C, ...A, ...C, ...D] : [...A, ...C, ...B, ...A, ...D, ...C];
}
const box = (l: number[], h: number[]) => {
  const t: number[] = [];
  for (let a = 0; a < 3; a++) for (const end of [0, 1]) t.push(...rectFace(a, end ? h[a] : l[a], l, h, !!end));
  return Float64Array.from(t);
};
// helpers that answer in this thread, each with its own kept data, as workers would
const inlinePool = (size: number): ParPool & { jobs: number } => {
  const S = Array.from({ length: size }, parState);
  const pool = {
    size, jobs: 0,
    all: async (m: ParMsg) => { for (const s of S) parHandle(s, structuredClone(m)); },
    map: async (jobs: ParMsg[]) => jobs.map((j, i) => { pool.jobs++; return structuredClone(parHandle(S[i % size], j).reply); }),
  };
  return pool;
};

test("cells cut by helpers give the same grid, for one body and for two", async () => {
  const a = box([0, 0, 0], [60, 40, 1.6]), b = box([20.3, 15.2, 1.6], [30.1, 24.7, 3.6]);
  const lo = [0, 0, 0], hi = [60, 40, 3.6], h = 4.1;
  for (const tris of [[a], [a, b]]) {
    const ins = tris.map(t => insideOf(new MeshBody(t))), all = insideOf(new MeshBody(Float64Array.from(tris.flatMap(t => [...t]))));
    const o = { q: 3, depth: 3, fit: 5, ...(ins.length > 1 ? { domains: ins } : {}) };
    usePrepared(null);
    const plain = makeGrid(lo, hi, h, ins.length > 1 ? all : ins[0], o);
    const pool = inlinePool(3);
    usePrepared(await prepareCells(pool, tris, lo, hi, h));
    const made = makeGrid(lo, hi, h, ins.length > 1 ? all : ins[0], o);
    usePrepared(null);
    assert.ok(pool.jobs >= 3, `jobs ${pool.jobs}`);
    assert.equal(made.cells.length, plain.cells.length);
    assert.equal(made.elems.length, plain.elems.length);
    for (let i = 0; i < plain.cells.length; i++) {
      const P = plain.cells[i], M = made.cells[i];
      assert.deepEqual(M.ijk, P.ijk);
      assert.equal(M.dom, P.dom); assert.equal(M.state, P.state); assert.equal(M.el, P.el); assert.equal(M.frac, P.frac);
      assert.equal(M.pts.n, P.pts.n);
      assert.deepEqual(M.pts.a.slice(0, 4 * M.pts.n), P.pts.a.slice(0, 4 * P.pts.n));
    }
  }
});

test("prepared cells of another grid or other settings are not used", async () => {
  const a = box([0, 0, 0], [10, 10, 10]), ins = insideOf(new MeshBody(a));
  usePrepared(await prepareCells(inlinePool(2), [a], [0, 0, 0], [10, 10, 10], 2.5));
  const other = makeGrid([0, 0, 0], [10, 10, 10], 5, ins, { q: 3, depth: 3 });
  const deep = makeGrid([0, 0, 0], [10, 10, 10], 2.5, ins, { q: 3, depth: 2 });
  usePrepared(null);
  assert.equal(other.cells.length, 8);
  assert.equal(deep.cells.length, 64);
});
