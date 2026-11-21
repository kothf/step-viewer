// Structural analysis (FR-SARC-012): background cells over the body and their aggregation.
// A uniform grid of cubes covers the body's box; cells the body misses are dropped, cells it cuts keep
// only the quadrature points inside. A cell with little material (volume fraction < minFrac) lends its
// points to the neighbour with the most material, whose polynomial then spans both (aggregation), so no
// basis lives on a sliver and the stiffness stays well conditioned.

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
  cellOf(x: number, y: number, z: number, dom = -1) {
    const [i, j, k] = this.index(x, y, z);
    if (dom < 0 && this.maps.length > 1) {
      // only where two domains share the cell does the point itself have to be asked
      let only = -1, n = 0;
      for (let d = 0; d < this.maps.length; d++) if (this.at(i, j, k, d) >= 0) { only = d; n++; }
      dom = n === 1 ? only : this.domainOf(x, y, z);
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
export function makeGrid(lo: number[], hi: number[], h: number, inside: Inside, o: GridOptions): Grid {
  const n = [0, 1, 2].map(a => Math.max(1, Math.ceil((hi[a] - lo[a]) / h - 1e-4)));
  // centre the grid on the box so the leftover is shared by both ends
  const lo0 = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2 - n[a] * h / 2);
  const g = new Grid(lo0, h, n);
  const vol = h * h * h;
  const doms = o.domains && o.domains.length > 1 ? o.domains : [inside];
  if (doms.length > 1) g.doms = doms;
  for (let dom = 0; dom < doms.length; dom++) {
  const inside = doms[dom], map = dom ? g.addMap() : g.map;
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const clo = [lo0[0] + i * h, lo0[1] + j * h, lo0[2] + k * h];
    const chi = [clo[0] + h, clo[1] + h, clo[2] + h];
    const s0 = boxState(clo, chi, inside);
    // exact for a mesh body; else the 27 samples can miss thin material, so an "outside" cell still has
    // its Gauss points tested
    if (s0 === 0 && inside.hint) continue;
    const st = s0 === 0 ? -1 : s0;
    const fine = st === 1 ? null : volumePoints(clo, chi, o.leafQ ?? 3, inside, s0 === -1 ? o.depth : 0, new Points(), st, 3, LEAF_RICH);
    if (fine && !fine.n) continue;
    const pts = fine ? (o.fit && fine.n > o.fit ** 3 ? fitPoints(fine, clo, chi, o.fit) : fine) : volumePoints(clo, chi, o.q, inside, 0, new Points(), 1);
    const frac = pts.weight() / vol;
    // a face lying on a grid plane leaves a film of no volume in the cell beyond it
    if (!(frac > 1e-9)) continue;
    map[(k * n[1] + j) * n[0] + i] = g.cells.length;
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
  for (const c of g.cells) {
    if (degree) { const d = degree(c); q = Math.min(q0, d + 1); fit = Math.min(fit0, 2 * d + 1); }
    c.pts = c.fine ? (fit && c.fine.n > fit ** 3 ? fitPoints(c.fine, c.lo, c.hi, fit) : c.fine) : volumePoints(c.lo, c.hi, q, () => true, 0, new Points(), 1);
  }
}

function aggregate(g: Grid, minFrac: number, rigid?: boolean[]) {
  const big = (c: number) => g.cells[c].frac >= minFrac;
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
