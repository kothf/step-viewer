// Structural analysis (FR-SARC-022): the lowest eigenpairs of K φ = θ M φ by subspace iteration.
// K is symmetric positive definite (shifted when the body is free), M symmetric positive semi-definite.
// Each step solves K Y = M X, then the small problem on the columns of Y gives new vectors (Rayleigh–Ritz).
// The solves may be iterative: K is always applied itself for the small matrices.

export interface EigenOptions {
  /** Pairs wanted. */
  count: number;
  /** Start vectors (an earlier pass's modes); the rest are filled with fixed pseudo-random numbers. */
  start?: Float64Array[];
  /** Relative change of the wanted values at which the iteration stops (default 1e-7). */
  tol?: number;
  maxIt?: number;
  /** Vectors carried beside the wanted ones (default: as many again, at least 8). */
  extra?: number;
}

export interface EigenResult {
  /** θ ascending, `count` of them (fewer when the problem is smaller). */
  values: number[];
  /** Vectors with φᵀ M φ = 1, one per value. */
  vectors: Float64Array[];
  /** Every vector of the last step, for the next pass to start from. */
  space: Float64Array[];
  iterations: number;
  /** Largest relative change of the wanted values in the last step. */
  change: number;
}

const dot = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Jacobi eigen-decomposition of a symmetric n×n matrix (row-major, overwritten): values on the diagonal, vectors in the columns of V. */
export function jacobiEigen(B: Float64Array, n: number): Float64Array {
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0, dia = 0;
    for (let i = 0; i < n; i++) { dia += B[i * n + i] ** 2; for (let j = i + 1; j < n; j++) off += B[i * n + j] ** 2; }
    if (off <= 1e-28 * dia) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = B[p * n + q];
      if (apq === 0) continue;
      const th = (B[q * n + q] - B[p * n + p]) / (2 * apq);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < n; k++) { const a = B[k * n + p], b = B[k * n + q]; B[k * n + p] = cs * a - sn * b; B[k * n + q] = sn * a + cs * b; }
      for (let k = 0; k < n; k++) { const a = B[p * n + k], b = B[q * n + k]; B[p * n + k] = cs * a - sn * b; B[q * n + k] = sn * a + cs * b; }
      for (let k = 0; k < n; k++) { const a = V[k * n + p], b = V[k * n + q]; V[k * n + p] = cs * a - sn * b; V[k * n + q] = sn * a + cs * b; }
    }
  }
  return V;
}

/**
 * The small problem Kr v = θ Mr v (q×q, row-major): θ ascending and the vectors as columns of a q×k matrix
 * with vᵀ Mr v = 1. Directions Mr hardly holds (dependent columns) are left out, so k may be under q.
 */
export function reduced(Kr: Float64Array, Mr: Float64Array, q: number): { val: number[]; V: Float64Array; k: number } {
  // Mr = U D Uᵀ; keep D above a share of the largest, T = U D^(-1/2)
  const D = Float64Array.from(Mr), U = jacobiEigen(D, q);
  let top = 0;
  for (let i = 0; i < q; i++) top = Math.max(top, D[i * q + i]);
  const keep: number[] = [];
  for (let i = 0; i < q; i++) if (D[i * q + i] > 1e-12 * top) keep.push(i);
  const k = keep.length, T = new Float64Array(q * k);
  for (let c = 0; c < k; c++) { const s = 1 / Math.sqrt(D[keep[c] * q + keep[c]]); for (let i = 0; i < q; i++) T[i * k + c] = U[i * q + keep[c]] * s; }
  // B = Tᵀ Kr T
  const KT = new Float64Array(q * k), B = new Float64Array(k * k);
  for (let i = 0; i < q; i++) for (let c = 0; c < k; c++) { let s = 0; for (let j = 0; j < q; j++) s += Kr[i * q + j] * T[j * k + c]; KT[i * k + c] = s; }
  for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) { let s = 0; for (let i = 0; i < q; i++) s += T[i * k + a] * KT[i * k + c]; B[a * k + c] = s; }
  for (let a = 0; a < k; a++) for (let c = a + 1; c < k; c++) B[a * k + c] = B[c * k + a] = (B[a * k + c] + B[c * k + a]) / 2;
  const W = jacobiEigen(B, k);
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => B[a * k + a] - B[b * k + b]);
  const V = new Float64Array(q * k);
  for (let c = 0; c < k; c++) for (let i = 0; i < q; i++) { let s = 0; for (let a = 0; a < k; a++) s += T[i * k + a] * W[a * k + order[c]]; V[i * k + c] = s; }
  return { val: order.map(i => B[i * k + i]), V, k };
}

export function subspace(
  n: number,
  solve: (b: Float64Array, guess?: Float64Array) => Float64Array,
  mulK: (x: Float64Array, y: Float64Array) => void,
  mulM: (x: Float64Array, y: Float64Array) => void,
  o: EigenOptions,
): EigenResult {
  const count = Math.min(o.count, n);
  const q = Math.min(n, count + Math.max(8, o.extra ?? count));
  let X: Float64Array[] = [];
  for (const s of o.start ?? []) if (X.length < q && s.length === n) X.push(Float64Array.from(s));
  let seed = 12345;
  while (X.length < q) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; v[i] = seed / 0x7fffffff - 0.5; }
    X.push(v);
  }
  let theta: number[] = [], change = Infinity, it = 0;
  const tol = o.tol ?? 1e-7, maxIt = o.maxIt ?? 60;
  const Z = new Float64Array(n), guess = new Float64Array(n);
  for (; it < maxIt; ) {
    it++;
    const Y: Float64Array[] = [], KY: Float64Array[] = [], MY: Float64Array[] = [];
    for (let j = 0; j < X.length; j++) {
      mulM(X[j], Z);
      // K y = M x: near a mode, y ≈ x / θ
      let g: Float64Array | undefined;
      if (theta[j] > 0) { for (let i = 0; i < n; i++) guess[i] = X[j][i] / theta[j]; g = guess; }
      const y = solve(Z, g);
      const ky = new Float64Array(n), my = new Float64Array(n);
      mulK(y, ky); mulM(y, my);
      Y.push(y); KY.push(ky); MY.push(my);
    }
    const m = Y.length, Kr = new Float64Array(m * m), Mr = new Float64Array(m * m);
    for (let a = 0; a < m; a++) for (let b = a; b < m; b++) {
      Kr[a * m + b] = Kr[b * m + a] = (dot(Y[a], KY[b]) + dot(Y[b], KY[a])) / 2;
      Mr[a * m + b] = Mr[b * m + a] = (dot(Y[a], MY[b]) + dot(Y[b], MY[a])) / 2;
    }
    const r = reduced(Kr, Mr, m);
    const next: Float64Array[] = [];
    for (let c = 0; c < r.k; c++) {
      const v = new Float64Array(n);
      for (let a = 0; a < m; a++) { const f = r.V[a * r.k + c]; if (f !== 0) { const y = Y[a]; for (let i = 0; i < n; i++) v[i] += f * y[i]; } }
      next.push(v);
    }
    change = 0;
    const want = Math.min(count, r.k);
    for (let c = 0; c < want; c++) change = Math.max(change, theta.length > c ? Math.abs(r.val[c] - theta[c]) / Math.abs(r.val[c] || 1) : Infinity);
    X = next; theta = r.val;
    if (change < tol) break;
  }
  const k = Math.min(count, X.length);
  return { values: theta.slice(0, k), vectors: X.slice(0, k), space: X, iterations: it, change };
}
