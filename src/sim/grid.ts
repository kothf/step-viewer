// Structural analysis (FR-SARC-012): background cells over the body and their aggregation.
// A uniform grid of cubes covers the body's box; cells the body misses are dropped, cells it cuts keep
// only the quadrature points inside. A cell with little material (volume fraction < minFrac) lends its
// points to the neighbour with the most material, whose polynomial then spans both (aggregation), so no
// basis lives on a sliver and the stiffness stays well conditioned.

import { progress } from "./progress";
import { kernel, parallelFor, sharedF64, sharedI32, worthSharing, type ParJob } from "./threads";
import { MOM_SIZE, Points, boxState, fitPoints, volumePoints, type Inside } from "./quad";
import { MeshBody, insideOf } from "./body";

export interface Cell {
  ijk: [number, number, number];
  lo: number[];
  hi: number[];
  /** 1 inside, −1 cut. */
  state: number;
  pts: Points;
  /** Cut cells: the points found on the geometry, before moment fitting. */
  fine: Points | null;
  /** Material volume / cell volume. */
  frac: number;
  /** Element holding the cell's polynomial. */
  el: number;
  /** Domain (a body with its own material) the cell belongs to; 0 with one domain. */
  dom: number;
}

export interface Element {
  /** Centre and half size of the root cell: the polynomial's scaled coordinates. */
  c: number[];
  s: number;
  cells: number[];
}

export class Grid {
  readonly cells: Cell[] = [];
  readonly elems: Element[] = [];
  /** Active cell per grid index, one map per domain. Domains share the grid: where two meet, each has its own cell. */
  readonly maps: Int32Array[] = [];
  /** With several domains: what each one fills. */
  doms: Inside[] | null = null;
  /** Fine quadrature of the faces between cells (key cell·3 + axis), reused by later passes. */
  readonly faces = new Map<number, Points | null>();
  /** The cut cells' fine points on shared memory (`at` = a cell's first point), once a fit was shared between threads. */
  shared: { a: Float64Array; at: Float64Array } | null = null;
  /**
   * The cut cells' moments kept between fits (`fitPoints`): MOM_SIZE numbers per cell from `slot[cell]`, summed up
   * to total degree `have[cell]` − 1, so a later pass adds only the moments its higher degree needs.
   */
  mom: { a: Float64Array; have: Int32Array; slot: Int32Array } | null = null;
  constructor(readonly lo: number[], readonly h: number, readonly n: number[]) {
    this.addMap();
  }
  get map() { return this.maps[0]; }
  addMap() { const m = new Int32Array(this.n[0] * this.n[1] * this.n[2]).fill(-1); this.maps.push(m); return m; }
  /** Active cell of domain `d` at grid index, −1 when none. */
  at(i: number, j: number, k: number, d = 0) {
    const n = this.n;
    if (i < 0 || j < 0 || k < 0 || i >= n[0] || j >= n[1] || k >= n[2]) return -1;
    return this.maps[d][(k * n[1] + j) * n[0] + i];
  }
  /** The domain a point is in (−1: none claims it, e.g. a point on the surface of another tessellation). */
  domainOf(x: number, y: number, z: number) {
    const D = this.doms;
    if (!D) return 0;
    for (let d = 0; d < D.length; d++) if (D[d](x, y, z)) return d;
    // just outside every domain: look a little way along the axes
    for (const s of [0.01, 0.05]) {
      const e = s * this.h;
      for (let d = 0; d < D.length; d++)
        if (D[d](x + e, y, z) || D[d](x - e, y, z) || D[d](x, y + e, z) || D[d](x, y - e, z) || D[d](x, y, z + e) || D[d](x, y, z - e)) return d;
      // on an edge or a corner of a box-like body no step along one axis goes in: try the diagonals too
      for (let d = 0; d < D.length; d++)
        for (let m = 0; m < 8; m++) if (D[d](x + (m & 1 ? e : -e), y + (m & 2 ? e : -e), z + (m & 4 ? e : -e))) return d;
    }
    return -1;
  }
  /** Grid index along each axis for a point (clamped). */
  index(x: number, y: number, z: number): [number, number, number] {
    const f = (v: number, a: number) => Math.min(this.n[a] - 1, Math.max(0, Math.floor((v - this.lo[a]) / this.h)));
    return [f(x, 0), f(y, 1), f(z, 2)];
  }
  /** Active cell holding a point; when its own cell is not active, the nearest active cell around it.
   * With several domains the cell is the one of the point's domain, or of `dom` when given. */
  /** Whether cell c is full of its body and the point lies inside it, clear of its faces. */
  private fills(c: number, x: number, y: number, z: number) {
    const cl = this.cells[c];
    if (cl.frac < 1 - 1e-9) return false;
    const m = 1e-7 * this.h;
    return x > cl.lo[0] + m && x < cl.hi[0] - m && y > cl.lo[1] + m && y < cl.hi[1] - m && z > cl.lo[2] + m && z < cl.hi[2] - m;
  }
  /**
   * The cell of each point of `pos` (stepped `eps` against its normal when given), found once per list and kept:
   * every pass reads its results at the same points of the picture, and the cells do not change between passes.
   */
  cellsOf(pos: ArrayLike<number>, nrm: ArrayLike<number> | undefined, eps: number): Int32Array {
    const key = pos as object, had = this.found.get(key);
    if (had && had.nrm === nrm && had.n === pos.length) return had.cells;
    const n = pos.length / 3, cells = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      if (nrm) { x -= eps * nrm[3 * i]; y -= eps * nrm[3 * i + 1]; z -= eps * nrm[3 * i + 2]; }
      cells[i] = this.cellOf(x, y, z);
    }
    this.found.set(key, { nrm, n: pos.length, cells });
    return cells;
  }
  private found = new WeakMap<object, { nrm: ArrayLike<number> | undefined; n: number; cells: Int32Array }>();
  cellOf(x: number, y: number, z: number, dom = -1) {
    const [i, j, k] = this.index(x, y, z);
    if (dom < 0 && this.maps.length > 1) {
      // only where two domains share the cell does the point itself have to be asked
      let only = -1, n = 0;
      for (let d = 0; d < this.maps.length; d++) if (this.at(i, j, k, d) >= 0) { only = d; n++; }
      // one domain's cell here does not make the point that domain's: a cell of a thin body reaches past it, and
      // a point on another body's face just across a cell plane would read the first body's field
      // (a point well inside a cell that body fills needs no asking)
      dom = n === 1 && (!this.doms || this.fills(this.at(i, j, k, only), x, y, z) || this.doms[only](x, y, z)) ? only : this.domainOf(x, y, z);
    }
    const one = dom >= 0 ? dom : 0, all = dom < 0 && this.maps.length > 1;
    const c = this.at(i, j, k, one);
    if (c >= 0) return c;
    if (all) for (let d = 1; d < this.maps.length; d++) { const o = this.at(i, j, k, d); if (o >= 0) return o; }
    let best = -1, bd = Infinity;
    for (let dm = all ? 0 : one; dm <= (all ? this.maps.length - 1 : one); dm++)
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const o = this.at(i + di, j + dj, k + dk, dm);
      if (o < 0) continue;
      const cl = this.cells[o];
      let d = 0;
      for (let a = 0; a < 3; a++) {
        const v = [x, y, z][a];
        d += Math.max(0, cl.lo[a] - v, v - cl.hi[a]) ** 2;
      }
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  get volume() { let s = 0; for (const c of this.cells) s += c.pts.weight(); return s; }
}

export interface GridOptions {
  /** Gauss points per direction in a cell. */
  q: number;
  /** Octree depth of the quadrature in cut cells. */
  depth: number;
  /** Cut cells: Gauss points per direction of the moment-fitted rule (0 = keep every point). */
  fit?: number;
  /** Gauss points per direction in the leaves of cut cells (default 3); kept so `refit` can reuse them. */
  leafQ?: number;
  /** Cells below this volume fraction are aggregated. */
  minFrac?: number;
  /** Several bodies with a material each: every one gets its own cells and elements (`inside` = all of them). */
  domains?: Inside[];
  /** Per domain: a rigid one is a single element over all its cells (its polynomial is then kept linear). */
  rigid?: boolean[];
}

/** Gauss points per direction in the large uncut pieces of a cut cell: enough for the highest pass (p = 4). */
const LEAF_RICH = 5;

/** What one grid cube holds: null when the body misses it, else its state, its points and (cut) the points found on the geometry. */
function cellAt(clo: number[], chi: number[], inside: Inside, o: GridOptions, full: boolean): { st: number; fine: Points | null; pts: Points | null } | null {
  const s0 = boxState(clo, chi, inside);
  // exact for a mesh body; else the 27 samples can miss thin material, so an "outside" cell still has
  // its Gauss points tested
  if (s0 === 0 && inside.hint) return null;
  const st = s0 === 0 ? -1 : s0;
  // a whole cell's Gauss points are cheap: a helper thread leaves them to the caller (`full` false)
  if (st === 1) return { st, fine: null, pts: full ? volumePoints(clo, chi, o.q, inside, 0, new Points(), 1) : null };
  const fine = volumePoints(clo, chi, o.leafQ ?? 3, inside, s0 === -1 ? o.depth : 0, new Points(), st, 3, LEAF_RICH);
  if (!fine.n) return null;
  return { st, fine, pts: o.fit && fine.n > o.fit ** 3 ? fitPoints(fine, clo, chi, o.fit) : fine };
}

/** Cells of size h over [lo, hi] for the body `inside`. */
export function makeGrid(lo: number[], hi: number[], h: number, inside: Inside, o: GridOptions): Grid {
  const n = [0, 1, 2].map(a => Math.max(1, Math.ceil((hi[a] - lo[a]) / h - 1e-4)));
  // centre the grid on the box so the leftover is shared by both ends
  const lo0 = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2 - n[a] * h / 2);
  const g = new Grid(lo0, h, n);
  const vol = h * h * h;
  const doms = o.domains && o.domains.length > 1 ? o.domains : [inside];
  if (doms.length > 1) g.doms = doms;
  const per = n[0] * n[1] * n[2], tasks = doms.length * per;
  // mesh bodies and several threads: the cubes are worked through on all of them (the same points either way)
  const found = doms.every(d => d.tris) && worthSharing(tasks * 1e6) ? sharedCells(lo0, h, n, doms, o) : null;
  for (let dom = 0; dom < doms.length; dom++) {
    const map = dom ? g.addMap() : g.map;
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
      if (i === 0 && !found) progress("cells", dom * n[2] * n[1] + k * n[1] + j, doms.length * n[2] * n[1]);
      const clo = [lo0[0] + i * h, lo0[1] + j * h, lo0[2] + k * h];
      const chi = [clo[0] + h, clo[1] + h, clo[2] + h];
      const at = (k * n[1] + j) * n[0] + i;
      const c = found ? found[dom * per + at] : cellAt(clo, chi, doms[dom], o, true);
      if (!c) continue;
      const pts = c.pts ?? volumePoints(clo, chi, o.q, doms[dom], 0, new Points(), 1);
      const frac = pts.weight() / vol;
      // a face lying on a grid plane leaves a film of no volume in the cell beyond it
      if (!(frac > 1e-9)) continue;
      map[at] = g.cells.length;
      g.cells.push({ ijk: [i, j, k], lo: clo, hi: chi, state: c.st, pts, fine: c.fine, frac, el: -1, dom });
    }
  }
  aggregate(g, o.minFrac ?? 0.25, doms.length > 1 ? o.rigid : undefined);
  return g;
}

/** Points a round of the shared cell loop has room for, and the room a thread wants left before it starts a cube. */
const CELL_ROOM = 1.5e6, CELL_RESERVE = 1e5;
/** Numbers per cube of the shared cell loop: status (0 nothing, 1 whole, 2 cut, 3 no room: again), state, first fine point, fine points, first fitted point, fitted points (−1 = the fine ones). */
const CELL_REC = 6;
interface CellJob extends ParJob { key: number; tris: Float64Array[]; ids: Int32Array; rec: Float64Array; out: Float64Array; ptr: Int32Array; lo0: number[]; h: number; dims: number[]; opt: { q: number; depth: number; fit?: number; leafQ?: number } }
/** The bodies of the cell loop under way, per thread: made once from the job's triangles (this thread already has them). */
let cellBodies: { key: number; doms: Inside[] } = { key: 0, doms: [] };
let cellKey = 0;
kernel<CellJob, { j: CellJob; doms: Inside[] }>("cells", {
  init(j) {
    if (cellBodies.key !== j.key) cellBodies = { key: j.key, doms: j.tris.map(t => insideOf(new MeshBody(t))) };
    return { j, doms: cellBodies.doms };
  },
  run({ j, doms }, t) {
    const id = j.ids[t], r = CELL_REC * id, rec = j.rec, cap = j.out.length / 4;
    if (Atomics.load(j.ptr, 0) > cap - CELL_RESERVE) { rec[r] = 3; return; }
    const [n0, n1, n2] = j.dims, per = n0 * n1 * n2, dom = Math.floor(id / per), at = id - dom * per, i = at % n0, jj = Math.floor(at / n0) % n1, k = Math.floor(at / (n0 * n1));
    const clo = [j.lo0[0] + i * j.h, j.lo0[1] + jj * j.h, j.lo0[2] + k * j.h], chi = [clo[0] + j.h, clo[1] + j.h, clo[2] + j.h];
    const c = cellAt(clo, chi, doms[dom], j.opt as GridOptions, false);
    if (!c) { rec[r] = 0; return; }
    rec[r + 1] = c.st;
    if (!c.fine) { rec[r] = 1; return; }
    const fitted = c.pts !== c.fine, need = c.fine.n + (fitted ? c.pts!.n : 0), off = Atomics.add(j.ptr, 0, need);
    if (off + need > cap) { rec[r] = 3; return; }
    j.out.set(c.fine.a.subarray(0, 4 * c.fine.n), 4 * off);
    if (fitted) j.out.set(c.pts!.a.subarray(0, 4 * c.pts!.n), 4 * (off + c.fine.n));
    rec[r + 2] = off; rec[r + 3] = c.fine.n; rec[r + 4] = off + c.fine.n; rec[r + 5] = fitted ? c.pts!.n : -1;
    rec[r] = 2;
  },
});

/**
 * Every cube of the grid looked at on all threads: what `cellAt` gives for each, in the cubes' order. The points
 * are written to shared memory a round at a time (a round ends when its memory is full; the cubes left over go
 * into the next one), and the cells keep views of it.
 */
function sharedCells(lo0: number[], h: number, n: number[], doms: Inside[], o: GridOptions): ({ st: number; fine: Points | null; pts: Points | null } | null)[] {
  const per = n[0] * n[1] * n[2], tasks = doms.length * per, res: ({ st: number; fine: Points | null; pts: Points | null } | null)[] = new Array(tasks).fill(null);
  const key = ++cellKey, tris = doms.map(d => { const t = sharedF64(d.tris!.length); t.set(d.tris!); return t; });
  cellBodies = { key, doms };
  const rec = sharedF64(CELL_REC * tasks), opt = { q: o.q, depth: o.depth, fit: o.fit, leafQ: o.leafQ };
  let left = Int32Array.from({ length: tasks }, (_v, i) => i), done = 0;
  const view = (out: Float64Array, off: number, cnt: number) => { const P = new Points(); P.a = out.subarray(4 * off, 4 * (off + cnt)); P.n = cnt; return P; };
  while (left.length) {
    const ids = sharedI32(left.length), out = sharedF64(4 * CELL_ROOM), ptr = sharedI32(1), base = done;
    ids.set(left);
    parallelFor({ kind: "cells", n: ids.length, key, tris, ids, rec, out, ptr, lo0, h, dims: n, opt } satisfies Omit<CellJob, "ctl">, d => progress("cells", Math.min(tasks, base + d), tasks));
    const again: number[] = [];
    for (const id of left) {
      const r = CELL_REC * id, s = rec[r];
      if (s === 3) { again.push(id); continue; }
      done++;
      if (s === 1) res[id] = { st: rec[r + 1], fine: null, pts: null };
      else if (s === 2) { const fine = view(out, rec[r + 2], rec[r + 3]); res[id] = { st: rec[r + 1], fine, pts: rec[r + 5] < 0 ? fine : view(out, rec[r + 4], rec[r + 5]) }; }
    }
    if (again.length === left.length) {
      // not even one cube fitted (a cube with more points than a round holds): the rest on this thread
      for (const id of again) {
        const dom = Math.floor(id / per), at = id - dom * per, i = at % n[0], j = Math.floor(at / n[0]) % n[1], k = Math.floor(at / (n[0] * n[1]));
        const clo = [lo0[0] + i * h, lo0[1] + j * h, lo0[2] + k * h];
        res[id] = cellAt(clo, [clo[0] + h, clo[1] + h, clo[2] + h], doms[dom], o, true);
      }
      break;
    }
    left = Int32Array.from(again);
  }
  return res;
}

/** The same cells with the quadrature for another degree: Gauss q in whole cells, the cut cells' points
 * fitted again to fit³ points. The geometry is not queried again. `degree` gives a cell its own degree d
 * (local refinement): then q = d + 1 and fit = 2d + 1 for that cell. */
export function refit(g: Grid, q: number, fit: number, degree?: (c: Cell) => number) {
  const q0 = q, fit0 = fit;
  let seen = 0;
  // the cut cells whose points are fitted again: the long part, shared between the threads when there are several
  const todo: number[] = [], fits: number[] = [];
  let work = 0;
  for (let i = 0; i < g.cells.length; i++) {
    const c = g.cells[i];
    if (!(seen++ & 15) && !todo.length) progress("cells", seen, g.cells.length);
    if (degree) { const d = degree(c); q = Math.min(q0, d + 1); fit = Math.min(fit0, 2 * d + 1); }
    if (c.fine && fit && c.fine.n > fit ** 3) { todo.push(i); fits.push(fit); work += (c.fine.n * fit ** 3) / 6; continue; }
    c.pts = c.fine ?? volumePoints(c.lo, c.hi, q, () => true, 0, new Points(), 1);
  }
  if (!todo.length) return;
  const share = worthSharing(work), M = momentsOf(g, share);
  if (!share) {
    todo.forEach((i, t) => {
      const c = g.cells[i], s = M.slot[i];
      if (!(t & 3)) progress("cells", t, todo.length);
      c.pts = fitPoints(c.fine!, c.lo, c.hi, fits[t], M.a.subarray(s, s + MOM_SIZE), M.have[i]);
      if (fits[t] > M.have[i]) M.have[i] = fits[t];
    });
    return;
  }
  // the fine points move to shared memory once and stay there for the later degrees
  if (!g.shared) {
    let n = 0;
    for (const c of g.cells) if (c.fine) n += c.fine.n;
    const a = sharedF64(4 * n), at = new Float64Array(g.cells.length);
    n = 0;
    g.cells.forEach((c, i) => {
      if (!c.fine) return;
      at[i] = n;
      a.set(c.fine.a.subarray(0, 4 * c.fine.n), 4 * n);
      c.fine.a = a.subarray(4 * n, 4 * (n + c.fine.n));
      n += c.fine.n;
    });
    g.shared = { a, at };
  }
  const T = todo.length, task = sharedF64(FIT_TASK * T), outN = sharedI32(T);
  let room = 0;
  todo.forEach((i, t) => {
    const c = g.cells[i], o = FIT_TASK * t;
    task[o] = g.shared!.at[i]; task[o + 1] = c.fine!.n; task[o + 2] = fits[t]; task[o + 3] = room; task[o + 10] = M.slot[i]; task[o + 11] = M.have[i];
    for (let k = 0; k < 3; k++) { task[o + 4 + k] = c.lo[k]; task[o + 7 + k] = c.hi[k]; }
    room += fits[t] ** 3;
  });
  const out = sharedF64(4 * room);
  parallelFor({ kind: "fit", n: T, fine: g.shared.a, task, out, outN, mom: M.a } satisfies Omit<FitJob, "ctl">, d => progress("cells", d, T));
  todo.forEach((i, t) => {
    if (fits[t] > M.have[i]) M.have[i] = fits[t];
    const P = new Points(), s = 4 * task[FIT_TASK * t + 3];
    P.a = out.subarray(s, s + 4 * outN[t]); P.n = outN[t];
    g.cells[i].pts = P;
  });
}

/** The grid's kept moments, made at the first fit (on shared memory once a fit is shared between threads). */
function momentsOf(g: Grid, share: boolean) {
  if (!g.mom) {
    const slot = new Int32Array(g.cells.length).fill(-1);
    let n = 0;
    g.cells.forEach((c, i) => { if (c.fine) { slot[i] = n; n += MOM_SIZE; } });
    g.mom = { a: share ? sharedF64(n) : new Float64Array(n), have: new Int32Array(g.cells.length), slot };
  } else if (share && !(g.mom.a.buffer instanceof SharedArrayBuffer)) {
    const a = sharedF64(g.mom.a.length);
    a.set(g.mom.a);
    g.mom.a = a;
  }
  return g.mom;
}

/** Numbers per task of a shared fit: first fine point, their count, fit, first point of the output, lo, hi, first kept moment, the degree they are summed to. */
const FIT_TASK = 12;
interface FitJob extends ParJob { fine: Float64Array; task: Float64Array; out: Float64Array; outN: Int32Array; mom: Float64Array }
kernel<FitJob, FitJob>("fit", {
  init: j => j,
  run(j, t) {
    const k = j.task, o = FIT_TASK * t, s = 4 * k[o], n = k[o + 1];
    const P = fitPoints({ a: j.fine.subarray(s, s + 4 * n), n } as Points, [k[o + 4], k[o + 5], k[o + 6]], [k[o + 7], k[o + 8], k[o + 9]], k[o + 2], j.mom.subarray(k[o + 10], k[o + 10] + MOM_SIZE), k[o + 11]);
    j.out.set(P.a.subarray(0, 4 * P.n), 4 * k[o + 3]);
    j.outN[t] = P.n;
  },
});

function aggregate(g: Grid, minFrac: number, rigid?: boolean[]) {
  // a body thinner than a cell has no cell that full: its roots are then the cells at least half as full as its
  // fullest one, so its slivers (the rim of a thin plate) still join a neighbour instead of standing alone
  const most: number[] = [];
  for (const cl of g.cells) most[cl.dom] = Math.max(most[cl.dom] ?? 0, cl.frac);
  const big = (c: number) => g.cells[c].frac >= Math.min(minFrac, 0.5 * most[g.cells[c].dom]);
  // a rigid domain: one element over its box
  if (rigid) for (let d = 0; d < rigid.length; d++) {
    if (!rigid[d]) continue;
    const cells: number[] = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < g.cells.length; c++) {
      const cl = g.cells[c];
      if (cl.dom !== d) continue;
      cells.push(c);
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], cl.lo[a]); hi[a] = Math.max(hi[a], cl.hi[a]); }
    }
    if (!cells.length) continue;
    for (const c of cells) g.cells[c].el = g.elems.length;
    g.elems.push({ c: lo.map((v, a) => (v + hi[a]) / 2), s: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, cells });
  }
  // roots: every cell with enough material
  for (let c = 0; c < g.cells.length; c++) {
    if (!big(c) || g.cells[c].el >= 0) continue;
    const cl = g.cells[c];
    cl.el = g.elems.length;
    g.elems.push({ c: cl.lo.map((v, a) => (v + cl.hi[a]) / 2), s: g.h / 2, cells: [c] });
  }
  // small cells join the fullest root among their face neighbours, then edge/corner neighbours;
  // rounds let a chain of slivers reach a root further away
  for (let round = 0; round < 4; round++) {
    let left = 0;
    // a round only sees what the rounds before joined: else a row of slivers would chain along itself into one
    // long element instead of each joining the root beside it
    const joined: [number, number][] = [];
    for (let c = 0; c < g.cells.length; c++) {
      const cl = g.cells[c];
      if (cl.el >= 0) continue;
      const [i, j, k] = cl.ijk;
      let best = -1, bf = -1, bw = 9;
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const w = Math.abs(di) + Math.abs(dj) + Math.abs(dk);
        if (!w) continue;
        const o = g.at(i + di, j + dj, k + dk, cl.dom);
        if (o < 0 || g.cells[o].el < 0) continue;
        const root = g.cells[g.elems[g.cells[o].el].cells[0]];
        if (w < bw || (w === bw && root.frac > bf)) { best = o; bf = root.frac; bw = w; }
      }
      if (best < 0) { left++; continue; }
      joined.push([c, g.cells[best].el]);
    }
    for (const [c, e] of joined) { g.cells[c].el = e; g.elems[e].cells.push(c); }
    if (!left) break;
  }
  // isolated slivers keep their own polynomial
  for (let c = 0; c < g.cells.length; c++) {
    const cl = g.cells[c];
    if (cl.el >= 0) continue;
    cl.el = g.elems.length;
    g.elems.push({ c: cl.lo.map((v, a) => (v + cl.hi[a]) / 2), s: g.h / 2, cells: [c] });
  }
}

/**
 * The memory the stiffness matrix of a grid takes, bytes (FR-SOL-020): a dense block per element and two per
 * pair of elements with cells side by side, `size(e)` unknowns in element e. Joins between domains, bolts and
 * connectors add a little that is not counted.
 */
export function memoryBytes(g: Grid, size: (el: number) => number): number {
  const nel = g.elems.length;
  let sum = 0;
  for (let e = 0; e < nel; e++) sum += size(e) ** 2;
  const seen = new Set<number>();
  for (const c of g.cells) {
    for (let a = 0; a < 3; a++) {
      const o = g.at(c.ijk[0] + (a === 0 ? 1 : 0), c.ijk[1] + (a === 1 ? 1 : 0), c.ijk[2] + (a === 2 ? 1 : 0), c.dom);
      if (o < 0) continue;
      const x = c.el, y = g.cells[o].el;
      if (x === y) continue;
      const k = Math.min(x, y) * nel + Math.max(x, y);
      if (seen.has(k)) continue;
      seen.add(k);
      sum += 2 * size(x) * size(y);
    }
  }
  return 8 * sum;
}
