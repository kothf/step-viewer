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
}

export interface Support {
  /** Triangles (9 numbers each) of the fixed faces. */
  tris: ArrayLike<number>;
  /** Sliding (frictionless, symmetry) support: only the normal displacement is held. */
  sliding?: boolean;
}

export interface Load {
  tris: ArrayLike<number>;
  /** Total force, N, shared over the faces by area (uniform traction). */
  force?: [number, number, number];
  /** Pressure, MPa, pushing against the outward normal of each triangle. */
  pressure?: number;
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
  const gamma = (pb.beta ?? 3) * (lam + 2 * mu) * (p + 1) * (p + 1) / grid.h;
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
      pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 3, pb.inside, pb.depth ?? 3);
      // a whole face keeps no points: it gets the plain Gauss rule of each pass
      const area = grid!.h * grid!.h;
      grid!.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    }
    if (!pts) pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, q, () => true, 0);
    else pts = fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, fq);
    const nrm = [0, 0, 0];
    nrm[axis] = 1;
    const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
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
  // Nitsche, u = 0: −N_i M_j − N_j M_iᵀ + 2γ N_i N_j I
  // sliding, u·n = 0: −N_a n_c (T_bd·n) − N_b n_d (T_ac·n) + 2γ N_a N_b n_c n_d
  const tn = new Float64Array(3 * nb);
  for (const s of pb.fixed) located(s.tris, (e, x, y, z, w, nrm) => {
    const E = grid.elems[e];
    bas.eval(x, y, z, E.c, E.s);
    for (let b = 0; b < nb; b++) traction(bas.g, 3 * b, nrm, lam, mu, MA, 9 * b);
    const K = A.block(e, e), v = bas.v;
    const gw = 2 * gamma * w;
    if (s.sliding) {
      for (let b = 0; b < nb; b++) for (let d = 0; d < 3; d++)
        tn[3 * b + d] = MA[9 * b + d] * nrm[0] + MA[9 * b + 3 + d] * nrm[1] + MA[9 * b + 6 + d] * nrm[2];
      for (let a = 0; a < nb; a++) for (let b = 0; b < nb; b++) {
        const pen = gw * v[a] * v[b];
        for (let c = 0; c < 3; c++) {
          const row = (3 * a + c) * m + 3 * b;
          for (let d = 0; d < 3; d++)
            K[row + d] += w * (-v[a] * nrm[c] * tn[3 * b + d] - v[b] * nrm[d] * tn[3 * a + c]) + pen * nrm[c] * nrm[d];
        }
      }
      return;
    }
    for (let a = 0; a < nb; a++) for (let b = 0; b < nb; b++) {
      const pen = gw * v[a] * v[b];
      for (let c = 0; c < 3; c++) {
        const row = (3 * a + c) * m + 3 * b;
        for (let d = 0; d < 3; d++)
          K[row + d] += -w * (v[a] * MA[9 * b + c * 3 + d] + v[b] * MA[9 * a + d * 3 + c]) + (c === d ? pen : 0);
      }
    }
  });
  for (const L of pb.loads) {
    const area = triArea(L.tris);
    if (!(area > 0)) continue;
    const t0 = (L.force ?? [0, 0, 0]).map(v => v / area), pr = L.pressure ?? 0;
    const t = [0, 0, 0];
    located(L.tris, (e, x, y, z, w, nrm) => {
      const E = grid.elems[e];
      bas.eval(x, y, z, E.c, E.s);
      for (let c = 0; c < 3; c++) t[c] = t0[c] - pr * nrm[c];
      for (let a = 0; a < nb; a++) for (let c = 0; c < 3; c++) f[e * m + 3 * a + c] += w * bas.v[a] * t[c];
    });
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

