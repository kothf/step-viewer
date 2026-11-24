// Structural and thermal analysis (FR-SOL-003, FR-SARC-005): a block (supernodal) Cholesky factorisation of a
// BlockMatrix. Each element's unknowns are one dense block; the elements are eliminated in a minimum-fill order of
// the element graph, so the factor holds far fewer values than the envelope of a band order, and the work is
// dense block products (rows times rows, both read in memory order). The block products of one elimination step
// touch distinct blocks, so they may run on several threads at once (`parallel.ts`); the sums inside each block are
// made in the same order whoever makes them, so the answer is the same to the last bit with one thread or many.

import type { BlockMatrix } from "./sparse";
import { progress } from "./progress";
import { factor, factorBuffer, parallelFor, sharedF64, sharedSolvePlan, worthSharing } from "./threads";

/** The factor's layout: element order, each column's lower blocks and where every block lives in `data`. */
export interface CholPlan {
  nel: number;
  /** Unknowns per element. */
  ms: Int32Array;
  /** perm[k] = element eliminated k-th; pos[e] = its step. */
  perm: Int32Array;
  pos: Int32Array;
  /** Column k (a step) holds blocks for rows rows[colStart[k] .. colStart[k + 1]) (steps after k, ascending). */
  colStart: Int32Array;
  rows: Int32Array;
  /** Offset in `data` of block colStart[k] + t (rows[..] × ms of column k, row-major) and of the diagonal block of step k. */
  blockAt: Float64Array;
  diagAt: Float64Array;
  /** Values in all. */
  size: number;
  /** Multiplications of the factorisation (to choose between direct and iterative solvers). */
  flops: number;
}

/**
 * Minimum fill-in weight order of the element graph (weights = unknowns per element): at each step the element
 * whose neighbours hold the fewest unknowns goes next (ties by the element number, so the order is fixed).
 */
export function minDegreeOrder(adj: Set<number>[], ms: ArrayLike<number>): Int32Array {
  const n = adj.length;
  const nb: Set<number>[] = adj.map((s, i) => { const t = new Set(s); t.delete(i); return t; });
  const w = new Float64Array(n), done = new Uint8Array(n), order = new Int32Array(n);
  const score = (i: number) => { let s = 0; for (const j of nb[i]) s += ms[j]; return s; };
  for (let i = 0; i < n; i++) w[i] = score(i);
  // a binary heap of (score, element), stale entries skipped
  const hs: number[] = [], he: number[] = [];
  const push = (s: number, e: number) => {
    let i = hs.length; hs.push(s); he.push(e);
    while (i > 0) { const p = (i - 1) >> 1; if (hs[p] < s || (hs[p] === s && he[p] < e)) break; hs[i] = hs[p]; he[i] = he[p]; i = p; }
    hs[i] = s; he[i] = e;
  };
  const pop = () => {
    const s0 = hs[0], e0 = he[0], s = hs.pop()!, e = he.pop()!, len = hs.length;
    if (len) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && (hs[c + 1] < hs[c] || (hs[c + 1] === hs[c] && he[c + 1] < he[c]))) c++;
        if (s < hs[c] || (s === hs[c] && e < he[c])) break;
        hs[i] = hs[c]; he[i] = he[c]; i = c;
      }
      hs[i] = s; he[i] = e;
    }
    return [s0, e0];
  };
  for (let i = 0; i < n; i++) push(w[i], i);
  for (let k = 0; k < n; k++) {
    let e = -1;
    while (hs.length) { const [s, c] = pop(); if (!done[c] && s === w[c]) { e = c; break; } }
    if (e < 0) for (let i = 0; i < n; i++) if (!done[i]) { e = i; break; }
    order[k] = e; done[e] = 1;
    const N = [...nb[e]];
    for (const a of N) nb[a].delete(e);
    // the neighbours become one clique
    for (let x = 0; x < N.length; x++) for (let y = x + 1; y < N.length; y++) { nb[N[x]].add(N[y]); nb[N[y]].add(N[x]); }
    for (const a of N) { const s = score(a); if (s !== w[a]) { w[a] = s; push(s, a); } }
  }
  return order;
}

/** The factor's structure for A in the given element order (default: minimum degree). */
export function cholPlan(A: { nel: number; ms: Int32Array; adj: Set<number>[] }, order?: Int32Array): CholPlan {
  const nel = A.nel, ms = A.ms;
  const perm = order ?? minDegreeOrder(A.adj, ms), pos = new Int32Array(nel);
  perm.forEach((e, k) => (pos[e] = k));
  // symbolic elimination on steps: struct(k) = the later neighbours of k, plus those its children pass up
  const cols: number[][] = new Array(nel);
  const parent = new Int32Array(nel).fill(-1);
  const kids: number[][] = Array.from({ length: nel }, () => []);
  for (let k = 0; k < nel; k++) {
    const s = new Set<number>();
    for (const b of A.adj[perm[k]]) { const q = pos[b]; if (q > k) s.add(q); }
    for (const c of kids[k]) for (const q of cols[c]) if (q > k) s.add(q);
    const r = [...s].sort((a, b) => a - b);
    cols[k] = r;
    if (r.length) { parent[k] = r[0]; kids[r[0]].push(k); }
  }
  const colStart = new Int32Array(nel + 1);
  for (let k = 0; k < nel; k++) colStart[k + 1] = colStart[k] + cols[k].length;
  const rows = new Int32Array(colStart[nel]), blockAt = new Float64Array(colStart[nel]), diagAt = new Float64Array(nel);
  let at = 0, flops = 0;
  for (let k = 0; k < nel; k++) {
    const mk = ms[perm[k]];
    diagAt[k] = at; at += mk * mk;
    let below = 0;
    cols[k].forEach((q, t) => { rows[colStart[k] + t] = q; blockAt[colStart[k] + t] = at; const mq = ms[perm[q]]; at += mq * mk; below += mq; });
    flops += (mk * mk * mk) / 3 + below * mk * mk + (below * below * mk) / 2;
  }
  return { nel, ms: Int32Array.from({ length: nel }, (_, k) => ms[perm[k]]), perm, pos, colStart, rows, blockAt, diagAt, size: at, flops };
}

/** Puts A's lower blocks (in step order) into a fresh factor buffer. */
export function scatter(A: BlockMatrix, P: CholPlan, data: Float64Array) {
  const nel = P.nel, pos = P.pos, ms = P.ms;
  // where block (row step i, column step k) lives
  const find = (i: number, k: number) => {
    let lo = P.colStart[k], hi = P.colStart[k + 1] - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1, r = P.rows[m]; if (r === i) return P.blockAt[m]; if (r < i) lo = m + 1; else hi = m - 1; }
    return -1;
  };
  for (const [key, B] of A.blocks) {
    const a = Math.floor(key / nel), b = key - a * nel;
    const i = pos[a], k = pos[b];
    if (i < k) continue;
    const mi = ms[i], mk = ms[k];
    if (i === k) { data.set(B, P.diagAt[k]); continue; }
    const o = find(i, k);
    if (o < 0) throw new Error("E-SIM-SINGULAR: factor structure");
    // B is rows of a (step i) × columns of b (step k), as the factor wants
    for (let x = 0; x < mi * mk; x++) data[o + x] += B[x];
  }
}

/** Cholesky of the diagonal block of step k in place (lower triangle; the upper is left as it is). */
export function factorDiag(P: CholPlan, data: Float64Array, k: number) {
  const m = P.ms[k], o = P.diagAt[k];
  for (let r = 0; r < m; r++) {
    const R = o + r * m;
    for (let c = 0; c <= r; c++) {
      const C = o + c * m;
      let s = data[R + c], s1 = 0, t = 0;
      for (; t + 1 < c; t += 2) { s -= data[R + t] * data[C + t]; s1 += data[R + t + 1] * data[C + t + 1]; }
      if (t < c) s -= data[R + t] * data[C + t];
      s -= s1;
      if (c < r) data[R + c] = s / data[C + c];
      else {
        if (!(s > 0)) throw new Error(`E-SIM-SINGULAR: pivot ${s} at ${P.colStart[k]}`);
        data[R + r] = Math.sqrt(s);
      }
    }
  }
}

/** Block t of column k ← block · L_kk⁻ᵀ (row by row forward substitution). */
export function solveBlock(P: CholPlan, data: Float64Array, k: number, t: number) {
  const mk = P.ms[k], d = P.diagAt[k], o = P.blockAt[t], mi = P.ms[P.rows[t]];
  for (let a = 0; a < mi; a++) {
    const R = o + a * mk;
    for (let c = 0; c < mk; c++) {
      const C = d + c * mk;
      let s = data[R + c], s1 = 0, q = 0;
      for (; q + 1 < c; q += 2) { s -= data[R + q] * data[C + q]; s1 += data[R + q + 1] * data[C + q + 1]; }
      if (q < c) s -= data[R + q] * data[C + q];
      data[R + c] = (s - s1) / data[C + c];
    }
  }
}

/** Where block (row step i, column step j) lives (i > j), or the diagonal block when i = j. */
export function targetOf(P: CholPlan, i: number, j: number): number {
  if (i === j) return P.diagAt[j];
  let lo = P.colStart[j], hi = P.colStart[j + 1] - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1, r = P.rows[m]; if (r === i) return P.blockAt[m]; if (r < i) lo = m + 1; else hi = m - 1; }
  throw new Error("E-SIM-SINGULAR: factor structure");
}

/**
 * The update of step k on block (rows[ti], rows[tj]) (ti ≥ tj): T −= L_ik L_jkᵀ, two rows of each at a time.
 * On a diagonal block only its lower triangle is made. `a0` (even) .. `a1` = the rows of the block to make: every
 * value is its own sum, so a block made in pieces by several threads is the same as one made whole.
 */
export function updateBlock(P: CholPlan, data: Float64Array, k: number, ti: number, tj: number, to: number, a0 = 0, a1 = -1) {
  const mk = P.ms[k], i = P.rows[ti], j = P.rows[tj], mi = a1 < 0 ? P.ms[i] : a1, mj = P.ms[j];
  const oi = P.blockAt[ti], oj = P.blockAt[tj], diag = ti === tj;
  let a = a0;
  for (; a + 1 < mi; a += 2) {
    const A0 = oi + a * mk, A1 = A0 + mk, T0 = to + a * mj, T1 = T0 + mj;
    const bEnd = diag ? a + 2 : mj;
    let b = 0;
    for (; b + 1 < bEnd; b += 2) {
      const B0 = oj + b * mk, B1 = B0 + mk;
      let s00 = 0, s01 = 0, s10 = 0, s11 = 0;
      for (let q = 0; q < mk; q++) {
        const x0 = data[A0 + q], x1 = data[A1 + q], y0 = data[B0 + q], y1 = data[B1 + q];
        s00 += x0 * y0; s01 += x0 * y1; s10 += x1 * y0; s11 += x1 * y1;
      }
      data[T0 + b] -= s00; data[T0 + b + 1] -= s01; data[T1 + b] -= s10; data[T1 + b + 1] -= s11;
    }
    for (; b < bEnd; b++) {
      const B0 = oj + b * mk;
      let s0 = 0, s1 = 0;
      for (let q = 0; q < mk; q++) { const y = data[B0 + q]; s0 += data[A0 + q] * y; s1 += data[A1 + q] * y; }
      data[T0 + b] -= s0; data[T1 + b] -= s1;
    }
  }
  for (; a < mi; a++) {
    const A0 = oi + a * mk, T0 = to + a * mj, bEnd = diag ? a + 1 : mj;
    for (let b = 0; b < bEnd; b++) {
      const B0 = oj + b * mk;
      let s = 0;
      for (let q = 0; q < mk; q++) s += data[A0 + q] * data[B0 + q];
      data[T0 + b] -= s;
    }
  }
}

/** The work of each step's updates (for splitting them between threads). */
export function updateCost(P: CholPlan, k: number, ti: number, tj: number) {
  return P.ms[P.rows[ti]] * P.ms[P.rows[tj]] * P.ms[k];
}

/** The multiplications done before each step (nel + 1 entries: the last is the total). */
export function stepCosts(P: CholPlan): Float64Array {
  const c = new Float64Array(P.nel + 1);
  for (let k = 0; k < P.nel; k++) {
    const mk = P.ms[k];
    let below = 0;
    for (let t = P.colStart[k]; t < P.colStart[k + 1]; t++) below += P.ms[P.rows[t]];
    c[k + 1] = c[k] + (mk * mk * mk) / 3 + below * mk * mk + (below * below * mk) / 2;
  }
  return c;
}

/** Runs the whole factorisation on this thread. */
export function factorSerial(P: CholPlan, data: Float64Array) {
  const cost = stepCosts(P);
  for (let k = 0; k < P.nel; k++) {
    progress("factor", cost[k], cost[P.nel]);
    factorDiag(P, data, k);
    const c0 = P.colStart[k], c1 = P.colStart[k + 1];
    for (let t = c0; t < c1; t++) solveBlock(P, data, k, t);
    for (let ti = c0; ti < c1; ti++) for (let tj = c0; tj <= ti; tj++) updateBlock(P, data, k, ti, tj, targetOf(P, P.rows[ti], P.rows[tj]));
  }
}

/** A factorised matrix: solves A x = b. */
export class BlockCholesky {
  readonly n: number;
  readonly plan: CholPlan;
  private readonly data: Float64Array;
  private readonly off: Int32Array;
  private readonly poff: Int32Array;
  constructor(A: BlockMatrix, opts: { order?: Int32Array; plan?: CholPlan; data?: Float64Array; factored?: boolean } = {}) {
    this.n = A.size;
    const P = (this.plan = opts.plan ?? cholPlan(A, opts.order));
    if (P.size > 2 ** 28) throw new Error(`E-SIM-MEMORY: factor of ${P.size} values`);
    this.data = opts.data ?? factorBuffer(P.size);
    if (!opts.factored) { scatter(A, P, this.data); factor(P, this.data); }
    this.off = A.off;
    this.poff = new Int32Array(P.nel + 1);
    for (let k = 0; k < P.nel; k++) this.poff[k + 1] = this.poff[k] + P.ms[k];
  }
  get values() { return this.data.length; }
  solve(b: Float64Array): Float64Array {
    const x = new Float64Array(this.n);
    cholSolve(this.solvePlan(), this.data, b, new Float64Array(this.n), x);
    return x;
  }
  /** Solves for several right-hand sides, on all threads when that is worth it: the same numbers as `solve` gives one by one. */
  solveAll(bs: Float64Array[]): Float64Array[] {
    const n = this.n, q = bs.length;
    if (q < 2 || typeof SharedArrayBuffer === "undefined" || !(this.data.buffer instanceof SharedArrayBuffer) || !worthSharing(4 * q * this.data.length)) return bs.map(b => this.solve(b));
    const P = (this.sharedPlan ??= sharedSolvePlan(this.solvePlan()));
    const B = sharedF64(n * q), X = sharedF64(n * q);
    for (let j = 0; j < q; j++) B.set(bs[j], n * j);
    parallelFor({ kind: "cholsolve", n: q, size: n, ...P, data: this.data, B, X });
    return bs.map((_, j) => X.slice(n * j, n * j + n));
  }
  private sharedPlan?: SolvePlan;
  private solvePlan(): SolvePlan { const P = this.plan; return { nel: P.nel, ms: P.ms, perm: P.perm, colStart: P.colStart, rows: P.rows, blockAt: P.blockAt, diagAt: P.diagAt, off: this.off, poff: this.poff }; }
}

/** The plan's arrays a solve reads (they may be shared copies). */
export interface SolvePlan { nel: number; ms: Int32Array; perm: Int32Array; colStart: Int32Array; rows: Int32Array; blockAt: Float64Array; diagAt: Float64Array; off: Int32Array; poff: Int32Array }
/** Solves L Lᵀ x = b with the factor `L`: `y` is scratch of the same length, `x` takes the answer (b and x may be parts of longer arrays). */
export function cholSolve(P: SolvePlan, L: Float64Array, b: Float64Array, y: Float64Array, x: Float64Array) {
  const nel = P.nel, ms = P.ms, poff = P.poff, off = P.off;
  for (let k = 0; k < nel; k++) { const e = P.perm[k]; y.set(b.subarray(off[e], off[e] + ms[k]), poff[k]); }
  // forward: L y = b
  for (let k = 0; k < nel; k++) {
    const m = ms[k], d = P.diagAt[k], y0 = poff[k];
    for (let r = 0; r < m; r++) {
      let s = y[y0 + r];
      const R = d + r * m;
      for (let c = 0; c < r; c++) s -= L[R + c] * y[y0 + c];
      y[y0 + r] = s / L[R + r];
    }
    for (let t = P.colStart[k]; t < P.colStart[k + 1]; t++) {
      const i = P.rows[t], mi = ms[i], o = P.blockAt[t], yi = poff[i];
      for (let a = 0; a < mi; a++) {
        let s = 0;
        const R = o + a * m;
        for (let c = 0; c < m; c++) s += L[R + c] * y[y0 + c];
        y[yi + a] -= s;
      }
    }
  }
  // backward: Lᵀ x = y
  for (let k = nel - 1; k >= 0; k--) {
    const m = ms[k], d = P.diagAt[k], y0 = poff[k];
    for (let t = P.colStart[k]; t < P.colStart[k + 1]; t++) {
      const i = P.rows[t], mi = ms[i], o = P.blockAt[t], yi = poff[i];
      for (let a = 0; a < mi; a++) {
        const v = y[yi + a];
        if (v === 0) continue;
        const R = o + a * m;
        for (let c = 0; c < m; c++) y[y0 + c] -= L[R + c] * v;
      }
    }
    for (let r = m - 1; r >= 0; r--) {
      const v = (y[y0 + r] /= L[d + r * m + r]);
      if (v !== 0) for (let c = 0; c < r; c++) y[y0 + c] -= L[d + r * m + c] * v;
    }
  }
  for (let k = 0; k < nel; k++) { const e = P.perm[k]; x.set(y.subarray(poff[k], poff[k] + ms[k]), off[e]); }
}

