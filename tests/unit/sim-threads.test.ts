// The block factorisation (blockchol.ts) and its sharing between threads (threads.ts): the same numbers as the
// envelope solver within round-off, and bit for bit the same with one thread or several.
import test from "node:test";
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { BlockMatrix, Envelope } from "../../src/sim/sparse";
import { BlockCholesky, cholPlan, minDegreeOrder } from "../../src/sim/blockchol";
import { serve, setHelpers, threadStats, type CholJob } from "../../src/sim/threads";

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
}
