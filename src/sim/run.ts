// Structural analysis (FR-SOL-010, FR-STU-020): a study turned into a solver problem, and the passes.
// Pure: runs in the solver worker and in node tests.

import { MeshBody, insideOf } from "./body";
import { solveStatic, triArea, triNormals, type Load, type Reaction, type Support } from "./static";
import type { Grid } from "./grid";
import type { Study } from "./types";

/** The body for the solver: the kernel's triangles with each one's face, and the face names. */
export interface SimBody {
  tris: Float64Array;
  face: Int32Array;
  names: string[];
  lo: number[];
  hi: number[];
}

export interface SimMaterial { name: string; /** MPa */ E: number; nu: number; /** t/mm³ */ rho: number; /** MPa */ sy?: number; su?: number }

export interface StudyProblem {
  fixed: Support[];
  loads: Load[];
  gravity?: number[];
  /** Items that cannot be solved as they are: code E-SIM-REF (face gone) or E-SIM-EMPTY (nothing picked). */
  problems: { id: string; code: "E-SIM-REF" | "E-SIM-EMPTY" | "E-SIM-HINGE" }[];
  /** Which study item each entry of `fixed` is. */
  supportIds: string[];
}

function trisOf(b: SimBody, names: string[]): Float64Array | null {
  const want = new Set<number>();
  for (const n of names) { const i = b.names.indexOf(n); if (i < 0) return null; want.add(i); }
  const out: number[] = [];
  for (let t = 0; t < b.face.length; t++) if (want.has(b.face[t])) for (let k = 0; k < 9; k++) out.push(b.tris[9 * t + k]);
  return Float64Array.from(out);
}

/** The axis of a round face from its triangles: the direction most square to every normal. */
export function axisOf(tris: ArrayLike<number>): number[] | null {
  const n = triNormals(tris), a = triNormals(tris, true);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < a.length; t++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += a[t] * n[3 * t + i] * n[3 * t + j];
  // smallest eigenvector by inverse-free power iteration on (tr·I − S)
  const tr = S[0][0] + S[1][1] + S[2][2];
  if (!(tr > 0)) return null;
  let best: number[] | null = null, bv = Infinity;
  for (const start of [[1, 0.3, 0.2], [0.2, 1, 0.3], [0.3, 0.2, 1]]) {
    let v = start;
    for (let it = 0; it < 200; it++) {
      const w = [0, 1, 2].map(i => tr * v[i] - (S[i][0] * v[0] + S[i][1] * v[1] + S[i][2] * v[2]));
      const l = Math.hypot(w[0], w[1], w[2]);
      if (!(l > 0)) break;
      v = w.map(x => x / l);
    }
    const q = [0, 1, 2].reduce((s, i) => s + v[i] * (S[i][0] * v[0] + S[i][1] * v[1] + S[i][2] * v[2]), 0);
    if (q < bv) { bv = q; best = v; }
  }
  // a flat face has two such directions, a sphere none: only a clear single one is an axis
  if (!best || bv > 1e-4 * tr) return null;
  let v = [1, 0.7, 0.4], top = 0;
  for (let it = 0; it < 200; it++) {
    const w = [0, 1, 2].map(i => S[i][0] * v[0] + S[i][1] * v[1] + S[i][2] * v[2]);
    top = Math.hypot(w[0], w[1], w[2]);
    if (!(top > 0)) break;
    v = w.map(x => x / top);
  }
  return tr - top - bv > 0.02 * tr ? best : null;
}

/** Supports and loads of a study on the body's triangles. */
export function studyProblem(st: Study, b: SimBody): StudyProblem {
  const off = new Set(st.suppressed ?? []);
  const out: StudyProblem = { fixed: [], loads: [], problems: [], supportIds: [] };
  for (const s of st.supports) {
    if (off.has(s.id)) continue;
    if (!s.faces.length) { out.problems.push({ id: s.id, code: "E-SIM-EMPTY" }); continue; }
    const tris = trisOf(b, s.faces.map(f => f.name));
    if (!tris) { out.problems.push({ id: s.id, code: "E-SIM-REF" }); continue; }
    const sup: Support = { tris, mode: s.type };
    if (s.type === "hinge") {
      const axis = axisOf(tris);
      if (!axis) { out.problems.push({ id: s.id, code: "E-SIM-HINGE" }); continue; }
      sup.axis = axis; sup.axialFree = s.axialFree;
    }
    if (s.type === "dirs") sup.dirs = s.dirs ?? [true, true, true];
    out.fixed.push(sup);
    out.supportIds.push(s.id);
  }
  for (const l of st.loads) {
    if (off.has(l.id)) continue;
    const comp = (l.comp ?? [{ v: 0 }, { v: 0 }, { v: 0 }]).map(c => c.v);
    if (l.type === "gravity") {
      out.gravity = (out.gravity ?? [0, 0, 0]).map((v, i) => v + comp[i]);
      continue;
    }
    if (!l.faces.length) { out.problems.push({ id: l.id, code: "E-SIM-EMPTY" }); continue; }
    const tris = trisOf(b, l.faces.map(f => f.name));
    if (!tris) { out.problems.push({ id: l.id, code: "E-SIM-REF" }); continue; }
    const sign = l.flip ? -1 : 1, v = l.value?.v ?? 0;
    if (l.type === "pressure") out.loads.push({ tris, pressure: sign * v });
    else if (l.type === "moment") out.loads.push({ tris, moment: comp });
    else if (l.normal) out.loads.push({ tris, pressure: (sign * v) / (triArea(tris) || 1) });
    else out.loads.push({ tris, force: comp });
  }
  return out;
}

export interface PassResult {
  pass: number;
  p: number;
  dofs: number;
  cells: number;
  /** Strain energy, N·mm. */
  energy: number;
  /** Change of the energy from the pass before, %, null on the first. */
  change: number | null;
  ms: number;
  reactions: Reaction[];
  applied: Reaction;
  /** At the sample points: displacement (3 each, mm) and von Mises stress (MPa). */
  u: Float32Array;
  vm: Float32Array;
  /** Where this pass still changed the solution: the local estimate at the sample points, % (zeros on the first pass). */
  err: Float32Array;
  /**
   * Error estimates in the energy norm, %, one per pass so far. A pass's error is known from the next one;
   * the last entry is extrapolated from the two before (their ratio holds), or null when there are fewer.
   */
  errors: (number | null)[];
  maxU: number;
  maxVm: number;
  /** The energy change is within the target (or this was the last pass). */
  done: boolean;
  converged: boolean;
}

export interface RunInput {
  body: SimBody;
  mat: SimMaterial;
  problem: StudyProblem;
  passes: number;
  /** Energy change target, %. */
  energyTol: number;
  /** Where results are wanted: positions and outward normals (3 each). */
  pos: Float32Array;
  nrm: Float32Array;
  /** Cells aimed for (default 150). */
  cells?: number;
}

/** Volume of a closed, outward-wound triangle mesh. */
export function meshVolume(t: ArrayLike<number>): number {
  let v = 0;
  for (let o = 0; o < t.length; o += 9)
    v += (t[o] * (t[o + 4] * t[o + 8] - t[o + 5] * t[o + 7]) - t[o + 1] * (t[o + 3] * t[o + 8] - t[o + 5] * t[o + 6]) + t[o + 2] * (t[o + 3] * t[o + 7] - t[o + 4] * t[o + 6])) / 6;
  return v;
}

/** Cell size for a body: about `cells` cells of material, never larger than the box's middle dimension. */
export function cellSize(b: SimBody, cells = 150): number {
  const d = [0, 1, 2].map(a => b.hi[a] - b.lo[a]).sort((x, y) => x - y);
  const vol = Math.abs(meshVolume(b.tris)) || d[0] * d[1] * d[2];
  const h = Math.min(Math.cbrt(vol / cells), Math.max(d[1], d[2] / 8));
  // a size that divides the smallest dimension lets flat-sided parts fill whole cells
  const fit = d[0] / Math.max(1, Math.round(d[0] / h));
  return fit > 0.7 * h && fit < 1.4 * h ? fit : h;
}

/**
 * The error of the pass after the ones whose errors are known: they fall by a steady ratio, so the next is
 * e·(e / before), never more than e. Null with fewer than two.
 */
export function passError(known: number[]): number | null {
  const n = known.length;
  if (n < 2) return null;
  const e = known[n - 1], b = known[n - 2];
  return b > 0 ? e * Math.min(1, e / b) : 0;
}

/** The passes of a static study: degree 2, 3, 4 on the same cells, until the energy settles. */
export function* runStatic(inp: RunInput): Generator<PassResult> {
  if (inp.problem.problems.length) throw new Error(`${inp.problem.problems[0].code}: ${inp.problem.problems[0].id}`);
  if (!inp.problem.loads.length && !inp.problem.gravity) throw new Error("E-SIM-NOLOAD");
  if (!inp.problem.fixed.length) throw new Error("E-SIM-FREE: 6");
  const body = new MeshBody(inp.body.tris);
  const inside = insideOf(body);
  const h = cellSize(inp.body, inp.cells);
  const passes = Math.max(1, Math.min(3, Math.round(inp.passes)));
  let grid: Grid | undefined, last = 0, prev: Float64Array | undefined;
  const known: number[] = [];
  for (let k = 0; k < passes; k++) {
    const t0 = Date.now();
    const p = k + 2;
    const r = solveStatic({
      lo: inp.body.lo, hi: inp.body.hi, inside, h, p, grid, prev,
      mat: { E: inp.mat.E, nu: inp.mat.nu, rho: inp.mat.rho },
      fixed: inp.problem.fixed, loads: inp.problem.loads, gravity: inp.problem.gravity,
    });
    grid = r.grid;
    prev = r.x;
    if (r.prevError != null) known.push(r.prevError);
    const errors: (number | null)[] = [...known, passError(known)];
    const { u, vm, err } = r.sample(inp.pos, inp.nrm);
    let maxU = 0, maxVm = 0;
    for (let i = 0; i < vm.length; i++) {
      maxVm = Math.max(maxVm, vm[i]);
      maxU = Math.max(maxU, Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]));
    }
    const change = k ? (Math.abs(r.energy - last) / Math.abs(r.energy || 1)) * 100 : null;
    last = r.energy;
    const converged = change != null && change <= inp.energyTol;
    yield { pass: k + 1, p, dofs: r.dofs, cells: r.grid.elems.length, energy: r.energy, change, ms: Date.now() - t0, reactions: r.reactions, applied: r.applied, u, vm, err, errors, maxU, maxVm, converged, done: converged || k === passes - 1 };
    if (converged) return;
  }
}
