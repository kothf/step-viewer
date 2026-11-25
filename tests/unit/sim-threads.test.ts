// The block factorisation (blockchol.ts), its solves and its sharing between threads (threads.ts): the same numbers as the
// envelope solver within round-off, and bit for bit the same with one thread or several.
import test from "node:test";
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { BlockMatrix, Envelope } from "../../src/sim/sparse";
import { BlockCholesky, cholPlan, minDegreeOrder } from "../../src/sim/blockchol";
import { serve, setHelpers, setLoopFloor, threadStats, type CholJob } from "../../src/sim/threads";
import { kernelMemories, setKernel } from "../../src/sim/cholwasm";
import { solveStatic } from "../../src/sim/static";
import { solveThermal } from "../../src/sim/thermal";
import { makeGrid, refit, setDropPoints } from "../../src/sim/grid";
import { MeshBody, insideOf } from "../../src/sim/body";

if (!isMainThread) parentPort!.on("message", (j: CholJob) => serve(j));

/** A grid of elements with dense blocks of mixed sizes: symmetric, diagonally dominant. */
function grid(nx: number, ny: number, nz: number, size: (e: number) => number) {
  const nel = nx * ny * nz, ms = Array.from({ length: nel }, (_, e) => size(e));
  const A = new BlockMatrix(nel, ms);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const id = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let e = 0; e < nel; e++) {
    const D = A.block(e, e), m = ms[e];
    for (let a = 0; a < m; a++) for (let b = 0; b <= a; b++) { const v = a === b ? 40 * m : rnd(); D[a * m + b] = v; D[b * m + a] = v; }
  }
  const link = (a: number, b: number) => {
    const X = A.block(a, b), Y = A.block(b, a), ma = ms[a], mb = ms[b];
    for (let i = 0; i < ma; i++) for (let j = 0; j < mb; j++) { const v = rnd(); X[i * mb + j] = v; Y[j * ma + i] = v; }
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i + 1 < nx) link(id(i, j, k), id(i + 1, j, k));
    if (j + 1 < ny) link(id(i, j, k), id(i, j + 1, k));
    if (k + 1 < nz) link(id(i, j, k), id(i, j, k + 1));
  }
  const b = Float64Array.from({ length: A.size }, rnd);
  return { A, b };
}

if (isMainThread) {
test("block Cholesky: solves like the envelope solver, with fewer values", () => {
  const { A, b } = grid(5, 4, 3, e => 6 + (e % 5) * 3);
  const x0 = new Envelope(A).solve(b), F = new BlockCholesky(A), x = F.solve(b);
  let d = 0, s = 0;
  for (let i = 0; i < x.length; i++) { d = Math.max(d, Math.abs(x[i] - x0[i])); s = Math.max(s, Math.abs(x0[i])); }
  assert.ok(d < 1e-11 * s, `difference ${d} of ${s}`);
  const r = A.mul(x);
  for (let i = 0; i < r.length; i++) assert.ok(Math.abs(r[i] - b[i]) < 1e-10);
  assert.ok(F.values < new Envelope(A).values, `${F.values} values`);
});

test("block Cholesky: the order is a permutation and the plan counts its work", () => {
  const { A } = grid(4, 4, 4, () => 5);
  const o = minDegreeOrder(A.adj, A.ms);
  assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i));
  const P = cholPlan(A);
  assert.ok(P.flops > 0 && P.size >= 64 * 25);
});

test("block Cholesky: not positive definite is reported", () => {
  const { A } = grid(2, 2, 1, () => 4);
  A.block(3, 3).fill(0);
  assert.throws(() => new BlockCholesky(A), /E-SIM-SINGULAR/);
});

test("block Cholesky: the WebAssembly kernel and the plain loops give the same numbers bit for bit", () => {
  // odd and even block sizes, so both the paired and the last column of every sum are used
  const { A, b } = grid(5, 4, 3, e => 5 + (e % 6) * 3);
  const before = kernelMemories(), x = new BlockCholesky(A).solve(b);
  assert.equal(kernelMemories(), before + 1, "the factor is in kernel memory");
  setKernel(false);
  let x0: Float64Array;
  try { x0 = new BlockCholesky(A).solve(b); } finally { setKernel(true); }
  assert.equal(kernelMemories(), before + 1);
  assert.deepEqual(x, x0);
  const { A: B } = grid(2, 2, 1, () => 4);
  B.block(3, 3).fill(0);
  setKernel(false);
  try { assert.throws(() => new BlockCholesky(B), /E-SIM-SINGULAR/); } finally { setKernel(true); }
});

test("threads: several threads give the same numbers bit for bit", async () => {
  const { A, b } = grid(6, 5, 4, e => 30 + (e % 3) * 12);
  const one = new BlockCholesky(A).solve(b);
  assert.equal(threadStats().jobs, 0);
  const ws = Array.from({ length: 3 }, () => new Worker(fileURLToPath(import.meta.url)));
  await Promise.all(ws.map(w => new Promise(r => w.once("online", r))));
  setHelpers(ws);
  try {
    const many = new BlockCholesky(A).solve(b);
    const st = threadStats();
    assert.ok(st.jobs === 1 && st.parallelSteps > 0, JSON.stringify(st));
    assert.deepEqual(many, one);
    // again: helpers come back for a second job
    const again = new BlockCholesky(A).solve(b);
    assert.deepEqual(again, one);
    assert.ok(threadStats().joined >= 1, JSON.stringify(threadStats()));
  } finally { setHelpers([]); }
});

test("threads: several right-hand sides solved on several threads are the same bit for bit", async () => {
  const { A, b } = grid(5, 4, 3, e => 12 + (e % 4) * 6);
  const bs = [b, b.map((v, i) => v * Math.cos(i)), b.map((v, i) => v + (i % 7)), b.map(v => -2 * v), b.map((_, i) => 1 / (1 + i))];
  const one = bs.map(v => new BlockCholesky(A).solve(v));
  const ws = Array.from({ length: 3 }, () => new Worker(fileURLToPath(import.meta.url)));
  await Promise.all(ws.map(w => new Promise(r => w.once("online", r))));
  setHelpers(ws);
  setLoopFloor(0);
  try {
    const before = threadStats().loops;
    const many = new BlockCholesky(A).solveAll(bs);
    assert.equal(threadStats().loops - before, 1);
    assert.deepEqual(many, one);
  } finally { setHelpers([]); setLoopFloor(2e7); }
  // a page that is not cross-origin isolated has no SharedArrayBuffer at all
  const g = globalThis as { SharedArrayBuffer?: unknown }, kept = g.SharedArrayBuffer;
  const F = new BlockCholesky(A);
  g.SharedArrayBuffer = undefined;
  try { assert.deepEqual(F.solveAll(bs), one); } finally { g.SharedArrayBuffer = kept; }
});

test("threads: the equations built on several threads are the same bit for bit", async () => {
  // a bar the grid does not fit, so its cells are cut and their points are fitted for each degree
  const L = 120, W = 20, lo = [0, -W / 2, -W / 2], hi = [L, W / 2, W / 2];
  const inside = (x: number, y: number, z: number) => x >= -1e-12 && x <= L + 1e-12 && Math.abs(y) <= W / 2 + 1e-12 && Math.abs(z) <= W / 2 + 1e-12;
  const end = (x: number, out: boolean) => { const q = [x, -W / 2, -W / 2, x, W / 2, -W / 2, x, W / 2, W / 2, x, -W / 2, -W / 2, x, W / 2, W / 2, x, -W / 2, W / 2]; return out ? q : [...q.slice(0, 3), ...q.slice(6, 9), ...q.slice(3, 6), ...q.slice(9, 12), ...q.slice(15, 18), ...q.slice(12, 15)]; };
  const run = () => {
    const pb = { lo, hi, inside, h: 13, mat: { E: 210000, nu: 0.3 }, fixed: [{ tris: end(0, false) }], loads: [{ tris: end(L, true), force: [0, 0, -500] }] };
    const a = solveStatic({ ...pb, p: 2 });
    const b = solveStatic({ ...pb, p: 3, grid: a.grid });
    return [a.x, b.x];
  };
  const one = run();
  const ws = Array.from({ length: 3 }, () => new Worker(fileURLToPath(import.meta.url)));
  await Promise.all(ws.map(w => new Promise(r => w.once("online", r))));
  setHelpers(ws);
  setLoopFloor(0);
  try {
    const before = threadStats().loops;
    const many = run();
    const st = threadStats();
    // each solve shares its element stiffness, faces and penalty measuring, the second also the fitting of the cut cells' points
    assert.ok(st.loops - before >= 7 && st.loopJoined >= 1, JSON.stringify(st));
    assert.deepEqual(many, one);
  } finally { setHelpers([]); setLoopFloor(2e7); }
});
test("threads: a thermal study's equations built on several threads are the same bit for bit", async () => {
  // the same bar: held at 20 °C at one end, a film and radiation at the other, heat made throughout
  const L = 120, W = 20, lo = [0, -W / 2, -W / 2], hi = [L, W / 2, W / 2];
  const inside = (x: number, y: number, z: number) => x >= -1e-12 && x <= L + 1e-12 && Math.abs(y) <= W / 2 + 1e-12 && Math.abs(z) <= W / 2 + 1e-12;
  const end = (x: number, out: boolean) => { const q = [x, -W / 2, -W / 2, x, W / 2, -W / 2, x, W / 2, W / 2, x, -W / 2, -W / 2, x, W / 2, W / 2, x, -W / 2, W / 2]; return out ? q : [...q.slice(0, 3), ...q.slice(6, 9), ...q.slice(3, 6), ...q.slice(9, 12), ...q.slice(15, 18), ...q.slice(12, 15)]; };
  const run = () => {
    const pb = { lo, hi, inside, h: 13, k: 0.05, sinks: [{ tris: end(0, false), temp: 20 }, { tris: end(L, true), h: 2e-5, ambient: 25 }, { tris: end(L, true), emissivity: 0.9, ambient: 25 }], sources: [{ power: 3 }] };
    const a = solveThermal({ ...pb, p: 2 });
    const b = solveThermal({ ...pb, p: 3, grid: a.grid, prev: a.x });
    // and with natural convection in place of the film
    const nat = { factor: 1, down: [0, 0, -1], lv: [W, W], lh: [W / 4, W / 4] };
    const n = solveThermal({ ...pb, sinks: [pb.sinks[0], { tris: end(L, true), ambient: 25, natural: nat }, pb.sinks[2]], p: 2 });
    return [a.x, b.x, a.iterations, b.iterations, n.x, a.energy, b.energy, b.eta, b.prevError];
  };
  const one = run();
  const ws = Array.from({ length: 3 }, () => new Worker(fileURLToPath(import.meta.url)));
  await Promise.all(ws.map(w => new Promise(r => w.once("online", r))));
  setHelpers(ws);
  setLoopFloor(0);
  try {
    const before = threadStats().loops;
    const many = run();
    // conduction and the faces between elements of the solves, the films, radiation and natural convection of every step,
    // and the energies at the end of each solve
    assert.ok(threadStats().loops - before >= 12, JSON.stringify(threadStats()));
    assert.deepEqual(many, one);
    // radiation settles in a few steps, and the answer is the one a fresh factorisation per step gives
    assert.ok((one[2] as number) > 1 && (one[2] as number) < 12);
  } finally { setHelpers([]); setLoopFloor(2e7); }
});

test("threads: the cells of a mesh body found on several threads are the same", async () => {
  // a tetrahedron leaning in its box: most cubes are cut, some hold nothing
  const P = [[0, 0, 0], [40, 3, 2], [5, 37, 4], [8, 6, 33]];
  const tris = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]].flatMap(f => f.flatMap(v => P[v]));
  const body = new MeshBody(tris);
  const make = () => {
    const g = makeGrid(body.lo, body.hi, 9, insideOf(body), { q: 3, depth: 3, fit: 5 });
    return g.cells.map(c => ({ ijk: c.ijk, state: c.state, frac: c.frac, el: c.el, pts: Array.from(c.pts.a.subarray(0, 4 * c.pts.n)), fine: c.fine ? Array.from(c.fine.a.subarray(0, 4 * c.fine.n)) : null }));
  };
  const one = make();
  assert.ok(one.length > 20 && one.some(c => c.fine));
  const ws = Array.from({ length: 3 }, () => new Worker(fileURLToPath(import.meta.url)));
  await Promise.all(ws.map(w => new Promise(r => w.once("online", r))));
  setHelpers(ws);
  setLoopFloor(0);
  try {
    const before = threadStats().loops;
    const many = make();
    assert.ok(threadStats().loops > before, JSON.stringify(threadStats()));
    assert.deepEqual(many, one);
  } finally { setHelpers([]); setLoopFloor(2e7); }
});

}

// the helpers load this file too: a long test must not run in them, or they are busy when a job arrives
if (isMainThread) test("threads: a big model lets its fine points go after the first fit, with the same fitted points", async () => {
  const P = [[0, 0, 0], [40, 3, 2], [5, 37, 4], [8, 6, 33]];
  const tris = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]].flatMap(f => f.flatMap(v => P[v]));
  const body = new MeshBody(tris);
  const make = (drop: number) => {
    setDropPoints(drop);
    try {
      const g = makeGrid(body.lo, body.hi, 5, insideOf(body), { q: 3, depth: 4, fit: 5 });
      const out: number[][][] = [];
      for (const [q, fit] of [[5, 9], [6, 11], [7, 13], [6, 11]]) { refit(g, q, fit); out.push(g.cells.map(c => Array.from(c.pts.a.subarray(0, 4 * c.pts.n)))); }
      return { out, gone: g.cells.filter(c => c.fine && c.fine.n && !c.fine.a.length).length, big: g.cells.filter(c => c.fine && c.fine.n > 13 ** 3).length };
    } finally { setDropPoints(); }
  };
  const kept = make(Infinity), dropped = make(0);
  assert.equal(kept.gone, 0);
  assert.ok(dropped.big > 3 && dropped.gone === dropped.big, JSON.stringify([dropped.gone, dropped.big]));
  assert.deepEqual(dropped.out, kept.out);
  const ws = Array.from({ length: 3 }, () => new Worker(fileURLToPath(import.meta.url)));
  await Promise.all(ws.map(w => new Promise(r => w.once("online", r))));
  setHelpers(ws);
  setLoopFloor(0);
  try {
    const before = threadStats().loops;
    const many = make(0);
    assert.ok(threadStats().loops > before);
    assert.equal(many.gone, many.big);
    assert.deepEqual(many.out, kept.out);
    assert.deepEqual(make(Infinity).out, kept.out);
  } finally { setHelpers([]); setLoopFloor(2e7); for (const w of ws) await w.terminate(); }
});
