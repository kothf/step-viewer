// Structural analysis (FR-SOL-001, FR-SARC-011..013): linear static solve of one body.
// Each element (an aggregated group of cells) carries a complete polynomial of degree p per displacement
// component. Elements are joined by the symmetric interior penalty method, fixed supports are imposed
// weakly (Nitsche) on boundary triangles, loads are tractions on boundary triangles.
// Units: mm, N, MPa (so E in MPa, density in t/mm³).

import { Basis, basisSize } from "./basis";
import { gridTrianglePoints, facePoints, fitFacePoints, type Inside } from "./quad";
import { makeGrid, refit, type Grid } from "./grid";
import { BlockMatrix, Envelope } from "./sparse";
import { pcg } from "./pcg";

export interface Material {
  /** Young's modulus, MPa. */
  E: number;
  nu: number;
  /** Density, t/mm³ (g/cm³ × 1e-9); needed for gravity. */
  rho?: number;
}

export interface Support {
  /** Triangles (9 numbers each) of the supported faces. */
  tris: ArrayLike<number>;
  /**
   * What is held (default fixed): `fixed` every direction, `sliding` only along the face normal,
   * `hinge` the normal and the `axis` direction (a pin in a bore; `axialFree` leaves the axis free),
   * `dirs` the ticked world directions.
   */
  mode?: "fixed" | "sliding" | "hinge" | "dirs";
  axis?: ArrayLike<number>;
  axialFree?: boolean;
  dirs?: [boolean, boolean, boolean];
}

export interface Load {
  tris: ArrayLike<number>;
  /** Total force, N, shared over the faces by area (uniform traction). */
  force?: ArrayLike<number>;
  /** Pressure, MPa, pushing against the outward normal of each triangle. */
  pressure?: number;
  /** Total moment, N·mm, about the faces' centroid, as a traction growing linearly from it. */
  moment?: ArrayLike<number>;
}

export interface Reaction {
  /** Force of the support on the body, N. */
  force: [number, number, number];
  /** Its moment about the origin, N·mm. */
  moment: [number, number, number];
}

export interface StaticProblem {
  lo: number[];
  hi: number[];
  inside: Inside;
  /** Cell size, mm. */
  h: number;
  /** Polynomial degree 1..4. */
  p: number;
  mat: Material;
  fixed: Support[];
  loads: Load[];
  /** Gravity, mm/s² (needs `mat.rho`). */
  gravity?: ArrayLike<number>;
  /** Cells of an earlier pass on the same body and cell size: reused, only refitted for p. */
  grid?: Grid;
  /** Octree depth of the quadrature in cut cells (default 3). */
  depth?: number;
  /** "direct" (envelope Cholesky), "pcg" (p-multigrid CG); default: direct up to DIRECT_LIMIT unknowns. */
  solver?: "direct" | "pcg";
  /** PCG relative residual (default 1e-8). */
  tol?: number;
  /** Penalty factor (default 3). */
  beta?: number;
  /** The coefficients of the pass before on the same `grid` (a lower degree), for the error estimate. */
  prev?: Float64Array;
}

export interface StaticResult {
  grid: Grid;
  p: number;
  dofs: number;
  /** Coefficients per element: element e, basis b, component c at (e·n + b)·3 + c. */
  x: Float64Array;
  /** PCG iterations (0 for the direct solver). */
  iterations: number;
  /** Strain energy, N·mm (half of f·x). */
  energy: number;
  ms: { grid: number; assemble: number; /** factor or PCG set-up */ factor: number; solve: number };
  /** Per support, in the order given. */
  reactions: Reaction[];
  /** Sum of the applied loads: force, N, and moment about the origin, N·mm. */
  applied: Reaction;
  /**
   * With `prev`: per element, the strain energy (N·mm) of the difference from the pass before, which is the
   * energy-norm error of that pass seen from this one. Zeros without `prev`.
   */
  eta: Float64Array;
  /** The pass before's error for the whole body, % in the energy norm: 100 · √(Σ eta / strain energy); null without `prev`. */
  prevError: number | null;
  /** Displacement (3 per point, mm), von Mises stress (MPa) and the local share of `eta` (%, the body's
   * error were every element like the one the point is in) at points; `nrm` = outward normals, so a point on
   * the surface is read from the cell the material is in. */
  sample(pos: ArrayLike<number>, nrm?: ArrayLike<number>): { u: Float32Array; vm: Float32Array; err: Float32Array };
  /** Displacement at a point, mm. */
  disp(x: number, y: number, z: number): [number, number, number];
  /** Stress at a point [xx, yy, zz, xy, yz, zx], MPa. */
  stress(x: number, y: number, z: number): number[];
}

/** Unknowns up to which the direct solver is used. */
export const DIRECT_LIMIT = 6000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function lame(m: Material) {
  const lam = (m.E * m.nu) / ((1 + m.nu) * (1 - 2 * m.nu));
  const mu = m.E / (2 * (1 + m.nu));
  return { lam, mu };
}

export function vonMises(s: number[]) {
  const [xx, yy, zz, xy, yz, zx] = s;
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy * xy + yz * yz + zx * zx));
}

/** M[ci][cj] = traction component ci of basis gradient g with displacement along cj, normal n. */
function traction(g: Float64Array, o: number, n: ArrayLike<number>, lam: number, mu: number, M: Float64Array, mo: number) {
  const gx = g[o], gy = g[o + 1], gz = g[o + 2];
  const gn = gx * n[0] + gy * n[1] + gz * n[2];
  const G = [gx, gy, gz];
  for (let ci = 0; ci < 3; ci++) for (let cj = 0; cj < 3; cj++)
    M[mo + ci * 3 + cj] = lam * G[cj] * n[ci] + (ci === cj ? mu * gn : 0) + mu * n[cj] * G[ci];
}

export function solveStatic(pb: StaticProblem): StaticResult {
  const t0 = now();
  const p = pb.p, q = p + 1, fq = 2 * p + 1;
  let grid = pb.grid;
  if (grid) refit(grid, q, 2 * p + 1);
  else grid = makeGrid(pb.lo, pb.hi, pb.h, pb.inside, { q, depth: pb.depth ?? 3, fit: 2 * p + 1 });
  const t1 = now();
  const { lam, mu } = lame(pb.mat);
  const bas = new Basis(p), bas2 = new Basis(p);
  const nb = bas.n, m = 3 * nb, nel = grid.elems.length;
  const A = new BlockMatrix(nel, m);
  const f = new Float64Array(nel * m);
  const gamma0 = (pb.beta ?? 3) * (lam + 2 * mu) * (p + 1) * (p + 1) / grid.h;
  // an element that is partly outside the body carries its polynomial on less material, so its tractions are
  // larger beside its energy: the penalty grows by the share that is missing (cells under 25 % are aggregated)
  const gam = new Float64Array(nel);
  for (let e = 0; e < nel; e++) {
    let fr = 0;
    for (const c of grid.elems[e].cells) fr = Math.max(fr, grid.cells[c].frac);
    gam[e] = gamma0 / Math.min(1, Math.max(0.2, fr));
  }
  let gamma = gamma0;
  const el = (c: number) => grid.elems[grid.cells[c].el];

  // volume terms
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e];
    const K = A.block(e, e);
    for (const ci of E.cells) {
      const P = grid.cells[ci].pts;
      for (let k = 0; k < P.n; k++) {
        const o = 4 * k, w = P.a[o + 3];
        bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], E.c, E.s);
        const g = bas.g;
        for (let a = 0; a < nb; a++) {
          const ax = g[3 * a] * w, ay = g[3 * a + 1] * w, az = g[3 * a + 2] * w;
          for (let b = 0; b < nb; b++) {
            const bx = g[3 * b], by = g[3 * b + 1], bz = g[3 * b + 2];
            const md = mu * (ax * bx + ay * by + az * bz);
            // K[(a,c),(b,d)] = λ ga_c gb_d + μ ga_d gb_c + δ_cd μ ga·gb
            let r = 3 * a * m + 3 * b;
            K[r] += (lam + mu) * ax * bx + md; K[r + 1] += lam * ax * by + mu * ay * bx; K[r + 2] += lam * ax * bz + mu * az * bx;
            r += m;
            K[r] += lam * ay * bx + mu * ax * by; K[r + 1] += (lam + mu) * ay * by + md; K[r + 2] += lam * ay * bz + mu * az * by;
            r += m;
            K[r] += lam * az * bx + mu * ax * bz; K[r + 1] += lam * az * by + mu * ay * bz; K[r + 2] += (lam + mu) * az * bz + md;
          }
        }
      }
    }
  }

  // interior faces between cells of different elements
  const MA = new Float64Array(9 * nb), MB = new Float64Array(9 * nb);
  const face = (ca: number, cb: number, axis: number) => {
    const A0 = grid.cells[ca], ea = A0.el, eb = grid.cells[cb].el;
    if (ea === eb) return;
    const EA = grid.elems[ea], EB = grid.elems[eb];
    // fine points of a cut face are kept on the grid for later passes
    const key = ca * 3 + axis;
    let pts = grid!.faces.get(key);
    if (pts === undefined) {
      pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 5, pb.inside, pb.depth ?? 3);
      // a whole face keeps no points: it gets the plain Gauss rule of each pass
      const area = grid!.h * grid!.h;
      grid!.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    }
    if (!pts) pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, q, () => true, 0);
    else pts = fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, fq);
    const nrm = [0, 0, 0];
    nrm[axis] = 1;
    const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
    gamma = Math.max(gam[ea], gam[eb]);
    for (let k = 0; k < pts.n; k++) {
      const o = 4 * k, w = pts.a[o + 3];
      const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
      bas.eval(x, y, z, EA.c, EA.s);
      bas2.eval(x, y, z, EB.c, EB.s);
      for (let b = 0; b < nb; b++) { traction(bas.g, 3 * b, nrm, lam, mu, MA, 9 * b); traction(bas2.g, 3 * b, nrm, lam, mu, MB, 9 * b); }
      pair(Kaa, bas.v, MA, 1, bas.v, MA, 1, w);
      pair(Kab, bas.v, MA, 1, bas2.v, MB, -1, w);
      pair(Kba, bas2.v, MB, -1, bas.v, MA, 1, w);
      pair(Kbb, bas2.v, MB, -1, bas2.v, MB, -1, w);
    }
  };
  // block (rows i, cols j): −½ s_i N_i M_j − ½ s_j N_j M_iᵀ + γ s_i s_j N_i N_j I
  function pair(K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, Nj: Float64Array, Mj: Float64Array, sj: number, w: number) {
    const hw = 0.5 * w, gw = gamma * w * si * sj;
    for (let a = 0; a < nb; a++) {
      const na = Ni[a] * si * hw;
      for (let b = 0; b < nb; b++) {
        const nbv = Nj[b] * sj * hw, pen = gw * Ni[a] * Nj[b];
        for (let c = 0; c < 3; c++) {
          const row = (3 * a + c) * m + 3 * b;
          for (let d = 0; d < 3; d++)
            K[row + d] += -na * Mj[9 * b + c * 3 + d] - nbv * Mi[9 * a + d * 3 + c] + (c === d ? pen : 0);
        }
      }
    }
  }
  for (let c = 0; c < grid.cells.length; c++) {
    const [i, j, k] = grid.cells[c].ijk;
    const nx = grid.at(i + 1, j, k), ny = grid.at(i, j + 1, k), nz = grid.at(i, j, k + 1);
    if (nx >= 0) face(c, nx, 0);
    if (ny >= 0) face(c, ny, 1);
    if (nz >= 0) face(c, nz, 2);
  }

  // boundary quadrature located in cells
  const tq = Math.max(2, p + 1);
  const located = (tris: ArrayLike<number>, fn: (e: number, x: number, y: number, z: number, w: number, nrm: number[]) => void) => {
    const { pts, tri } = gridTrianglePoints(tris, grid.lo, grid.h, tq);
    const nrms = triNormals(tris);
    for (let k = 0; k < pts.n; k++) {
      const o = 4 * k, t = tri[k];
      const nrm = [nrms[3 * t], nrms[3 * t + 1], nrms[3 * t + 2]];
      const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
      // nudge inwards so a point on a cell face lands in the cell the body is on
      const eps = 1e-7 * grid.h;
      const c = grid.cellOf(x - eps * nrm[0], y - eps * nrm[1], z - eps * nrm[2]);
      if (c < 0) continue;
      fn(grid.cells[c].el, x, y, z, pts.a[o + 3], nrm);
    }
  };
  // Nitsche for P u = 0 (P projects on the held directions): −N_a (P M_b) − N_b (P M_a)ᵀ + 2γ N_a N_b P
  const free = freeModes(pb.fixed, pb.lo, pb.hi);
  if (free > 0) throw new Error(`E-SIM-FREE: ${free}`);
  const P = new Float64Array(9), PM = new Float64Array(9 * nb);
  for (const s of pb.fixed) located(s.tris, (e, x, y, z, w, nrm) => {
    const E = grid.elems[e];
    bas.eval(x, y, z, E.c, E.s);
    for (let b = 0; b < nb; b++) traction(bas.g, 3 * b, nrm, lam, mu, MA, 9 * b);
    holdMatrix(s, nrm, P);
    for (let b = 0; b < nb; b++) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++)
      PM[9 * b + 3 * c + d] = P[3 * c] * MA[9 * b + d] + P[3 * c + 1] * MA[9 * b + 3 + d] + P[3 * c + 2] * MA[9 * b + 6 + d];
    const K = A.block(e, e), v = bas.v;
    const gw = 2 * gam[e] * w;
    for (let a = 0; a < nb; a++) for (let b = 0; b < nb; b++) {
      const pen = gw * v[a] * v[b];
      for (let c = 0; c < 3; c++) {
        const row = (3 * a + c) * m + 3 * b;
        for (let d = 0; d < 3; d++)
          K[row + d] += -w * (v[a] * PM[9 * b + 3 * c + d] + v[b] * PM[9 * a + 3 * d + c]) + pen * P[3 * c + d];
      }
    }
  });
  const applied: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
  const add = (R: Reaction, x: number, y: number, z: number, fx: number, fy: number, fz: number) => {
    R.force[0] += fx; R.force[1] += fy; R.force[2] += fz;
    R.moment[0] += y * fz - z * fy; R.moment[1] += z * fx - x * fz; R.moment[2] += x * fy - y * fx;
  };
  for (const L of pb.loads) {
    const area = triArea(L.tris);
    if (!(area > 0)) continue;
    const t0 = Array.from(L.force ?? [0, 0, 0]).map(v => v / area), pr = L.pressure ?? 0;
    const mo = L.moment ? momentField(L.tris, L.moment) : null;
    const t = [0, 0, 0];
    located(L.tris, (e, x, y, z, w, nrm) => {
      const E = grid.elems[e];
      bas.eval(x, y, z, E.c, E.s);
      for (let c = 0; c < 3; c++) t[c] = t0[c] - pr * nrm[c];
      if (mo) {
        const rx = x - mo.c[0], ry = y - mo.c[1], rz = z - mo.c[2], o = mo.w;
        t[0] += o[1] * rz - o[2] * ry; t[1] += o[2] * rx - o[0] * rz; t[2] += o[0] * ry - o[1] * rx;
      }
      add(applied, x, y, z, w * t[0], w * t[1], w * t[2]);
      for (let a = 0; a < nb; a++) for (let c = 0; c < 3; c++) f[e * m + 3 * a + c] += w * bas.v[a] * t[c];
    });
  }
  if (pb.gravity && pb.mat.rho) {
    const g = Array.from(pb.gravity).map(v => v * pb.mat.rho!);
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e];
      for (const ci of E.cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) {
          const o = 4 * k, w = Q.a[o + 3];
          bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
          add(applied, Q.a[o], Q.a[o + 1], Q.a[o + 2], w * g[0], w * g[1], w * g[2]);
          for (let a = 0; a < nb; a++) for (let c = 0; c < 3; c++) f[e * m + 3 * a + c] += w * bas.v[a] * g[c];
        }
      }
    }
  }
  // keep elements nothing reaches solvable (no stiffness at all): pin them
  for (let e = 0; e < nel; e++) {
    const K = A.block(e, e);
    for (let i = 0; i < m; i++) if (K[i * m + i] === 0) K[i * m + i] = 1;
  }
  const t2 = now();
  let x: Float64Array, t3: number, iterations = 0;
  const useCg = pb.solver === "pcg" || (pb.solver !== "direct" && p >= 2 && nel * m > DIRECT_LIMIT);
  if (useCg) {
    const r = pcg(A, f, { coarse: 3 * basisSize(1), tol: pb.tol ?? 1e-8 });
    x = r.x; iterations = r.iterations;
    t3 = t2 + r.ms.setup;
  } else {
    const L = new Envelope(A);
    t3 = now();
    x = L.solve(f);
  }
  const t4 = now();
  let energy = 0;
  for (let i = 0; i < f.length; i++) energy += f[i] * x[i];
  energy /= 2;

  // reactions: the Nitsche flux P (σ(u) n − 2γ u) over each support
  const sn = [0, 0, 0], uu = [0, 0, 0];
  const reactions = pb.fixed.map(s => {
    const R: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
    located(s.tris, (e, px, py, pz, w, nrm) => {
      const E = grid.elems[e];
      bas.eval(px, py, pz, E.c, E.s);
      holdMatrix(s, nrm, P);
      sn[0] = sn[1] = sn[2] = uu[0] = uu[1] = uu[2] = 0;
      for (let b = 0; b < nb; b++) {
        traction(bas.g, 3 * b, nrm, lam, mu, MA, 0);
        for (let d = 0; d < 3; d++) {
          const v = x[e * m + 3 * b + d];
          uu[d] += bas.v[b] * v;
          sn[0] += MA[d] * v; sn[1] += MA[3 + d] * v; sn[2] += MA[6 + d] * v;
        }
      }
      for (let c = 0; c < 3; c++) sn[c] -= 2 * gam[e] * uu[c];
      add(R, px, py, pz, w * (P[0] * sn[0] + P[1] * sn[1] + P[2] * sn[2]), w * (P[3] * sn[0] + P[4] * sn[1] + P[5] * sn[2]), w * (P[6] * sn[0] + P[7] * sn[1] + P[8] * sn[2]));
    });
    return R;
  });

  // error estimate: strain energy of what this pass changed, per element, beside the whole strain energy
  const eta = new Float64Array(nel), prev = pb.prev && pb.prev.length % (3 * nel) === 0 ? pb.prev : null, pm = prev ? prev.length / nel : 0;
  let strain = 0;
  {
    const G = new Float64Array(9), H = new Float64Array(9);
    const dens = (g: Float64Array) => {
      const tr = g[0] + g[4] + g[8];
      let s = lam * tr * tr;
      for (let c = 0; c < 3; c++) for (let j = 0; j < 3; j++) { const e2 = 0.5 * (g[c * 3 + j] + g[j * 3 + c]); s += 2 * mu * e2 * e2; }
      return 0.5 * s;
    };
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e];
      for (const ci of E.cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) {
          const o = 4 * k, w = Q.a[o + 3];
          bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
          G.fill(0); H.fill(0);
          for (let a = 0; a < nb; a++) for (let c = 0; c < 3; c++) {
            const v = x[e * m + 3 * a + c];
            const dv = prev ? v - (3 * a + c < pm ? prev[e * pm + 3 * a + c] : 0) : 0;
            for (let j = 0; j < 3; j++) { G[c * 3 + j] += v * bas.g[3 * a + j]; H[c * 3 + j] += dv * bas.g[3 * a + j]; }
          }
          strain += w * dens(G);
          if (prev) eta[e] += w * dens(H);
        }
      }
    }
  }
  let etaSum = 0;
  for (let e = 0; e < nel; e++) etaSum += eta[e];
  const prevError = !prev ? null : strain > 0 ? 100 * Math.sqrt(etaSum / strain) : 0;
  const local = new Float32Array(nel);
  for (let e = 0; e < nel; e++) local[e] = strain > 0 ? 100 * Math.sqrt((eta[e] * nel) / strain) : 0;

  const at = (px: number, py: number, pz: number) => {
    const c = grid.cellOf(px, py, pz);
    if (c < 0) return -1;
    const E = el(c);
    bas.eval(px, py, pz, E.c, E.s);
    return grid.cells[c].el;
  };
  return {
    grid, p, dofs: nel * m, x, energy, iterations,
    ms: { grid: t1 - t0, assemble: t2 - t1, factor: t3 - t2, solve: t4 - t3 },
    reactions, applied, eta, prevError,
    sample(pos, nrm) {
      const n = pos.length / 3, u = new Float32Array(3 * n), vm = new Float32Array(n), err = new Float32Array(n);
      const eps = 1e-6 * grid.h, G = new Float64Array(9);
      for (let i = 0; i < n; i++) {
        let px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
        if (nrm) { px -= eps * nrm[3 * i]; py -= eps * nrm[3 * i + 1]; pz -= eps * nrm[3 * i + 2]; }
        const e = at(px, py, pz);
        if (e < 0) continue;
        err[i] = local[e];
        G.fill(0);
        let ux = 0, uy = 0, uz = 0;
        for (let a = 0; a < nb; a++) {
          const o = e * m + 3 * a, va = bas.v[a];
          ux += va * x[o]; uy += va * x[o + 1]; uz += va * x[o + 2];
          for (let c = 0; c < 3; c++) { const v = x[o + c]; G[c * 3] += v * bas.g[3 * a]; G[c * 3 + 1] += v * bas.g[3 * a + 1]; G[c * 3 + 2] += v * bas.g[3 * a + 2]; }
        }
        u[3 * i] = ux; u[3 * i + 1] = uy; u[3 * i + 2] = uz;
        const tr = G[0] + G[4] + G[8];
        vm[i] = vonMises([lam * tr + 2 * mu * G[0], lam * tr + 2 * mu * G[4], lam * tr + 2 * mu * G[8], mu * (G[1] + G[3]), mu * (G[5] + G[7]), mu * (G[6] + G[2])]);
      }
      return { u, vm, err };
    },
    disp(px, py, pz) {
      const e = at(px, py, pz);
      const u: [number, number, number] = [0, 0, 0];
      if (e < 0) return u;
      for (let a = 0; a < nb; a++) for (let c = 0; c < 3; c++) u[c] += bas.v[a] * x[e * m + 3 * a + c];
      return u;
    },
    stress(px, py, pz) {
      const e = at(px, py, pz);
      if (e < 0) return [0, 0, 0, 0, 0, 0];
      const G = new Float64Array(9); // G[c*3+j] = ∂u_c/∂x_j
      for (let a = 0; a < nb; a++) for (let c = 0; c < 3; c++) {
        const v = x[e * m + 3 * a + c];
        for (let j = 0; j < 3; j++) G[c * 3 + j] += v * bas.g[3 * a + j];
      }
      const tr = G[0] + G[4] + G[8];
      return [
        lam * tr + 2 * mu * G[0], lam * tr + 2 * mu * G[4], lam * tr + 2 * mu * G[8],
        mu * (G[1] + G[3]), mu * (G[5] + G[7]), mu * (G[6] + G[2]),
      ];
    },
  };
}

export function triArea(tris: ArrayLike<number>) {
  let s = 0;
  const n = triNormals(tris, true);
  for (let i = 0; i < n.length; i++) s += n[i];
  return s;
}

/** Unit normals per triangle (or areas when `areas`). */
export function triNormals(tris: ArrayLike<number>, areas = false): Float64Array {
  const nt = tris.length / 9;
  const out = new Float64Array(areas ? nt : 3 * nt);
  for (let t = 0; t < nt; t++) {
    const o = 9 * t;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz);
    if (areas) out[t] = l / 2;
    else if (l > 0) { out[3 * t] = cx / l; out[3 * t + 1] = cy / l; out[3 * t + 2] = cz / l; }
  }
  return out;
}


/** P (row-major 3×3): the projector on the directions a support holds at a point with normal n. */
export function holdMatrix(s: Support, n: ArrayLike<number>, P: Float64Array) {
  P.fill(0);
  const mode = s.mode ?? "fixed";
  if (mode === "fixed") { P[0] = P[4] = P[8] = 1; return; }
  if (mode === "dirs") { const d = s.dirs ?? [true, true, true]; if (d[0]) P[0] = 1; if (d[1]) P[4] = 1; if (d[2]) P[8] = 1; return; }
  for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) P[3 * c + d] = n[c] * n[d];
  if (mode === "hinge" && s.axis && !s.axialFree) {
    // the axis direction square to the normal (on the bore they are square already)
    const a = s.axis, an = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    const t = [a[0] - an * n[0], a[1] - an * n[1], a[2] - an * n[2]], l = Math.hypot(t[0], t[1], t[2]);
    if (l > 1e-9) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) P[3 * c + d] += (t[c] * t[d]) / (l * l);
  }
}

/** Jacobi eigen-decomposition of a symmetric n×n matrix (row-major, overwritten): values on the diagonal, vectors in the columns of V. */
function jacobi(B: Float64Array, n: number): Float64Array {
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 40; sweep++) {
    let off = 0, dia = 0;
    for (let i = 0; i < n; i++) { dia += B[i * n + i] ** 2; for (let j = i + 1; j < n; j++) off += B[i * n + j] ** 2; }
    if (off <= 1e-26 * dia) break;
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

/** With F = L Lᵀ (6×6, ridge added): the eigenvalues of L⁻¹ C L⁻ᵀ and M = L V, so C = M Λ Mᵀ. */
function relative(C: Float64Array, F: Float64Array, ridge: number) {
  const L = new Float64Array(36);
  for (let j = 0; j < 6; j++) {
    let d = F[j * 7] + ridge;
    for (let k = 0; k < j; k++) d -= L[j * 6 + k] ** 2;
    d = Math.sqrt(Math.max(d, 1e-300));
    L[j * 7] = d;
    for (let i = j + 1; i < 6; i++) { let v = F[i * 6 + j]; for (let k = 0; k < j; k++) v -= L[i * 6 + k] * L[j * 6 + k]; L[i * 6 + j] = v / d; }
  }
  const B = Float64Array.from(C);
  for (let col = 0; col < 6; col++) for (let i = 0; i < 6; i++) { let v = B[i * 6 + col]; for (let k = 0; k < i; k++) v -= L[i * 6 + k] * B[k * 6 + col]; B[i * 6 + col] = v / L[i * 7]; }
  for (let row = 0; row < 6; row++) for (let i = 0; i < 6; i++) { let v = B[row * 6 + i]; for (let k = 0; k < i; k++) v -= L[i * 6 + k] * B[row * 6 + k]; B[row * 6 + i] = v / L[i * 7]; }
  const V = jacobi(B, 6), M = new Float64Array(36);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { let v = 0; for (let k = 0; k <= i; k++) v += L[i * 6 + k] * V[k * 6 + j]; M[i * 6 + j] = v; }
  return { val: [0, 1, 2, 3, 4, 5].map(i => B[i * 7]), M };
}

/**
 * How many of the six rigid-body motions the supports leave free (0 = held). Per support, a motion it
 * holds less than 2 % as much as fixing the same faces would is taken as not held: the facets of a round
 * face hold a spin about its axis a little, and that must still count as free.
 */
export function freeModes(supports: Support[], lo: ArrayLike<number>, hi: ArrayLike<number>): number {
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const L = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
  const P = new Float64Array(9), R = new Float64Array(18), PR = new Float64Array(18);
  const Call = new Float64Array(36), Fall = new Float64Array(36);
  let total = 0;
  for (const s of supports) {
    const C = new Float64Array(36), F = new Float64Array(36);
    const nrm = triNormals(s.tris), ar = triNormals(s.tris, true);
    let area = 0;
    for (let t = 0; t < ar.length; t++) {
      if (!(ar[t] > 0)) continue;
      const n = [nrm[3 * t], nrm[3 * t + 1], nrm[3 * t + 2]];
      holdMatrix(s, n, P);
      for (let k = 0; k < 3; k++) {
        const o = 9 * t + 3 * k;
        const r = [(s.tris[o] - c[0]) / L, (s.tris[o + 1] - c[1]) / L, (s.tris[o + 2] - c[2]) / L];
        // columns: three translations, three rotations ω × r
        R.fill(0);
        R[0] = R[7] = R[14] = 1;
        R[4] = r[2]; R[5] = -r[1]; R[9] = -r[2]; R[11] = r[0]; R[15] = r[1]; R[16] = -r[0];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) PR[i * 6 + j] = P[3 * i] * R[j] + P[3 * i + 1] * R[6 + j] + P[3 * i + 2] * R[12 + j];
        const w = ar[t] / 3;
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
          C[i * 6 + j] += w * (PR[i] * PR[j] + PR[6 + i] * PR[6 + j] + PR[12 + i] * PR[12 + j]);
          F[i * 6 + j] += w * (R[i] * R[j] + R[6 + i] * R[6 + j] + R[12 + i] * R[12 + j]);
        }
        area += w;
      }
    }
    if (!(area > 0)) continue;
    total += area;
    const { val, M } = relative(C, F, 1e-12 * area);
    for (let k = 0; k < 6; k++) {
      if (val[k] < 0.02) continue;
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) Call[i * 6 + j] += val[k] * M[i * 6 + k] * M[j * 6 + k];
    }
    for (let i = 0; i < 36; i++) Fall[i] += F[i];
  }
  if (!(total > 0)) return 6;
  const { val } = relative(Call, Fall, 1e-12 * total);
  return val.filter(v => v < 1e-7).length;
}

/** Traction t = ω × (x − c) over the triangles whose moment about their centroid c is `moment`. */
export function momentField(tris: ArrayLike<number>, moment: ArrayLike<number>): { c: number[]; w: number[] } {
  const nt = tris.length / 9, ar = triNormals(tris, true);
  const c = [0, 0, 0];
  let A = 0;
  for (let t = 0; t < nt; t++) { A += ar[t]; for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) c[a] += (ar[t] / 3) * tris[9 * t + 3 * k + a]; }
  for (let a = 0; a < 3; a++) c[a] /= A || 1;
  // J = ∫ (|r|² I − r rᵀ) dA, exact for a triangle from its edge midpoints
  const J = new Float64Array(9);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const o = 9 * t, k2 = (k + 1) % 3;
    const r = [0, 1, 2].map(a => (tris[o + 3 * k + a] + tris[o + 3 * k2 + a]) / 2 - c[a]);
    const w = ar[t] / 3, rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) J[3 * i + j] += w * ((i === j ? rr : 0) - r[i] * r[j]);
  }
  return { c, w: solve3(J, moment) };
}

function solve3(M: Float64Array, b: ArrayLike<number>): number[] {
  const a = [[M[0], M[1], M[2], b[0]], [M[3], M[4], M[5], b[1]], [M[6], M[7], M[8], b[2]]];
  const scale = Math.max(Math.abs(M[0]), Math.abs(M[4]), Math.abs(M[8])) || 1;
  const x = [0, 0, 0], col = [0, 1, 2], used = [false, false, false];
  const piv: [number, number][] = [];
  for (let s = 0; s < 3; s++) {
    let bi = -1, bj = -1, bv = 1e-9 * scale;
    for (let i = 0; i < 3; i++) if (!used[i]) for (const j of col) if (Math.abs(a[i][j]) > bv && !piv.some(q => q[1] === j)) { bv = Math.abs(a[i][j]); bi = i; bj = j; }
    if (bi < 0) break;
    used[bi] = true; piv.push([bi, bj]);
    for (let i = 0; i < 3; i++) if (i !== bi) { const f = a[i][bj] / a[bi][bj]; for (let j = 0; j < 4; j++) a[i][j] -= f * a[bi][j]; }
  }
  for (const [i, j] of piv) x[j] = a[i][3] / a[i][j];
  return x;
}
