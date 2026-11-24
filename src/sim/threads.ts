// Analysis on all CPU cores (FR-SARC-005): the block factorisation's work shared between this thread and helper
// threads over shared memory. It needs SharedArrayBuffer (a cross-origin isolated page); without it, or with no
// helper attached, everything runs on this thread and gives the same numbers.
//
// A step of the factorisation (blockchol.ts) is a list of block tasks that touch distinct memory. The list is
// written to shared arrays and published as a "generation"; every thread, this one too, claims tasks with one
// atomic add until none are left. Helpers never need to be counted or waited for: one that wakes late finds
// nothing to claim, one that never wakes costs nothing.

import { cholSolve, factorDiag, factorSerial, solveBlock, stepCosts, targetOf, updateBlock, type CholPlan, type SolvePlan } from "./blockchol";
import { progress } from "./progress";

/** What a helper needs of a factorisation: the plan's arrays and the factor, all on shared memory. */
export interface CholJob {
  ctl: Int32Array;
  nOf: Int32Array;
  tasks: Float64Array;
  ms: Int32Array;
  rows: Int32Array;
  blockAt: Float64Array;
  diagAt: Float64Array;
  data: Float64Array;
}
export interface HelperLike { postMessage(m: unknown): void; terminate(): void }

// ctl words
const NEXT = 0, DONE = 1, GEN = 2, STOP = 3, JOINED = 4;
const GEN_BITS = 11, IDX_BITS = 20, GENS = 1 << GEN_BITS, IDX_MASK = (1 << IDX_BITS) - 1;
/** Numbers per task: kind (1 solve, 2 update), step, ti, tj, target offset, first row, end row. */
const TASK = 7;
/** A step is shared out from this many multiplications on; a task is cut to about this many. */
const PAR_STEP = 3e6, PAR_TASK = 4e5;

const sharedOk = typeof SharedArrayBuffer !== "undefined" && typeof Atomics !== "undefined";
let helpers: HelperLike[] = [];
let stats = { jobs: 0, parallelSteps: 0, joined: 0, loops: 0, loopJoined: 0 };

/** Whether factorisations can be shared between threads here. */
export const canShare = () => sharedOk;
/** The helper threads to share with (made by the caller: a worker in the browser, a worker thread in node). */
export function setHelpers(list: HelperLike[]) { for (const h of helpers) h.terminate(); helpers = sharedOk ? list : []; if (!sharedOk) for (const h of list) h.terminate(); }
export const helperCount = () => helpers.length;
/** Jobs shared so far, the steps shared out and the helpers that took part in the last job (tests, debug). */
export const threadStats = () => ({ ...stats, helpers: helpers.length });

/** Memory for a factor: shared when there are helpers to share it with. */
export function factorBuffer(n: number): Float64Array {
  return helpers.length && sharedOk ? new Float64Array(new SharedArrayBuffer(8 * n)) : new Float64Array(n);
}

const planOf = (j: CholJob): CholPlan => ({ ms: j.ms, rows: j.rows, blockAt: j.blockAt, diagAt: j.diagAt } as CholPlan);

/** Claims and runs tasks of the current generation until none are left. */
function work(j: CholJob, P: CholPlan) {
  const { ctl, nOf, tasks, data } = j;
  for (;;) {
    const v = Atomics.add(ctl, NEXT, 1), g = v >>> IDX_BITS, i = v & IDX_MASK;
    const n = Atomics.load(nOf, g);
    if (i >= n) return;
    const o = TASK * i;
    if (tasks[o] === 1) solveBlock(P, data, tasks[o + 1], tasks[o + 2]);
    else updateBlock(P, data, tasks[o + 1], tasks[o + 2], tasks[o + 3], tasks[o + 4], tasks[o + 5], tasks[o + 6]);
    if (Atomics.add(ctl, DONE, 1) + 1 === n) Atomics.notify(ctl, DONE);
  }
}

/** A helper thread's side of a job: works until the job says stop. */
export function serve(j: CholJob | ParJob) {
  if ("kind" in j) { serveJob(j); return; }
  const P = planOf(j), ctl = j.ctl;
  Atomics.add(ctl, JOINED, 1);
  let seen = -1;
  for (;;) {
    const g = Atomics.load(ctl, GEN);
    if (g !== seen) { seen = g; work(j, P); continue; }
    if (Atomics.load(ctl, STOP)) return;
    Atomics.wait(ctl, GEN, g, 200);
  }
}

const shared = <T extends Int32Array | Float64Array>(a: T): T => {
  const b = new SharedArrayBuffer(a.byteLength);
  const out = (a instanceof Int32Array ? new Int32Array(b) : new Float64Array(b)) as T;
  out.set(a);
  return out;
};

/** The tasks of step k's block solves (kind 1) or updates (kind 2) into `out` (null = only count them). */
function stepTasks(P: CholPlan, k: number, kind: 1 | 2, piece: number, out: Float64Array | null): number {
  const c0 = P.colStart[k], c1 = P.colStart[k + 1], mk = P.ms[k];
  let n = 0;
  if (kind === 1) {
    for (let t = c0; t < c1; t++) { if (out) { const o = TASK * n; out[o] = 1; out[o + 1] = k; out[o + 2] = t; } n++; }
    return n;
  }
  for (let ti = c0; ti < c1; ti++) for (let tj = c0; tj <= ti; tj++) {
    const mi = P.ms[P.rows[ti]], mj = P.ms[P.rows[tj]], cost = mi * mj * mk;
    const parts = Math.max(1, Math.min(mi >> 1, Math.round(cost / piece)));
    const to = out ? targetOf(P, P.rows[ti], P.rows[tj]) : 0;
    for (let q = 0; q < parts; q++) {
      // even row starts: the kernel works on pairs of rows
      const a0 = (Math.floor((q * mi) / parts) >> 1) << 1, a1 = q === parts - 1 ? mi : (Math.floor(((q + 1) * mi) / parts) >> 1) << 1;
      if (a1 <= a0) continue;
      if (out) { const o = TASK * n; out[o] = 2; out[o + 1] = k; out[o + 2] = ti; out[o + 3] = tj; out[o + 4] = to; out[o + 5] = a0; out[o + 6] = a1; }
      n++;
    }
  }
  return n;
}

/** Factorises in place: on all threads when the factor is on shared memory and helpers exist, else on this one. */
export function factor(P: CholPlan, data: Float64Array) {
  const threads = helpers.length + 1;
  if (threads < 2 || !sharedOk || !(data.buffer instanceof SharedArrayBuffer)) { factorSerial(P, data); return; }
  const cost = stepCosts(P), nel = P.nel;
  // which steps are worth sharing, and the longest task list among them
  const piece = (k: number) => Math.max(PAR_TASK, (cost[k + 1] - cost[k]) / (4 * threads));
  let most = 0;
  for (let k = 0; k < nel; k++) if (cost[k + 1] - cost[k] >= PAR_STEP) most = Math.max(most, stepTasks(P, k, 2, piece(k), null), P.colStart[k + 1] - P.colStart[k]);
  if (!most || most > IDX_MASK) { factorSerial(P, data); return; }
  const job: CholJob = {
    ctl: new Int32Array(new SharedArrayBuffer(4 * 8)), nOf: new Int32Array(new SharedArrayBuffer(4 * GENS)), tasks: new Float64Array(new SharedArrayBuffer(8 * TASK * most)),
    ms: shared(P.ms), rows: shared(P.rows), blockAt: shared(P.blockAt), diagAt: shared(P.diagAt), data,
  };
  const { ctl, nOf, tasks } = job, Q = { ...P, ms: job.ms, rows: job.rows, blockAt: job.blockAt, diagAt: job.diagAt };
  let gen = 0;
  const run = (n: number) => {
    gen = (gen + 1) % GENS;
    Atomics.store(nOf, gen, n);
    Atomics.store(ctl, DONE, 0);
    Atomics.store(ctl, NEXT, gen << IDX_BITS);
    Atomics.store(ctl, GEN, gen);
    Atomics.notify(ctl, GEN);
    work(job, Q);
    for (;;) { const d = Atomics.load(ctl, DONE); if (d >= n) break; Atomics.wait(ctl, DONE, d, 50); }
    // what is left of this generation's counter must not serve a later one
    Atomics.store(nOf, gen, 0);
  };
  for (const h of helpers) h.postMessage(job);
  stats.jobs++;
  try {
    for (let k = 0; k < nel; k++) {
      progress("factor", cost[k], cost[nel]);
      factorDiag(Q, data, k);
      const c0 = P.colStart[k], c1 = P.colStart[k + 1];
      if (cost[k + 1] - cost[k] < PAR_STEP) {
        for (let t = c0; t < c1; t++) solveBlock(Q, data, k, t);
        for (let ti = c0; ti < c1; ti++) for (let tj = c0; tj <= ti; tj++) updateBlock(Q, data, k, ti, tj, targetOf(Q, P.rows[ti], P.rows[tj]));
        continue;
      }
      stats.parallelSteps++;
      run(stepTasks(Q, k, 1, 0, tasks));
      const n = stepTasks(Q, k, 2, piece(k), tasks);
      if (n) run(n);
    }
  } finally {
    stats.joined = Atomics.load(ctl, JOINED);
    Atomics.store(ctl, STOP, 1);
    Atomics.store(ctl, GEN, (gen + 1) % GENS);
    Atomics.notify(ctl, GEN);
  }
}

// Loops over independent tasks (building the equations: one task per cell or element), shared the same way. A kind
// of loop is registered once by the module that owns it (`kernel`), on every thread, since each thread imports
// the same modules; a job names its kind and carries its arrays on shared memory. Every task writes only its own
// part of the output and is worked through in the same order whoever runs it, so the numbers do not depend on the
// number of threads.

export interface ParJob { kind: string; ctl: Int32Array; n: number; [k: string]: unknown }
interface Kernel<J, S> { init(job: J): S; run(state: S, i: number): void }
const kernels = new Map<string, Kernel<never, unknown>>();
/** Registers a kind of loop: `init` once per thread and job, `run` per task. */
export function kernel<J, S>(kind: string, k: Kernel<J, S>) { kernels.set(kind, k as unknown as Kernel<never, unknown>); }

const P_NEXT = 0, P_DONE = 1, P_FAIL = 2, P_JOINED = 3;
function claim(j: ParJob, k: Kernel<never, unknown>, tick?: (done: number) => void) {
  const ctl = j.ctl, n = j.n;
  let st: unknown;
  for (;;) {
    const i = Atomics.add(ctl, P_NEXT, 1);
    if (i >= n) return;
    try { st ??= k.init(j as never); k.run(st, i); } catch { Atomics.store(ctl, P_FAIL, 1); }
    const d = Atomics.add(ctl, P_DONE, 1) + 1;
    if (d === n) Atomics.notify(ctl, P_DONE);
    tick?.(d);
  }
}
function serveJob(j: ParJob) {
  const k = kernels.get(j.kind);
  if (!k) return;
  Atomics.add(j.ctl, P_JOINED, 1);
  claim(j, k);
}
/** Whether a loop of about `work` multiplications is worth sharing between threads here. */
export const worthSharing = (work: number) => sharedOk && helpers.length > 0 && work >= loopFloor;
let loopFloor = 2e7;
/** The least work a loop is shared from (tests share small ones). */
export function setLoopFloor(n: number) { loopFloor = n; }
/** A shared copy's memory: n doubles or 32-bit integers. */
export const sharedF64 = (n: number) => new Float64Array(new SharedArrayBuffer(8 * n));
export const sharedI32 = (n: number) => new Int32Array(new SharedArrayBuffer(4 * n));
/** Runs the job's `n` tasks on all threads and returns when every one is done (`tick`: tasks done so far). */
export function parallelFor(job: { kind: string; n: number; [k: string]: unknown }, tick?: (done: number) => void) {
  const k = kernels.get(job.kind);
  if (!k) throw new Error(`no loop "${job.kind}"`);
  const j = { ...job, ctl: sharedI32(4) } as ParJob;
  for (const h of helpers) h.postMessage(j);
  stats.loops++;
  claim(j, k, tick);
  for (;;) { const d = Atomics.load(j.ctl, P_DONE); if (d >= j.n) break; Atomics.wait(j.ctl, P_DONE, d, 50); }
  stats.loopJoined = Atomics.load(j.ctl, P_JOINED);
  if (Atomics.load(j.ctl, P_FAIL)) throw new Error("E-SIM-THREADS");
}

// Solves with one factorisation for several right-hand sides: one task per right-hand side (blockchol.ts `solveAll`).
interface SolveJob extends ParJob, SolvePlan { size: number; data: Float64Array; B: Float64Array; X: Float64Array }
kernel<SolveJob, { j: SolveJob; y: Float64Array }>("cholsolve", {
  init: j => ({ j, y: new Float64Array(j.size) }),
  run({ j, y }, i) { const n = j.size; cholSolve(j, j.data, j.B.subarray(n * i, n * i + n), y, j.X.subarray(n * i, n * i + n)); },
});
/** A solve plan with its arrays on shared memory, so a job does not copy them to every thread. */
export function sharedSolvePlan(P: SolvePlan): SolvePlan {
  return { nel: P.nel, ms: shared(P.ms), perm: shared(P.perm), colStart: shared(P.colStart), rows: shared(P.rows), blockAt: shared(P.blockAt), diagAt: shared(P.diagAt), off: shared(P.off), poff: shared(P.poff) };
}
