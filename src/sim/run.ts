// Structural analysis (FR-SOL-010, FR-STU-020): a study turned into a solver problem, and the passes.
// Pure: runs in the solver worker and in node tests.

import { MeshBody, insideOf } from "./body";
import { solveStatic, triArea, triNormals, type Load, type Reaction, type Support } from "./static";
import type { Grid } from "./grid";
import type { Study, StudyEdge, StudyPoint } from "./types";

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

const vkey = (t: ArrayLike<number>, o: number, q: number) => `${Math.round(t[o] / q)},${Math.round(t[o + 1] / q)},${Math.round(t[o + 2] / q)}`;
const quantum = (b: SimBody) => 1e-7 * Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2], 1e-9);

/**
 * The edge two faces share, as segments of 9 numbers: both ends and a direction into the body (against the
 * two faces' normals). Null when a face is gone, empty when they share no edge.
 */
export function edgeLines(b: SimBody, fa: string, fb: string): Float64Array | null {
  const ia = b.names.indexOf(fa), ib = b.names.indexOf(fb);
  if (ia < 0 || ib < 0) return null;
  if (ia === ib) return new Float64Array(0);
  const q = quantum(b), T = b.tris, nrm = triNormals(T);
  const sides = new Map<string, number>();
  const each = (f: number, fn: (key: string, t: number, o0: number, o1: number) => void) => {
    for (let t = 0; t < b.face.length; t++) {
      if (b.face[t] !== f) continue;
      const k = [0, 1, 2].map(v => vkey(T, 9 * t + 3 * v, q));
      for (let e = 0; e < 3; e++) {
        const i = e, j = (e + 1) % 3;
        fn(k[i] < k[j] ? `${k[i]}|${k[j]}` : `${k[j]}|${k[i]}`, t, 9 * t + 3 * i, 9 * t + 3 * j);
      }
    }
  };
  each(ib, (key, t) => { sides.set(key, t); });
  const out: number[] = [];
  each(ia, (key, t, o0, o1) => {
    const u = sides.get(key);
    if (u === undefined) return;
    const d = [0, 1, 2].map(c => -(nrm[3 * t + c] + nrm[3 * u + c]));
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    out.push(T[o0], T[o0 + 1], T[o0 + 2], T[o1], T[o1 + 1], T[o1 + 2], d[0] / l, d[1] / l, d[2] / l);
  });
  return Float64Array.from(out);
}

/**
 * The corner where the faces meet nearest `at`: position and a direction into the body (against the normals
 * of the triangles around it). Null when a face is gone or they share no point.
 */
export function cornerPoint(b: SimBody, faces: string[], at: ArrayLike<number>): number[] | null {
  const ids = faces.map(n => b.names.indexOf(n));
  if (!ids.length || ids.some(i => i < 0)) return null;
  const q = quantum(b), T = b.tris;
  const seen = new Map<string, { mask: Set<number>; o: number }>();
  for (let t = 0; t < b.face.length; t++) {
    if (!ids.includes(b.face[t])) continue;
    for (let v = 0; v < 3; v++) {
      const k = vkey(T, 9 * t + 3 * v, q);
      let r = seen.get(k);
      if (!r) seen.set(k, r = { mask: new Set(), o: 9 * t + 3 * v });
      r.mask.add(b.face[t]);
    }
  }
  const want = new Set(ids).size;
  let best = -1, bd = Infinity, bk = "";
  for (const [k, r] of seen) {
    if (r.mask.size < want) continue;
    const d = Math.hypot(T[r.o] - at[0], T[r.o + 1] - at[1], T[r.o + 2] - at[2]);
    if (d < bd) { bd = d; best = r.o; bk = k; }
  }
  if (best < 0) return null;
  const nrm = triNormals(T), d = [0, 0, 0];
  for (let t = 0; t < b.face.length; t++) for (let v = 0; v < 3; v++)
    if (vkey(T, 9 * t + 3 * v, q) === bk) for (let c = 0; c < 3; c++) d[c] -= nrm[3 * t + c];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [T[best], T[best + 1], T[best + 2], d[0] / l, d[1] / l, d[2] / l];
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

/** The picked edges as segments, or the picked corners as points, of an item on edges or points; else the problem. */
function linesOrPoints(b: SimBody, it: { on?: "edges" | "points"; edges?: StudyEdge[]; points?: StudyPoint[] }): Float64Array | "E-SIM-REF" | "E-SIM-EMPTY" {
  const parts: number[] = [];
  if (it.on === "edges") for (const e of it.edges ?? []) {
    const s = edgeLines(b, e.faces[0], e.faces[1]);
    if (!s || !s.length) return "E-SIM-REF";
    for (const v of s) parts.push(v);
  } else for (const pt of it.points ?? []) {
    const c = cornerPoint(b, pt.faces, pt.at);
    if (!c) return "E-SIM-REF";
    parts.push(...c);
  }
  return parts.length ? Float64Array.from(parts) : "E-SIM-EMPTY";
}

/** Supports and loads of a study on the body's triangles. */
export function studyProblem(st: Study, b: SimBody): StudyProblem {
  const off = new Set(st.suppressed ?? []);
  const out: StudyProblem = { fixed: [], loads: [], problems: [], supportIds: [] };
  for (const s of st.supports) {
    if (off.has(s.id)) continue;
    if (s.on && (s.type === "fixed" || s.type === "dirs")) {
      const g = linesOrPoints(b, s);
      if (typeof g === "string") { out.problems.push({ id: s.id, code: g }); continue; }
      const sup: Support = { tris: new Float64Array(0), mode: s.type, ...(s.on === "edges" ? { lines: g } : { points: g }) };
      if (s.type === "dirs") sup.dirs = s.dirs ?? [true, true, true];
      out.fixed.push(sup);
      out.supportIds.push(s.id);
      continue;
    }
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
    if (l.type === "force" && l.on) {
      const none = new Float64Array(0), g = linesOrPoints(b, l);
      if (typeof g === "string") out.problems.push({ id: l.id, code: g });
      else out.loads.push(l.on === "edges" ? { tris: none, force: comp, lines: g } : { tris: none, force: comp, points: g });
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
  /** Highest degree in use. */
  p: number;
  /** Local passes: how many elements had their degree raised in this pass (absent on whole-body passes). */
  raised?: number;
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
  /**
   * Modal studies: the modes, lowest first, and each one's shape at the sample points (3 each, scaled so the
   * largest displacement is 1). `u` is then the first elastic mode's shape, `vm` zeros, `change` the largest
   * change of an elastic frequency from the pass before, %.
   */
  modes?: ModeInfo[];
  shapes?: Float32Array[];
  /** Modal studies: the body's mass, t. */
  mass?: number;
}

export interface ModeInfo {
  hz: number;
  /** A motion of the whole body without strain. */
  rigid: boolean;
  /** Effective mass along X, Y, Z as shares of the body's mass. */
  eff: [number, number, number];
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
  /** A modal study: this many modes; loads are not used. */
  modal?: { count: number };
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

/** Whole-body passes (degree 2, 3, 4), then local ones up to this many passes and this degree. */
export const GLOBAL_PASSES = 3, MAX_PASSES = 6, LOCAL_DEGREE = 6;

/**
 * Elements to refine next: the fewest that hold `share` of the error indicator among those still below
 * `pmax`, largest first.
 */
export function markElements(ind: ArrayLike<number>, deg: ArrayLike<number>, share = 0.6, pmax = LOCAL_DEGREE): number[] {
  const open: number[] = [];
  let total = 0;
  for (let e = 0; e < ind.length; e++) if (deg[e] < pmax && ind[e] > 0) { open.push(e); total += ind[e]; }
  open.sort((a, b) => ind[b] - ind[a]);
  const out: number[] = [];
  let sum = 0;
  for (const e of open) {
    if (sum >= share * total) break;
    out.push(e); sum += ind[e];
  }
  return out;
}

/**
 * The passes of a static study on the same cells, until the energy settles: degree 2, 3, 4 everywhere,
 * then local passes that raise the degree by one only in the elements holding most of the error estimate.
 */
export function* runStatic(inp: RunInput): Generator<PassResult> {
  if (inp.problem.problems.length) throw new Error(`${inp.problem.problems[0].code}: ${inp.problem.problems[0].id}`);
  if (!inp.problem.loads.length && !inp.problem.gravity) throw new Error("E-SIM-NOLOAD");
  if (!inp.problem.fixed.length) throw new Error("E-SIM-FREE: 6");
  const body = new MeshBody(inp.body.tris);
  const inside = insideOf(body);
  const h = cellSize(inp.body, inp.cells);
  const passes = Math.max(1, Math.min(MAX_PASSES, Math.round(inp.passes)));
  let grid: Grid | undefined, last = 0, prev: Float64Array | undefined;
  const known: number[] = [];
  // local passes: each element's degree, and its share of the error when its degree was last raised
  let degrees: Int8Array | undefined, ind: Float64Array | undefined;
  for (let k = 0; k < passes; k++) {
    const t0 = Date.now();
    let p = k + 2, raised: number | undefined, marked: number[] = [];
    if (k >= GLOBAL_PASSES && grid && ind) {
      degrees ??= new Int8Array(grid.elems.length).fill(GLOBAL_PASSES + 1);
      marked = markElements(ind, degrees);
      if (!marked.length) return;
      for (const e of marked) degrees[e]++;
      raised = marked.length;
      p = 0;
      for (let e = 0; e < degrees.length; e++) p = Math.max(p, degrees[e]);
    }
    const r = solveStatic({
      lo: inp.body.lo, hi: inp.body.hi, inside, h, p, grid, prev, degrees,
      mat: { E: inp.mat.E, nu: inp.mat.nu, rho: inp.mat.rho },
      fixed: inp.problem.fixed, loads: inp.problem.loads, gravity: inp.problem.gravity,
    });
    grid = r.grid;
    prev = r.x;
    if (!ind || !degrees) ind = Float64Array.from(r.eta);
    else for (const e of marked) ind[e] = r.eta[e];
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
    yield { pass: k + 1, p, raised, dofs: r.dofs, cells: r.grid.elems.length, energy: r.energy, change, ms: Date.now() - t0, reactions: r.reactions, applied: r.applied, u, vm, err, errors, maxU, maxVm, converged, done: converged || k === passes - 1 || (k >= GLOBAL_PASSES - 1 && k < passes - 1 && !markElements(ind, degrees ?? new Int8Array(ind.length).fill(GLOBAL_PASSES + 1)).length) };
    if (converged) return;
  }
}

/**
 * The passes of a modal study (FR-RES-020..022): degree 2, 3, 4 on the same cells, each starting from the
 * modes of the one before, until the elastic frequencies settle within `energyTol` %.
 */
export function* runModal(inp: RunInput): Generator<PassResult> {
  if (inp.problem.problems.length) throw new Error(`${inp.problem.problems[0].code}: ${inp.problem.problems[0].id}`);
  if (!(inp.mat.rho > 0)) throw new Error("E-SIM-DENSITY");
  const body = new MeshBody(inp.body.tris);
  const inside = insideOf(body);
  const h = cellSize(inp.body, inp.cells);
  const passes = Math.max(1, Math.min(GLOBAL_PASSES, Math.round(inp.passes)));
  const count = Math.max(1, Math.round(inp.modal?.count ?? 6));
  let grid: Grid | undefined, start: Float64Array[] | undefined, before: number[] | null = null;
  const none: Reaction = { force: [0, 0, 0], moment: [0, 0, 0] };
  for (let k = 0; k < passes; k++) {
    const t0 = Date.now(), p = k + 2;
    const r = solveStatic({
      lo: inp.body.lo, hi: inp.body.hi, inside, h, p, grid,
      mat: { E: inp.mat.E, nu: inp.mat.nu, rho: inp.mat.rho },
      fixed: inp.problem.fixed, loads: [], modal: { count, start },
    });
    grid = r.grid; start = r.space;
    const found = r.modes ?? [];
    const shapes: Float32Array[] = [];
    found.forEach((_m, i) => {
      r.use!(i);
      const u = r.sample(inp.pos, inp.nrm).u;
      // largest displacement 1, and its largest component positive, so a mode looks the same in every pass
      let top = 0, at = 0;
      for (let j = 0; j < u.length; j += 3) { const l = Math.hypot(u[j], u[j + 1], u[j + 2]); if (l > top) { top = l; at = j; } }
      let sign = 1;
      if (top > 0) { const a = [Math.abs(u[at]), Math.abs(u[at + 1]), Math.abs(u[at + 2])], c = a.indexOf(Math.max(...a)); sign = u[at + c] < 0 ? -1 : 1; }
      const f = top > 0 ? sign / top : 1;
      for (let j = 0; j < u.length; j++) u[j] *= f;
      shapes.push(u);
    });
    const freqs = found.map(m => m.hz);
    let change: number | null = null;
    if (before) {
      change = 0;
      found.forEach((m, i) => { if (!m.rigid && before![i] > 0) change = Math.max(change!, (Math.abs(m.hz - before![i]) / m.hz) * 100); });
    }
    before = freqs;
    const first = Math.max(0, found.findIndex(m => !m.rigid));
    const n = inp.pos.length / 3;
    const converged = change != null && change <= inp.energyTol;
    yield {
      pass: k + 1, p, dofs: r.dofs, cells: r.grid.elems.length, energy: 0, change, ms: Date.now() - t0, reactions: [], applied: none,
      u: shapes[first] ? Float32Array.from(shapes[first]) : new Float32Array(3 * n), vm: new Float32Array(n), err: new Float32Array(n), errors: [],
      maxU: shapes.length ? 1 : 0, maxVm: 0, converged, done: converged || k === passes - 1,
      modes: found.map(m => ({ hz: m.hz, rigid: m.rigid, eff: m.eff })), shapes, mass: r.mass,
    };
    if (converged) return;
  }
}
