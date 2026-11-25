// Structural and thermal analysis: element matrices from moments.
// An element's functions are products of Legendre polynomials, so a product of two of them (or of their
// derivatives) is again a sum of such products with fixed coefficients. The integral of that product over the
// element's material is then a sum of the material's moments ∫ L_r(ξ) L_s(η) L_t(ζ), which are summed once
// from the element's integration points: a few hundred numbers instead of one pass over every pair of
// functions at every point. The integration points integrate those polynomials as they did before, so the
// matrix is the same to rounding.

import { monomials } from "./basis";

/** Legendre values P_0..P_n at x. */
function legendreValues(n: number, x: number, out: Float64Array) {
  out[0] = 1;
  if (n > 0) out[1] = x;
  for (let k = 2; k <= n; k++) out[k] = ((2 * k - 1) * x * out[k - 1] - (k - 1) * out[k - 2]) / k;
}

/** Gauss–Legendre points and weights on [−1, 1]. */
function gauss(n: number): { x: Float64Array; w: Float64Array } {
  const x = new Float64Array(n), w = new Float64Array(n), P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let t = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    for (let it = 0; it < 100; it++) {
      legendreValues(n, t, P);
      const d = (n * (t * P[n] - P[n - 1])) / (t * t - 1), dt = P[n] / d;
      t -= dt;
      if (Math.abs(dt) < 1e-16) break;
    }
    legendreValues(n, t, P);
    const d = (n * (t * P[n] - P[n - 1])) / (t * t - 1);
    x[i] = t; w[i] = 2 / ((1 - t * t) * d * d);
  }
  return { x, w };
}

/** One direction's products as Legendre sums: for the pair (i, j), entries [s, coefficient] of the sum over L_s. */
type Pairs = Float64Array[][];

/** The expansions L_i L_j and L_i' L_j' for i, j ≤ p. */
function expansions(p: number): { g: Pairs; d: Pairs } {
  const n = 2 * p + 2, { x, w } = gauss(n), top = 2 * p;
  const V = new Float64Array(top + 1), val: Float64Array[] = [], der: Float64Array[] = [], all: Float64Array[] = [];
  for (let q = 0; q < n; q++) {
    legendreValues(top, x[q], V);
    all.push(Float64Array.from(V));
    const v = new Float64Array(p + 1), dv = new Float64Array(p + 1);
    for (let k = 0; k <= p; k++) {
      v[k] = V[k];
      // P_k' = Σ (2m + 1) P_m over m = k − 1, k − 3, …
      let s = 0;
      for (let m = k - 1; m >= 0; m -= 2) s += (2 * m + 1) * V[m];
      dv[k] = s;
    }
    val.push(v); der.push(dv);
  }
  const make = (f: Float64Array[]): Pairs => {
    const out: Pairs = [];
    for (let i = 0; i <= p; i++) {
      out.push([]);
      for (let j = 0; j <= p; j++) {
        const terms: number[] = [];
        for (let s = 0; s <= i + j; s++) {
          let c = 0;
          for (let q = 0; q < n; q++) c += w[q] * f[q][i] * f[q][j] * all[q][s];
          c *= (2 * s + 1) / 2;
          if (Math.abs(c) > 1e-12) terms.push(s, c);
        }
        out[i].push(Float64Array.from(terms));
      }
    }
    return out;
  };
  return { g: make(val), d: make(der) };
}

/** What a degree needs to turn moments into matrices. */
export interface MomentTables {
  p: number;
  /** Functions of the degree. */
  n: number;
  /** Moments are kept for r + s + t ≤ top = 2p, at index (r · m + s) · m + t with m = top + 1. */
  top: number;
  m: number;
  /**
   * The conduction terms of the lower triangle, pair after pair (a, then b ≤ a): `start[a]` is where the pairs of
   * function a begin in `pairAt`; pair k has the terms pairAt[k] .. pairAt[k + 1], each a moment index `mi`, a
   * coefficient `co` and the direction `dir` (0, 1, 2) whose conductivity multiplies it.
   */
  start: Int32Array;
  pairAt: Int32Array;
  mi: Int32Array;
  dir: Uint8Array;
  co: Float64Array;
  /** The same for the products N_a N_b (no direction): pair k = `start[a] + b` has the terms massAt[k] .. massAt[k + 1]. */
  massAt: Int32Array;
  mmi: Int32Array;
  mco: Float64Array;
  /** Scratch: Legendre values of one point per direction, and the moments. */
  lx: Float64Array; ly: Float64Array; lz: Float64Array;
  mom: Float64Array;
}

const tables = new Map<number, MomentTables>();

/** The tables of degree p (made once per thread). */
export function momentTables(p: number): MomentTables {
  let T = tables.get(p);
  if (T) return T;
  const ex = monomials(p), n = ex.length, top = 2 * p, m = top + 1, { g, d } = expansions(p);
  const start = new Int32Array(n + 1), pairAt: number[] = [0], mi: number[] = [], dir: number[] = [], co: number[] = [];
  for (let a = 0; a < n; a++) {
    start[a] = pairAt.length - 1;
    for (let b = 0; b <= a; b++) {
      for (let ax = 0; ax < 3; ax++) {
        // the derivative is taken along `ax`: its direction uses d, the other two g
        const X = (ax === 0 ? d : g)[ex[a][0]][ex[b][0]], Y = (ax === 1 ? d : g)[ex[a][1]][ex[b][1]], Z = (ax === 2 ? d : g)[ex[a][2]][ex[b][2]];
        for (let i = 0; i < X.length; i += 2) for (let j = 0; j < Y.length; j += 2) for (let k = 0; k < Z.length; k += 2) {
          mi.push((X[i] * m + Y[j]) * m + Z[k]); dir.push(ax); co.push(X[i + 1] * Y[j + 1] * Z[k + 1]);
        }
      }
      pairAt.push(mi.length);
    }
  }
  start[n] = pairAt.length - 1;
  const massAt: number[] = [0], mmi: number[] = [], mco: number[] = [];
  for (let a = 0; a < n; a++) for (let b = 0; b <= a; b++) {
    const X = g[ex[a][0]][ex[b][0]], Y = g[ex[a][1]][ex[b][1]], Z = g[ex[a][2]][ex[b][2]];
    for (let i = 0; i < X.length; i += 2) for (let j = 0; j < Y.length; j += 2) for (let k = 0; k < Z.length; k += 2) {
      mmi.push((X[i] * m + Y[j]) * m + Z[k]); mco.push(X[i + 1] * Y[j + 1] * Z[k + 1]);
    }
    massAt.push(mmi.length);
  }
  T = {
    p, n, top, m, start, pairAt: Int32Array.from(pairAt), mi: Int32Array.from(mi), dir: Uint8Array.from(dir), co: Float64Array.from(co),
    massAt: Int32Array.from(massAt), mmi: Int32Array.from(mmi), mco: Float64Array.from(mco),
    lx: new Float64Array(m), ly: new Float64Array(m), lz: new Float64Array(m), mom: new Float64Array(m * m * m),
  };
  tables.set(p, T);
  return T;
}

/** Clears the moments before the points of an element are added. */
export function momentsClear(T: MomentTables) { T.mom.fill(0); }

/**
 * Adds the moments of `n` points (x, y, z, weight, four numbers each, from `from`) in the coordinates of the
 * element centred at c with half size s, up to total degree `top` (at most the tables').
 */
export function momentsAdd(T: MomentTables, pts: ArrayLike<number>, from: number, n: number, c: ArrayLike<number>, s: number, top = T.top) {
  const { m, lx, ly, lz, mom } = T, inv = 1 / s, cx = c[0], cy = c[1], cz = c[2];
  for (let q = 0; q < n; q++) {
    const o = from + 4 * q, w = pts[o + 3];
    legendreValues(top, (pts[o] - cx) * inv, lx);
    legendreValues(top, (pts[o + 1] - cy) * inv, ly);
    legendreValues(top, (pts[o + 2] - cz) * inv, lz);
    for (let r = 0; r <= top; r++) {
      const wr = w * lx[r];
      for (let t = 0, tm = top - r; t <= tm; t++) {
        const wrs = wr * ly[t], row = (r * m + t) * m;
        for (let u = 0, um = tm - t; u <= um; u++) mom[row + u] += wrs * lz[u];
      }
    }
  }
}

/**
 * The conduction matrix of an element from its moments: K (nb × nb, row-major, both triangles) +=
 * ∫ kx ∂xN_a ∂xN_b + ky ∂yN_a ∂yN_b + kz ∂zN_a ∂zN_b for its first nb functions; s = the element's half size.
 */
export function conductFromMoments(T: MomentTables, K: Float64Array, nb: number, s: number, kx: number, ky: number, kz: number) {
  const { start, pairAt, mi, dir, co, mom } = T, inv2 = 1 / (s * s), kd = [kx * inv2, ky * inv2, kz * inv2];
  for (let a = 0; a < nb; a++) {
    let k = start[a];
    for (let b = 0; b <= a; b++, k++) {
      let sx = 0, sy = 0, sz = 0;
      for (let t = pairAt[k], t1 = pairAt[k + 1]; t < t1; t++) {
        const v = co[t] * mom[mi[t]], ax = dir[t];
        if (ax === 0) sx += v; else if (ax === 1) sy += v; else sz += v;
      }
      const v = kd[0] * sx + kd[1] * sy + kd[2] * sz;
      K[a * nb + b] += v;
      if (b !== a) K[b * nb + a] += v;
    }
  }
}

/** Adds one point's moments with weight w (as `momentsAdd` does for a run of points). */
export function momentsPoint(T: MomentTables, x: number, y: number, z: number, w: number, c: ArrayLike<number>, s: number, top = T.top) {
  const { m, lx, ly, lz, mom } = T, inv = 1 / s;
  legendreValues(top, (x - c[0]) * inv, lx);
  legendreValues(top, (y - c[1]) * inv, ly);
  legendreValues(top, (z - c[2]) * inv, lz);
  for (let r = 0; r <= top; r++) {
    const wr = w * lx[r];
    for (let t = 0, tm = top - r; t <= tm; t++) {
      const wrs = wr * ly[t], row = (r * m + t) * m;
      for (let u = 0, um = tm - t; u <= um; u++) mom[row + u] += wrs * lz[u];
    }
  }
}

/** The Legendre values `momentsPoint` makes for a point, written to `out` from `o`: 3 · (top + 1) numbers (x, y, z). */
export function legendrePoint(top: number, x: number, y: number, z: number, c: ArrayLike<number>, s: number, out: Float64Array, o: number) {
  const inv = 1 / s, n1 = top + 1;
  for (let d = 0; d < 3; d++) {
    const v = ((d === 0 ? x : d === 1 ? y : z) - c[d]) * inv, b = o + d * n1;
    out[b] = 1;
    if (top > 0) out[b + 1] = v;
    for (let k = 2; k <= top; k++) out[b + k] = ((2 * k - 1) * v * out[b + k - 1] - (k - 1) * out[b + k - 2]) / k;
  }
}

/** `momentsPoint` from a point's kept Legendre values (`legendrePoint`, at `o` of `A`): the same sums. */
export function momentsKept(T: MomentTables, A: Float64Array, o: number, w: number, top: number) {
  const { m, mom } = T, n1 = top + 1, oy = o + n1, oz = oy + n1;
  for (let r = 0; r <= top; r++) {
    const wr = w * A[o + r];
    for (let t = 0, tm = top - r; t <= tm; t++) {
      const wrs = wr * A[oy + t], row = (r * m + t) * m;
      for (let u = 0, um = tm - t; u <= um; u++) mom[row + u] += wrs * A[oz + u];
    }
  }
}

/** S (nb × nb, row-major, both triangles) += Σ w N_a N_b over the points whose moments (to degree 2 · the element's) are held. */
export function massFromMoments(T: MomentTables, S: Float64Array, nb: number) {
  const { massAt, mmi, mco, mom } = T;
  for (let a = 0, k = 0; a < nb; a++) {
    for (let b = 0; b <= a; b++, k++) {
      let v = 0;
      for (let t = massAt[k], t1 = massAt[k + 1]; t < t1; t++) v += mco[t] * mom[mmi[t]];
      S[a * nb + b] += v;
      if (b !== a) S[b * nb + a] += v;
    }
  }
}

/** The degree whose basis has nb functions. */
export function degreeOf(nb: number): number {
  for (let p = 0; p < 12; p++) if ((p + 1) * (p + 2) * (p + 3) === 6 * nb) return p;
  throw new Error("not a basis size: " + nb);
}
