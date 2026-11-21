// Structural analysis (FR-SARC-021): preconditioned conjugate gradients with a two-level p-multigrid.
// The cell basis is hierarchical (lowest degree first), so the degree-1 part of every element is a
// coarse space whose matrix is just the leading sub-blocks of A, no Galerkin product needed. One cycle:
// forward block Gauss–Seidel over elements, exact coarse solve (envelope Cholesky), backward sweep.

import { BlockMatrix, Envelope } from "./sparse";

/** In-place Cholesky of an n×n row-major SPD matrix; returns false when it is not positive definite. */
function cholesky(a: Float64Array, n: number) {
  for (let j = 0; j < n; j++) {
    let s = a[j * n + j];
    for (let k = 0; k < j; k++) s -= a[j * n + k] ** 2;
    if (!(s > 0)) return false;
    const d = Math.sqrt(s);
    a[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = a[i * n + j];
      for (let k = 0; k < j; k++) t -= a[i * n + k] * a[j * n + k];
      a[i * n + j] = t / d;
    }
  }
  return true;
}

function cholSolve(L: Float64Array, n: number, b: Float64Array, bo: number) {
  for (let i = 0; i < n; i++) {
    let s = b[bo + i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * b[bo + k];
    b[bo + i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[bo + i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[bo + k];
    b[bo + i] = s / L[i * n + i];
  }
}

export interface PcgOptions {
  /** Unknowns per element in the coarse space (the leading ones of each element). */
  coarse: number;
  tol?: number;
  maxIt?: number;
}

export interface PcgResult { x: Float64Array; iterations: number; residual: number; ms: { setup: number; iterate: number } }

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A solver kept for several right-hand sides: the smoother's factors and the coarse matrix are made once. */
export interface PcgSolver { setup: number; solve(b: Float64Array, x0?: Float64Array, tol?: number): PcgResult }

export function pcg(A: BlockMatrix, b: Float64Array, o: PcgOptions): PcgResult {
  const s = pcgSolver(A, o), r = s.solve(b);
  r.ms.setup = s.setup;
  return r;
}

export function pcgSolver(A: BlockMatrix, o: PcgOptions): PcgSolver {
  const t0 = now();
  const nel = A.nel, n = A.size, mc = o.coarse, ms = A.ms, off = A.off;
  let mmax = 0;
  for (let e = 0; e < nel; e++) mmax = Math.max(mmax, ms[e]);
  // element diagonal blocks, factored
  const D: Float64Array[] = [];
  for (let e = 0; e < nel; e++) {
    const B = Float64Array.from(A.block(e, e));
    if (!cholesky(B, ms[e])) throw new Error(`E-SIM-SINGULAR: element ${e}`);
    D.push(B);
  }
  // neighbours per element row, for the Gauss–Seidel sweeps
  const rows: { b: number; B: Float64Array }[][] = Array.from({ length: nel }, () => []);
  for (const [k, B] of A.blocks) {
    const a = Math.floor(k / nel), c = k - a * nel;
    if (a !== c) rows[a].push({ b: c, B });
  }
  // coarse matrix: leading mc×mc of every block
  const Ac = new BlockMatrix(nel, mc);
  for (const [k, B] of A.blocks) {
    const a = Math.floor(k / nel), c = k - a * nel;
    const C = Ac.block(a, c);
    const mb = ms[c];
    for (let i = 0; i < mc; i++) for (let j = 0; j < mc; j++) C[i * mc + j] = B[i * mb + j];
  }
  const coarse = new Envelope(Ac);
  const t1 = now();

  const tmp = new Float64Array(mmax);
  const sweep = (x: Float64Array, r: Float64Array, forward: boolean) => {
    for (let s = 0; s < nel; s++) {
      const e = forward ? s : nel - 1 - s;
      const eo = off[e], m = ms[e];
      for (let i = 0; i < m; i++) tmp[i] = r[eo + i];
      // r_e − Σ_f A_ef x_f, including the diagonal block, then solve with it for the correction
      for (const { b: f, B } of rows[e]) {
        const fo = off[f], mf = ms[f];
        for (let i = 0; i < m; i++) { let s2 = 0; const io = i * mf; for (let j = 0; j < mf; j++) s2 += B[io + j] * x[fo + j]; tmp[i] -= s2; }
      }
      const Bd = A.block(e, e);
      for (let i = 0; i < m; i++) { let s2 = 0; const io = i * m; for (let j = 0; j < m; j++) s2 += Bd[io + j] * x[eo + j]; tmp[i] -= s2; }
      cholSolve(D[e], m, tmp, 0);
      for (let i = 0; i < m; i++) x[eo + i] += tmp[i];
    }
  };
  const Ax = new Float64Array(n), rc = new Float64Array(nel * mc);
  const precond = (r: Float64Array, z: Float64Array) => {
    z.fill(0);
    sweep(z, r, true);
    A.mul(z, Ax);
    for (let e = 0; e < nel; e++) for (let i = 0; i < mc; i++) rc[e * mc + i] = r[off[e] + i] - Ax[off[e] + i];
    const xc = coarse.solve(rc);
    for (let e = 0; e < nel; e++) for (let i = 0; i < mc; i++) z[off[e] + i] += xc[e * mc + i];
    sweep(z, r, false);
  };

  const solve = (b: Float64Array, x0?: Float64Array, tol0?: number): PcgResult => {
  const ts = now();
  const x = new Float64Array(n), r = Float64Array.from(b), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
  if (x0) { x.set(x0); A.mul(x, q); for (let i = 0; i < n; i++) r[i] -= q[i]; }
  let bn = 0;
  for (let i = 0; i < n; i++) bn += b[i] * b[i];
  bn = Math.sqrt(bn) || 1;
  precond(r, z);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  const tol = tol0 ?? o.tol ?? 1e-9, maxIt = o.maxIt ?? 500;
  let it = 0, res = 1;
  { let rr = 0; for (let i = 0; i < n; i++) rr += r[i] * r[i]; if (Math.sqrt(rr) / bn < tol) return { x, iterations: 0, residual: Math.sqrt(rr) / bn, ms: { setup: 0, iterate: now() - ts } }; }
  for (; it < maxIt; it++) {
    A.mul(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    const al = rz / pq;
    let rr = 0;
    for (let i = 0; i < n; i++) { x[i] += al * p[i]; r[i] -= al * q[i]; rr += r[i] * r[i]; }
    res = Math.sqrt(rr) / bn;
    if (res < tol) { it++; break; }
    precond(r, z);
    let rz2 = 0;
    for (let i = 0; i < n; i++) rz2 += r[i] * z[i];
    const be = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + be * p[i];
  }
  return { x, iterations: it, residual: res, ms: { setup: 0, iterate: now() - ts } };
  };
  return { setup: t1 - t0, solve };
}
