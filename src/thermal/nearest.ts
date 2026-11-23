// Nearest package point per model vertex (FR-TMAP-002): the model's own faces take the temperature of the
// closest point of the same part, so a STEP tessellated finer or differently still shows the map.
// Pure: a uniform grid hash (0.5 mm cells by default) searched ring by ring outwards.

export const NEAREST_CELL = 0.5;

/** The points of each part, from the triangles that carry its id. */
export function pointsByPart(tri: ArrayLike<number>, part: ArrayLike<number>): Map<number, Uint32Array> {
  const sets = new Map<number, Set<number>>();
  for (let k = 0; k < part.length; k++) {
    let s = sets.get(part[k]);
    if (!s) sets.set(part[k], s = new Set());
    s.add(tri[k * 3]); s.add(tri[k * 3 + 1]); s.add(tri[k * 3 + 2]);
  }
  const out = new Map<number, Uint32Array>();
  for (const [id, s] of sets) out.set(id, Uint32Array.from(s));
  return out;
}

/** A grid over some of the points of `pos` (x, y, z per point) that finds the nearest of them. */
export class PointGrid {
  private cells = new Map<number, number[]>();
  private min = [0, 0, 0];
  private n = [1, 1, 1];
  constructor(private pos: ArrayLike<number>, private pts: ArrayLike<number>, private cell = NEAREST_CELL) {
    if (!pts.length) return;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < pts.length; j++) for (let a = 0; a < 3; a++) { const v = pos[pts[j] * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    this.min = lo;
    // a very large part gets coarser cells, so the grid stays a few million cells at most
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (span / cell > 4000) this.cell = cell = span / 4000;
    this.n = [0, 1, 2].map(a => Math.floor((hi[a] - lo[a]) / cell) + 1);
    for (let j = 0; j < pts.length; j++) {
      const i = pts[j], key = this.key(this.ix(pos[i * 3], 0), this.ix(pos[i * 3 + 1], 1), this.ix(pos[i * 3 + 2], 2));
      const c = this.cells.get(key);
      if (c) c.push(i); else this.cells.set(key, [i]);
    }
  }
  private ix(v: number, a: number) { return Math.floor((v - this.min[a]) / this.cell); }
  private key(x: number, y: number, z: number) { return x + this.n[0] * (y + this.n[1] * z); }

  /** Index (into `pos`) of the nearest grid point to (x, y, z), or −1 when the grid is empty. */
  nearest(x: number, y: number, z: number): number {
    if (!this.pts.length) return -1;
    const n = this.n, p = this.pos;
    // start from the cell of the point clamped into the grid; rings beyond the far side add nothing
    const c = [this.ix(x, 0), this.ix(y, 1), this.ix(z, 2)].map((v, a) => Math.max(0, Math.min(n[a] - 1, v)));
    const reach = Math.max(c[0], n[0] - 1 - c[0], c[1], n[1] - 1 - c[1], c[2], n[2] - 1 - c[2]);
    // the query's distance outside the grid box is a floor on every candidate
    const out = [x, y, z].map((v, a) => Math.max(0, this.min[a] - v, v - (this.min[a] + n[a] * this.cell)));
    const base = Math.hypot(out[0], out[1], out[2]);
    let best = -1, bd = Infinity;
    const visit = (ix: number, iy: number, iz: number) => {
      if (ix < 0 || iy < 0 || iz < 0 || ix >= n[0] || iy >= n[1] || iz >= n[2]) return;
      const list = this.cells.get(this.key(ix, iy, iz));
      if (!list) return;
      for (const i of list) {
        const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    };
    for (let r = 0; r <= reach; r++) {
      // every unvisited cell is at least (r − 1) cells away, and never nearer than the grid box
      if (best >= 0) { const floor = Math.max(base, (r - 1) * this.cell); if (floor * floor > bd) break; }
      for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) {
        const edge = Math.abs(dz) === r || Math.abs(dy) === r;
        if (edge) for (let dx = -r; dx <= r; dx++) visit(c[0] + dx, c[1] + dy, c[2] + dz);
        else { visit(c[0] - r, c[1] + dy, c[2] + dz); if (r) visit(c[0] + r, c[1] + dy, c[2] + dz); }
      }
    }
    return best;
  }
}

/** Mean triangle edge length per part: a grid cell about that size keeps the ring search short. */
export function meanEdges(pos: ArrayLike<number>, tri: ArrayLike<number>, part: ArrayLike<number>): Map<number, number> {
  const sum = new Map<number, [number, number]>();
  const d = (i: number, j: number) => Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
  for (let k = 0; k < part.length; k++) {
    const a = tri[k * 3], b = tri[k * 3 + 1], c = tri[k * 3 + 2];
    let s = sum.get(part[k]);
    if (!s) sum.set(part[k], s = [0, 0]);
    s[0] += d(a, b) + d(b, c) + d(c, a); s[1] += 3;
  }
  const out = new Map<number, number>();
  for (const [id, [l, n]] of sum) out.set(id, n ? l / n : NEAREST_CELL);
  return out;
}

/** For each of `count` query points (x, y, z in `q`), the nearest point of `pts`; cell = max(0.5 mm, `edge`). */
export function nearestPoints(pos: ArrayLike<number>, pts: ArrayLike<number>, q: ArrayLike<number>, edge = 0): Int32Array {
  const g = new PointGrid(pos, pts, Math.max(NEAREST_CELL, edge)), n = q.length / 3, out = new Int32Array(n);
  for (let j = 0; j < n; j++) out[j] = g.nearest(q[j * 3], q[j * 3 + 1], q[j * 3 + 2]);
  return out;
}
