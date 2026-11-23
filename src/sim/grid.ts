// Structural analysis (FR-SARC-012): background cells over the body and their aggregation.
// A uniform grid of cubes covers the body's box; cells the body misses are dropped, cells it cuts keep
// only the quadrature points inside. A cell with little material (volume fraction < minFrac) lends its
// points to the neighbour with the most material, whose polynomial then spans both (aggregation), so no
// basis lives on a sliver and the stiffness stays well conditioned.

import { progress } from "./progress";
import { Points, boxState, fitPoints, volumePoints, type Inside } from "./quad";

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

/** Cells of size h over [lo, hi] for the body `inside`. */
/** What the grid over a box is: cells per direction and its low corner (centred on the box, the leftover shared by both ends). */
export function gridFrame(lo: number[], hi: number[], h: number): { n: number[]; lo0: number[] } {
  const n = [0, 1, 2].map(a => Math.max(1, Math.ceil((hi[a] - lo[a]) / h - 1e-4)));
  return { n, lo0: [0, 1, 2].map(a => (lo[a] + hi[a]) / 2 - n[a] * h / 2) };
}

/** A cell's state against the body (1 inside, −1 cut) and, when cut, its points on the geometry; null = no cell here. */
export interface CellPrep { st: number; fine: Points | null }
export function cellFine(clo: number[], chi: number[], inside: Inside, depth: number, leafQ: number): CellPrep | null {
  const s0 = boxState(clo, chi, inside);
  // exact for a mesh body; else the 27 samples can miss thin material, so an "outside" cell still has
  // its Gauss points tested
  if (s0 === 0 && inside.hint) return null;
  const st = s0 === 0 ? -1 : s0;
  const fine = st === 1 ? null : volumePoints(clo, chi, leafQ, inside, s0 === -1 ? depth : 0, new Points(), st, 3, LEAF_RICH);
  if (fine && !fine.n) return null;
  return { st, fine };
}

/**
 * Cells worked out ahead (by helper workers, `par.ts`): `makeGrid` takes them instead of cutting each cell itself
 * when the grid and the settings are the same. `cells[dom][index]`: undefined = not prepared, null = no cell.
 */
export interface Prepared { lo0: number[]; h: number; n: number[]; depth: number; leafQ: number; cells: (CellPrep | null | undefined)[][] }
let prepared: Prepared | null = null;
export function usePrepared(p: Prepared | null) { prepared = p; }

export function makeGrid(lo: number[], hi: number[], h: number, inside: Inside, o: GridOptions): Grid {
  const { n, lo0 } = gridFrame(lo, hi, h);
  const g = new Grid(lo0, h, n);
  const vol = h * h * h;
  const doms = o.domains && o.domains.length > 1 ? o.domains : [inside];
  if (doms.length > 1) g.doms = doms;
  const leafQ = o.leafQ ?? 3, P = prepared;
  const ready = P && P.h === h && P.depth === o.depth && P.leafQ === leafQ && P.cells.length === doms.length && [0, 1, 2].every(a => P.n[a] === n[a] && P.lo0[a] === lo0[a]) ? P.cells : null;
  for (let dom = 0; dom < doms.length; dom++) {
  const inside = doms[dom], map = dom ? g.addMap() : g.map;
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    if (i === 0) progress("cells", dom * n[2] * n[1] + k * n[1] + j, doms.length * n[2] * n[1]);
    const clo = [lo0[0] + i * h, lo0[1] + j * h, lo0[2] + k * h];
    const chi = [clo[0] + h, clo[1] + h, clo[2] + h];
    const at = (k * n[1] + j) * n[0] + i, had = ready?.[dom][at];
    const cf = had !== undefined ? had : cellFine(clo, chi, inside, o.depth, leafQ);
    if (!cf) continue;
    const { st, fine } = cf;
    const pts = fine ? (o.fit && fine.n > o.fit ** 3 ? fitPoints(fine, clo, chi, o.fit) : fine) : volumePoints(clo, chi, o.q, inside, 0, new Points(), 1);
    const frac = pts.weight() / vol;
    // a face lying on a grid plane leaves a film of no volume in the cell beyond it
    if (!(frac > 1e-9)) continue;
    map[at] = g.cells.length;
    g.cells.push({ ijk: [i, j, k], lo: clo, hi: chi, state: st, pts, fine, frac, el: -1, dom });
  }
  }
  aggregate(g, o.minFrac ?? 0.25, doms.length > 1 ? o.rigid : undefined);
  return g;
}

/** The same cells with the quadrature for another degree: Gauss q in whole cells, the cut cells' points
 * fitted again to fit³ points. The geometry is not queried again. `degree` gives a cell its own degree d
 * (local refinement): then q = d + 1 and fit = 2d + 1 for that cell. */
export function refit(g: Grid, q: number, fit: number, degree?: (c: Cell) => number) {
  const q0 = q, fit0 = fit;
  let seen = 0;
  for (const c of g.cells) {
    if (!(seen++ & 15)) progress("cells", seen, g.cells.length);
    if (degree) { const d = degree(c); q = Math.min(q0, d + 1); fit = Math.min(fit0, 2 * d + 1); }
    c.pts = c.fine ? (fit && c.fine.n > fit ** 3 ? fitPoints(c.fine, c.lo, c.hi, fit) : c.fine) : volumePoints(c.lo, c.hi, q, () => true, 0, new Points(), 1);
  }
}

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
