// Structural analysis (FR-SOL-001, FR-SARC-011..013): linear static solve of one body.
// Each element (an aggregated group of cells) carries a complete polynomial of degree p per displacement
// component. Elements are joined by the symmetric interior penalty method, fixed supports are imposed
// weakly (Nitsche) on boundary triangles, loads are tractions on boundary triangles.
// Units: mm, N, MPa (so E in MPa, density in t/mm³).

import { Basis, basisSize } from "./basis";
import { gauss, gridTrianglePoints, facePoints, fitFacePoints, type Inside } from "./quad";
import { makeGrid, memoryBytes, refit, type Grid } from "./grid";
import { BlockMatrix } from "./sparse";
import { BlockCholesky, cholPlan, type CholPlan } from "./blockchol";
import { pcgSolver, cholesky } from "./pcg";
import { subspace } from "./eigen";
import { progress } from "./progress";
import { kernel, parallelFor, sharedF64, sharedI32, worthSharing, type ParJob } from "./threads";

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

/**
 * A bolt (FR-CON-020): an elastic beam of round section between the motion of two patches, each averaged
 * over its triangles (mean displacement and mean rotation). The fastener itself is not one of the solids.
 */
export interface Bolt {
  /** Triangles under the head, and those the nut (or the thread) holds. */
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  /** Shank diameter, mm, and Young's modulus, MPa. */
  d: number;
  E: number;
  nu?: number;
  /** Tension the tightening leaves in the bolt before the loads act, N. */
  preload?: number;
}

/**
 * A weld (FR-CON-022): two bodies that meet along a line share its motion there through an elastic strip.
 * `lines` = segments of an edge of one body (9 numbers each: both ends and a direction into that body); the
 * other body is the one found beside each point. `k` = the strip's stiffness per length, N/mm² (default: the
 * softer body's elastic modulus, a strip as wide as it is thick).
 */
export interface Weld {
  lines: ArrayLike<number>;
  k?: number;
  /**
   * Spot welds (FR-CON-024) instead of lines: 6 numbers per spot, a point on a face of one body and the
   * direction into that body. The spot goes through the body to the next one behind it and joins the two over
   * a disc of diameter `d`, mm, there; `k` = stiffness per area, N/mm³ (default: the joining penalty).
   */
  spots?: ArrayLike<number>;
  d?: number;
}

export interface WeldResult {
  /** What the first body passes to the second through the weld, N, and the length that was joined, mm. */
  force: [number, number, number];
  length: number;
  /** Largest and mean force per length, N/mm. */
  peak: number;
  mean: number;
  /** Where the largest is. */
  at: [number, number, number];
  /** Spot welds: how many spots joined two bodies; `length` is then their area, mm², and `peak` and `mean`
   * the largest and the mean force of one spot, N. */
  spots?: number;
}

/**
 * A connector (FR-CON-023) between two patches of faces: each patch moves as its mean displacement and rotation,
 * and the two are tied at the point midway between their centres. Without `k` the tie is rigid; with it, a spring
 * of `k` N/mm along X, Y and Z, and `kr` N·mm/rad against a relative turn (left out: the two cannot turn against each other).
 */
export interface Connector {
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  k?: ArrayLike<number>;
  kr?: number;
}

export interface ConnectorResult {
  /** What patch a passes to patch b: force, N, and moment at the midpoint, N·mm. */
  force: [number, number, number];
  moment: [number, number, number];
  /** How far b moved from a at the midpoint, mm. */
  stretch: [number, number, number];
  a: number[]; b: number[];
}

/** Mass spread evenly over faces (FR-CON-023): it weighs under gravity and spinning, and counts in modal solves. `mass` in t. */
export interface FaceMass {
  tris: ArrayLike<number>;
  mass: number;
}

export interface BoltResult {
  /** Tension (pulling the two patches together), N; with a preload it starts from it. */
  axial: number;
  /** Shear force, N, the larger end bending moment and the twisting moment, N·mm. */
  shear: number;
  moment: number;
  torsion: number;
  /** Centres of the two patches and the beam's length between them, mm. */
  a: number[]; b: number[]; length: number;
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
  domains?: { inside: Inside; mat: Material; tris: ArrayLike<number>; rigid?: boolean }[];
  /**
   * Domains are also joined across a gap up to this wide, mm (imprecise assemblies, FR-CON-003): a point of
   * one's surface is on another when a step of the gap along its normal ends inside it.
   */
  gap?: number;
  /** How pairs of domains are joined where they touch, when not bonded: sliding (only the motion across the
   * surface is shared) or not at all. */
  links?: { a: number; b: number; type: "sliding" | "none" | "adhesive"; kn?: number; kt?: number }[];
  fixed: Support[];
  loads: Load[];
  bolts?: Bolt[];
  welds?: Weld[];
  connectors?: Connector[];
  masses?: FaceMass[];
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
  /**
   * Thermal strain (FR-LOAD-011, FRS-thermal FR-TREP-012): α (T − ref) in every direction, `alpha` 1/K. `field`
   * gives the temperature °C (and its gradient K/mm when `grad`) at points (3 numbers each). The loads that are
   * consistent with σ = D(ε − ε_th): the body force −β∇T and the traction β (T − ref) n on `tris` (the surface
   * less the faces whose motion supports hold), β = (3λ + 2μ) α. Stresses are reported less β (T − ref) I.
   * With `domains`, `alphas` gives each domain's α (a rigid one takes none) and the domains' joining terms
   * carry the thermal part of their shared traction, so bodies of different expansion push on each other.
   */
  thermo?: { alpha: number; alphas?: ArrayLike<number>; ref: number; field: TempField; tris: ArrayLike<number> };
  /** The most memory the stiffness matrix may take, bytes (default `MEMORY_LIMIT`); more = E-SIM-MEMORY: <MB>. */
  memory?: number;
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

/**
 * Two domains joined where they touch. After a static solve: `force` = what a passes to b over the patch, N,
 * `moment` = its moment about the patch's centre `at`, N·mm (FR-RES-008).
 */
export interface Contact {
  a: number; b: number; area: number; type: "bonded" | "sliding" | "adhesive";
  force?: [number, number, number]; moment?: [number, number, number]; at?: [number, number, number];
}

export interface StaticResult {
  grid: Grid;
  p: number;
  dofs: number;
  /** What the stiffness matrix took, bytes. */
  memory: number;
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
  /** With `domains`: the pairs found touching, the area they share (mm²) and how they are joined. */
  contacts?: Contact[];
  /** Per bolt, in the order given (static solves). */
  bolts?: BoltResult[];
  welds?: WeldResult[];
  connectors?: ConnectorResult[];
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
/** The memory budget of a solve (NFR-SIM-005), bytes. */
export const MEMORY_LIMIT = 1.5 * 2 ** 30;
/** What the stiffness matrix of a pass takes, bytes (FR-SOL-020): degree `p`, or each element's own up to `p`. */
export function staticMemory(grid: Grid, p: number, degrees?: ArrayLike<number> | null): number {
  return memoryBytes(grid, e => 3 * basisSize(degrees ? Math.min(p, Math.max(1, degrees[e])) : p));
}
/** The megabytes an E-SIM-MEMORY error names. */
export const memoryMb = (bytes: number) => Math.ceil(bytes / 2 ** 20);
/** The same for a modal solve, where one factorisation serves many solves. */
export const MODAL_DIRECT = 9000;
/**
 * Above those sizes the direct solver is still used while its factorisation is cheap: a slender part (a shaft,
 * a strip) has a narrow envelope whatever its size, and the iterative solver suits it badly (a 12 000-unknown
 * shaft's modal pass took 160 s with it, 15 s without). Multiplications of the factorisation, and its values.
 */
export const DIRECT_FLOPS = 4e10, MODAL_FLOPS = 2e11, DIRECT_VALUES = 5e7;
/** Whether the direct solver is the one to use for A (and the element order it found, to factor with). */
export function directFits(A: BlockMatrix, limit: number, flops: number): { direct: boolean; plan?: CholPlan } {
  const plan = cholPlan(A);
  if (A.size <= limit) return { direct: true, plan };
  return { direct: plan.flops <= flops && plan.size <= DIRECT_VALUES, plan };
}

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

/** The measured penalty of a cut element: a margin over the bound, and the most it may grow over the formula. */
const PENALTY_SAFE = 1.15, PENALTY_CAP = 40;

/**
 * The largest λ of T x = λ K x for symmetric n × n matrices (row-major), T positive semi-definite and K positive
 * semi-definite with T zero on K's null space (an element's rigid motions): K is shifted by a hair to factor
 * it, then power iteration on L⁻¹ T L⁻ᵀ.
 */
export function topEigen(T: Float64Array, K: Float64Array, n: number): number {
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, K[i * n + i]);
  if (!(top > 0)) return 0;
  let L: Float64Array | null = null;
  for (let shift = 1e-9; shift < 1; shift *= 100) {
    const B = Float64Array.from(K);
    for (let i = 0; i < n; i++) B[i * n + i] += shift * top;
    if (cholesky(B, n)) { L = B; break; }
  }
  if (!L) return 0;
  let v = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), lam = 0;
  for (let i = 0; i < n; i++) v[i] = 1 + 0.5 * Math.sin(1.7 * i + 0.3);
  for (let it = 0; it < 80; it++) {
    let nv = 0;
    for (let i = 0; i < n; i++) nv += v[i] * v[i];
    nv = Math.sqrt(nv);
    if (!(nv > 0)) return 0;
    // y = L⁻ᵀ v
    for (let i = n - 1; i >= 0; i--) {
      let s = v[i] / nv;
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * y[k];
      y[i] = s / L[i * n + i];
    }
    // z = T y
    for (let i = 0; i < n; i++) { let s = 0; const r = i * n; for (let k = 0; k < n; k++) s += T[r + k] * y[k]; z[i] = s; }
    // v = L⁻¹ z
    for (let i = 0; i < n; i++) {
      let s = z[i];
      for (let k = 0; k < i; k++) s -= L[i * n + k] * v[k];
      v[i] = s / L[i * n + i];
    }
    let nw = 0;
    for (let i = 0; i < n; i++) nw += v[i] * v[i];
    nw = Math.sqrt(nw);
    if (it > 8 && Math.abs(nw - lam) < 1e-3 * nw) { lam = nw; break; }
    lam = nw;
  }
  void y; void z;
  return lam;
}

/**
 * Raises the penalty of the elements the body cuts to what their tractions need (see `solveStatic`): kept out of
 * `solveStatic`, which must stay small enough for the browser's compiler to optimise its loops.
 */
function measurePenalty(grid: Grid, nel: number, nbs: ArrayLike<number>, gam: Float64Array, p: number, rigid: (e: number) => boolean,
  facePts: (c: number, ea: number, eb: number, axis: number) => { n: number; a: ArrayLike<number> },
  lameOf: (e: number) => { lam: number; mu: number }, A: BlockMatrix, bas: Basis, surf: ArrayLike<number>[]) {
  const cutE = new Uint8Array(nel);
  let any = false;
  for (let e = 0; e < nel; e++) if (!rigid(e) && grid.elems[e].cells.some(c => grid.cells[c].frac < 1 - 1e-9)) { cutE[e] = 1; any = true; }
  if (!any) return;
  // the supports' faces and the domains' surfaces, located once
  const tq0 = Math.max(2, p + 1), eps = 1e-7 * grid.h;
  const held: Float64Array[] = surf.map(tris => {
    const { pts, tri } = gridTrianglePoints(tris, grid.lo, grid.h, tq0), nrms = triNormals(tris), L = new Float64Array(8 * pts.n);
    let m = 0;
    for (let q2 = 0; q2 < pts.n; q2++) {
      const o4 = 4 * q2, t = tri[q2], nx = nrms[3 * t], ny = nrms[3 * t + 1], nz = nrms[3 * t + 2];
      const x = pts.a[o4], y = pts.a[o4 + 1], z = pts.a[o4 + 2];
      const c = grid.cellOf(x - eps * nx, y - eps * ny, z - eps * nz);
      if (c < 0 || !cutE[grid.cells[c].el]) continue;
      L.set([grid.cells[c].el, x, y, z, pts.a[o4 + 3], nx, ny, nz], 8 * m++);
    }
    return L.subarray(0, 8 * m);
  });
  // the samples of each cut element (place, weight, normal), in the order they are met: one task per element
  const faces = (each: (e: number, x: number, y: number, z: number, w: number, nx: number, ny: number, nz: number) => void) => {
    for (let c = 0; c < grid.cells.length; c++) {
      const [i, j, k] = grid.cells[c].ijk, d = grid.cells[c].dom, ea = grid.cells[c].el;
      for (let axis = 0; axis < 3; axis++) {
        const o = grid.at(i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), k + (axis === 2 ? 1 : 0), d);
        if (o < 0) continue;
        const eb = grid.cells[o].el;
        if (ea === eb || !(cutE[ea] || cutE[eb])) continue;
        const pts = facePts(c, ea, eb, axis), nx = axis === 0 ? 1 : 0, ny = axis === 1 ? 1 : 0, nz = axis === 2 ? 1 : 0;
        for (let q2 = 0; q2 < pts.n; q2++) {
          const o4 = 4 * q2;
          if (cutE[ea]) each(ea, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], nx, ny, nz);
          if (cutE[eb]) each(eb, pts.a[o4], pts.a[o4 + 1], pts.a[o4 + 2], pts.a[o4 + 3], nx, ny, nz);
        }
      }
    }
    for (const L of held) for (let o = 0; o < L.length; o += 8) each(L[o], L[o + 1], L[o + 2], L[o + 3], L[o + 4], L[o + 5], L[o + 6], L[o + 7]);
  };
  const count = new Int32Array(nel);
  faces(e => { count[e]++; });
  const els: number[] = [];
  let total = 0, work = 0, size = 0;
  for (let e = 0; e < nel; e++) if (count[e]) { const mm = 3 * nbs[e]; els.push(e); total += count[e]; work += count[e] * mm * mm * 2 + 60 * mm ** 3; size += mm * mm; }
  if (!els.length) return;
  const shared = worthSharing(work), f64 = (m: number) => (shared ? sharedF64(m) : new Float64Array(m));
  const sam = f64(7 * total), task = f64(SMEAS * els.length), blocks = f64(size), out = f64(els.length), fill = new Int32Array(nel);
  let from = 0, bo = 0;
  els.forEach((e, t) => {
    const E = grid.elems[e], mm = 3 * nbs[e], L = lameOf(e);
    task.set([from, from + count[e], bo, E.c[0], E.c[1], E.c[2], E.s, nbs[e], L.lam, L.mu], SMEAS * t);
    blocks.set(A.block(e, e).subarray(0, mm * mm), bo);
    fill[e] = from;
    from += count[e];
    bo += mm * mm;
  });
  faces((e, x, y, z, w, nx, ny, nz) => { const o = 7 * fill[e]++; sam[o] = x; sam[o + 1] = y; sam[o + 2] = z; sam[o + 3] = w; sam[o + 4] = nx; sam[o + 5] = ny; sam[o + 6] = nz; });
  if (shared) parallelFor({ kind: "smeasure", n: els.length, p: bas.p, sam, task, blocks, out } satisfies Omit<SMeasureJob, "ctl">);
  else {
    const nb = bas.v.length, T = new Float64Array(9 * nb * nb), M = new Float64Array(9 * nb);
    for (let t = 0; t < els.length; t++) out[t] = measureCell(t, sam, task, blocks, bas, T, M);
  }
  els.forEach((e, t) => {
    // never under the formula, and not without bound: a cell that keeps almost none of some function
    const need = Math.min(PENALTY_CAP * gam[e], PENALTY_SAFE * 2 * out[t]);
    if (need > gam[e]) gam[e] = need;
  });
}
/** Numbers per element of a penalty loop: first and end sample, place of its block, centre, half size, functions, λ, μ. */
const SMEAS = 10;
/** The largest λ of T x = λ K x of one cut element: T = Σ w (σ n)ᵀ(σ n) over its samples, K its stiffness block. */
function measureCell(t: number, sam: ArrayLike<number>, task: ArrayLike<number>, blocks: Float64Array, bas: Basis, TT: Float64Array, M: Float64Array): number {
  const o = SMEAS * t, n = task[o + 7], mm = 3 * n, cc = [task[o + 3], task[o + 4], task[o + 5]], sz = task[o + 6], lam = task[o + 8], mu = task[o + 9];
  const T = TT.subarray(0, mm * mm), nrm = [0, 0, 0];
  T.fill(0);
  for (let q = task[o]; q < task[o + 1]; q++) {
    const s = 7 * q, w = sam[s + 3];
    nrm[0] = sam[s + 4]; nrm[1] = sam[s + 5]; nrm[2] = sam[s + 6];
    bas.eval(sam[s], sam[s + 1], sam[s + 2], cc, sz, n);
    for (let b2 = 0; b2 < n; b2++) traction(bas.g, 3 * b2, nrm, lam, mu, M, 9 * b2);
    for (let a = 0; a < n; a++) for (let c = 0; c < 3; c++) {
      const s0 = w * M[9 * a + c], s1 = w * M[9 * a + 3 + c], s2 = w * M[9 * a + 6 + c], row = (3 * a + c) * mm;
      for (let b2 = 0; b2 <= a; b2++) {
        const o9 = 9 * b2, r = row + 3 * b2;
        T[r] += s0 * M[o9] + s1 * M[o9 + 3] + s2 * M[o9 + 6];
        T[r + 1] += s0 * M[o9 + 1] + s1 * M[o9 + 4] + s2 * M[o9 + 7];
        T[r + 2] += s0 * M[o9 + 2] + s1 * M[o9 + 5] + s2 * M[o9 + 8];
      }
    }
  }
  for (let r = 0; r < mm; r++) for (let c = 0; c < r; c++) T[c * mm + r] = T[r * mm + c];
  return topEigen(T, blocks.subarray(task[o + 2], task[o + 2] + mm * mm), mm);
}
interface SMeasureJob extends ParJob { p: number; sam: Float64Array; task: Float64Array; blocks: Float64Array; out: Float64Array }
kernel<SMeasureJob, { j: SMeasureJob; bas: Basis; T: Float64Array; M: Float64Array }>("smeasure", {
  init: j => { const bas = new Basis(j.p), nb = bas.v.length; return { j, bas, T: new Float64Array(9 * nb * nb), M: new Float64Array(9 * nb) }; },
  run({ j, bas, T, M }, t) { j.out[t] = measureCell(t, j.sam, j.task, j.blocks, bas, T, M); },
});

/** A rigid domain's stiffness beside the stiffest material of the model. */
const RIGID_STIFF = 1e3;

/**
 * The stiffness of one cell's quadrature points into its element's matrix (blocks b ≥ a; see mirrorBlocks).
 * Kept out of solveStatic, like the other hot loops: inside that long function Chrome ran this one unoptimised
 * (37 s for a 12 000-unknown shaft at degree 4, 3 s here).
 */
function volumeCell(K: Float64Array, P: { a: ArrayLike<number>; n: number }, bas: Basis, c: number[], sz: number, nb: number, lam: number, mu: number) {
  const m = 3 * nb, g = bas.g, lm = lam + mu;
  for (let k = 0; k < P.n; k++) {
    const o = 4 * k, w = P.a[o + 3];
    bas.eval(P.a[o], P.a[o + 1], P.a[o + 2], c, sz);
    for (let a = 0; a < nb; a++) {
      const ax = g[3 * a] * w, ay = g[3 * a + 1] * w, az = g[3 * a + 2] * w;
      for (let b = a; b < nb; b++) {
        const bx = g[3 * b], by = g[3 * b + 1], bz = g[3 * b + 2];
        const md = mu * (ax * bx + ay * by + az * bz);
        // K[(a,c),(b,d)] = λ ga_c gb_d + μ ga_d gb_c + δ_cd μ ga·gb
        let r = 3 * a * m + 3 * b;
        K[r] += lm * ax * bx + md; K[r + 1] += lam * ax * by + mu * ay * bx; K[r + 2] += lam * ax * bz + mu * az * bx;
        r += m;
        K[r] += lam * ay * bx + mu * ax * by; K[r + 1] += lm * ay * by + md; K[r + 2] += lam * ay * bz + mu * az * by;
        r += m;
        K[r] += lam * az * bx + mu * ax * bz; K[r + 1] += lam * az * by + mu * ay * bz; K[r + 2] += lm * az * bz + md;
      }
    }
  }
}

/** Every element's stiffness from its cells' quadrature points: on all threads when there are several and the work is worth it. */
function volumeTerms(A: BlockMatrix, grid: Grid, nbs: Int32Array, bas: Basis, lameOf: (e: number) => { lam: number; mu: number }) {
  const nel = grid.elems.length;
  let work = 0, npt = 0;
  for (let e = 0; e < nel; e++) for (const ci of grid.elems[e].cells) { const n = grid.cells[ci].pts.n; npt += n; work += n * nbs[e] * nbs[e] * 5; }
  if (!worthSharing(work)) {
    for (let e = 0; e < nel; e++) {
      progress("assemble", e, 2 * nel);
      const E = grid.elems[e], K = A.block(e, e), nb = nbs[e], L = lameOf(e);
      for (const ci of E.cells) volumeCell(K, grid.cells[ci].pts, bas, E.c, E.s, nb, L.lam, L.mu);
      mirrorBlocks(K, nb);
    }
    return;
  }
  // the points, the elements and the blocks they fill, on shared memory: one task per element
  const pts = sharedF64(4 * npt), at = sharedF64(VOL_TASK * nel + 1), nb = sharedI32(nel);
  let n = 0, size = 0;
  for (let e = 0; e < nel; e++) {
    const E = grid.elems[e], o = VOL_TASK * e, L = lameOf(e);
    at[o] = n;
    for (const ci of E.cells) { const P = grid.cells[ci].pts; pts.set(P.a.subarray(0, 4 * P.n), 4 * n); n += P.n; }
    at[o + 1] = n; at[o + 2] = size; at[o + 3] = E.c[0]; at[o + 4] = E.c[1]; at[o + 5] = E.c[2]; at[o + 6] = E.s; at[o + 7] = L.lam; at[o + 8] = L.mu;
    nb[e] = nbs[e];
    size += 9 * nbs[e] * nbs[e];
  }
  const out = sharedF64(size);
  parallelFor({ kind: "volume", n: nel, p: bas.p, pts, at, nb, out } satisfies Omit<VolumeJob, "ctl">, d => progress("assemble", d, 2 * nel));
  for (let e = 0; e < nel; e++) { const o = at[VOL_TASK * e + 2]; A.adopt(e, out.subarray(o, o + 9 * nbs[e] * nbs[e])); }
}
/**
 * The terms of the faces between cells of different elements. On one thread each face goes through `one`. On
 * several, the faces are worked through in batches: every thread sums faces' blocks into its own part of a shared
 * scratch, and this thread adds them to the matrix in the faces' order, so the sums are the same either way.
 */
function faceTerms(A: BlockMatrix, grid: Grid, nbs: Int32Array, gam: Float64Array, p: number, lameOf: (e: number) => { lam: number; mu: number },
  facePts: (ca: number, ea: number, eb: number, axis: number) => { a: ArrayLike<number>; n: number }, one: (ca: number, cb: number, axis: number) => void) {
  const faces: number[] = [];
  let work = 0;
  for (let c = 0; c < grid.cells.length; c++) {
    const [i, j, k] = grid.cells[c].ijk, d = grid.cells[c].dom, ea = grid.cells[c].el;
    const nx = [grid.at(i + 1, j, k, d), grid.at(i, j + 1, k, d), grid.at(i, j, k + 1, d)];
    for (let axis = 0; axis < 3; axis++) {
      const cb = nx[axis];
      if (cb < 0 || grid.cells[cb].el === ea) continue;
      faces.push(c, cb, axis);
      work += (p + 1) ** 2 * (nbs[ea] + nbs[grid.cells[cb].el]) ** 2 * 6;
    }
  }
  const nf = faces.length / 3, nel = grid.elems.length;
  if (!worthSharing(work)) {
    for (let f = 0; f < nf; f++) { if (!(f & 15)) progress("assemble", nel + (f * nel) / nf, 2 * nel); one(faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]); }
    return;
  }
  const nb = basisSize(p), slot = 3 * 9 * nb * nb;
  const B = Math.max(1, Math.min(nf, 512, Math.floor(FACE_SCRATCH / (8 * slot))));
  const out = sharedF64(B * slot), task = sharedF64(FACE_TASK * B);
  let pts = sharedF64(4 * B * (2 * p + 1) ** 2);
  for (let f0 = 0; f0 < nf; f0 += B) {
    const n = Math.min(B, nf - f0);
    let np = 0;
    for (let t = 0; t < n; t++) {
      const ca = faces[3 * (f0 + t)], cb = faces[3 * (f0 + t) + 1], axis = faces[3 * (f0 + t) + 2];
      const ea = grid.cells[ca].el, eb = grid.cells[cb].el, EA = grid.elems[ea], EB = grid.elems[eb], L = lameOf(ea);
      const P = facePts(ca, ea, eb, axis);
      if (4 * (np + P.n) > pts.length) { const more = sharedF64(Math.max(2 * pts.length, 4 * (np + P.n))); more.set(pts.subarray(0, 4 * np)); pts = more; }
      pts.set((P.a as Float64Array).subarray(0, 4 * P.n), 4 * np);
      task.set([np, P.n, axis, EA.c[0], EA.c[1], EA.c[2], EA.s, EB.c[0], EB.c[1], EB.c[2], EB.s, nbs[ea], nbs[eb], L.lam, L.mu, Math.max(gam[ea], gam[eb])], FACE_TASK * t);
      np += P.n;
    }
    parallelFor({ kind: "faces", n, p, slot, pts, task, out } satisfies Omit<FaceJob, "ctl">);
    progress("assemble", nel + ((f0 + n) * nel) / nf, 2 * nel);
    for (let t = 0; t < n; t++) {
      const ea = grid.cells[faces[3 * (f0 + t)]].el, eb = grid.cells[faces[3 * (f0 + t) + 1]].el, na = nbs[ea], nc = nbs[eb], ma = 3 * na, mc = 3 * nc;
      const o = slot * t, q = slot / 3;
      const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
      addSym(Kaa, out.subarray(o, o + ma * ma), na); addSym(Kbb, out.subarray(o + 2 * q, o + 2 * q + mc * mc), nc);
      const Sab = out.subarray(o + q, o + q + ma * mc);
      for (let i = 0; i < ma; i++) for (let j = 0; j < mc; j++) { const v = Sab[i * mc + j]; Kab[i * mc + j] += v; Kba[j * ma + i] += v; }
    }
  }
}
/** Bytes of scratch a batch of faces may take, and the numbers per face of a shared face loop: first point, points,
 * axis, the two elements' centres and half sizes, their function counts, λ, μ, penalty. */
const FACE_SCRATCH = 96e6, FACE_TASK = 16;
interface FaceJob extends ParJob { p: number; slot: number; pts: Float64Array; task: Float64Array; out: Float64Array }
kernel<FaceJob, { j: FaceJob; bas: Basis; bas2: Basis; MA: Float64Array; MB: Float64Array }>("faces", {
  init: j => { const bas = new Basis(j.p); return { j, bas, bas2: new Basis(j.p), MA: new Float64Array(9 * bas.n), MB: new Float64Array(9 * bas.n) }; },
  run({ j, bas, bas2, MA, MB }, t) {
    const k = j.task, o = FACE_TASK * t, a = j.pts, nb = bas.n, na = k[o + 11], nc = k[o + 12], lam = k[o + 13], mu = k[o + 14], gamma = k[o + 15];
    const ma = 3 * na, mc = 3 * nc, q = j.slot / 3, so = j.slot * t;
    const Saa = j.out.subarray(so, so + ma * ma), Sab = j.out.subarray(so + q, so + q + ma * mc), Sbb = j.out.subarray(so + 2 * q, so + 2 * q + mc * mc);
    Saa.fill(0); Sab.fill(0); Sbb.fill(0);
    const nrm = [0, 0, 0], ca = [k[o + 3], k[o + 4], k[o + 5]], cb = [k[o + 7], k[o + 8], k[o + 9]], sa = k[o + 6], sb = k[o + 10];
    nrm[k[o + 2]] = 1;
    for (let i = k[o], end = k[o] + k[o + 1]; i < end; i++) {
      const x = a[4 * i], y = a[4 * i + 1], z = a[4 * i + 2], w = a[4 * i + 3];
      bas.eval(x, y, z, ca, sa);
      bas2.eval(x, y, z, cb, sb);
      for (let b = 0; b < nb; b++) { traction(bas.g, 3 * b, nrm, lam, mu, MA, 9 * b); traction(bas2.g, 3 * b, nrm, lam, mu, MB, 9 * b); }
      facePair(Saa, bas.v, MA, 1, na, bas.v, MA, 1, na, w, gamma, true);
      facePair(Sab, bas.v, MA, 1, na, bas2.v, MB, -1, nc, w, gamma, false);
      facePair(Sbb, bas2.v, MB, -1, nc, bas2.v, MB, -1, nc, w, gamma, true);
    }
  },
});

/** Numbers per element of a shared volume loop: first point, end point, block offset, centre, half size, λ, μ. */
const VOL_TASK = 9;
interface VolumeJob extends ParJob { p: number; pts: Float64Array; at: Float64Array; nb: Int32Array; out: Float64Array }
kernel<VolumeJob, { j: VolumeJob; bas: Basis }>("volume", {
  init: j => ({ j, bas: new Basis(j.p) }),
  run({ j, bas }, e) {
    const a = j.at, o = VOL_TASK * e, nb = j.nb[e], m2 = 9 * nb * nb;
    const K = j.out.subarray(a[o + 2], a[o + 2] + m2);
    volumeCell(K, { a: j.pts.subarray(4 * a[o], 4 * a[o + 1]), n: a[o + 1] - a[o] }, bas, [a[o + 3], a[o + 4], a[o + 5]], a[o + 6], nb, a[o + 7], a[o + 8]);
    mirrorBlocks(K, nb);
  },
});

/** The mass of one cell's quadrature points into its element's mass matrix M and sums S; returns the cell's mass. */
function massCell(M: Float64Array, S: Float64Array, Q: { a: ArrayLike<number>; n: number }, bas: Basis, c: number[], sz: number, ne: number, rho: number): number {
  const v = bas.v;
  let mass = 0;
  for (let k = 0; k < Q.n; k++) {
    const o = 4 * k, w = Q.a[o + 3] * rho;
    bas.eval(Q.a[o], Q.a[o + 1], Q.a[o + 2], c, sz);
    mass += w;
    for (let a = 0; a < ne; a++) {
      const va = v[a] * w, r = a * ne;
      S[a] += va;
      for (let b = a; b < ne; b++) M[r + b] += va * v[b];
    }
  }
  return mass;
}

/** Copies the blocks b > a of an element matrix (n functions, 3 unknowns each) to the blocks under the diagonal. */
function mirrorBlocks(K: Float64Array, n: number) {
  const m = 3 * n;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++)
    K[(3 * b + d) * m + 3 * a + c] = K[(3 * a + c) * m + 3 * b + d];
}

/** Adds S, summed for the blocks b ≥ a only, to K with its mirror image. */
function addSym(K: Float64Array, S: Float64Array, n: number) {
  const m = 3 * n;
  for (let a = 0; a < n; a++) {
    for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) K[(3 * a + c) * m + 3 * a + d] += S[(3 * a + c) * m + 3 * a + d];
    for (let b = a + 1; b < n; b++) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) {
      const v = S[(3 * a + c) * m + 3 * b + d];
      K[(3 * a + c) * m + 3 * b + d] += v; K[(3 * b + d) * m + 3 * a + c] += v;
    }
  }
}

/**
 * The interior-face terms of one quadrature point into the block (rows i, columns j):
 * −½ s_i N_i M_j − ½ s_j N_j M_iᵀ + γ s_i s_j N_i N_j I; `upper` = only the blocks b ≥ a (i and j the same side).
 */
function facePair(K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, ni: number, Nj: Float64Array, Mj: Float64Array, sj: number, nj: number, w: number, gamma: number, upper: boolean) {
  const hw = 0.5 * w, gw = gamma * w * si * sj, m = 3 * nj;
  for (let a = 0; a < ni; a++) {
    const na = Ni[a] * si * hw, pa = gw * Ni[a], a9 = 9 * a;
    const i0 = Mi[a9], i1 = Mi[a9 + 1], i2 = Mi[a9 + 2], i3 = Mi[a9 + 3], i4 = Mi[a9 + 4], i5 = Mi[a9 + 5], i6 = Mi[a9 + 6], i7 = Mi[a9 + 7], i8 = Mi[a9 + 8];
    for (let b = upper ? a : 0; b < nj; b++) {
      const nbv = Nj[b] * sj * hw, pen = pa * Nj[b], b9 = 9 * b;
      let r = 3 * a * m + 3 * b;
      K[r] += pen - na * Mj[b9] - nbv * i0; K[r + 1] -= na * Mj[b9 + 1] + nbv * i3; K[r + 2] -= na * Mj[b9 + 2] + nbv * i6;
      r += m;
      K[r] -= na * Mj[b9 + 3] + nbv * i1; K[r + 1] += pen - na * Mj[b9 + 4] - nbv * i4; K[r + 2] -= na * Mj[b9 + 5] + nbv * i7;
      r += m;
      K[r] -= na * Mj[b9 + 6] + nbv * i2; K[r + 1] -= na * Mj[b9 + 7] + nbv * i5; K[r + 2] += pen - na * Mj[b9 + 8] - nbv * i8;
    }
  }
}

export function solveStatic(pb: StaticProblem): StaticResult {
  const t0 = now();
  const p = pb.p, q = p + 1;
  let grid = pb.grid;
  const deg0 = pb.grid && pb.degrees && pb.degrees.length === pb.grid.elems.length ? pb.degrees : null;
  if (grid) refit(grid, q, 2 * p + 1, deg0 ? c => deg0[c.el] : undefined);
  const doms = pb.domains && pb.domains.length > 1 ? pb.domains : null;
  if (!grid) grid = makeGrid(pb.lo, pb.hi, pb.h, pb.inside, { q, depth: pb.depth ?? 3, fit: 2 * p + 1, domains: doms?.map(d => d.inside), rigid: doms?.map(d => !!d.rigid) });
  const t1 = now();
  // materials: one, or one per domain; `lam`/`mu` are those of the element being worked on (`setMat`)
  // a rigid domain (FR-CON-001) keeps its density and gets a stiffness far above every other's; its one element
  // is linear, so beside its six rigid motions only six uniform strains are left, and those cost that stiffness
  const rigidD = doms ? doms.map(d => !!d.rigid) : [false], anyRigid = rigidD.some(Boolean);
  const stiffest = doms ? Math.max(...doms.map(d => (d.rigid ? 0 : d.mat.E))) || Math.max(...doms.map(d => d.mat.E)) || 1 : pb.mat.E;
  const mats = doms ? doms.map(d => (d.rigid ? { ...d.mat, E: RIGID_STIFF * stiffest, nu: 0.3 } : d.mat)) : [pb.mat], lames = mats.map(lame);
  let { lam, mu } = lames[0];
  const domE = Uint8Array.from(grid.elems, E => (doms ? grid!.cells[E.cells[0]].dom : 0));
  const setMat = (e: number) => { const L = lames[domE[e]]; lam = L.lam; mu = L.mu; };
  const rhoOf = (e: number) => mats[domE[e]].rho ?? 0;
  const rigidE = (e: number) => rigidD[domE[e]];
  // thermal strain: β = (3λ + 2μ) α per element, by its domain's material (a rigid domain has none)
  const betaE = pb.thermo ? thermoBeta(pb.thermo, grid.elems.length, domE, lames, rigidD) : null;
  const deg: ArrayLike<number> | null = anyRigid ? Int8Array.from(grid.elems, (_, e) => (rigidE(e) ? 1 : deg0 ? deg0[e] : p)) : deg0;
  const hasRho = mats.every(q => (q.rho ?? 0) > 0);
  /** The lowest E/ρ: the scale of the shift that stands in for stiffness the supports do not give. */
  const stiffRho = () => Math.min(...mats.map(q => q.E / q.rho!));
  const insideOfDom = (d: number) => (doms ? doms[d].inside : pb.inside);
  const bas = new Basis(p), bas2 = new Basis(p);
  const nb = bas.n, m = 3 * nb, nel = grid.elems.length;
  // functions per element: the leading ones of the hierarchical basis up to the element's own degree
  const nbs = new Int32Array(nel).fill(nb);
  if (deg) for (let e = 0; e < nel; e++) nbs[e] = basisSize(Math.min(p, Math.max(1, deg[e])));
  const memory = memoryBytes(grid, e => 3 * nbs[e]);
  if (memory > (pb.memory ?? MEMORY_LIMIT)) throw new Error(`E-SIM-MEMORY: ${memoryMb(memory)}`);
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
  volumeTerms(A, grid, nbs, bas, e => lames[domE[e]]);

  // interior faces between cells of different elements
  const MA = new Float64Array(9 * nb), MB = new Float64Array(9 * nb);
  const Saa = new Float64Array(9 * nb * nb), Sab = new Float64Array(9 * nb * nb), Sbb = new Float64Array(9 * nb * nb);
  /** Quadrature of the face of cell `ca` on its high side along `axis`, for the elements `ea` and `eb` it parts. */
  const fitted = new Map<number, ReturnType<typeof facePoints>>();
  const facePts = (ca: number, ea: number, eb: number, axis: number) => {
    const A0 = grid!.cells[ca];
    // fine points of a cut face are kept on the grid for later passes
    const key = ca * 3 + axis;
    // the measured penalty and the face terms both ask: the fitted points of this solve are kept
    const had = fitted.get(key);
    if (had) return had;
    let pts = grid!.faces.get(key);
    if (pts === undefined) {
      pts = facePoints(axis, A0.hi[axis], A0.lo, A0.hi, 5, insideOfDom(A0.dom), pb.depth ?? 3);
      // a whole face keeps no points: it gets the plain Gauss rule of each pass
      const area = grid!.h * grid!.h;
      grid!.faces.set(key, Math.abs(pts.weight() - area) < 1e-12 * area ? null : pts);
    }
    const pf = Math.max(pOf(ea), pOf(eb));
    const out = pts ? fitFacePoints(pts, axis, A0.hi[axis], A0.lo, A0.hi, 2 * pf + 1) : facePoints(axis, A0.hi[axis], A0.lo, A0.hi, pf + 1, () => true, 0);
    fitted.set(key, out);
    return out;
  };
  const face = (ca: number, cb: number, axis: number) => {
    const A0 = grid.cells[ca], ea = A0.el, eb = grid.cells[cb].el;
    if (ea === eb) return;
    const EA = grid.elems[ea], EB = grid.elems[eb];
    setMat(ea);
    const pts = facePts(ca, ea, eb, axis);
    const na = nbs[ea], nc = nbs[eb];
    const nrm = [0, 0, 0];
    nrm[axis] = 1;
    const Kaa = A.block(ea, ea), Kab = A.block(ea, eb), Kba = A.block(eb, ea), Kbb = A.block(eb, eb);
    gamma = Math.max(gam[ea], gam[eb]);
    // the four blocks are symmetric as a whole: aa and bb are summed for b ≥ a, ab in full, ba is its transpose
    const ma = 3 * na, mc = 3 * nc;
    Saa.fill(0, 0, ma * ma); Sab.fill(0, 0, ma * mc); Sbb.fill(0, 0, mc * mc);
    for (let k = 0; k < pts.n; k++) {
      const o = 4 * k, w = pts.a[o + 3];
      const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
      bas.eval(x, y, z, EA.c, EA.s);
      bas2.eval(x, y, z, EB.c, EB.s);
      for (let b = 0; b < nb; b++) { traction(bas.g, 3 * b, nrm, lam, mu, MA, 9 * b); traction(bas2.g, 3 * b, nrm, lam, mu, MB, 9 * b); }
      facePair(Saa, bas.v, MA, 1, na, bas.v, MA, 1, na, w, gamma, true);
      facePair(Sab, bas.v, MA, 1, na, bas2.v, MB, -1, nc, w, gamma, false);
      facePair(Sbb, bas2.v, MB, -1, nc, bas2.v, MB, -1, nc, w, gamma, true);
    }
    addSym(Kaa, Saa, na); addSym(Kbb, Sbb, nc);
    for (let i = 0; i < ma; i++) for (let j = 0; j < mc; j++) { const v = Sab[i * mc + j]; Kab[i * mc + j] += v; Kba[j * ma + i] += v; }
  };
  // a sliding joint shares only the motion along this normal (null: all of it)
  let slideN: number[] | null = null;
  // block (rows i, cols j): −½ s_i N_i M_j − ½ s_j N_j M_iᵀ + γ s_i s_j N_i N_j I
  function pair(K: Float64Array, Ni: Float64Array, Mi: Float64Array, si: number, ni: number, Nj: Float64Array, Mj: Float64Array, sj: number, nj: number, w: number) {
    const hw = 0.5 * w, gw = gamma * w * si * sj, m = 3 * nj, sn = slideN;
    for (let a = 0; a < ni; a++) {
      const na = Ni[a] * si * hw;
      for (let b = 0; b < nj; b++) {
        const nbv = Nj[b] * sj * hw, pen = gw * Ni[a] * Nj[b];
        for (let c = 0; c < 3; c++) {
          const row = (3 * a + c) * m + 3 * b;
          for (let d = 0; d < 3; d++)
            K[row + d] += -na * Mj[9 * b + c * 3 + d] - nbv * Mi[9 * a + d * 3 + c] + (sn ? pen * sn[c] * sn[d] : c === d ? pen : 0);
        }
      }
    }
  }
  // The penalty an element needs is set by how large its tractions on its faces can be beside its strain
  // energy: the largest eigenvalue of the two. On whole cells the formula above covers it. On cells the body
  // cuts it does not always (a bracket's forked lug at degree 5 came out 6 % too soft, and singular at 6), so
  // there it is measured: T = ∫ (σ n)ᵀ(σ n) over the element's faces and the supports on it, K = its stiffness
  // so far (volume terms only), γ = 2 λmax(T, K).
  {
    // the faces held by supports (not springs: those bring no flux terms), and with several domains every
    // domain's surface (where two of them meet they are joined by the same terms)
    const surf: ArrayLike<number>[] = [];
    for (const s of pb.fixed) if (!s.spring && s.tris?.length) surf.push(s.tris);
    if (doms && doms.length > 1) for (const d of doms) if (!d.rigid) surf.push(d.tris);
    measurePenalty(grid, nel, nbs, gam, p, rigidE, facePts, e => lames[domE[e]], A, bas, surf);
  }
  faceTerms(A, grid, nbs, gam, p, e => lames[domE[e]], facePts, face);

  // boundary quadrature located in cells
  const tq = Math.max(2, p + 1);
  // domains are joined where one's surface lies on another's: the same terms as between elements, each side
  // with its own material. A point of A's surface is on B when a step along the normal ends inside B.
  const contacts: Contact[] = [];
  // the joining points, kept for the connection forces: contact, elements a and b, x, y, z, w, normal, γ
  const joins: number[] = [];
  // adhesive layers (FR-CON-025): stiffness per area across and along the layer, by pair and then by contact
  const glues = new Map<number, [number, number]>(), glueOf: ([number, number] | undefined)[] = [];
  const sets: RigidSet[] = [];
  const rc = [(pb.lo[0] + pb.hi[0]) / 2, (pb.lo[1] + pb.hi[1]) / 2, (pb.lo[2] + pb.hi[2]) / 2];
  const rL = Math.hypot(pb.hi[0] - pb.lo[0], pb.hi[1] - pb.lo[1], pb.hi[2] - pb.lo[2]) / 2 || 1;
  if (doms) {
    const eps = 2e-3 * grid.h, gap = Math.max(0, pb.gap ?? 0), far = gap + eps, nd = doms.length;
    const how = new Map<number, "sliding" | "none" | "adhesive">();
    for (const l of pb.links ?? []) {
      const key = Math.min(l.a, l.b) * nd + Math.max(l.a, l.b);
      how.set(key, l.type);
      if (l.type === "adhesive") {
        if (!(l.kn! > 0) || !(l.kt! > 0)) throw new Error("E-SIM-ADHESIVE");
        glues.set(key, [l.kn!, l.kt!]);
      }
    }
    const boxes = doms.map(d => triBox(d.tris));
    const found = new Map<number, { c: Contact; set: RigidSet }>();
    const PJ = new Float64Array(9);
    for (let a = 0; a + 1 < nd; a++) {
      // only the domains whose boxes come within the gap of this one's can touch it
      const near: number[] = [];
      for (let d = a + 1; d < nd; d++) {
        if (how.get(a * nd + d) === "none") continue;
        let apart = false;
        for (let k = 0; k < 3; k++) if (boxes[a][k] > boxes[d][3 + k] + far || boxes[d][k] > boxes[a][3 + k] + far) apart = true;
        if (!apart) near.push(d);
      }
      if (!near.length) continue;
      const T = doms[a].tris, { pts, tri } = gridTrianglePoints(T, grid.lo, grid.h, tq), nrms = triNormals(T);
      for (let k = 0; k < pts.n; k++) {
        const o = 4 * k, t = tri[k], w = pts.a[o + 3];
        const nrm = [nrms[3 * t], nrms[3 * t + 1], nrms[3 * t + 2]];
        const x = pts.a[o], y = pts.a[o + 1], z = pts.a[o + 2];
        let b = -1, bx = 0, by = 0, bz = 0;
        for (const d of near) {
          const B = boxes[d];
          if (x < B[0] - far || y < B[1] - far || z < B[2] - far || x > B[3] + far || y > B[4] + far || z > B[5] + far) continue;
          for (const st of gap > 0 ? [eps, far] : [eps]) {
            bx = x + st * nrm[0]; by = y + st * nrm[1]; bz = z + st * nrm[2];
            if (doms[d].inside(bx, by, bz)) { b = d; break; }
          }
          if (b >= 0) break;
        }
        if (b < 0) continue;
        const ca = grid.cellOf(x - eps * nrm[0], y - eps * nrm[1], z - eps * nrm[2], a), cb = grid.cellOf(bx, by, bz, b);
        if (ca < 0 || cb < 0) continue;
        const slide = how.get(a * nd + b) === "sliding";
        let f = found.get(a * nd + b);
        const glue = glues.get(a * nd + b);
        if (!f) { f = { c: { a, b, area: 0, type: glue ? "adhesive" : slide ? "sliding" : "bonded" }, set: new RigidSet(a, b, rc, rL) }; found.set(a * nd + b, f); contacts.push(f.c); sets.push(f.set); glueOf.push(glue); }
        f.c.area += w;
        for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) PJ[3 * c + d] = slide ? nrm[c] * nrm[d] : c === d ? 1 : 0;
        f.set.add(PJ, x, y, z, w);
        const ea = grid.cells[ca].el, eb = grid.cells[cb].el, EA = grid.elems[ea], EB = grid.elems[eb];
        bas.eval(x, y, z, EA.c, EA.s);
        bas2.eval(x, y, z, EB.c, EB.s);
        if (glue) {
          // a thin elastic layer: the jump of the two motions is resisted by kn across it and kt along it
          const kn = glue[0], kt = glue[1];
          for (const [e1, N1, s1] of [[ea, bas.v, 1], [eb, bas2.v, -1]] as [number, Float64Array, number][])
            for (const [e2, N2, s2] of [[ea, bas.v, 1], [eb, bas2.v, -1]] as [number, Float64Array, number][]) {
              const K = A.block(e1, e2), n1 = nbs[e1], n2 = nbs[e2], m2 = 3 * n2;
              for (let i2 = 0; i2 < n1; i2++) for (let j2 = 0; j2 < n2; j2++) {
                const v = w * s1 * s2 * N1[i2] * N2[j2];
                if (v) for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) K[(3 * i2 + c) * m2 + 3 * j2 + d] += v * ((c === d ? kt : 0) + (kn - kt) * nrm[c] * nrm[d]);
              }
            }
          joins.push(contacts.indexOf(f.c), ea, eb, x, y, z, w, nrm[0], nrm[1], nrm[2], 0);
          continue;
        }
        setMat(ea);
        for (let q2 = 0; q2 < nb; q2++) traction(bas.g, 3 * q2, nrm, lam, mu, MA, 9 * q2);
        setMat(eb);
        for (let q2 = 0; q2 < nb; q2++) traction(bas2.g, 3 * q2, nrm, lam, mu, MB, 9 * q2);
        if (slide) {
          // only the part of each traction along the normal works on the shared motion
          for (const M of [MA, MB]) for (let q2 = 0; q2 < nb; q2++) for (let d = 0; d < 3; d++) {
            const r = 9 * q2 + d, sN = nrm[0] * M[r] + nrm[1] * M[r + 3] + nrm[2] * M[r + 6];
            M[r] = nrm[0] * sN; M[r + 3] = nrm[1] * sN; M[r + 6] = nrm[2] * sN;
          }
          slideN = nrm;
        }
        const na = nbs[ea], nc = nbs[eb];
        gamma = Math.max(gam[ea], gam[eb]);
        // a rigid side has no stress of its own to share: the joint carries the other side's, with its penalty
        if (rigidD[a] !== rigidD[b]) {
          const [Z, D] = rigidD[a] ? [MA, MB] : [MB, MA];
          Z.fill(0);
          for (let q2 = 0; q2 < D.length; q2++) D[q2] *= 2;
          gamma = gam[rigidD[a] ? eb : ea];
        }
        joins.push(contacts.indexOf(f.c), ea, eb, x, y, z, w, nrm[0], nrm[1], nrm[2], gamma);
        pair(A.block(ea, ea), bas.v, MA, 1, na, bas.v, MA, 1, na, w);
        pair(A.block(ea, eb), bas.v, MA, 1, na, bas2.v, MB, -1, nc, w);
        pair(A.block(eb, ea), bas2.v, MB, -1, nc, bas.v, MA, 1, na, w);
        pair(A.block(eb, eb), bas2.v, MB, -1, nc, bas2.v, MB, -1, nc, w);
        slideN = null;
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
  // bolts: each patch's mean displacement and rotation as rows over the unknowns of the elements it lies on
  type Patch = { c: number[]; dom: number; W: Map<number, Float64Array>; pts: number[] };
  const patchOf = (tris: ArrayLike<number>): Patch => {
    const pts: number[] = [], c = [0, 0, 0];
    let area = 0, dom = 0, first = true;
    located(tris, (e, x, y, z, w) => {
      pts.push(e, x, y, z, w); area += w; c[0] += w * x; c[1] += w * y; c[2] += w * z;
      if (first) { dom = domE[e]; first = false; }
    });
    if (!(area > 0)) throw new Error("E-SIM-BOLT");
    for (let i = 0; i < 3; i++) c[i] /= area;
    const J = new Float64Array(9);
    for (let o = 0; o < pts.length; o += 5) {
      const r = [pts[o + 1] - c[0], pts[o + 2] - c[1], pts[o + 3] - c[2]], r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2], w = pts[o + 4];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) J[3 * i + j] += w * ((i === j ? r2 : 0) - r[i] * r[j]);
    }
    const det = J[0] * (J[4] * J[8] - J[5] * J[7]) - J[1] * (J[3] * J[8] - J[5] * J[6]) + J[2] * (J[3] * J[7] - J[4] * J[6]);
    if (!(Math.abs(det) > 1e-12 * Math.abs(J[0] + J[4] + J[8]) ** 3)) throw new Error("E-SIM-BOLT");
    const Ji = [J[4] * J[8] - J[5] * J[7], J[2] * J[7] - J[1] * J[8], J[1] * J[5] - J[2] * J[4], J[5] * J[6] - J[3] * J[8], J[0] * J[8] - J[2] * J[6], J[2] * J[3] - J[0] * J[5],
      J[3] * J[7] - J[4] * J[6], J[1] * J[6] - J[0] * J[7], J[0] * J[4] - J[1] * J[3]].map(v => v / det);
    const W = new Map<number, Float64Array>();
    for (let o = 0; o < pts.length; o += 5) {
      const e = pts[o], E = grid.elems[e], w = pts[o + 4], ne = nbs[e], me = 3 * ne;
      const r = [pts[o + 1] - c[0], pts[o + 2] - c[1], pts[o + 3] - c[2]];
      // θ = J⁻¹ ∫ r × u: column k of J⁻¹ [r]×
      const X = [0, -r[2], r[1], r[2], 0, -r[0], -r[1], r[0], 0], JX = new Float64Array(9);
      for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) JX[3 * i + k] = Ji[3 * i] * X[k] + Ji[3 * i + 1] * X[3 + k] + Ji[3 * i + 2] * X[6 + k];
      let We = W.get(e);
      if (!We) { We = new Float64Array(6 * me); W.set(e, We); }
      bas.eval(pts[o + 1], pts[o + 2], pts[o + 3], E.c, E.s);
      for (let a = 0; a < ne; a++) {
        const q = w * bas.v[a];
        for (let k = 0; k < 3; k++) {
          We[k * me + 3 * a + k] += q / area;
          for (let i = 0; i < 3; i++) We[(3 + i) * me + 3 * a + k] += q * JX[3 * i + k];
        }
      }
    }
    return { c, dom, W, pts };
  };
  const boltSet = (pb.bolts ?? []).map(B => {
    const pa = patchOf(B.a), pc = patchOf(B.b);
    const t = [pc.c[0] - pa.c[0], pc.c[1] - pa.c[1], pc.c[2] - pa.c[2]];
    let L = Math.hypot(t[0], t[1], t[2]);
    if (!(L > 1e-9)) throw new Error("E-SIM-BOLT");
    for (let i = 0; i < 3; i++) t[i] /= L;
    L = Math.max(L, B.d / 4);
    const K = beamStiffness(B.E, B.nu ?? 0.3, B.d, L, t);
    // the 12 rows (patch a, then b) over each element either patch lies on
    const W = new Map<number, Float64Array>();
    for (const [P, r0] of [[pa, 0], [pc, 6]] as [Patch, number][]) for (const [e, We] of P.W) {
      const me = 3 * nbs[e];
      let Q = W.get(e);
      if (!Q) { Q = new Float64Array(12 * me); W.set(e, Q); }
      Q.set(We, r0 * me);
    }
    return { B, pa, pc, t, L, K, W, kax: B.E * Math.PI * B.d * B.d / 4 / L, g: null as Float64Array | null, f0: 0 };
  });
  // connectors: the same rows, tied at the midpoint of the two centres by a spring or a stiff penalty
  const connSet = (pb.connectors ?? []).map((C, ci) => {
    let pa: Patch, pc: Patch;
    try { pa = patchOf(C.a); pc = patchOf(C.b); } catch { throw new Error(`E-SIM-CONNECTOR: ${ci}`); }
    const hx = (pc.c[0] - pa.c[0]) / 2, hy = (pc.c[1] - pa.c[1]) / 2, hz = (pc.c[2] - pa.c[2]) / 2;
    let area = 0;
    for (const P of [pa, pc]) for (let o = 0; o < P.pts.length; o += 5) area += P.pts[o + 4];
    const R = Math.sqrt(area / 2) || grid.h;
    // rigid: far stiffer than the bodies under the patches, without drowning the rest of the matrix
    const kt = C.k ? [Math.max(0, C.k[0]), Math.max(0, C.k[1]), Math.max(0, C.k[2])] : [1e2 * stiffest * R, 1e2 * stiffest * R, 1e2 * stiffest * R];
    const kr = C.k && C.kr !== undefined ? Math.max(0, C.kr) : 1e2 * stiffest * R * R * R;
    // d = u_b + [h]× θ_b − u_a + [h]× θ_a, φ = θ_b − θ_a over (u_a, θ_a, u_b, θ_b)
    const X = [0, -hz, hy, hz, 0, -hx, -hy, hx, 0], Bm = new Float64Array(72);
    for (let i = 0; i < 3; i++) {
      Bm[12 * i + i] = -1; Bm[12 * i + 6 + i] = 1;
      for (let j = 0; j < 3; j++) { Bm[12 * i + 3 + j] = X[3 * i + j]; Bm[12 * i + 9 + j] = X[3 * i + j]; }
      Bm[12 * (3 + i) + 3 + i] = -1; Bm[12 * (3 + i) + 9 + i] = 1;
    }
    const D = [kt[0], kt[1], kt[2], kr, kr, kr], K = new Float64Array(144);
    for (let q = 0; q < 6; q++) if (D[q]) for (let i = 0; i < 12; i++) { const bi = Bm[12 * q + i]; if (bi) for (let j = 0; j < 12; j++) K[12 * i + j] += D[q] * bi * Bm[12 * q + j]; }
    const W = new Map<number, Float64Array>();
    for (const [P, r0] of [[pa, 0], [pc, 6]] as [Patch, number][]) for (const [e, We] of P.W) {
      const me = 3 * nbs[e];
      let Q = W.get(e);
      if (!Q) { Q = new Float64Array(12 * me); W.set(e, Q); }
      Q.set(We, r0 * me);
    }
    return { B: { a: C.a, b: C.b, d: 0, E: 0 } as Bolt, pa, pc, t: [0, 0, 1], L: 0, K, W, kax: 0, g: null as Float64Array | null, f0: 0, Bm, D };
  });
  for (const b of [...boltSet, ...connSet]) {
    const els = [...b.W.keys()];
    const KW = new Map<number, Float64Array>();
    for (const e of els) {
      const me = 3 * nbs[e], We = b.W.get(e)!, R = new Float64Array(12 * me);
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { const k = b.K[12 * i + j]; if (k) for (let q = 0; q < me; q++) R[i * me + q] += k * We[j * me + q]; }
      KW.set(e, R);
    }
    for (const e1 of els) for (const e2 of els) {
      const m1 = 3 * nbs[e1], m2 = 3 * nbs[e2], W1 = b.W.get(e1)!, R2 = KW.get(e2)!, Kb = A.block(e1, e2);
      for (let i = 0; i < 12; i++) for (let q = 0; q < m1; q++) { const w = W1[i * m1 + q]; if (w) for (let r = 0; r < m2; r++) Kb[q * m2 + r] += w * R2[i * m2 + r]; }
    }
    // a unit of tightening: patch a pulled towards b, b towards a
    if ((b.B.preload ?? 0) > 0 && !pb.modal) {
      const g = new Float64Array(A.size);
      for (const e of els) {
        const me = 3 * nbs[e], We = b.W.get(e)!;
        for (let q = 0; q < me; q++) g[off[e] + q] += b.t[0] * (We[q] - We[6 * me + q]) + b.t[1] * (We[me + q] - We[7 * me + q]) + b.t[2] * (We[2 * me + q] - We[8 * me + q]);
      }
      b.g = g;
    }
  }
  // welds: an elastic strip along the line between the body the edge is on and the body beside it
  // (weld, element a, element b, x, y, z, length weight, stiffness per length) per point
  const weldPts: number[] = [];
  const weldSets: RigidSet[] = [];
  // the spot each of those points belongs to (−1: a weld along a line)
  const weldSpot: number[] = [];
  if (doms && pb.welds?.length) {
    const e0 = 2e-3 * grid.h, far = Math.max(0, pb.gap ?? 0) + e0, gw = gauss(Math.max(2, p + 1));
    const DIRS: number[][] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) if (i || j || k) { const l = Math.hypot(i, j, k); DIRS.push([i / l, j / l, k / l]); }
    const PI3 = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // one point of a weld: the two elements share their motion there through a spring
    const tie = (wi: number, mine: Map<number, RigidSet>, a: number, b: number, ca: number, cb: number, x: number, y: number, z: number, w: number, k: number, spot: number) => {
      const ea = grid.cells[ca].el, eb = grid.cells[cb].el, EA = grid.elems[ea], EB = grid.elems[eb], kw = k * w;
      bas.eval(x, y, z, EA.c, EA.s);
      bas2.eval(x, y, z, EB.c, EB.s);
      for (const [e1, N1, s1] of [[ea, bas.v, 1], [eb, bas2.v, -1]] as [number, Float64Array, number][])
        for (const [e2, N2, s2] of [[ea, bas.v, 1], [eb, bas2.v, -1]] as [number, Float64Array, number][]) {
          const K = A.block(e1, e2), n1 = nbs[e1], n2 = nbs[e2], m2 = 3 * n2;
          for (let i2 = 0; i2 < n1; i2++) for (let j2 = 0; j2 < n2; j2++) {
            const v = kw * s1 * s2 * N1[i2] * N2[j2];
            if (v) for (let c = 0; c < 3; c++) K[(3 * i2 + c) * m2 + 3 * j2 + c] += v;
          }
        }
      weldPts.push(wi, ea, eb, x, y, z, w, k);
      weldSpot.push(spot);
      let r = mine.get(a * doms.length + b);
      if (!r) { r = new RigidSet(a, b, rc, rL); mine.set(a * doms.length + b, r); weldSets.push(r); }
      r.add(PI3, x, y, z, spot < 0 ? w * rL : w);
    };
    const gr = gauss(3), TURN = 12;
    pb.welds.forEach((W, wi) => {
      const S = W.lines, mine = new Map<number, RigidSet>();
      if (W.spots) {
        const P = W.spots, R = (W.d ?? 0) / 2, ds = grid.h / 16, reach = 2 * rL;
        if (!(R > 0)) throw new Error(`E-SIM-WELD: ${wi}`);
        for (let o = 0, si = 0; o + 5 < P.length; o += 6, si++) {
          const n = [P[o + 3], P[o + 4], P[o + 5]], nl = Math.hypot(n[0], n[1], n[2]);
          if (!(nl > 0)) continue;
          for (let c = 0; c < 3; c++) n[c] /= nl;
          const at = (t: number) => [P[o] + t * n[0], P[o + 1] + t * n[1], P[o + 2] + t * n[2]];
          let a = -1;
          { const q = at(e0); for (let d = 0; d < doms.length; d++) if (doms[d].inside(q[0], q[1], q[2])) { a = d; break; } }
          if (a < 0) continue;
          // through the body the point is on, to where it ends
          let t0 = e0, t1 = -1;
          for (let t = e0 + ds; t < reach; t += ds) { const q = at(t); if (!doms[a].inside(q[0], q[1], q[2])) { t1 = t; break; } t0 = t; }
          if (t1 < 0) continue;
          for (let it = 0; it < 30; it++) { const tm = (t0 + t1) / 2, q = at(tm); if (doms[a].inside(q[0], q[1], q[2])) t0 = tm; else t1 = tm; }
          // the body behind it, on it or within the gap
          let b = -1, st = e0;
          for (const s of far > e0 ? [e0, far] : [e0]) {
            const q = at(t1 + s);
            for (let d = 0; d < doms.length; d++) if (d !== a && doms[d].inside(q[0], q[1], q[2])) { b = d; st = s; break; }
            if (b >= 0) break;
          }
          if (b < 0) continue;
          const c0 = at(t1), ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
          const u = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]], ul = Math.hypot(u[0], u[1], u[2]);
          for (let c = 0; c < 3; c++) u[c] /= ul;
          const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
          for (let g = 0; g < gr.x.length; g++) {
            const r = R * (gr.x[g] + 1) / 2, wr = (gr.w[g] / 2) * R * r * (2 * Math.PI / TURN);
            for (let q = 0; q < TURN; q++) {
              const an = (q + 0.5 * (g % 2)) * 2 * Math.PI / TURN, cu = r * Math.cos(an), cv = r * Math.sin(an);
              const x = c0[0] + cu * u[0] + cv * v[0], y = c0[1] + cu * u[1] + cv * v[1], z = c0[2] + cu * u[2] + cv * v[2];
              const pa = [x - 2 * e0 * n[0], y - 2 * e0 * n[1], z - 2 * e0 * n[2]], pc = [x + st * n[0], y + st * n[1], z + st * n[2]];
              if (!doms[a].inside(pa[0], pa[1], pa[2]) || !doms[b].inside(pc[0], pc[1], pc[2])) continue;
              const ca = grid.cellOf(pa[0], pa[1], pa[2], a), cb = grid.cellOf(pc[0], pc[1], pc[2], b);
              if (ca < 0 || cb < 0) continue;
              const ea = grid.cells[ca].el, eb = grid.cells[cb].el;
              const k = W.k ?? (rigidD[a] ? gam[eb] : rigidD[b] ? gam[ea] : Math.max(gam[ea], gam[eb]));
              tie(wi, mine, a, b, ca, cb, x, y, z, wr, k, si);
            }
          }
        }
        if (!mine.size) throw new Error(`E-SIM-WELD: ${wi}`);
        return;
      }
      for (let o = 0; o + 8 < S.length; o += 9) {
        const d = [S[o + 3] - S[o], S[o + 4] - S[o + 1], S[o + 5] - S[o + 2]], l = Math.hypot(d[0], d[1], d[2]);
        if (!(l > 0)) continue;
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
          const t0 = cuts[i - 1], t1 = cuts[i];
          if (t1 - t0 < 1e-12) continue;
          for (let g = 0; g < gw.x.length; g++) {
            const tt = t0 + (t1 - t0) * (gw.x[g] + 1) / 2, w = (gw.w[g] / 2) * (t1 - t0) * l;
            const x = S[o] + tt * d[0], y = S[o + 1] + tt * d[1], z = S[o + 2] + tt * d[2];
            const ax = x + e0 * S[o + 6], ay = y + e0 * S[o + 7], az = z + e0 * S[o + 8];
            let a = -1, b = -1, bx = 0, by = 0, bz = 0;
            for (let q = 0; q < doms.length; q++) if (doms[q].inside(ax, ay, az)) { a = q; break; }
            if (a < 0) continue;
            for (const st of far > e0 ? [e0, far] : [e0]) {
              for (const D of DIRS) {
                bx = x + st * D[0]; by = y + st * D[1]; bz = z + st * D[2];
                for (let q = 0; q < doms.length; q++) if (q !== a && doms[q].inside(bx, by, bz)) { b = q; break; }
                if (b >= 0) break;
              }
              if (b >= 0) break;
            }
            if (b < 0) continue;
            const ca = grid.cellOf(ax, ay, az, a), cb = grid.cellOf(bx, by, bz, b);
            if (ca < 0 || cb < 0) continue;
            const soft = Math.min(...[a, b].filter(q => !rigidD[q]).map(q => mats[q].E), Infinity);
            tie(wi, mine, a, b, ca, cb, x, y, z, w, W.k ?? (Number.isFinite(soft) ? soft : stiffest), -1);
          }
        }
      }
      if (!mine.size) throw new Error(`E-SIM-WELD: ${wi}`);
    });
  }
  /** The 12 mean motions of a bolt's two patches for the unknowns `v`. */
  const boltMotion = (b: { W: Map<number, Float64Array> }, v: Float64Array) => {
    const q = new Float64Array(12);
    for (const [e, We] of b.W) { const me = 3 * nbs[e]; for (let i = 0; i < 12; i++) { let s2 = 0; for (let k = 0; k < me; k++) s2 += We[i * me + k] * v[off[e] + k]; q[i] += s2; } }
    return q;
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
  let free: number;
  if (doms) {
    // each domain may move on its own: what the supports hold of each, and the joints of each pair
    const eps = 2e-3 * grid.h, PS = new Float64Array(9);
    const domAt = (x: number, y: number, z: number) => { const c = grid!.cellOf(x, y, z); return c < 0 ? 0 : grid!.cells[c].dom; };
    for (const s of pb.fixed) {
      const mine = new Map<number, RigidSet>();
      const put = (d: number, x: number, y: number, z: number, w: number) => {
        let r = mine.get(d);
        if (!r) { r = new RigidSet(d, -1, rc, rL); mine.set(d, r); sets.push(r); }
        r.add(PS, x, y, z, w);
      };
      const T = s.tris, nrm = triNormals(T), ar = triNormals(T, true);
      for (let t = 0; t < ar.length; t++) {
        if (!(ar[t] > 0)) continue;
        const o = 9 * t, n = [nrm[3 * t], nrm[3 * t + 1], nrm[3 * t + 2]];
        const d = domAt((T[o] + T[o + 3] + T[o + 6]) / 3 - eps * n[0], (T[o + 1] + T[o + 4] + T[o + 7]) / 3 - eps * n[1], (T[o + 2] + T[o + 5] + T[o + 8]) / 3 - eps * n[2]);
        holdMatrix(s, n, PS);
        for (let k = 0; k < 3; k++) put(d, T[o + 3 * k], T[o + 3 * k + 1], T[o + 3 * k + 2], ar[t] / 3);
      }
      const S = s.lines, Q = s.points;
      if (S?.length || Q?.length) holdMatrix(s, [0, 0, 0], PS);
      if (S) for (let o = 0; o + 8 < S.length; o += 9) {
        const l = Math.hypot(S[o + 3] - S[o], S[o + 4] - S[o + 1], S[o + 5] - S[o + 2]) * rL;
        if (!(l > 0)) continue;
        const mx = (S[o] + S[o + 3]) / 2, my = (S[o + 1] + S[o + 4]) / 2, mz = (S[o + 2] + S[o + 5]) / 2;
        const d = domAt(mx + eps * S[o + 6], my + eps * S[o + 7], mz + eps * S[o + 8]);
        put(d, S[o], S[o + 1], S[o + 2], l / 6); put(d, S[o + 3], S[o + 4], S[o + 5], l / 6); put(d, mx, my, mz, 2 * l / 3);
      }
      if (Q) for (let o = 0; o + 5 < Q.length; o += 6) put(domAt(Q[o] + eps * Q[o + 3], Q[o + 1] + eps * Q[o + 4], Q[o + 2] + eps * Q[o + 5]), Q[o], Q[o + 1], Q[o + 2], rL * rL);
    }
    const PI = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (const b of boltSet) {
      if (b.pa.dom === b.pc.dom) continue;
      const r = new RigidSet(b.pa.dom, b.pc.dom, rc, rL);
      for (const P of [b.pa, b.pc]) for (let o = 0; o < P.pts.length; o += 5) r.add(PI, P.pts[o + 1], P.pts[o + 2], P.pts[o + 3], P.pts[o + 4]);
      sets.push(r);
    }
    // a connector holds the directions its spring has a stiffness in: at the patches when it also resists
    // turning, at its midpoint alone when it does not
    for (const b of connSet) {
      if (b.pa.dom === b.pc.dom) continue;
      const r = new RigidSet(b.pa.dom, b.pc.dom, rc, rL), Pk = Float64Array.from([b.D[0] > 0 ? 1 : 0, 0, 0, 0, b.D[1] > 0 ? 1 : 0, 0, 0, 0, b.D[2] > 0 ? 1 : 0]);
      if (b.D[3] > 0) { for (const P of [b.pa, b.pc]) for (let o = 0; o < P.pts.length; o += 5) r.add(Pk, P.pts[o + 1], P.pts[o + 2], P.pts[o + 3], P.pts[o + 4]); }
      else r.add(Pk, (b.pa.c[0] + b.pc.c[0]) / 2, (b.pa.c[1] + b.pc.c[1]) / 2, (b.pa.c[2] + b.pc.c[2]) / 2, rL * rL);
      sets.push(r);
    }
    for (const r of weldSets) sets.push(r);
    const fb = freeBodies(sets, doms.length);
    free = fb.free;
    if (free > 0 && !pb.modal && !(pb.relief && hasRho)) throw new Error(fb.loose.length && fb.loose.length < doms.length ? `E-SIM-LOOSE: ${fb.loose.join(",")}` : `E-SIM-FREE: ${free}`);
  } else {
    free = freeModes(pb.fixed, pb.lo, pb.hi);
    if (free > 0 && !pb.modal && !(pb.relief && hasRho)) throw new Error(`E-SIM-FREE: ${free}`);
  }
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
  // masses spread over faces: points with a mass each (element, x, y, z, t)
  const massPts: number[] = [];
  for (const M of pb.masses ?? []) {
    const at = massPts.length;
    let area = 0;
    located(M.tris, (e, x, y, z, w) => { massPts.push(e, x, y, z, w); area += w; });
    if (!(area > 0)) throw new Error("E-SIM-MASS");
    for (let o = at; o < massPts.length; o += 5) massPts[o + 4] *= M.mass / area;
  }
  const eachMass = (fn: (e: number, x: number, y: number, z: number, w: number) => void) => { for (let o = 0; o < massPts.length; o += 5) fn(massPts[o], massPts[o + 1], massPts[o + 2], massPts[o + 3], massPts[o + 4]); };
  if (pb.gravity) eachMass((e, x, y, z, w) => {
    const g = pb.gravity!, E = grid.elems[e];
    bas.eval(x, y, z, E.c, E.s);
    add(applied, x, y, z, w * g[0], w * g[1], w * g[2]);
    for (let a = 0; a < nbs[e]; a++) for (let c = 0; c < 3; c++) f[off[e] + 3 * a + c] += w * bas.v[a] * g[c];
  });
  if (pb.spin) eachMass((e, x, y, z, w) => {
    const sp = pb.spin!, ax = sp.axis, w2 = sp.omega * sp.omega, al = sp.alpha ?? 0, E = grid.elems[e];
    const rx = x - sp.p[0], ry = y - sp.p[1], rz = z - sp.p[2], ra = rx * ax[0] + ry * ax[1] + rz * ax[2];
    const bx = w2 * (rx - ra * ax[0]) - al * (ax[1] * rz - ax[2] * ry), by = w2 * (ry - ra * ax[1]) - al * (ax[2] * rx - ax[0] * rz), bz = w2 * (rz - ra * ax[2]) - al * (ax[0] * ry - ax[1] * rx);
    bas.eval(x, y, z, E.c, E.s);
    add(applied, x, y, z, w * bx, w * by, w * bz);
    for (let a = 0, q = off[e]; a < nbs[e]; a++) { f[q + 3 * a] += w * bas.v[a] * bx; f[q + 3 * a + 1] += w * bas.v[a] * by; f[q + 3 * a + 2] += w * bas.v[a] * bz; }
  });
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
  // thermal strain: traction β ΔT n on the free surface and body force −β ∇T in the volume (kept out of this function: see measurePenalty)
  const th = pb.thermo;
  // per joining point: the thermal part {β} ΔT of the shared traction (taken off the connection forces)
  let joinTh: Float64Array | null = null;
  if (th) {
    joinTh = thermoLoads(th, betaE!, grid, bas, off, nbs, f, located, (x, y, z, fx, fy, fz) => add(applied, x, y, z, fx, fy, fz),
      doms ? { insides: doms.map(d => d.inside), joins, glued: glueOf.map(Boolean), rigid: rigidE } : null);
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
      eachMass(fn);
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
      for (const ci of E.cells) mass += massCell(M, S, grid.cells[ci].pts, bas, E.c, E.s, ne, rho);
      for (let a = 0; a < ne; a++) for (let b = a + 1; b < ne; b++) M[b * ne + a] = M[a * ne + b];
      Mel.push(M); Sel.push(S);
    }
    eachMass((e, x, y, z, w) => {
      const E = grid.elems[e], ne = nbs[e], M = Mel[e], S = Sel[e];
      bas.eval(x, y, z, E.c, E.s);
      mass += w;
      for (let a = 0; a < ne; a++) { const va = bas.v[a] * w; S[a] += va; for (let b = 0; b < ne; b++) M[a * ne + b] += va * bas.v[b]; }
    });
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
      const fits = pb.solver ? { direct: pb.solver === "direct" } as ReturnType<typeof directFits> : directFits(A, MODAL_DIRECT, MODAL_FLOPS);
      const direct = fits.direct;
      let solve: (b: Float64Array, g?: Float64Array) => Float64Array;
      if (direct) { const F = new BlockCholesky(A, { plan: fits.plan }); solve = b => F.solve(b); }
      else { const S = pcgSolver(A, { coarse: 3 * basisSize(1), tol: 1e-6, maxIt: 300 }); solve = (b, g) => { const r = S.solve(b, g); iterations += r.iterations; return r.x; }; }
      // an earlier pass's vectors in this pass's layout (zeros for the functions it did not have)
      const start = (modal.start ?? []).map(v => {
        if (v.length === n || deg || v.length % nel) return v;
        const pm = v.length / nel, w = new Float64Array(n);
        for (let e = 0; e < nel; e++) w.set(v.subarray(e * pm, e * pm + Math.min(pm, m)), e * m);
        return w;
      });
      const r = subspace(n, solve, (v, y) => { A.mul(v, y); }, mulM, { count: modal.count, start, tol: modal.tol ?? (direct ? 1e-8 : 1e-6), exact: direct });
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
    }
    eachMass((e, x, y, z, w) => {
      const E = grid.elems[e], ne = nbs[e], M = Ms[e];
      bas.eval(x, y, z, E.c, E.s);
      for (let a = 0; a < ne; a++) { const va = bas.v[a] * w * sigma; for (let b = 0; b < ne; b++) M[a * ne + b] += va * bas.v[b]; }
    });
    for (let e = 0; e < nel; e++) {
      const M = Ms[e], ne = nbs[e], K = A.block(e, e), mm = 3 * ne;
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
  // tightening: the pair of forces on each preloaded bolt that leaves its preload in it once the joint has
  // given way under all of them (one solve per bolt, then a small system), added to the loads
  const tighten = (solve: (b: Float64Array) => Float64Array) => {
    const pre = boltSet.filter(b => b.g), n = pre.length;
    if (!n) return;
    const T = new Float64Array(n * n), rhs = pre.map(b => b.B.preload!);
    pre.forEach((bj, j) => {
      const xj = solve(bj.g!);
      pre.forEach((bi, i) => {
        const q = boltMotion(bi, xj), t = bi.t;
        T[i * n + j] = (i === j ? 1 : 0) + bi.kax * (t[0] * (q[6] - q[0]) + t[1] * (q[7] - q[1]) + t[2] * (q[8] - q[2]));
      });
    });
    // Gauss elimination with pivoting
    for (let k = 0; k < n; k++) {
      let piv = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(T[i * n + k]) > Math.abs(T[piv * n + k])) piv = i;
      if (piv !== k) { for (let j = 0; j < n; j++) { const v = T[k * n + j]; T[k * n + j] = T[piv * n + j]; T[piv * n + j] = v; } const v = rhs[k]; rhs[k] = rhs[piv]; rhs[piv] = v; }
      const d = T[k * n + k];
      // nothing but the bolt itself resists its tightening: the parts it clamps are not joined where they touch
      if (!(Math.abs(d) > 1e-6)) throw new Error("E-SIM-PRELOAD");
      for (let i = k + 1; i < n; i++) { const m2 = T[i * n + k] / d; if (!m2) continue; for (let j = k; j < n; j++) T[i * n + j] -= m2 * T[k * n + j]; rhs[i] -= m2 * rhs[k]; }
    }
    for (let k = n - 1; k >= 0; k--) { let v = rhs[k]; for (let j = k + 1; j < n; j++) v -= T[k * n + j] * rhs[j]; rhs[k] = v / (T[k * n + k] || 1); }
    pre.forEach((b, k) => { b.f0 = rhs[k]; for (let i = 0; i < f.length; i++) f[i] += rhs[k] * b.g![i]; });
  };
  progress("factor", 0, 1);
  const fitsS = modalRun || pb.solver || p < 2 ? null : directFits(A, DIRECT_LIMIT, DIRECT_FLOPS);
  const useCg = pb.solver === "pcg" || (pb.solver !== "direct" && p >= 2 && !(fitsS?.direct ?? A.size <= DIRECT_LIMIT));
  if (modalRun) {
    t3 = t2;
    xs = modalRun();
  } else if (useCg) {
    const S = pcgSolver(A, { coarse: 3 * basisSize(1), tol: pb.tol ?? 1e-8 });
    tighten(b => { const r = S.solve(b); iterations += r.iterations; return r.x; });
    const r = S.solve(f);
    xs = r.x; iterations += r.iterations;
    t3 = t2 + S.setup;
    if (reliefM) {
      const y = new Float64Array(f.length);
      reliefM(xs, y);
      for (let i = 0; i < y.length; i++) y[i] += f[i];
      const r2 = S.solve(y, xs);
      xs = r2.x; iterations += r2.iterations;
    }
  } else {
    const L = new BlockCholesky(A, { plan: fitsS?.plan });
    t3 = now();
    progress("solve", 0, 1);
    tighten(b => L.solve(b));
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

  // bolts: the beam's end forces from the two patches' mean motions
  const bolts: BoltResult[] | undefined = boltSet.length && !modal ? boltSet.map(b => {
    const q = boltMotion(b, xs), F = new Float64Array(12), t = b.t;
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) F[i] += b.K[12 * i + j] * q[j];
    const perp = (o: number) => { const a = F[o] * t[0] + F[o + 1] * t[1] + F[o + 2] * t[2]; return Math.hypot(F[o] - a * t[0], F[o + 1] - a * t[1], F[o + 2] - a * t[2]); };
    return {
      axial: b.f0 + F[6] * t[0] + F[7] * t[1] + F[8] * t[2], shear: perp(6), moment: Math.max(perp(3), perp(9)),
      torsion: Math.abs(F[9] * t[0] + F[10] * t[1] + F[11] * t[2]), a: b.pa.c, b: b.pc.c, length: b.L,
    };
  }) : undefined;

  const connectors: ConnectorResult[] | undefined = connSet.length && !modal ? connSet.map(c => {
    const q = boltMotion(c, xs), g = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 12; j++) g[i] += c.Bm[12 * i + j] * q[j];
    // stretched (b moved away from a) the tie pulls b back: a passes −k d to b
    return { force: [-c.D[0] * g[0], -c.D[1] * g[1], -c.D[2] * g[2]], moment: [-c.D[3] * g[3], -c.D[4] * g[4], -c.D[5] * g[5]], stretch: [g[0], g[1], g[2]], a: c.pa.c, b: c.pc.c };
  }) : undefined;

  // welds: the strip's force per length is its stiffness times the jump of the two bodies' motion
  const welds: WeldResult[] | undefined = pb.welds?.length && !modal ? pb.welds.map(() => ({ force: [0, 0, 0], length: 0, peak: 0, mean: 0, at: [0, 0, 0] })) : undefined;
  if (welds) {
    const ju = [0, 0, 0], spotF = new Map<number, number[]>();
    for (let o = 0; o < weldPts.length; o += 8) {
      const R = welds[weldPts[o]], px = weldPts[o + 3], py = weldPts[o + 4], pz = weldPts[o + 5], w = weldPts[o + 6], k = weldPts[o + 7];
      ju[0] = ju[1] = ju[2] = 0;
      for (const [e, sg] of [[weldPts[o + 1], 1], [weldPts[o + 2], -1]]) {
        const E = grid.elems[e];
        bas.eval(px, py, pz, E.c, E.s);
        for (let b = 0; b < nb; b++) for (let d = 0; d < 3; d++) ju[d] += sg * bas.v[b] * x[e * m + 3 * b + d];
      }
      const f = k * Math.hypot(ju[0], ju[1], ju[2]);
      for (let d = 0; d < 3; d++) R.force[d] += w * k * ju[d];
      R.length += w;
      const sp = weldSpot[o / 8];
      if (sp >= 0) {
        // a spot weld: the force of each spot
        const key = weldPts[o] * 1e6 + sp;
        let T = spotF.get(key);
        if (!T) { T = [0, 0, 0, 0, 0, 0, 0, weldPts[o]]; spotF.set(key, T); }
        for (let d = 0; d < 3; d++) T[d] += w * k * ju[d];
        T[3] += w * px; T[4] += w * py; T[5] += w * pz; T[6] += w;
        continue;
      }
      R.mean += w * f;
      if (f > R.peak) { R.peak = f; R.at = [px, py, pz]; }
    }
    for (const T of spotF.values()) {
      const R = welds[T[7]], f = Math.hypot(T[0], T[1], T[2]);
      R.spots = (R.spots ?? 0) + 1;
      R.mean += f;
      if (f >= R.peak) { R.peak = f; R.at = [T[3] / T[6], T[4] / T[6], T[5] / T[6]]; }
    }
    for (const R of welds) { if (R.spots) R.mean /= R.spots; else if (R.length > 0) R.mean /= R.length; }
  }

  // connection forces: the flux the joining terms carry, ½(σ_a + σ_b) n − γ (u_a − u_b), is what b does to a
  if (!modal && joins.length) {
    const tot = contacts.map(() => new Float64Array(10));
    const ta = [0, 0, 0], ua = [0, 0, 0];
    for (let o = 0; o < joins.length; o += 11) {
      const ci = joins[o], ea = joins[o + 1], eb = joins[o + 2], px = joins[o + 3], py = joins[o + 4], pz = joins[o + 5], w = joins[o + 6];
      const nrm = [joins[o + 7], joins[o + 8], joins[o + 9]], g = joins[o + 10];
      ta[0] = ta[1] = ta[2] = ua[0] = ua[1] = ua[2] = 0;
      const oneRigid = rigidE(ea) !== rigidE(eb);
      for (const [e, sg] of [[ea, 1], [eb, -1]]) {
        const E = grid.elems[e];
        bas.eval(px, py, pz, E.c, E.s);
        setMat(e);
        const half = oneRigid ? (rigidE(e) ? 0 : 1) : 0.5;
        for (let b = 0; b < nb; b++) {
          traction(bas.g, 3 * b, nrm, lam, mu, MA, 0);
          for (let d = 0; d < 3; d++) {
            const v = x[e * m + 3 * b + d];
            ua[d] += sg * bas.v[b] * v;
            ta[0] += half * MA[d] * v; ta[1] += half * MA[3 + d] * v; ta[2] += half * MA[6 + d] * v;
          }
        }
      }
      for (let c = 0; c < 3; c++) ta[c] -= g * ua[c];
      // the stress is D ε less the thermal part β ΔT I
      if (joinTh) { const q = joinTh[o / 11]; for (let c = 0; c < 3; c++) ta[c] -= q * nrm[c]; }
      const gl = glueOf[ci];
      if (gl) {
        // the layer alone carries the load: b pulls a back by its stiffness times the jump
        const un = ua[0] * nrm[0] + ua[1] * nrm[1] + ua[2] * nrm[2];
        for (let c = 0; c < 3; c++) ta[c] = -(gl[1] * ua[c] + (gl[0] - gl[1]) * un * nrm[c]);
      }
      if (contacts[ci].type === "sliding") {
        const tn = ta[0] * nrm[0] + ta[1] * nrm[1] + ta[2] * nrm[2];
        for (let c = 0; c < 3; c++) ta[c] = tn * nrm[c];
      }
      // a passes to b the opposite
      const T = tot[ci], fx = -w * ta[0], fy = -w * ta[1], fz = -w * ta[2];
      T[0] += fx; T[1] += fy; T[2] += fz;
      T[3] += py * fz - pz * fy; T[4] += pz * fx - px * fz; T[5] += px * fy - py * fx;
      T[6] += w * px; T[7] += w * py; T[8] += w * pz; T[9] += w;
    }
    contacts.forEach((c, i) => {
      const T = tot[i];
      if (!(T[9] > 0)) return;
      const cx = T[6] / T[9], cy = T[7] / T[9], cz = T[8] / T[9];
      c.at = [cx, cy, cz];
      c.force = [T[0], T[1], T[2]];
      c.moment = [T[3] - (cy * T[2] - cz * T[1]), T[4] - (cz * T[0] - cx * T[2]), T[5] - (cx * T[1] - cy * T[0])];
    });
  }

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
          if (prev && !rigidE(e)) eta[e] += w * dens(H);
        }
      }
    }
  }
  // with an enforced displacement f·x / 2 is not the strain energy: the integral is
  if (pb.fixed.some(q => q.value) || boltSet.some(b => b.g)) energy = strain;
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
    grid, p, dofs: A.size, memory, x, energy, iterations,
    ms: { grid: t1 - t0, assemble: t2 - t1, factor: t3 - t2, solve: t4 - t3 },
    reactions, applied, eta, prevError, accel,
    ...(doms ? { contacts } : {}),
    ...(bolts ? { bolts } : {}),
    ...(welds ? { welds } : {}),
    ...(connectors ? { connectors } : {}),
    modes, space, mass: modal ? mass : undefined,
    use(k) { const v = modes?.[k]; if (v) x = v.x; },
    sample(pos, nrm, hits) {
      const n = pos.length / 3, u = new Float32Array(3 * n), vm = new Float32Array(n), err = new Float32Array(n);
      const hit = hits ? new Uint8Array(n) : undefined, dom = doms ? new Uint8Array(n) : undefined;
      const eps = 1e-6 * grid.h, G = new Float64Array(9);
      const thT = th ? th.field(Float64Array.from(pos), false).t : null;
      for (let i = 0; i < n; i++) {
        let px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
        if (nrm) { px -= eps * nrm[3 * i]; py -= eps * nrm[3 * i + 1]; pz -= eps * nrm[3 * i + 2]; }
        // asked with `hits`: a point outside the grid's box has no value (the nearest cell's would be an extrapolation)
        if (hit && (px < grid.lo[0] - eps || py < grid.lo[1] - eps || pz < grid.lo[2] - eps || px > grid.lo[0] + grid.n[0] * grid.h + eps || py > grid.lo[1] + grid.n[1] * grid.h + eps || pz > grid.lo[2] + grid.n[2] * grid.h + eps)) continue;
        const e = at(px, py, pz);
        if (e < 0) continue;
        if (hit) hit[i] = 1;
        if (dom) dom[i] = domE[e];
        const stiff = rigidE(e);
        err[i] = stiff ? 0 : local[e];
        G.fill(0);
        let ux = 0, uy = 0, uz = 0;
        for (let a = 0; a < nb; a++) {
          const o = e * m + 3 * a, va = bas.v[a];
          ux += va * x[o]; uy += va * x[o + 1]; uz += va * x[o + 2];
          for (let c = 0; c < 3; c++) { const v = x[o + c]; G[c * 3] += v * bas.g[3 * a]; G[c * 3 + 1] += v * bas.g[3 * a + 1]; G[c * 3 + 2] += v * bas.g[3 * a + 2]; }
        }
        u[3 * i] = ux; u[3 * i + 1] = uy; u[3 * i + 2] = uz;
        const tr = G[0] + G[4] + G[8];
        // a rigid component's stress is not a result
        const sth = thT ? betaE![e] * (thT[i] - th!.ref) : 0;
        if (!stiff) vm[i] = vonMises([lam * tr + 2 * mu * G[0] - sth, lam * tr + 2 * mu * G[4] - sth, lam * tr + 2 * mu * G[8] - sth, mu * (G[1] + G[3]), mu * (G[5] + G[7]), mu * (G[6] + G[2])]);
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
      const tr = G[0] + G[4] + G[8], sth = th ? (3 * lam + 2 * mu) * th.alpha * (th.field(Float64Array.of(px, py, pz), false).t[0] - th.ref) : 0;
      return [
        lam * tr + 2 * mu * G[0] - sth, lam * tr + 2 * mu * G[4] - sth, lam * tr + 2 * mu * G[8] - sth,
        mu * (G[1] + G[3]), mu * (G[5] + G[7]), mu * (G[6] + G[2]),
      ];
    },
  };
}

/** The loads of a thermal strain (`StaticProblem.thermo`): traction β ΔT n on its surface, body force −β ∇T. */
function thermoLoads(th: NonNullable<StaticProblem["thermo"]>, betaE: Float64Array, grid: Grid, bas: Basis, off: ArrayLike<number>, nbs: ArrayLike<number>, f: Float64Array,
  located: (tris: ArrayLike<number>, fn: (e: number, x: number, y: number, z: number, w: number, nrm: number[]) => void) => void,
  add: (x: number, y: number, z: number, fx: number, fy: number, fz: number) => void,
  multi: { insides: ((x: number, y: number, z: number) => boolean)[]; joins: number[]; glued: boolean[]; rigid: (e: number) => boolean } | null): Float64Array | null {
  const sp: number[] = [];
  const eps = 2e-3 * grid.h;
  located(th.tris, (e, x, y, z, w, nrm) => {
    if (multi) {
      // several bodies: the point belongs to the body just inside it (a cell may hold two bodies' pieces)
      const bx = x - eps * nrm[0], by = y - eps * nrm[1], bz = z - eps * nrm[2];
      const d = multi.insides.findIndex(f => f(bx, by, bz));
      const c = d >= 0 ? grid.cellOf(bx, by, bz, d) : -1;
      if (c >= 0) e = grid.cells[c].el;
    }
    sp.push(e, x, y, z, w, nrm[0], nrm[1], nrm[2]);
  });
  const ns = sp.length / 8, sx = new Float64Array(3 * ns);
  for (let k = 0; k < ns; k++) { sx[3 * k] = sp[8 * k + 1]; sx[3 * k + 1] = sp[8 * k + 2]; sx[3 * k + 2] = sp[8 * k + 3]; }
  const ts = ns ? th.field(sx, false).t : new Float64Array(0);
  for (let k = 0; k < ns; k++) {
    const o = 8 * k, e = sp[o], x = sp[o + 1], y = sp[o + 2], z = sp[o + 3], q = sp[o + 4] * betaE[e] * (ts[k] - th.ref), E = grid.elems[e];
    if (!q) continue;
    bas.eval(x, y, z, E.c, E.s);
    add(x, y, z, q * sp[o + 5], q * sp[o + 6], q * sp[o + 7]);
    for (let a = 0, r = off[e]; a < nbs[e]; a++) for (let c = 0; c < 3; c++) f[r + 3 * a + c] += bas.v[a] * q * sp[o + 5 + c];
  }
  for (let e = 0; e < grid.elems.length; e++) {
    const E = grid.elems[e];
    let n = 0;
    for (const ci of E.cells) n += grid.cells[ci].pts.n;
    if (!n) continue;
    const P = new Float64Array(3 * n), W = new Float64Array(n);
    let k = 0;
    for (const ci of E.cells) {
      const Q = grid.cells[ci].pts;
      for (let j = 0; j < Q.n; j++, k++) { P[3 * k] = Q.a[4 * j]; P[3 * k + 1] = Q.a[4 * j + 1]; P[3 * k + 2] = Q.a[4 * j + 2]; W[k] = Q.a[4 * j + 3]; }
    }
    const beta = betaE[e];
    if (!beta) continue;
    const g = th.field(P, true).g;
    if (!g) continue;
    for (let j = 0; j < n; j++) {
      const bx = -beta * g[3 * j], by = -beta * g[3 * j + 1], bz = -beta * g[3 * j + 2], w = W[j];
      if (!bx && !by && !bz) continue;
      bas.eval(P[3 * j], P[3 * j + 1], P[3 * j + 2], E.c, E.s);
      add(P[3 * j], P[3 * j + 1], P[3 * j + 2], w * bx, w * by, w * bz);
      for (let a = 0, q = off[e]; a < nbs[e]; a++) { f[q + 3 * a] += w * bas.v[a] * bx; f[q + 3 * a + 1] += w * bas.v[a] * by; f[q + 3 * a + 2] += w * bas.v[a] * bz; }
    }
  }
  if (!multi) return null;
  // joined bodies: the shared traction {σ n} holds the thermal part −{β} ΔT n too, which works on the jump [v]
  // (with one material it cancels the two faces' tractions above; with two it is what makes them push on each other)
  const J = multi.joins, nj = J.length / 11, out = new Float64Array(nj);
  if (!nj) return out;
  const jp = new Float64Array(3 * nj);
  for (let k = 0; k < nj; k++) for (let c = 0; c < 3; c++) jp[3 * k + c] = J[11 * k + 3 + c];
  const jt = th.field(jp, false).t;
  for (let k = 0; k < nj; k++) {
    const o = 11 * k;
    if (multi.glued[J[o]]) continue;
    const ea = J[o + 1], eb = J[o + 2], x = J[o + 3], y = J[o + 4], z = J[o + 5], w = J[o + 6];
    const ra = multi.rigid(ea), rb = multi.rigid(eb), wa = ra === rb ? 0.5 : ra ? 0 : 1, wb = ra === rb ? 0.5 : rb ? 0 : 1;
    out[k] = (wa * betaE[ea] + wb * betaE[eb]) * (jt[k] - th.ref);
    const q = w * out[k];
    if (!q) continue;
    for (const [e, sg] of [[ea, -1], [eb, 1]]) {
      const E = grid.elems[e];
      bas.eval(x, y, z, E.c, E.s);
      for (let a = 0, r = off[e]; a < nbs[e]; a++) for (let c = 0; c < 3; c++) f[r + 3 * a + c] += sg * bas.v[a] * q * J[o + 7 + c];
    }
  }
  return out;
}

/** β = (3λ + 2μ) α per element: by its domain's material and α, none for a rigid domain. */
function thermoBeta(th: NonNullable<StaticProblem["thermo"]>, nel: number, domE: ArrayLike<number>, lames: { lam: number; mu: number }[], rigidD: boolean[]): Float64Array {
  const out = new Float64Array(nel);
  for (let e = 0; e < nel; e++) {
    const d = domE[e], L = lames[d], a = th.alphas && th.alphas.length > d ? th.alphas[d] : th.alpha;
    out[e] = rigidD[d] ? 0 : (3 * L.lam + 2 * L.mu) * a;
  }
  return out;
}

/** Temperature °C at points (3 numbers each), and its gradient K/mm (3 each) when `grad`. */
export type TempField = (pts: Float64Array, grad: boolean) => { t: Float64Array; g?: Float64Array };

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

/** The box of a triangle soup: [lo x, y, z, hi x, y, z]. */
export function triBox(T: ArrayLike<number>) {
  const B = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < T.length; i++) { const a = i % 3; if (T[i] < B[a]) B[a] = T[i]; if (T[i] > B[3 + a]) B[3 + a] = T[i]; }
  return B;
}

/**
 * What one support holds of a domain (`b` = −1), or what a joint shares between two: sums over its points of
 * the held part of the six rigid motions (C) and of all of them (F), about `c` in lengths of L.
 */
/**
 * Stiffness (12 × 12, row-major, global axes; ends a then b: displacement, rotation) of a round beam of
 * diameter `d` and length `L` along the unit `t`, with shear deformation.
 */
export function beamStiffness(E: number, nu: number, d: number, L: number, t: number[]): Float64Array {
  const Ar = Math.PI * d * d / 4, I = Math.PI * d ** 4 / 64, G = E / (2 * (1 + nu));
  const phi = 12 * E * I / (0.9 * G * Ar * L * L);
  const a = 12 * E * I / (L ** 3 * (1 + phi)), b = 6 * E * I / (L * L * (1 + phi)), c = (4 + phi) * E * I / (L * (1 + phi)), e = (2 - phi) * E * I / (L * (1 + phi));
  const k = new Float64Array(144), set = (ix: number[], v: number[]) => { for (let i = 0; i < ix.length; i++) for (let j = 0; j < ix.length; j++) k[12 * ix[i] + ix[j]] += v[i * ix.length + j]; };
  const ka = E * Ar / L, kt = G * 2 * I / L;
  set([0, 6], [ka, -ka, -ka, ka]);
  set([3, 9], [kt, -kt, -kt, kt]);
  set([1, 5, 7, 11], [a, b, -a, b, b, c, -b, e, -a, -b, a, -b, b, e, -b, c]);
  set([2, 4, 8, 10], [a, -b, -a, -b, -b, c, b, e, -a, b, a, b, -b, e, b, c]);
  // local axes: x along the beam, y and z across
  const s = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let y = [t[1] * s[2] - t[2] * s[1], t[2] * s[0] - t[0] * s[2], t[0] * s[1] - t[1] * s[0]];
  const yl = Math.hypot(y[0], y[1], y[2]);
  y = y.map(v => v / yl);
  const z = [t[1] * y[2] - t[2] * y[1], t[2] * y[0] - t[0] * y[2], t[0] * y[1] - t[1] * y[0]];
  const R = [t, y, z], T = new Float64Array(144);
  for (let q = 0; q < 4; q++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[12 * (3 * q + i) + 3 * q + j] = R[i][j];
  const kT = new Float64Array(144), out = new Float64Array(144);
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { let v = 0; for (let l = 0; l < 12; l++) v += k[12 * i + l] * T[12 * l + j]; kT[12 * i + j] = v; }
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { let v = 0; for (let l = 0; l < 12; l++) v += T[12 * l + i] * kT[12 * l + j]; out[12 * i + j] = v; }
  return out;
}

export class RigidSet {
  C = new Float64Array(36);
  F = new Float64Array(36);
  w = 0;
  private R = new Float64Array(18);
  private PR = new Float64Array(18);
  constructor(readonly a: number, readonly b: number, private c: number[], private L: number) {}
  add(P: Float64Array, x: number, y: number, z: number, w: number) {
    const { R, PR, C, F, c, L } = this, r0 = (x - c[0]) / L, r1 = (y - c[1]) / L, r2 = (z - c[2]) / L;
    R.fill(0);
    R[0] = R[7] = R[14] = 1;
    R[4] = r2; R[5] = -r1; R[9] = -r2; R[11] = r0; R[15] = r1; R[16] = -r0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) PR[i * 6 + j] = P[3 * i] * R[j] + P[3 * i + 1] * R[6 + j] + P[3 * i + 2] * R[12 + j];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      C[i * 6 + j] += w * (PR[i] * PR[j] + PR[6 + i] * PR[6 + j] + PR[12 + i] * PR[12 + j]);
      F[i * 6 + j] += w * (R[i] * R[j] + R[6 + i] * R[6 + j] + R[12 + i] * R[12 + j]);
    }
    this.w += w;
  }
}

/**
 * Rigid motions left free in a set of `nd` domains held by supports and joined to each other: their number
 * and the domains that take part in them (`loose`). As in `freeModes`, a motion a set holds less than 2 % as
 * much as fixing the same points would counts as not held by it.
 */
export function freeBodies(sets: RigidSet[], nd: number): { free: number; loose: number[] } {
  const n = 6 * nd, G = new Float64Array(n * n);
  for (const s of sets) {
    if (!(s.w > 0)) continue;
    const { val, M } = relative(s.C, s.F, 1e-12 * s.w);
    const H = new Float64Array(36);
    for (let k = 0; k < 6; k++) {
      if (val[k] < 0.02) continue;
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) H[i * 6 + j] += (val[k] * M[i * 6 + k] * M[j * 6 + k]) / s.w;
    }
    const put = (p: number, q: number, sg: number) => { for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) G[(6 * p + i) * n + 6 * q + j] += sg * H[i * 6 + j]; };
    put(s.a, s.a, 1);
    if (s.b >= 0) { put(s.b, s.b, 1); put(s.a, s.b, -1); put(s.b, s.a, -1); }
  }
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, G[i * n + i]);
  if (!(top > 0)) return { free: n, loose: [] };
  const V = jacobi(G, n);
  const loose = new Set<number>();
  let free = 0;
  for (let k = 0; k < n; k++) {
    if (G[k * n + k] > 1e-9 * top) continue;
    free++;
    for (let d = 0; d < nd; d++) { let m = 0; for (let i = 0; i < 6; i++) m += V[(6 * d + i) * n + k] ** 2; if (m > 1e-6) loose.add(d); }
  }
  return { free, loose: [...loose].sort((x, y) => x - y) };
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
