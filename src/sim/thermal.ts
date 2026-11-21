// Thermal analysis (FRS-thermal TH2, FR-TSOL-001..): steady heat conduction on the structural solver's cells.
// One unknown per basis function (temperature, °C). Units: mm, W, K; conductivity W/(mm·K), film
// coefficient W/(mm²·K), flux W/mm². The same cut cells, hierarchical basis and interior-penalty coupling as
// `static.ts`; a fixed temperature is held by Nitsche terms, convection is a Robin term, radiation is
// linearised about the last temperatures and solved again until it settles.
// Pure: runs in the solver worker and in node tests. Work is split into small functions on purpose (a single
// large solve function is not optimised by the browser's compiler, see `measurePenalty` in static.ts).

import { Basis, basisSize } from "./basis";
import { BlockMatrix, Envelope } from "./sparse";
import { pcgSolver } from "./pcg";
import { makeGrid, refit, memoryBytes, type Grid } from "./grid";
import { facePoints, fitFacePoints, gridTrianglePoints, type Inside, type Points } from "./quad";
import { DIRECT_LIMIT, MEMORY_LIMIT, memoryMb, topEigen, triArea, triNormals } from "./static";

/** Stefan–Boltzmann constant, W/(mm²·K⁴). */
export const SIGMA = 5.670374419e-14;
export const KELVIN = 273.15;

/** A surface condition that takes heat away (or brings it): what the faces see. */
export interface ThermalSink {
  tris: ArrayLike<number>;
  /** Fixed temperature, °C. */
  temp?: number;
  /** Convection: film coefficient, W/(mm²·K), to air at `ambient` °C. */
  h?: number;
  /** Radiation: emissivity 0..1 to surroundings at `ambient` °C. */
  emissivity?: number;
  ambient?: number;
}

export interface ThermalSource {
  /** Faces the heat enters through; none = spread over the whole body's volume. */
  tris?: ArrayLike<number>;
  /** Total power, W (over the faces or the volume). */
  power?: number;
  /** Heat flux into the body, W/mm² (faces only). */
  flux?: number;
}

export interface ThermalProblem {
  lo: number[];
  hi: number[];
  inside: Inside;
  h: number;
  p: number;
  /** Conductivity, W/(mm·K). */
  k: number;
  sinks: ThermalSink[];
  sources: ThermalSource[];
  grid?: Grid;
  depth?: number;
  /** The pass before's coefficients on the same grid (for the error estimate). */
  prev?: Float64Array;
  solver?: "direct" | "pcg";
  tol?: number;
  beta?: number;
  memory?: number;
}

export interface SinkFlow {
  /** Heat leaving through this condition, W (negative = it brings heat in). */
  out: number;
  area: number;
  /** Mean temperature of its faces, °C. */
  mean: number;
}

export interface ThermalSample {
  /** °C */
  temp: Float32Array;
  /** Heat flux −k ∇T, W/mm², 3 each. */
  flux: Float32Array;
  err: Float32Array;
  hit?: Uint8Array;
}

export interface ThermalResult {
  grid: Grid;
  p: number;
  dofs: number;
  memory: number;
  x: Float64Array;
  /** ∫ k |∇T|² dV, W·K. */
  energy: number;
  /** Heat put in by the sources, W, and what each sink takes, in the order given. */
  applied: number;
  flows: SinkFlow[];
  /** Solves it took (more than one with radiation). */
  iterations: number;
  eta: Float64Array;
  prevError: number | null;
  volume: number;
  sample(pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean): ThermalSample;
  temp(x: number, y: number, z: number): number;
}

interface Ctx {
  pb: ThermalProblem;
  grid: Grid;
  p: number;
  nb: number;
  nel: number;
  k: number;
  bas: Basis;
  bas2: Basis;
  gam: Float64Array;
  fitted: Map<number, Points>;
}

/** Boundary points of some triangles with the element each lies in: e, x, y, z, w, nx, ny, nz per point. */
function located(c: Ctx, tris: ArrayLike<number>, q: number): Float64Array {
  const g = c.grid, { pts, tri } = gridTrianglePoints(tris, g.lo, g.h, q), nrms = triNormals(tris), eps = 1e-7 * g.h;
  const out = new Float64Array(8 * pts.n);
  let n = 0;
  for (let i = 0; i < pts.n; i++) {
    const o = 4 * i, t = tri[i], nx = nrms[3 * t], ny = nrms[3 * t + 1], nz = nrms[3 * t + 2];
    const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
    // nudged inwards so a point on a cell face lands in the cell the body is on
    const cl = g.cellOf(x - eps * nx, y - eps * ny, z - eps * nz);
    if (cl < 0) continue;
    out.set([g.cells[cl].el, x, y, z, pts.a[o + 3], nx, ny, nz], 8 * n++);
  }
  return out.subarray(0, 8 * n);
}

function facePts(c: Ctx, ca: number, axis: number): Points {
  const g = c.grid, A0 = g.cells[ca], key = ca * 3 + axis, had = c.fitted.get(key);
  if (had) return had;
  let pts = g.faces.get(key);
  if (pts === undefined) {
    pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 5, c.pb.inside, c.pb.depth ?? 3);
    const area = g.h * g.h;
    g.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    pts = g.faces.get(key);
  }
  const out = pts ? fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, 2 * c.p + 1) : facePoints(axis, A0.hi[axis], A0.lo, A0.hi, c.p + 1, () => true, 0);
  c.fitted.set(key, out);
  return out;
}

/** Conduction inside the elements: K += k w ∇N_a · ∇N_b. */
function volumeTerms(c: Ctx, A: BlockMatrix) {
  const { grid, nb, bas, k } = c;
  for (let e = 0; e < c.nel; e++) {
    const E = grid.elems[e], K = A.block(e, e);
    for (const ci of E.cells) {
      const P = grid.cells[ci].pts;
      for (let q = 0; q < P.n; q++) {
        const o = 4 * q, w = k * P.a[o + 3];
        bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s);
        const g = bas.g;
        for (let a = 0; a < nb; a++) {
          const ax = g[3 * a] * w, ay = g[3 * a + 1] * w, az = g[3 * a + 2] * w, r = a * nb;
          for (let b = 0; b < nb; b++) K[r + b] += ax * g[3 * b] + ay * g[3 * b + 1] + az * g[3 * b + 2];
        }
      }
    }
  }
}

/**
 * The penalty the cut elements need: γ = 2 λmax(T, K) with T = ∫ (k ∂N/∂n)² over the element's interior faces
 * and its fixed-temperature faces, K its conduction matrix; never under the formula's value.
 */
function measure(c: Ctx, A: BlockMatrix, held: Float64Array[]) {
  const { grid, nb, nel, bas, k, gam } = c;
  const cut = new Uint8Array(nel);
  let any = false;
  for (let e = 0; e < nel; e++) if (grid.elems[e].cells.some(ci => grid.cells[ci].frac < 1 - 1e-9)) { cut[e] = 1; any = true; }
  if (!any) return;
  const TT: (Float64Array | undefined)[] = new Array(nel), M = new Float64Array(nb);
  const at = (e: number, x: number, y: number, z: number, w: number, nx: number, ny: number, nz: number) => {
    const E = grid.elems[e], T = TT[e] ?? (TT[e] = new Float64Array(nb * nb));
    bas.eval(x, y, z, E.c, E.s);
    for (let a = 0; a < nb; a++) M[a] = k * (bas.g[3 * a] * nx + bas.g[3 * a + 1] * ny + bas.g[3 * a + 2] * nz);
    for (let a = 0; a < nb; a++) { const s = w * M[a], r = a * nb; for (let b = 0; b < nb; b++) T[r + b] += s * M[b]; }
  };
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [i, j, kk] = grid.cells[ci].ijk, ea = grid.cells[ci].el;
    for (let axis = 0; axis < 3; axis++) {
      const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), kk + (axis === 2 ? 1 : 0));
      if (o < 0) continue;
      const eb = grid.cells[o].el;
      if (ea === eb || !(cut[ea] || cut[eb])) continue;
      const pts = facePts(c, ci, axis), n = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
      for (let q = 0; q < pts.n; q++) {
        const o4 = 4 * q;
        if (cut[ea]) at(ea, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], n[0], n[1], n[2]);
        if (cut[eb]) at(eb, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], n[0], n[1], n[2]);
      }
    }
  }
  for (const L of held) for (let o = 0; o < L.length; o += 8) if (cut[L[o]]) at(L[o], L[o + 1], L[o + 2], L[o + 3], L[o + 4], L[o + 5], L[o + 6], L[o + 7]);
  for (let e = 0; e < nel; e++) {
    const T = TT[e];
    if (!T) continue;
    const need = Math.min(40 * gam[e], 1.15 * 2 * topEigen(T, A.block(e, e), nb));
    if (need > gam[e]) gam[e] = need;
  }
}

/** Elements joined across the faces between their cells: −½ [N]{k ∂N/∂n} − ½ {k ∂N/∂n}[N] + γ [N][N]. */
function faceTerms(c: Ctx, A: BlockMatrix) {
  const { grid, nb, bas, bas2, k, gam } = c;
  const MA = new Float64Array(nb), MB = new Float64Array(nb);
  const pair = (K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, Nj: Float64Array, Mj: Float64Array, sj: number, w: number, gamma: number) => {
    const hw = 0.5 * w, gw = gamma * w * si * sj;
    for (let a = 0; a < nb; a++) {
      const na = Ni[a] * si * hw, ma = Mi[a] * sj * hw, ga = gw * Ni[a], r = a * nb;
      for (let b = 0; b < nb; b++) K[r + b] += -na * Mj[b] - ma * Nj[b] + ga * Nj[b];
    }
  };
  for (let ci = 0; ci < grid.cells.length; ci++) {
    const [i, j, kk] = grid.cells[ci].ijk, ea = grid.cells[ci].el;
    for (let axis = 0; axis < 3; axis++) {
      const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), kk + (axis === 2 ? 1 : 0));
      if (o < 0) continue;
      const eb = grid.cells[o].el;
      if (ea === eb) continue;
      const EA = grid.elems[ea], EB = grid.elems[eb], pts = facePts(c, ci, axis), gamma = Math.max(gam[ea], gam[eb]);
      const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
      for (let q = 0; q < pts.n; q++) {
        const o4 = 4 * q, w = pts.a[o4 + 3], x = pts.a[o4], y = pts.a[o4 + 1], z = pts.a[o4 + 2];
        bas.eval(x, y, z, EA.c, EA.s);
        bas2.eval(x, y, z, EB.c, EB.s);
        for (let b = 0; b < nb; b++) { MA[b] = k * bas.g[3 * b + axis]; MB[b] = k * bas2.g[3 * b + axis]; }
        pair(Kaa, bas.v, MA, 1, bas.v, MA, 1, w, gamma);
        pair(Kab, bas.v, MA, 1, bas2.v, MB, -1, w, gamma);
        pair(Kba, bas2.v, MB, -1, bas.v, MA, 1, w, gamma);
        pair(Kbb, bas2.v, MB, -1, bas2.v, MB, -1, w, gamma);
      }
    }
  }
}

/** A fixed temperature g on boundary points (Nitsche): K += −N_a M_b − M_a N_b + 2γ N_a N_b, f += (−M_a + 2γ N_a) g. */
function heldTerms(c: Ctx, A: BlockMatrix, f: Float64Array, L: Float64Array, g: number) {
  const { grid, nb, bas, k, gam } = c, M = new Float64Array(nb);
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4], K = A.block(e, e), g2 = 2 * gam[e], fo = e * nb;
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    for (let a = 0; a < nb; a++) M[a] = k * (bas.g[3 * a] * L[o + 5] + bas.g[3 * a + 1] * L[o + 6] + bas.g[3 * a + 2] * L[o + 7]);
    for (let a = 0; a < nb; a++) {
      const na = bas.v[a], r = a * nb;
      f[fo + a] += w * (g2 * na - M[a]) * g;
      for (let b = 0; b < nb; b++) K[r + b] += w * (-na * M[b] - M[a] * bas.v[b] + g2 * na * bas.v[b]);
    }
  }
}

/**
 * A film on boundary points: K += h w N_a N_b, f += h w T∞ N_a. `rad` > 0 makes it radiation of that emissivity,
 * linearised about the temperatures `x` (°C): q = εσ(T⁴ − Ts⁴) ≈ q(T₀) + 4εσT₀³ (T − T₀).
 */
function filmTerms(c: Ctx, A: BlockMatrix, f: Float64Array, L: Float64Array, h: number, amb: number, rad: number, x: Float64Array | null) {
  const { grid, nb, bas } = c;
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4], K = A.block(e, e), fo = e * nb;
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    let hh = h, rhs = h * amb;
    if (rad > 0) {
      let t0 = amb;
      if (x) { t0 = 0; for (let a = 0; a < nb; a++) t0 += bas.v[a] * x[fo + a]; }
      const T0 = Math.max(1, t0 + KELVIN), Ts = amb + KELVIN, es = rad * SIGMA;
      hh = 4 * es * T0 ** 3;
      rhs = hh * t0 - es * (T0 ** 4 - Ts ** 4);
    }
    for (let a = 0; a < nb; a++) {
      const na = w * bas.v[a], r = a * nb;
      f[fo + a] += na * rhs;
      for (let b = 0; b < nb; b++) K[r + b] += hh * na * bas.v[b];
    }
  }
}

function copyMatrix(A: BlockMatrix): BlockMatrix {
  const B = new BlockMatrix(A.nel, A.ms);
  for (const [key, blk] of A.blocks) { const a = Math.floor(key / A.nel); B.block(a, key - a * A.nel).set(blk); }
  return B;
}

function solveSystem(c: Ctx, A: BlockMatrix, f: Float64Array, x0: Float64Array | null): Float64Array {
  const pb = c.pb, useCg = pb.solver === "pcg" || (pb.solver !== "direct" && A.size > DIRECT_LIMIT);
  if (useCg) return pcgSolver(A, { coarse: basisSize(1), tol: pb.tol ?? 1e-9 }).solve(f, x0 ?? undefined).x;
  return new Envelope(A).solve(f);
}

/** ∫ k |∇T|² and, with the pass before, the same of what this pass changed per element. */
function energies(c: Ctx, x: Float64Array, prev: Float64Array | null) {
  const { grid, nb, nel, bas, k } = c, eta = new Float64Array(nel), pm = prev ? prev.length / nel : 0;
  let energy = 0;
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e];
    for (const ci of E.cells) {
      const Q = grid.cells[ci].pts;
      for (let q = 0; q < Q.n; q++) {
        const o = 4 * q, w = k * Q.a[o + 3];
        bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
        let gx = 0, gy = 0, gz = 0, hx = 0, hy = 0, hz = 0;
        for (let a = 0; a < nb; a++) {
          const v = x[e * nb + a], dv = prev ? v - (a < pm ? prev[e * pm + a] : 0) : 0;
          gx += v * bas.g[3 * a]; gy += v * bas.g[3 * a + 1]; gz += v * bas.g[3 * a + 2];
          hx += dv * bas.g[3 * a]; hy += dv * bas.g[3 * a + 1]; hz += dv * bas.g[3 * a + 2];
        }
        energy += w * (gx * gx + gy * gy + gz * gz);
        eta[e] += w * (hx * hx + hy * hy + hz * hz);
      }
    }
  }
  return { energy, eta };
}

/** What a sink takes, W: the flux the terms above carry through its points. */
function flowOf(c: Ctx, s: ThermalSink, L: Float64Array, x: Float64Array): SinkFlow {
  const { grid, nb, bas, k, gam } = c;
  let out = 0, area = 0, sum = 0;
  for (let o = 0; o < L.length; o += 8) {
    const e = L[o], E = grid.elems[e], w = L[o + 4];
    bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
    let t = 0, dn = 0;
    for (let a = 0; a < nb; a++) {
      const v = x[e * nb + a];
      t += v * bas.v[a];
      dn += v * (bas.g[3 * a] * L[o + 5] + bas.g[3 * a + 1] * L[o + 6] + bas.g[3 * a + 2] * L[o + 7]);
    }
    area += w; sum += w * t;
    if (s.temp !== undefined) out += w * (-k * dn + 2 * gam[e] * (t - s.temp));
    if (s.temp === undefined && s.emissivity) out += w * s.emissivity * SIGMA * ((t + KELVIN) ** 4 - ((s.ambient ?? 0) + KELVIN) ** 4);
    if (s.temp === undefined) out += w * (s.h ?? 0) * (t - (s.ambient ?? 0));
  }
  return { out, area, mean: area > 0 ? sum / area : 0 };
}

export const thermalMemory = (grid: Grid, p: number) => memoryBytes(grid, () => basisSize(p));

/** Most solves of a problem with radiation. */
const RAD_STEPS = 40;

export function solveThermal(pb: ThermalProblem): ThermalResult {
  const p = pb.p;
  if (!(pb.k > 0)) throw new Error("E-TH-NOK");
  if (!pb.sinks.length) throw new Error("E-TH-NOSINK");
  let grid = pb.grid;
  if (grid) refit(grid, p + 1, 2 * p + 1);
  else grid = makeGrid(pb.lo, pb.hi, pb.h, pb.inside, { q: p + 1, depth: pb.depth ?? 3, fit: 2 * p + 1 });
  const nb = basisSize(p), nel = grid.elems.length;
  const memory = thermalMemory(grid, p);
  if (memory > (pb.memory ?? MEMORY_LIMIT)) throw new Error(`E-SIM-MEMORY: ${memoryMb(memory)}`);
  const c: Ctx = { pb, grid, p, nb, nel, k: pb.k, bas: new Basis(p), bas2: new Basis(p), gam: new Float64Array(nel), fitted: new Map() };
  for (let e = 0; e < nel; e++) {
    let fr = 0;
    for (const ci of grid.elems[e].cells) fr = Math.max(fr, grid.cells[ci].frac);
    c.gam[e] = ((pb.beta ?? 3) * pb.k) / grid.h * (p + 1) ** 2 / Math.min(1, Math.max(0.2, fr));
  }
  const tq = Math.max(2, p + 1);
  const A = new BlockMatrix(nel, nb), f = new Float64Array(A.size);
  volumeTerms(c, A);
  const at = pb.sinks.map(s => located(c, s.tris, tq));
  measure(c, A, at.filter((_L, i) => pb.sinks[i].temp !== undefined));
  faceTerms(c, A);
  pb.sinks.forEach((s, i) => {
    if (s.temp !== undefined) heldTerms(c, A, f, at[i], s.temp);
    else if ((s.h ?? 0) > 0) filmTerms(c, A, f, at[i], s.h!, s.ambient ?? 0, 0, null);
  });
  // sources
  let applied = 0, volume = 0;
  for (const cl of grid.cells) volume += cl.pts.weight();
  for (const s of pb.sources) {
    if (s.tris) {
      const area = triArea(s.tris), q = s.flux !== undefined ? s.flux : area > 0 ? (s.power ?? 0) / area : 0;
      const L = located(c, s.tris, tq);
      for (let o = 0; o < L.length; o += 8) {
        const e = L[o], E = grid.elems[e], w = q * L[o + 4];
        c.bas.eval(L[o + 1], L[o + 2], L[o + 3], E.c, E.s);
        for (let a = 0; a < nb; a++) f[e * nb + a] += w * c.bas.v[a];
        applied += w;
      }
    } else if (s.power && volume > 0) {
      const q = s.power / volume;
      for (let e = 0; e < nel; e++) {
        const E = grid.elems[e];
        for (const ci of E.cells) {
          const P = grid.cells[ci].pts;
          for (let i = 0; i < P.n; i++) {
            const o = 4 * i, w = q * P.a[o + 3];
            c.bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s);
            for (let a = 0; a < nb; a++) f[e * nb + a] += w * c.bas.v[a];
          }
        }
      }
      applied += s.power;
    }
  }
  const rads = pb.sinks.map((s, i) => ((s.emissivity ?? 0) > 0 && s.temp === undefined ? i : -1)).filter(i => i >= 0);
  let x: Float64Array, iterations = 1;
  if (!rads.length) x = solveSystem(c, A, f, null);
  else {
    // radiation: linearised about the last answer and solved again until the temperatures stop moving
    let last: Float64Array | null = null;
    x = f;
    for (let it = 0; it < RAD_STEPS; it++) {
      const B = copyMatrix(A), g = Float64Array.from(f);
      for (const i of rads) {
        const s = pb.sinks[i];
        filmTerms(c, B, g, at[i], 0, s.ambient ?? 0, s.emissivity!, last);
      }
      x = solveSystem(c, B, g, last);
      iterations = it + 1;
      let d = 0, top = 0;
      if (last) for (let e = 0; e < nel; e++) { d = Math.max(d, Math.abs(x[e * nb] - last[e * nb])); top = Math.max(top, Math.abs(x[e * nb])); }
      const settled = !!last && d <= 1e-4 * Math.max(1, top);
      last = x;
      if (settled) break;
    }
  }
  const prev = pb.prev && pb.prev.length % nel === 0 ? pb.prev : null;
  const { energy, eta } = energies(c, x, prev);
  let etaSum = 0;
  for (let e = 0; e < nel; e++) etaSum += eta[e];
  const prevError = !prev ? null : energy > 0 ? 100 * Math.sqrt(etaSum / energy) : 0;
  const local = new Float32Array(nel);
  for (let e = 0; e < nel; e++) local[e] = prev && energy > 0 ? 100 * Math.sqrt((eta[e] * nel) / energy) : 0;
  const flows = pb.sinks.map((s, i) => flowOf(c, s, at[i], x));
  const g0 = grid, bas = c.bas, k = pb.k;
  const elAt = (px: number, py: number, pz: number) => {
    const cl = g0.cellOf(px, py, pz);
    if (cl < 0) return -1;
    const e = g0.cells[cl].el, E = g0.elems[e];
    bas.eval(px, py, pz, E.c, E.s);
    return e;
  };
  return {
    grid, p, dofs: A.size, memory, x, energy, applied, flows, iterations, eta, prevError, volume,
    sample(pos, nrm, hits) {
      const n = pos.length / 3, temp = new Float32Array(n), flux = new Float32Array(3 * n), err = new Float32Array(n);
      const hit = hits ? new Uint8Array(n) : undefined, eps = 1e-6 * g0.h;
      for (let i = 0; i < n; i++) {
        let px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
        if (nrm) { px -= eps * nrm[3 * i]; py -= eps * nrm[3 * i + 1]; pz -= eps * nrm[3 * i + 2]; }
        if (hit && (px < g0.lo[0] - eps || py < g0.lo[1] - eps || pz < g0.lo[2] - eps || px > g0.lo[0] + g0.n[0] * g0.h + eps || py > g0.lo[1] + g0.n[1] * g0.h + eps || pz > g0.lo[2] + g0.n[2] * g0.h + eps)) continue;
        const e = elAt(px, py, pz);
        if (e < 0) continue;
        if (hit) hit[i] = 1;
        let t = 0, gx = 0, gy = 0, gz = 0;
        for (let a = 0; a < nb; a++) { const v = x[e * nb + a]; t += v * bas.v[a]; gx += v * bas.g[3 * a]; gy += v * bas.g[3 * a + 1]; gz += v * bas.g[3 * a + 2]; }
        temp[i] = t; flux[3 * i] = -k * gx; flux[3 * i + 1] = -k * gy; flux[3 * i + 2] = -k * gz; err[i] = local[e];
      }
      return { temp, flux, err, ...(hit ? { hit } : {}) };
    },
    temp(px, py, pz) {
      const e = elAt(px, py, pz);
      if (e < 0) return NaN;
      let t = 0;
      for (let a = 0; a < nb; a++) t += x[e * nb + a] * bas.v[a];
      return t;
    },
  };
}
