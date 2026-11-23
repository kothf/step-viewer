// Structural analysis (FRS-structural FR-SARC-011): polynomial fields per cell.
// A cell's displacement is a complete polynomial of total degree ≤ p in the cell's scaled coordinates
// ξ = (x − c) / s (s = half size), built from products of Legendre polynomials for conditioning.
// Pure maths, no DOM, so the solver worker and the unit tests share it.

/** Legendre polynomial P_n(x) and its derivative, n ≤ 8. */
export function legendre(n: number, x: number, out: Float64Array) {
  // out[2k] = P_k(x), out[2k + 1] = P_k'(x), k = 0..n
  out[0] = 1; out[1] = 0;
  if (n === 0) return;
  out[2] = x; out[3] = 1;
  for (let k = 2; k <= n; k++) {
    const p1 = out[2 * k - 2], p2 = out[2 * k - 4];
    const d1 = out[2 * k - 1], d2 = out[2 * k - 3];
    out[2 * k] = ((2 * k - 1) * x * p1 - (k - 1) * p2) / k;
    out[2 * k + 1] = ((2 * k - 1) * (p1 + x * d1) - (k - 1) * d2) / k;
  }
}

/** Exponent triples (i, j, k) with i + j + k ≤ p, lowest degree first. */
export function monomials(p: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let d = 0; d <= p; d++)
    for (let i = d; i >= 0; i--)
      for (let j = d - i; j >= 0; j--) out.push([i, j, d - i - j]);
  return out;
}

/** Number of scalar basis functions of degree ≤ p in 3D. */
export const basisSize = (p: number) => ((p + 1) * (p + 2) * (p + 3)) / 6;

/** Scalar basis of one cell: values and gradients (in model mm) at a point. */
export class Basis {
  readonly n: number;
  private readonly ex: Int32Array;
  private readonly lx = new Float64Array(18);
  private readonly ly = new Float64Array(18);
  private readonly lz = new Float64Array(18);
  /** Values, n entries. */
  readonly v: Float64Array;
  /** Gradients, 3n entries (x, y, z per function). */
  readonly g: Float64Array;
  constructor(readonly p: number) {
    const m = monomials(p);
    this.n = m.length;
    this.ex = new Int32Array(m.flat());
    this.v = new Float64Array(this.n);
    this.g = new Float64Array(3 * this.n);
  }
  /** Evaluates at x for a cell centred at c with half size s (cube cells): the first `n` functions (all by default; they span a lower degree). */
  eval(x: number, y: number, z: number, c: ArrayLike<number>, s: number, n = this.n) {
    const p = this.p, ex = this.ex, lx = this.lx, ly = this.ly, lz = this.lz;
    legendre(p, (x - c[0]) / s, lx);
    legendre(p, (y - c[1]) / s, ly);
    legendre(p, (z - c[2]) / s, lz);
    const inv = 1 / s;
    for (let b = 0; b < n; b++) {
      const i = ex[3 * b], j = ex[3 * b + 1], k = ex[3 * b + 2];
      const X = lx[2 * i], Y = ly[2 * j], Z = lz[2 * k];
      this.v[b] = X * Y * Z;
      this.g[3 * b] = lx[2 * i + 1] * Y * Z * inv;
      this.g[3 * b + 1] = X * ly[2 * j + 1] * Z * inv;
      this.g[3 * b + 2] = X * Y * lz[2 * k + 1] * inv;
    }
  }
}
