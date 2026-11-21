// Structural analysis (FR-SOL-001, FR-SARC-011..013): linear static solve of one body.
// Each element (an aggregated group of cells) carries a complete polynomial of degree p per displacement
// component. Elements are joined by the symmetric interior penalty method, fixed supports are imposed
// weakly (Nitsche) on boundary triangles, loads are tractions on boundary triangles.
// Units: mm, N, MPa (so E in MPa, density in t/mm³).

import { Basis, basisSize } from "./basis";
import { gauss, gridTrianglePoints, facePoints, fitFacePoints, type Inside } from "./quad";
import { makeGrid, refit, type Grid } from "./grid";
import { BlockMatrix, Envelope } from "./sparse";
import { pcgSolver } from "./pcg";
import { subspace } from "./eigen";

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
  mode?: "fixed" | "sliding" | "hinge" | "dirs" | "tangent";
  /** Enforced displacement, mm: the held directions are moved to this instead of 0 (P u = P value). */
  value?: ArrayLike<number>;
  /**
   * Elastic support (faces only): instead of being held, the faces rest on springs of stiffness per area
   * `kn` along the normal and `kt` in the tangent plane, N/mm³. `mode` is then only what the free check
   * counts as held (`sliding` for kn alone, `tangent` for kt alone).
   */
  spring?: { kn: number; kt: number };
  axis?: ArrayLike<number>;
  axialFree?: boolean;
  dirs?: [boolean, boolean, boolean];
  /**
   * Support on edges: segments of 9 numbers (two ends and a direction into the body), `tris` empty. Held by
   * a penalty of the order of the face supports'; only `fixed` and `dirs` (an edge has no one normal).
   */
  lines?: ArrayLike<number>;
  /** Support on points: 6 numbers per point (position and a direction into the body), `tris` empty. */
  points?: ArrayLike<number>;
}

export interface Load {
  tris: ArrayLike<number>;
  /** Total force, N, shared over the faces by area (uniform traction). */
  force?: ArrayLike<number>;
  /** Pressure, MPa, pushing against the outward normal of each triangle. */
  pressure?: number;
  /** Total moment, N·mm, about the faces' centroid, as a traction growing linearly from it. */
  moment?: ArrayLike<number>;
  /**
   * Edge load: segments of 9 numbers (two ends and a direction into the body); `force` is then the total
   * over their length. `tris` is empty.
   */
  lines?: ArrayLike<number>;
  /** Point load: 6 numbers per point (position and a direction into the body); `force` is shared equally. */
  points?: ArrayLike<number>;
  /**
   * Torque, N·mm, about the line through `p` along the unit `axis`, as a traction along the circumference
   * growing with the distance from the axis (cylindrical faces; positive turns right-handed about `axis`).
   */
  torque?: { p: ArrayLike<number>; axis: ArrayLike<number>; value: number };
  /**
   * Bearing load: the total `force`, N, pressed onto the half of the (cylindrical) faces that faces it,
   * as a pressure growing with the cosine of the angle from the force's direction.
   */
  bearing?: ArrayLike<number>;
  /**
   * Hydrostatic pressure: `gamma` N/mm³ (fluid density × gravity) per mm of depth below the point `p`
   * on the fluid's surface, measured along the unit `down`; nothing above the surface.
   */
  hydro?: { p: ArrayLike<number>; down: ArrayLike<number>; gamma: number };
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
  /**
   * Bodies with a material each (two or more): every one gets its own elements, joined to its neighbours
   * where their surfaces touch like elements inside a body are, each side with its own stiffness. `tris` =
   * the body's own closed surface, wound outwards. `inside`/`mat` are then not used.
   */
  domains?: { inside: Inside; mat: Material; tris: ArrayLike<number> }[];
  fixed: Support[];
  loads: Load[];
  /** Gravity, mm/s² (needs `mat.rho`). */
  gravity?: ArrayLike<number>;
  /**
   * Spinning about the line through `p` along the unit `axis` (needs `mat.rho`): `omega` rad/s gives the
   * centrifugal body force ρ ω² r, `alpha` rad/s² the inertia force −ρ α × r of speeding up.
   */
  spin?: { p: ArrayLike<number>; axis: ArrayLike<number>; omega: number; alpha?: number };
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
  /**
   * Local refinement: the degree of each element of `grid` (2..p, `p` being their highest). Elements of
   * different degrees are joined like any others; each is integrated by the rule of its own degree.
   */
  degrees?: ArrayLike<number>;
  /**
   * Modal analysis (FR-SARC-022): the lowest `count` natural modes instead of a static solve. Loads are
   * ignored, supports may leave the body free (the stiffness is then shifted). `start` = the `space` of an
   * earlier pass on the same `grid` (any lower degree). Needs `mat.rho`.
   */
  modal?: { count: number; start?: Float64Array[]; tol?: number };
  /**
   * Inertia relief (FR-SUP-007): the body is held by nothing; the loads are balanced by the inertia forces
   * −ρ(a + α × r) of the rigid acceleration they give it. Supports that leave it free are then allowed (the
   * usual case: none). The result has no rigid motion (mass-weighted). Needs `mat.rho`.
   */
  relief?: boolean;
}

export interface Mode {
  /** Natural frequency, Hz (0 for a rigid-body motion). */
  hz: number;
  /** ω², rad²/s². */
  lambda: number;
  /** A motion of the whole body without strain (a free or partly held body). */
  rigid: boolean;
  /** Effective mass along X, Y, Z as shares of the body's mass (0..1). */
  eff: [number, number, number];
  /** Coefficients in the layout of `x`, with φᵀ M φ = 1 (t, mm). */
  x: Float64Array;
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
  /** Inertia relief: the acceleration the loads give the free body (mm/s², rad/s²), its centre of mass (mm) and mass (t). */
  accel?: { a: number[]; alpha: number[]; com: number[]; mass: number };
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
  /** `hit` (asked for with `hits`): 1 where the point lies in a cell of the grid, so the values there mean something. */
  sample(pos: ArrayLike<number>, nrm?: ArrayLike<number>, hits?: boolean): { u: Float32Array; vm: Float32Array; err: Float32Array; hit?: Uint8Array; /** With `domains`: the one each point is in. */ dom?: Uint8Array };
  /** Displacement at a point, mm. */
  disp(x: number, y: number, z: number): [number, number, number];
  /** Modal: the modes, lowest first; `use(k)` makes `sample`/`disp`/`stress` read mode k (the first to begin with). */
  modes?: Mode[];
  use?(k: number): void;
  /** Modal: every vector of the last iteration, for the next pass's `start`. */
  space?: Float64Array[];
  /** Modal: the body's mass, t. */
  mass?: number;
  /** Stress at a point [xx, yy, zz, xy, yz, zx], MPa. */
  stress(x: number, y: number, z: number): number[];
}

/** Unknowns up to which the direct solver is used. */
export const DIRECT_LIMIT = 6000;
/** The same for a modal solve, where one factorisation serves many solves. */
export const MODAL_DIRECT = 9000;

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
  const p = pb.p, q = p + 1;
  let grid = pb.grid;
  const deg = pb.grid && pb.degrees && pb.degrees.length === pb.grid.elems.length ? pb.degrees : null;
  if (grid) refit(grid, q, 2 * p + 1, deg ? c => deg[c.el] : undefined);
  const doms = pb.domains && pb.domains.length > 1 ? pb.domains : null;
  if (!grid) grid = makeGrid(pb.lo, pb.hi, pb.h, pb.inside, { q, depth: pb.depth ?? 3, fit: 2 * p + 1, domains: doms?.map(d => d.inside) });
  const t1 = now();
  // materials: one, or one per domain; `lam`/`mu` are those of the element being worked on (`setMat`)
  const mats = doms ? doms.map(d => d.mat) : [pb.mat], lames = mats.map(lame);
  let { lam, mu } = lames[0];
  const domE = Uint8Array.from(grid.elems, E => (doms ? grid!.cells[E.cells[0]].dom : 0));
  const setMat = (e: number) => { const L = lames[domE[e]]; lam = L.lam; mu = L.mu; };
  const rhoOf = (e: number) => mats[domE[e]].rho ?? 0;
  const hasRho = mats.every(q => (q.rho ?? 0) > 0);
  /** The lowest E/ρ: the scale of the shift that stands in for stiffness the supports do not give. */
  const stiffRho = () => Math.min(...mats.map(q => q.E / q.rho!));
  const insideOfDom = (d: number) => (doms ? doms[d].inside : pb.inside);
  const bas = new Basis(p), bas2 = new Basis(p);
  const nb = bas.n, m = 3 * nb, nel = grid.elems.length;
  // functions per element: the leading ones of the hierarchical basis up to the element's own degree
  const nbs = new Int32Array(nel).fill(nb);
  if (deg) for (let e = 0; e < nel; e++) nbs[e] = basisSize(Math.min(p, Math.max(1, deg[e])));
  const A = new BlockMatrix(nel, Array.from(nbs, v => 3 * v));
  const off = A.off;
  const f = new Float64Array(A.size);
  const pOf = (e: number) => (deg ? Math.min(p, Math.max(1, deg[e])) : p);
  // an element that is partly outside the body carries its polynomial on less material, so its tractions are
  // larger beside its energy: the penalty grows by the share that is missing (cells under 25 % are aggregated)
  const gam = new Float64Array(nel);
  for (let e = 0; e < nel; e++) {
    let fr = 0;
    for (const c of grid.elems[e].cells) fr = Math.max(fr, grid.cells[c].frac);
    setMat(e);
    gam[e] = (pb.beta ?? 3) * (lam + 2 * mu) / grid.h * (pOf(e) + 1) ** 2 / Math.min(1, Math.max(0.2, fr));
  }
  let gamma = 0;
  const el = (c: number) => grid.elems[grid.cells[c].el];

  // volume terms
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e];
    const K = A.block(e, e);
    const nb = nbs[e], m = 3 * nb;
    setMat(e);
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
    setMat(ea);
    // fine points of a cut face are kept on the grid for later passes
    const key = ca * 3 + axis;
    let pts = grid!.faces.get(key);
    if (pts === undefined) {
      pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 5, insideOfDom(A0.dom), pb.depth ?? 3);
      // a whole face keeps no points: it gets the plain Gauss rule of each pass
      const area = grid!.h * grid!.h;
      grid!.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    }
    const pf = Math.max(pOf(ea), pOf(eb));
    if (!pts) pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, pf + 1, () => true, 0);
    else pts = fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, 2 * pf + 1);
    const na = nbs[ea], nc = nbs[eb];
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
      pair(Kaa, bas.v, MA, 1, na, bas.v, MA, 1, na, w);
      pair(Kab, bas.v, MA, 1, na, bas2.v, MB, -1, nc, w);
      pair(Kba, bas2.v, MB, -1, nc, bas.v, MA, 1, na, w);
      pair(Kbb, bas2.v, MB, -1, nc, bas2.v, MB, -1, nc, w);
    }
  };
  // block (rows i, cols j): −½ s_i N_i M_j − ½ s_j N_j M_iᵀ + γ s_i s_j N_i N_j I
  function pair(K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, ni: number, Nj: Float64Array, Mj: Float64Array, sj: number, nj: number, w: number) {
    const hw = 0.5 * w, gw = gamma * w * si * sj, m = 3 * nj;
    for (let a = 0; a < ni; a++) {
      const na = Ni[a] * si * hw;
      for (let b = 0; b < nj; b++) {
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
    const [i, j, k] = grid.cells[c].ijk, d = grid.cells[c].dom;
    const nx = grid.at(i + 1, j, k, d), ny = grid.at(i, j + 1, k, d), nz = grid.at(i, j, k + 1, d);
    if (nx >= 0) face(c, nx, 0);
    if (ny >= 0) face(c, ny, 1);
    if (nz >= 0) face(c, nz, 2);
  }

  // boundary quadrature located in cells
  const tq = Math.max(2, p + 1);
  // domains are joined where one's surface lies on another's: the same terms as between elements, each side
  // with its own material. A point of A's surface is on B when a step along the normal ends inside B.
  if (doms) {
    const eps = 2e-3 * grid.h;
    for (let a = 0; a + 1 < doms.length; a++) {
      const T = doms[a].tris, { pts, tri } = gridTrianglePoints(T, grid.lo, grid.h, tq), nrms = triNormals(T);
      for (let k = 0; k < pts.n; k++) {
        const o = 4 * k, t = tri[k], w = pts.a[o + 3];
        const nrm = [nrms[3 * t], nrms[3 * t + 1], nrms[3 * t + 2]];
        const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
        const bx = x + eps * nrm[0], by = y + eps * nrm[1], bz = z + eps * nrm[2];
        let b = -1;
        for (let d = a + 1; d < doms.length && b < 0; d++) if (doms[d].inside(bx, by, bz)) b = d;
        if (b < 0) continue;
        const ca = grid.cellOf(x - eps * nrm[0], y - eps * nrm[1], z - eps * nrm[2], a), cb = grid.cellOf(bx, by, bz, b);
        if (ca < 0 || cb < 0) continue;
        const ea = grid.cells[ca].el, eb = grid.cells[cb].el, EA = grid.elems[ea], EB = grid.elems[eb];
        bas.eval(x, y, z, EA.c, EA.s);
        bas2.eval(x, y, z, EB.c, EB.s);
        setMat(ea);
        for (let q2 = 0; q2 < nb; q2++) traction(bas.g, 3 * q2, nrm, lam, mu, MA, 9 * q2);
        setMat(eb);
        for (let q2 = 0; q2 < nb; q2++) traction(bas2.g, 3 * q2, nrm, lam, mu, MB, 9 * q2);
        const na = nbs[ea], nc = nbs[eb];
        gamma = Math.max(gam[ea], gam[eb]);
        pair(A.block(ea, ea), bas.v, MA, 1, na, bas.v, MA, 1, na, w);
        pair(A.block(ea, eb), bas.v, MA, 1, na, bas2.v, MB, -1, nc, w);
        pair(A.block(eb, ea), bas2.v, MB, -1, nc, bas.v, MA, 1, na, w);
        pair(A.block(eb, eb), bas2.v, MB, -1, nc, bas2.v, MB, -1, nc, w);
      }
    }
  }
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
  // the cell a boundary point belongs to: nudged into the body, further when the first try lands outside
  const cellNear = (x: number, y: number, z: number, d: ArrayLike<number>, o: number) => {
    for (const k of [1e-7, 1e-4, 1e-2, 0.1]) {
      const c = grid.cellOf(x + k * grid.h * d[o], y + k * grid.h * d[o + 1], z + k * grid.h * d[o + 2]);
      if (c >= 0) return c;
    }
    return -1;
  };
  const gl = gauss(Math.max(2, p + 1));
  /** Gauss points along segments (9 numbers each), cut at the grid planes: cell, point, weight (length). */
  const onLines = (S: ArrayLike<number>, fn: (c: number, x: number, y: number, z: number, w: number) => void) => {
    for (let o = 0; o < S.length; o += 9) {
      const d = [S[o + 3] - S[o], S[o + 4] - S[o + 1], S[o + 5] - S[o + 2]], l = Math.hypot(d[0], d[1], d[2]);
      // cut where the segment crosses a grid plane: the basis is a polynomial only inside a cell
      const cuts = [0, 1];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-12) continue;
        const u0 = (S[o + a] - grid.lo[a]) / grid.h, u1 = u0 + d[a] / grid.h;
        for (let q = Math.ceil(Math.min(u0, u1)); q <= Math.floor(Math.max(u0, u1)); q++) {
          const tt = (q - u0) / (u1 - u0);
          if (tt > 1e-9 && tt < 1 - 1e-9) cuts.push(tt);
        }
      }
      cuts.sort((x, y) => x - y);
      for (let i = 1; i < cuts.length; i++) {
        const t0 = cuts[i - 1], t1 = cuts[i], tm = (t0 + t1) / 2;
        if (t1 - t0 < 1e-12) continue;
        const c = cellNear(S[o] + tm * d[0], S[o + 1] + tm * d[1], S[o + 2] + tm * d[2], S, o + 6);
        if (c < 0) continue;
        for (let g = 0; g < gl.x.length; g++) {
          const tt = t0 + (t1 - t0) * (gl.x[g] + 1) / 2;
          fn(c, S[o] + tt * d[0], S[o + 1] + tt * d[1], S[o + 2] + tt * d[2], (gl.w[g] / 2) * (t1 - t0) * l);
        }
      }
    }
  };
  /** The points an edge or point support holds: cell, place and weight (the penalty times a length or 1). */
  const heldAt = (s: Support, fn: (c: number, x: number, y: number, z: number, w: number) => void) => {
    if (s.lines?.length) onLines(s.lines, (c, x, y, z, w) => fn(c, x, y, z, 2 * gam[grid.cells[c].el] * grid.h * w));
    const Q = s.points;
    if (Q?.length) for (let k = 0; k < Q.length; k += 6) {
      const c = cellNear(Q[k], Q[k + 1], Q[k + 2], Q, k + 3);
      if (c >= 0) fn(c, Q[k], Q[k + 1], Q[k + 2], 2 * gam[grid.cells[c].el] * grid.h * grid.h);
    }
  };
  // Nitsche for P u = 0 (P projects on the held directions): −N_a (P M_b) − N_b (P M_a)ᵀ + 2γ N_a N_b P
  const free = freeModes(pb.fixed, pb.lo, pb.hi);
  if (free > 0 && !pb.modal && !(pb.relief && hasRho)) throw new Error(`E-SIM-FREE: ${free}`);
  const P = new Float64Array(9), PM = new Float64Array(9 * nb);
  const Pg = [0, 0, 0];
  const springAt = (s: Support, nrm: ArrayLike<number>) => {
    // kt I + (kn − kt) n nᵀ
    const k = s.spring!;
    for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) P[3 * c + d] = (c === d ? k.kt : 0) + (k.kn - k.kt) * nrm[c] * nrm[d];
  };
  for (const s of pb.fixed) located(s.tris, (e, x, y, z, w, nrm) => {
    const E = grid.elems[e];
    bas.eval(x, y, z, E.c, E.s);
    setMat(e);
    if (s.spring) {
      springAt(s, nrm);
      const K = A.block(e, e), v = bas.v, ne = nbs[e], m = 3 * ne;
      for (let a = 0; a < ne; a++) for (let b = 0; b < ne; b++) {
        const q = w * v[a] * v[b];
        for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) K[(3 * a + c) * m + 3 * b + d] += q * P[3 * c + d];
      }
      return;
    }
    for (let b = 0; b < nb; b++) traction(bas.g, 3 * b, nrm, lam, mu, MA, 9 * b);
    holdMatrix(s, nrm, P);
    for (let b = 0; b < nb; b++) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++)
      PM[9 * b + 3 * c + d] = P[3 * c] * MA[9 * b + d] + P[3 * c + 1] * MA[9 * b + 3 + d] + P[3 * c + 2] * MA[9 * b + 6 + d];
    const K = A.block(e, e), v = bas.v;
    const ne = nbs[e], m = 3 * ne;
    const gw = 2 * gam[e] * w;
    for (let a = 0; a < ne; a++) for (let b = 0; b < ne; b++) {
      const pen = gw * v[a] * v[b];
      for (let c = 0; c < 3; c++) {
        const row = (3 * a + c) * m + 3 * b;
        for (let d = 0; d < 3; d++)
          K[row + d] += -w * (v[a] * PM[9 * b + 3 * c + d] + v[b] * PM[9 * a + 3 * d + c]) + pen * P[3 * c + d];
      }
    }
    // an enforced displacement g: −(P σ(v) n)·g + 2γ (P g)·v on the right-hand side
    const g = s.value;
    if (g) {
      for (let c = 0; c < 3; c++) Pg[c] = P[3 * c] * g[0] + P[3 * c + 1] * g[1] + P[3 * c + 2] * g[2];
      for (let a = 0, o = off[e]; a < ne; a++) for (let c = 0; c < 3; c++)
        f[o + 3 * a + c] += w * (-(PM[9 * a + c] * g[0] + PM[9 * a + 3 + c] * g[1] + PM[9 * a + 6 + c] * g[2]) + 2 * gam[e] * v[a] * Pg[c]);
    }
  });
  // edges and points: a penalty on P u there (no flux terms: a line carries no traction integral)
  const N0 = [0, 0, 0];
  for (const s of pb.fixed) heldAt(s, (c, x, y, z, w) => {
    const e = grid.cells[c].el, E = grid.elems[e];
    bas.eval(x, y, z, E.c, E.s);
    holdMatrix(s, N0, P);
    const K = A.block(e, e), v = bas.v, ne = nbs[e], m = 3 * ne;
    for (let a = 0; a < ne; a++) for (let b = 0; b < ne; b++) {
      const pen = w * v[a] * v[b];
      for (let c2 = 0; c2 < 3; c2++) for (let d = 0; d < 3; d++) K[(3 * a + c2) * m + 3 * b + d] += pen * P[3 * c2 + d];
    }
    const g = s.value;
    if (g) for (let a = 0, o = off[e]; a < ne; a++) for (let c2 = 0; c2 < 3; c2++)
      f[o + 3 * a + c2] += w * v[a] * (P[3 * c2] * g[0] + P[3 * c2 + 1] * g[1] + P[3 * c2 + 2] * g[2]);
  });
  const applied: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
  const add = (R: Reaction, x: number, y: number, z: number, fx: number, fy: number, fz: number) => {
    R.force[0] += fx; R.force[1] += fy; R.force[2] += fz;
    R.moment[0] += y * fz - z * fy; R.moment[1] += z * fx - x * fz; R.moment[2] += x * fy - y * fx;
  };
  const push = (c: number, x: number, y: number, z: number, fx: number, fy: number, fz: number) => {
    const e = grid.cells[c].el, E = grid.elems[e];
    bas.eval(x, y, z, E.c, E.s);
    add(applied, x, y, z, fx, fy, fz);
    for (let a = 0, o = off[e]; a < nbs[e]; a++) { f[o + 3 * a] += bas.v[a] * fx; f[o + 3 * a + 1] += bas.v[a] * fy; f[o + 3 * a + 2] += bas.v[a] * fz; }
  };
  for (const L of pb.loads) {
    if (L.points?.length && L.force) {
      const P = L.points, n = P.length / 6;
      for (let k = 0; k < n; k++) {
        const c = cellNear(P[6 * k], P[6 * k + 1], P[6 * k + 2], P, 6 * k + 3);
        if (c >= 0) push(c, P[6 * k], P[6 * k + 1], P[6 * k + 2], L.force[0] / n, L.force[1] / n, L.force[2] / n);
      }
      continue;
    }
    if (L.lines?.length && L.force) {
      const S = L.lines;
      const len = lineLength(S);
      if (!(len > 0)) continue;
      onLines(S, (c, x, y, z, w) => push(c, x, y, z, w / len * L.force![0], w / len * L.force![1], w / len * L.force![2]));
      continue;
    }
    // a hydrostatic load acts on the wetted part only: the triangles are cut at the fluid's surface, so the pressure is linear on each
    const tris = L.hydro ? wetted(L.tris, L.hydro.p, L.hydro.down) : L.tris;
    const area = triArea(tris);
    if (!(area > 0)) continue;
    const t0 = Array.from(L.force ?? [0, 0, 0]).map(v => v / area), pr = L.pressure ?? 0;
    const mo = L.moment ? momentField(tris, L.moment) : null;
    const t = [0, 0, 0];
    // torque and bearing loads are scaled so their totals are the given ones on this quadrature
    const tq = L.torque, bf = L.bearing, hy = L.hydro;
    let tqK = 0, bfK = 0;
    const bd = bf ? Math.hypot(bf[0], bf[1], bf[2]) : 0;
    if (tq || bd > 0) {
      let i2 = 0, c2 = 0;
      located(tris, (_e, x, y, z, w, nrm) => {
        if (tq) {
          const rx = x - tq.p[0], ry = y - tq.p[1], rz = z - tq.p[2], a = tq.axis;
          const cx = a[1] * rz - a[2] * ry, cy = a[2] * rx - a[0] * rz, cz = a[0] * ry - a[1] * rx;
          i2 += w * (cx * cx + cy * cy + cz * cz);
        }
        if (bd > 0) { const q = Math.max(0, -(nrm[0] * bf![0] + nrm[1] * bf![1] + nrm[2] * bf![2]) / bd); c2 += w * q * q; }
      });
      tqK = tq && i2 > 0 ? tq.value / i2 : 0;
      bfK = c2 > 0 ? bd / c2 : 0;
    }
    located(tris, (e, x, y, z, w, nrm) => {
      const E = grid.elems[e];
      bas.eval(x, y, z, E.c, E.s);
      for (let c = 0; c < 3; c++) t[c] = t0[c] - pr * nrm[c];
      if (tq) {
        const rx = x - tq.p[0], ry = y - tq.p[1], rz = z - tq.p[2], a = tq.axis;
        t[0] += tqK * (a[1] * rz - a[2] * ry); t[1] += tqK * (a[2] * rx - a[0] * rz); t[2] += tqK * (a[0] * ry - a[1] * rx);
      }
      if (bfK > 0) {
        const q = bfK * Math.max(0, -(nrm[0] * bf![0] + nrm[1] * bf![1] + nrm[2] * bf![2]) / bd);
        t[0] -= q * nrm[0]; t[1] -= q * nrm[1]; t[2] -= q * nrm[2];
      }
      if (hy) {
        const q = hy.gamma * Math.max(0, (x - hy.p[0]) * hy.down[0] + (y - hy.p[1]) * hy.down[1] + (z - hy.p[2]) * hy.down[2]);
        t[0] -= q * nrm[0]; t[1] -= q * nrm[1]; t[2] -= q * nrm[2];
      }
      if (mo) {
        const rx = x - mo.c[0], ry = y - mo.c[1], rz = z - mo.c[2], o = mo.w;
        t[0] += o[1] * rz - o[2] * ry; t[1] += o[2] * rx - o[0] * rz; t[2] += o[0] * ry - o[1] * rx;
      }
      add(applied, x, y, z, w * t[0], w * t[1], w * t[2]);
      for (let a = 0; a < nbs[e]; a++) for (let c = 0; c < 3; c++) f[off[e] + 3 * a + c] += w * bas.v[a] * t[c];
    });
  }
  if (pb.gravity && hasRho) {
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e], g = Array.from(pb.gravity).map(v => v * rhoOf(e));
      for (const ci of E.cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) {
          const o = 4 * k, w = Q.a[o + 3];
          bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
          add(applied, Q.a[o], Q.a[o + 1], Q.a[o + 2], w * g[0], w * g[1], w * g[2]);
          for (let a = 0; a < nbs[e]; a++) for (let c = 0; c < 3; c++) f[off[e] + 3 * a + c] += w * bas.v[a] * g[c];
        }
      }
    }
  }
  if (pb.spin && hasRho) {
    const sp = pb.spin, ax = sp.axis, w2 = sp.omega * sp.omega, al = sp.alpha ?? 0;
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e], rho = rhoOf(e);
      for (const ci of E.cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) {
          const o = 4 * k, w = Q.a[o + 3] * rho;
          const rx = Q.a[o] - sp.p[0], ry = Q.a[o + 1] - sp.p[1], rz = Q.a[o + 2] - sp.p[2], ra = rx * ax[0] + ry * ax[1] + rz * ax[2];
          // ω² r⊥ − α a × r
          const bx = w2 * (rx - ra * ax[0]) - al * (ax[1] * rz - ax[2] * ry), by = w2 * (ry - ra * ax[1]) - al * (ax[2] * rx - ax[0] * rz), bz = w2 * (rz - ra * ax[2]) - al * (ax[0] * ry - ax[1] * rx);
          bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
          add(applied, Q.a[o], Q.a[o + 1], Q.a[o + 2], w * bx, w * by, w * bz);
          for (let a = 0, q = off[e]; a < nbs[e]; a++) { f[q + 3 * a] += w * bas.v[a] * bx; f[q + 3 * a + 1] += w * bas.v[a] * by; f[q + 3 * a + 2] += w * bas.v[a] * bz; }
        }
      }
    }
  }
  // inertia relief: the rigid acceleration the loads give the free body, and its inertia forces as a body force
  let accel: { a: number[]; alpha: number[]; com: number[]; mass: number } | undefined;
  const relief = !!pb.relief && hasRho && free > 0 && !pb.modal;
  if (relief) {
    let ms = 0;
    const c = [0, 0, 0], I = new Float64Array(9);
    const each = (fn: (e: number, x: number, y: number, z: number, w: number) => void) => {
      for (let e = 0; e < nel; e++) for (const ci of grid.elems[e].cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) fn(e, Q.a[4 * k], Q.a[4 * k + 1], Q.a[4 * k + 2], Q.a[4 * k + 3] * rhoOf(e));
      }
    };
    each((_e, x, y, z, w) => { ms += w; c[0] += w * x; c[1] += w * y; c[2] += w * z; });
    for (let i = 0; i < 3; i++) c[i] /= ms || 1;
    each((_e, x, y, z, w) => {
      const r = [x - c[0], y - c[1], z - c[2]], r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[3 * i + j] += w * ((i === j ? r2 : 0) - r[i] * r[j]);
    });
    const F = applied.force, M0 = applied.moment;
    const Mc = [M0[0] - (c[1] * F[2] - c[2] * F[1]), M0[1] - (c[2] * F[0] - c[0] * F[2]), M0[2] - (c[0] * F[1] - c[1] * F[0])];
    const a = F.map(v => v / (ms || 1));
    // α = I⁻¹ M (I is symmetric positive definite for a solid)
    const det = I[0] * (I[4] * I[8] - I[5] * I[7]) - I[1] * (I[3] * I[8] - I[5] * I[6]) + I[2] * (I[3] * I[7] - I[4] * I[6]);
    const inv = [I[4] * I[8] - I[5] * I[7], I[2] * I[7] - I[1] * I[8], I[1] * I[5] - I[2] * I[4], I[5] * I[6] - I[3] * I[8], I[0] * I[8] - I[2] * I[6], I[2] * I[3] - I[0] * I[5],
      I[3] * I[7] - I[4] * I[6], I[1] * I[6] - I[0] * I[7], I[0] * I[4] - I[1] * I[3]].map(v => v / (det || 1));
    const al = [0, 1, 2].map(i => inv[3 * i] * Mc[0] + inv[3 * i + 1] * Mc[1] + inv[3 * i + 2] * Mc[2]);
    each((e, x, y, z, w) => {
      const rx = x - c[0], ry = y - c[1], rz = z - c[2];
      const bx = -w * (a[0] + al[1] * rz - al[2] * ry), by = -w * (a[1] + al[2] * rx - al[0] * rz), bz = -w * (a[2] + al[0] * ry - al[1] * rx);
      bas.eval(x, y, z, grid.elems[e].c, grid.elems[e].s);
      for (let q = 0, o = off[e]; q < nbs[e]; q++) { f[o + 3 * q] += bas.v[q] * bx; f[o + 3 * q + 1] += bas.v[q] * by; f[o + 3 * q + 2] += bas.v[q] * bz; }
    });
    accel = { a, alpha: al, com: c, mass: ms };
  }
  // keep elements nothing reaches solvable (no stiffness at all): pin them
  for (let e = 0; e < nel; e++) {
    const K = A.block(e, e), m = 3 * nbs[e];
    for (let i = 0; i < m; i++) if (K[i * m + i] === 0) K[i * m + i] = 1;
  }
  // modal: consistent mass from the same quadrature, the same for each component
  let modes: Mode[] | undefined, space: Float64Array[] | undefined, mass = 0;
  const modal = pb.modal && hasRho ? pb.modal : null;
  let modalRun: (() => Float64Array) | null = null;
  if (modal) {
    const Mel: Float64Array[] = [], Sel: Float64Array[] = [];
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e], ne = nbs[e], rho = rhoOf(e);
      const M = new Float64Array(ne * ne), S = new Float64Array(ne);
      for (const ci of E.cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) {
          const o = 4 * k, w = Q.a[o + 3] * rho;
          bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
          mass += w;
          for (let a = 0; a < ne; a++) {
            const va = bas.v[a] * w;
            S[a] += va;
            for (let b = 0; b < ne; b++) M[a * ne + b] += va * bas.v[b];
          }
        }
      }
      Mel.push(M); Sel.push(S);
    }
    const mulM = (v: Float64Array, y: Float64Array) => {
      for (let e = 0; e < nel; e++) {
        const M = Mel[e], ne = nbs[e], o = off[e];
        for (let a = 0; a < ne; a++) {
          let sx = 0, sy = 0, sz = 0;
          for (let b = 0; b < ne; b++) { const mv = M[a * ne + b]; sx += mv * v[o + 3 * b]; sy += mv * v[o + 3 * b + 1]; sz += mv * v[o + 3 * b + 2]; }
          y[o + 3 * a] = sx; y[o + 3 * a + 1] = sy; y[o + 3 * a + 2] = sz;
        }
      }
    };
    // a body the supports leave free has motions without stiffness: K + σM is solved instead, σ far under
    // the first elastic mode of anything but a hair
    const L = Math.hypot(pb.hi[0] - pb.lo[0], pb.hi[1] - pb.lo[1], pb.hi[2] - pb.lo[2]) || 1;
    const scale = stiffRho() / (L * L);
    const sigma = free > 0 ? 1e-4 * scale : 0;
    if (sigma > 0) for (let e = 0; e < nel; e++) {
      const K = A.block(e, e), M = Mel[e], ne = nbs[e], m = 3 * ne;
      for (let a = 0; a < ne; a++) for (let b = 0; b < ne; b++) for (let c = 0; c < 3; c++) K[(3 * a + c) * m + 3 * b + c] += sigma * M[a * ne + b];
    }
    modalRun = () => {
      const n = A.size;
      const direct = pb.solver === "direct" || (pb.solver !== "pcg" && n <= MODAL_DIRECT);
      let solve: (b: Float64Array, g?: Float64Array) => Float64Array;
      if (direct) { const F = new Envelope(A); solve = b => F.solve(b); }
      else { const S = pcgSolver(A, { coarse: 3 * basisSize(1), tol: 1e-6, maxIt: 300 }); solve = (b, g) => { const r = S.solve(b, g); iterations += r.iterations; return r.x; }; }
      // an earlier pass's vectors in this pass's layout (zeros for the functions it did not have)
      const start = (modal.start ?? []).map(v => {
        if (v.length === n || deg || v.length % nel) return v;
        const pm = v.length / nel, w = new Float64Array(n);
        for (let e = 0; e < nel; e++) w.set(v.subarray(e * pm, e * pm + Math.min(pm, m)), e * m);
        return w;
      });
      const r = subspace(n, solve, (v, y) => { A.mul(v, y); }, mulM, { count: modal.count, start, tol: modal.tol ?? (direct ? 1e-9 : 1e-6) });
      space = r.space;
      modes = r.values.map((th, k) => {
        const v = r.vectors[k], lambda = th - sigma, rigid = lambda < 1e-5 * (sigma || scale * 1e-4) ;
        const eff: [number, number, number] = [0, 0, 0];
        for (let e = 0; e < nel; e++) for (let a = 0; a < nbs[e]; a++) for (let c = 0; c < 3; c++) eff[c] += Sel[e][a] * v[off[e] + 3 * a + c];
        for (let c = 0; c < 3; c++) eff[c] = (eff[c] * eff[c]) / (mass || 1);
        return { lambda: rigid ? 0 : lambda, hz: rigid ? 0 : Math.sqrt(Math.max(lambda, 0)) / (2 * Math.PI), rigid, eff, x: v };
      });
      return r.vectors[0] ?? new Float64Array(n);
    };
  }
  // inertia relief: the balanced loads leave the rigid motions without stiffness, so K + σM is solved (σ far under
  // the first elastic mode) and the answer corrected once with the mass term on the right
  let reliefM: ((v: Float64Array, y: Float64Array) => void) | null = null;
  if (relief) {
    const Ld = Math.hypot(pb.hi[0] - pb.lo[0], pb.hi[1] - pb.lo[1], pb.hi[2] - pb.lo[2]) || 1, sigma = 1e-4 * stiffRho() / (Ld * Ld);
    const Ms: Float64Array[] = [];
    for (let e = 0; e < nel; e++) {
      const E = grid.elems[e], ne = nbs[e], M = new Float64Array(ne * ne), rho = rhoOf(e);
      for (const ci of E.cells) {
        const Q = grid.cells[ci].pts;
        for (let k = 0; k < Q.n; k++) {
          const o = 4 * k, w = Q.a[o + 3] * rho * sigma;
          bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], E.c, E.s);
          for (let a = 0; a < ne; a++) { const va = bas.v[a] * w; for (let b = 0; b < ne; b++) M[a * ne + b] += va * bas.v[b]; }
        }
      }
      Ms.push(M);
      const K = A.block(e, e), mm = 3 * ne;
      for (let a = 0; a < ne; a++) for (let b = 0; b < ne; b++) for (let c = 0; c < 3; c++) K[(3 * a + c) * mm + 3 * b + c] += M[a * ne + b];
    }
    reliefM = (v, y) => {
      for (let e = 0; e < nel; e++) {
        const M = Ms[e], ne = nbs[e], o = off[e];
        for (let a = 0; a < ne; a++) for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let b = 0; b < ne; b++) s += M[a * ne + b] * v[o + 3 * b + c];
          y[o + 3 * a + c] = s;
        }
      }
    };
  }
  const t2 = now();
  let xs: Float64Array, t3: number, iterations = 0;
  const useCg = pb.solver === "pcg" || (pb.solver !== "direct" && p >= 2 && A.size > DIRECT_LIMIT);
  if (modalRun) {
    t3 = t2;
    xs = modalRun();
  } else if (useCg) {
    const S = pcgSolver(A, { coarse: 3 * basisSize(1), tol: pb.tol ?? 1e-8 }), r = S.solve(f);
    xs = r.x; iterations = r.iterations;
    t3 = t2 + S.setup;
    if (reliefM) {
      const y = new Float64Array(f.length);
      reliefM(xs, y);
      for (let i = 0; i < y.length; i++) y[i] += f[i];
      const r2 = S.solve(y, xs);
      xs = r2.x; iterations += r2.iterations;
    }
  } else {
    const L = new Envelope(A);
    t3 = now();
    xs = L.solve(f);
    if (reliefM) { const y = new Float64Array(f.length); reliefM(xs, y); for (let i = 0; i < y.length; i++) y[i] += f[i]; xs = L.solve(y); }
  }

  const t4 = now();
  let energy = 0;
  for (let i = 0; i < f.length; i++) energy += f[i] * xs[i];
  energy /= 2;
  // every element in the layout of the highest degree: zeros for the functions a lower one does not have
  let x = xs;
  if (deg) {
    x = new Float64Array(nel * m);
    for (let e = 0; e < nel; e++) x.set(xs.subarray(off[e], off[e + 1]), e * m);
  }

  // reactions: the Nitsche flux P (σ(u) n − 2γ u) over each support
  const sn = [0, 0, 0], uu = [0, 0, 0];
  const reactions = pb.fixed.map(s => {
    const R: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
    located(s.tris, (e, px, py, pz, w, nrm) => {
      const E = grid.elems[e];
      bas.eval(px, py, pz, E.c, E.s);
      setMat(e);
      if (s.spring) {
        // the springs' pull: −K u
        springAt(s, nrm);
        uu[0] = uu[1] = uu[2] = 0;
        for (let b = 0; b < nb; b++) for (let d = 0; d < 3; d++) uu[d] += bas.v[b] * x[e * m + 3 * b + d];
        add(R, px, py, pz, -w * (P[0] * uu[0] + P[1] * uu[1] + P[2] * uu[2]), -w * (P[3] * uu[0] + P[4] * uu[1] + P[5] * uu[2]), -w * (P[6] * uu[0] + P[7] * uu[1] + P[8] * uu[2]));
        return;
      }
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
      if (s.value) for (let c = 0; c < 3; c++) uu[c] -= s.value[c];
      for (let c = 0; c < 3; c++) sn[c] -= 2 * gam[e] * uu[c];
      add(R, px, py, pz, w * (P[0] * sn[0] + P[1] * sn[1] + P[2] * sn[2]), w * (P[3] * sn[0] + P[4] * sn[1] + P[5] * sn[2]), w * (P[6] * sn[0] + P[7] * sn[1] + P[8] * sn[2]));
    });
    // the penalty's pull: −w P u
    heldAt(s, (c, px, py, pz, w) => {
      const e = grid.cells[c].el, E = grid.elems[e];
      bas.eval(px, py, pz, E.c, E.s);
      holdMatrix(s, N0, P);
      uu[0] = uu[1] = uu[2] = 0;
      for (let b = 0; b < nb; b++) for (let d = 0; d < 3; d++) uu[d] += bas.v[b] * x[e * m + 3 * b + d];
      if (s.value) for (let c = 0; c < 3; c++) uu[c] -= s.value[c];
      add(R, px, py, pz, -w * (P[0] * uu[0] + P[1] * uu[1] + P[2] * uu[2]), -w * (P[3] * uu[0] + P[4] * uu[1] + P[5] * uu[2]), -w * (P[6] * uu[0] + P[7] * uu[1] + P[8] * uu[2]));
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
      setMat(e);
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
  // with an enforced displacement f·x / 2 is not the strain energy: the integral is
  if (pb.fixed.some(q => q.value)) energy = strain;
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
    setMat(grid.cells[c].el);
    return grid.cells[c].el;
  };
  return {
    grid, p, dofs: A.size, x, energy, iterations,
    ms: { grid: t1 - t0, assemble: t2 - t1, factor: t3 - t2, solve: t4 - t3 },
    reactions, applied, eta, prevError, accel,
    modes, space, mass: modal ? mass : undefined,
    use(k) { const v = modes?.[k]; if (v) x = v.x; },
    sample(pos, nrm, hits) {
      const n = pos.length / 3, u = new Float32Array(3 * n), vm = new Float32Array(n), err = new Float32Array(n);
      const hit = hits ? new Uint8Array(n) : undefined, dom = doms ? new Uint8Array(n) : undefined;
      const eps = 1e-6 * grid.h, G = new Float64Array(9);
      for (let i = 0; i < n; i++) {
        let px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
        if (nrm) { px -= eps * nrm[3 * i]; py -= eps * nrm[3 * i + 1]; pz -= eps * nrm[3 * i + 2]; }
        // asked with `hits`: a point outside the grid's box has no value (the nearest cell's would be an extrapolation)
        if (hit && (px < grid.lo[0] - eps || py < grid.lo[1] - eps || pz < grid.lo[2] - eps || px > grid.lo[0] + grid.n[0] * grid.h + eps || py > grid.lo[1] + grid.n[1] * grid.h + eps || pz > grid.lo[2] + grid.n[2] * grid.h + eps)) continue;
        const e = at(px, py, pz);
        if (e < 0) continue;
        if (hit) hit[i] = 1;
        if (dom) dom[i] = domE[e];
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
      return { u, vm, err, ...(hit ? { hit } : {}), ...(dom ? { dom } : {}) };
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


/** The part of triangles (9 numbers each) on the side of the plane through `p` that `down` points to. */
export function wetted(tris: ArrayLike<number>, p: ArrayLike<number>, down: ArrayLike<number>): Float64Array {
  const out: number[] = [];
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const V = [0, 1, 2].map(k => [tris[o + 3 * k], tris[o + 3 * k + 1], tris[o + 3 * k + 2]]);
    const d = V.map(v => (v[0] - p[0]) * down[0] + (v[1] - p[1]) * down[1] + (v[2] - p[2]) * down[2]);
    // the polygon below the surface, in the triangle's own winding
    const poly: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const a = V[k], b = V[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
      if (da >= 0) poly.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) { const u = da / (da - db); poly.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])]); }
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
  }
  return Float64Array.from(out);
}

/** P (row-major 3×3): the projector on the directions a support holds at a point with normal n. */
export function holdMatrix(s: Support, n: ArrayLike<number>, P: Float64Array) {
  P.fill(0);
  const mode = s.mode ?? "fixed";
  if (mode === "fixed") { P[0] = P[4] = P[8] = 1; return; }
  if (mode === "dirs") { const d = s.dirs ?? [true, true, true]; if (d[0]) P[0] = 1; if (d[1]) P[4] = 1; if (d[2]) P[8] = 1; return; }
  if (mode === "tangent") { for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) P[3 * c + d] = (c === d ? 1 : 0) - n[c] * n[d]; return; }
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
    // what holds: (place, weight) samples with the projector set
    const each = (fn: (r: number[], w: number) => void) => {
      for (let t = 0; t < ar.length; t++) {
        if (!(ar[t] > 0)) continue;
        holdMatrix(s, [nrm[3 * t], nrm[3 * t + 1], nrm[3 * t + 2]], P);
        for (let k = 0; k < 3; k++) { const o = 9 * t + 3 * k; fn([s.tris[o], s.tris[o + 1], s.tris[o + 2]], ar[t] / 3); }
      }
      // edges and points count by length × L and by L²: only their rank matters here
      const S = s.lines, Q = s.points;
      if (S?.length || Q?.length) holdMatrix(s, [0, 0, 0], P);
      if (S) for (let o = 0; o + 8 < S.length; o += 9) {
        const l = Math.hypot(S[o + 3] - S[o], S[o + 4] - S[o + 1], S[o + 5] - S[o + 2]) * L;
        if (!(l > 0)) continue;
        fn([S[o], S[o + 1], S[o + 2]], l / 6); fn([S[o + 3], S[o + 4], S[o + 5]], l / 6);
        fn([(S[o] + S[o + 3]) / 2, (S[o + 1] + S[o + 4]) / 2, (S[o + 2] + S[o + 5]) / 2], 2 * l / 3);
      }
      if (Q) for (let o = 0; o + 5 < Q.length; o += 6) fn([Q[o], Q[o + 1], Q[o + 2]], L * L);
    };
    each((q, w) => {
      const r = [(q[0] - c[0]) / L, (q[1] - c[1]) / L, (q[2] - c[2]) / L];
      // columns: three translations, three rotations ω × r
      R.fill(0);
      R[0] = R[7] = R[14] = 1;
      R[4] = r[2]; R[5] = -r[1]; R[9] = -r[2]; R[11] = r[0]; R[15] = r[1]; R[16] = -r[0];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) PR[i * 6 + j] = P[3 * i] * R[j] + P[3 * i + 1] * R[6 + j] + P[3 * i + 2] * R[12 + j];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        C[i * 6 + j] += w * (PR[i] * PR[j] + PR[6 + i] * PR[6 + j] + PR[12 + i] * PR[12 + j]);
        F[i * 6 + j] += w * (R[i] * R[j] + R[6 + i] * R[6 + j] + R[12 + i] * R[12 + j]);
      }
      area += w;
    });
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
  // edges and points alone do not span the six motions: a faint whole-body term keeps the comparison sound
  for (let k = 0; k < 8; k++) {
    const r = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1].map((sg, a2) => (sg * (hi[a2] - lo[a2])) / (2 * L));
    R.fill(0);
    R[0] = R[7] = R[14] = 1;
    R[4] = r[2]; R[5] = -r[1]; R[9] = -r[2]; R[11] = r[0]; R[15] = r[1]; R[16] = -r[0];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) Fall[i * 6 + j] += 1e-6 * (total / 8) * (R[i] * R[j] + R[6 + i] * R[6 + j] + R[12 + i] * R[12 + j]);
  }
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

/** Summed length of segments of 9 numbers. */
export function lineLength(S: ArrayLike<number>): number {
  let len = 0;
  for (let o = 0; o + 8 < S.length; o += 9) len += Math.hypot(S[o + 3] - S[o], S[o + 4] - S[o + 1], S[o + 5] - S[o + 2]);
  return len;
}
