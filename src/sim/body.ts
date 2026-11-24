// Structural analysis (FR-SARC-012): the body as a closed triangle mesh of its exact faces.
// Lines along an axis are cut exactly at the mesh (Gauss lines in cut cells, the inside test by parity),
// and a box can say which way its boundary faces and whether two faces meet in it (an edge), so the
// quadrature splits such boxes further and runs its lines across the boundary.

export interface Body {
  inside(x: number, y: number, z: number): boolean;
  /** Sorted coordinates along `axis` where the line through p along that axis crosses the boundary. */
  hits?(axis: number, p: ArrayLike<number>): number[];
  /** The boundary inside box [lo, hi]: the axis nearest its normal, and whether it bends sharply there. */
  hint?(lo: ArrayLike<number>, hi: ArrayLike<number>): { axis: number; edge: boolean } | null;
}

/** Cosine of the largest normal spread a box may hold before it counts as an edge. */
const EDGE_COS = Math.cos((25 * Math.PI) / 180);

export class MeshBody implements Body {
  readonly n: Float64Array;
  readonly lo = [Infinity, Infinity, Infinity];
  readonly hi = [-Infinity, -Infinity, -Infinity];
  private readonly t: Float64Array;
  private readonly nt: number;
  /** Per axis: 2D buckets over the other two coordinates. */
  private seen: Int32Array | null = null;
  private stamp = 0;
  private readonly cols: { a1: number; a2: number; n1: number; n2: number; o1: number; o2: number; s: number; idx: Int32Array; start: Int32Array }[] = [];
  /** 3D buckets for box queries. */
  private readonly g3: { n: number[]; o: number[]; s: number; idx: Int32Array; start: Int32Array };
  /** Irrational offsets keep lines off triangle edges and vertices. */
  private readonly jit: number;
  /** The axis the inside test counts crossings along when it is not X. */
  private ray = 0;

  /** The triangles the body was made from. */
  get tris(): Float64Array { return this.t; }

  constructor(tris: ArrayLike<number>) {
    this.nt = tris.length / 9;
    this.t = Float64Array.from(tris);
    this.n = new Float64Array(3 * this.nt);
    const t = this.t;
    let area = 0;
    for (let i = 0; i < this.nt; i++) {
      const o = 9 * i;
      for (let k = 0; k < 9; k++) { const a = k % 3; this.lo[a] = Math.min(this.lo[a], t[o + k]); this.hi[a] = Math.max(this.hi[a], t[o + k]); }
      const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
      const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const l = Math.hypot(cx, cy, cz);
      area += l / 2;
      if (l > 0) { this.n[3 * i] = cx / l; this.n[3 * i + 1] = cy / l; this.n[3 * i + 2] = cz / l; }
    }
    const size = Math.max(this.hi[0] - this.lo[0], this.hi[1] - this.lo[1], this.hi[2] - this.lo[2]) || 1;
    this.jit = size * 1.234567e-9;
    // bucket size: a few triangles per bucket on average
    const s = Math.max(size / 256, Math.sqrt(area / Math.max(1, this.nt)) * 2);
    for (let ax = 0; ax < 3; ax++) {
      const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
      const o1 = this.lo[a1], o2 = this.lo[a2];
      const n1 = Math.max(1, Math.ceil((this.hi[a1] - o1) / s) + 1), n2 = Math.max(1, Math.ceil((this.hi[a2] - o2) / s) + 1);
      const lists: number[][] = Array.from({ length: n1 * n2 }, () => []);
      for (let i = 0; i < this.nt; i++) {
        const o = 9 * i;
        const u0 = Math.min(t[o + a1], t[o + 3 + a1], t[o + 6 + a1]), u1 = Math.max(t[o + a1], t[o + 3 + a1], t[o + 6 + a1]);
        const v0 = Math.min(t[o + a2], t[o + 3 + a2], t[o + 6 + a2]), v1 = Math.max(t[o + a2], t[o + 3 + a2], t[o + 6 + a2]);
        const i0 = Math.max(0, Math.floor((u0 - o1) / s)), i1 = Math.min(n1 - 1, Math.floor((u1 - o1) / s));
        const j0 = Math.max(0, Math.floor((v0 - o2) / s)), j1 = Math.min(n2 - 1, Math.floor((v1 - o2) / s));
        // a triangle seen edge-on along this axis is never crossed by a line along it (the tests skip it: d = 0)
        const x0 = t[o + a1], y0 = t[o + a2], x1 = t[o + 3 + a1], y1 = t[o + 3 + a2], x2 = t[o + 6 + a1], y2 = t[o + 6 + a2];
        if ((y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2) === 0) continue;
        if ((i1 - i0 + 1) * (j1 - j0 + 1) <= 2) { for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) lists[ii * n2 + jj].push(i); continue; }
        // a long thin triangle lying askew goes only into the buckets it reaches, not all of its box
        const tol = 1e-7 * s, ex = [y1 - y0, y2 - y1, y0 - y2], ey = [x0 - x1, x1 - x2, x2 - x0], px = [x0, x1, x2], py = [y0, y1, y2], qx = [x2, x0, x1], qy = [y2, y0, y1];
        const len = [Math.hypot(ex[0], ey[0]), Math.hypot(ex[1], ey[1]), Math.hypot(ex[2], ey[2])];
        for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) {
          const r0 = o1 + ii * s, r1 = r0 + s, q0 = o2 + jj * s, q1 = q0 + s;
          let out = false;
          for (let e = 0; e < 3 && !out; e++) {
            const side = ex[e] * (qx[e] - px[e]) + ey[e] * (qy[e] - py[e]), base = ex[e] * px[e] + ey[e] * py[e], lim = tol * len[e];
            if (side > 0) out = ex[e] * (ex[e] > 0 ? r1 : r0) + ey[e] * (ey[e] > 0 ? q1 : q0) - base < -lim;
            else out = ex[e] * (ex[e] > 0 ? r0 : r1) + ey[e] * (ey[e] > 0 ? q0 : q1) - base > lim;
          }
          if (!out) lists[ii * n2 + jj].push(i);
        }
      }
      const { idx, start } = flatten(lists);
      this.cols.push({ a1, a2, n1, n2, o1, o2, s, idx, start });
    }
    // the inside test runs along X unless a line along another axis meets under a third of the triangles (a board
    // asked along its length passes every hole's wall)
    const cost = this.cols.map(C => { let q = 0; for (let b = 0; b + 1 < C.start.length; b++) { const l = C.start[b + 1] - C.start[b]; q += l * l; } return q / Math.max(1, C.idx.length); });
    const best = cost[1] < cost[2] ? 1 : 2;
    if (cost[best] * 3 < cost[0]) this.ray = best;
    const n = [0, 1, 2].map(a => Math.max(1, Math.ceil((this.hi[a] - this.lo[a]) / s) + 1));
    const lists: number[][] = Array.from({ length: n[0] * n[1] * n[2] }, () => []);
    for (let i = 0; i < this.nt; i++) {
      const o = 9 * i;
      const r = [0, 1, 2].map(a => {
        const mn = Math.min(t[o + a], t[o + 3 + a], t[o + 6 + a]), mx = Math.max(t[o + a], t[o + 3 + a], t[o + 6 + a]);
        return [Math.max(0, Math.floor((mn - this.lo[a]) / s)), Math.min(n[a] - 1, Math.floor((mx - this.lo[a]) / s))];
      });
      for (let x = r[0][0]; x <= r[0][1]; x++) for (let y = r[1][0]; y <= r[1][1]; y++) for (let z = r[2][0]; z <= r[2][1]; z++)
        lists[(z * n[1] + y) * n[0] + x].push(i);
    }
    const f = flatten(lists);
    this.g3 = { n, o: this.lo.slice(), s, idx: f.idx, start: f.start };
  }

  hits(axis: number, p: ArrayLike<number>): number[] {
    const C = this.cols[axis], t = this.t;
    const u = p[C.a1] + this.jit, v = p[C.a2] + 0.7071 * this.jit;
    const i = Math.floor((u - C.o1) / C.s), j = Math.floor((v - C.o2) / C.s);
    const out: number[] = [];
    if (i < 0 || j < 0 || i >= C.n1 || j >= C.n2) return out;
    const b = i * C.n2 + j;
    for (let k = C.start[b]; k < C.start[b + 1]; k++) {
      const o = 9 * C.idx[k];
      // barycentric coordinates in the (a1, a2) projection
      const x0 = t[o + C.a1], y0 = t[o + C.a2], x1 = t[o + 3 + C.a1], y1 = t[o + 3 + C.a2], x2 = t[o + 6 + C.a1], y2 = t[o + 6 + C.a2];
      const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (d === 0) continue;
      const l0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / d;
      const l1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      out.push(l0 * t[o + axis] + l1 * t[o + 3 + axis] + l2 * t[o + 6 + axis]);
    }
    return out.sort((a, b) => a - b);
  }

  /** Odd number of surface crossings beyond x on the line along X through the point: the cuts `hits(0, …)` gives,
   * counted without making the list. */
  inside(x: number, y: number, z: number): boolean {
    if (this.ray) return this.insideAlong(this.ray, x, y, z);
    if (x > this.hi[0] || x < this.lo[0]) return false;
    const C = this.cols[0], t = this.t;
    const u = (C.a1 === 1 ? y : z) + this.jit, v = (C.a2 === 1 ? y : z) + 0.7071 * this.jit;
    const i = Math.floor((u - C.o1) / C.s), j = Math.floor((v - C.o2) / C.s);
    if (i < 0 || j < 0 || i >= C.n1 || j >= C.n2) return false;
    const b = i * C.n2 + j, a1 = C.a1, a2 = C.a2, idx = C.idx;
    let c = 0;
    for (let k = C.start[b], end = C.start[b + 1]; k < end; k++) {
      const o = 9 * idx[k];
      const x0 = t[o + a1], y0 = t[o + a2], x1 = t[o + 3 + a1], y1 = t[o + 3 + a2], x2 = t[o + 6 + a1], y2 = t[o + 6 + a2];
      const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (d === 0) continue;
      const l0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / d;
      const l1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      if (l0 * t[o] + l1 * t[o + 3] + l2 * t[o + 6] > x) c++;
    }
    return (c & 1) === 1;
  }

  /** The same count along another axis (a thin plate is asked across its thickness: few triangles per line). */
  private insideAlong(ax: number, x: number, y: number, z: number): boolean {
    const C = this.cols[ax], t = this.t, a1 = C.a1, a2 = C.a2;
    const u = (a1 === 0 ? x : a1 === 1 ? y : z) + this.jit, v = (a2 === 0 ? x : a2 === 1 ? y : z) + 0.7071 * this.jit, w = ax === 1 ? y : z;
    // beyond the body's box along the line: nothing to cross above, or everything (an even number)
    if (w > this.hi[ax] || w < this.lo[ax]) return false;
    const i = Math.floor((u - C.o1) / C.s), j = Math.floor((v - C.o2) / C.s);
    if (i < 0 || j < 0 || i >= C.n1 || j >= C.n2) return false;
    const b = i * C.n2 + j, idx = C.idx;
    let c = 0;
    for (let k = C.start[b], end = C.start[b + 1]; k < end; k++) {
      const o = 9 * idx[k];
      const x0 = t[o + a1], y0 = t[o + a2], x1 = t[o + 3 + a1], y1 = t[o + 3 + a2], x2 = t[o + 6 + a1], y2 = t[o + 6 + a2];
      const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (d === 0) continue;
      const l0 = ((y1 - y2) * (u - x2) + (x2 - x1) * (v - y2)) / d;
      const l1 = ((y2 - y0) * (u - x2) + (x0 - x2) * (v - y2)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      if (l0 * t[o + ax] + l1 * t[o + 3 + ax] + l2 * t[o + 6 + ax] > w) c++;
    }
    return (c & 1) === 1;
  }

  hint(lo: ArrayLike<number>, hi: ArrayLike<number>) {
    const G = this.g3, t = this.t;
    const r = [0, 1, 2].map(a => [Math.max(0, Math.floor((lo[a] - G.o[a]) / G.s)), Math.min(G.n[a] - 1, Math.floor((hi[a] - G.o[a]) / G.s))]);
    // a triangle listed in several boxes is looked at once: stamped with this call's number
    if (!this.seen) this.seen = new Int32Array(this.nt);
    const seen = this.seen, stamp = ++this.stamp;
    const m = [0, 0, 0];
    let first = -1, edge = false, any = false;
    for (let x = r[0][0]; x <= r[0][1]; x++) for (let y = r[1][0]; y <= r[1][1]; y++) for (let z = r[2][0]; z <= r[2][1]; z++) {
      const b = (z * G.n[1] + y) * G.n[0] + x;
      for (let k = G.start[b]; k < G.start[b + 1]; k++) {
        const i = G.idx[k];
        if (seen[i] === stamp) continue;
        seen[i] = stamp;
        if (!triBox(t, 9 * i, lo, hi)) continue;
        any = true;
        const nx = this.n[3 * i], ny = this.n[3 * i + 1], nz = this.n[3 * i + 2];
        if (first < 0) first = i;
        else if (!edge) {
          // compare with every normal so far through the running sum's spread
          const f = 3 * first;
          if (nx * this.n[f] + ny * this.n[f + 1] + nz * this.n[f + 2] < EDGE_COS) edge = true;
        }
        m[0] += nx; m[1] += ny; m[2] += nz;
      }
    }
    if (!any) return null;
    const d = m.map(Math.abs);
    return { axis: d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2, edge };
  }
}

function flatten(lists: number[][]) {
  const start = new Int32Array(lists.length + 1);
  for (let i = 0; i < lists.length; i++) start[i + 1] = start[i] + lists[i].length;
  const idx = new Int32Array(start[lists.length]);
  for (let i = 0; i < lists.length; i++) idx.set(lists[i], start[i]);
  return { idx, start };
}

/** One axis of the separating axis test: the triangle's three projections against the box's reach. */
function axisMeets(ax0: number, ax1: number, ax2: number, e0: number, e1: number, e2: number,
  a0: number, a1: number, a2: number, b0: number, b1: number, b2: number, c0: number, c1: number, c2: number): boolean {
  const p0 = a0 * ax0 + a1 * ax1 + a2 * ax2, p1 = b0 * ax0 + b1 * ax1 + b2 * ax2, p2 = c0 * ax0 + c1 * ax1 + c2 * ax2;
  const r = e0 * Math.abs(ax0) + e1 * Math.abs(ax1) + e2 * Math.abs(ax2);
  return !(Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r);
}

/** Triangle (at t[o]) meets box [lo, hi]: separating axis test (no arrays made: it runs for every triangle near
 * every cube the cells are cut from). */
export function triBox(t: ArrayLike<number>, o: number, lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
  const e0 = (hi[0] - lo[0]) / 2, e1 = (hi[1] - lo[1]) / 2, e2 = (hi[2] - lo[2]) / 2;
  const a0 = t[o] - cx, a1 = t[o + 1] - cy, a2 = t[o + 2] - cz;
  const b0 = t[o + 3] - cx, b1 = t[o + 4] - cy, b2 = t[o + 5] - cz;
  const c0 = t[o + 6] - cx, c1 = t[o + 7] - cy, c2 = t[o + 8] - cz;
  if (Math.min(a0, b0, c0) > e0 || Math.max(a0, b0, c0) < -e0) return false;
  if (Math.min(a1, b1, c1) > e1 || Math.max(a1, b1, c1) < -e1) return false;
  if (Math.min(a2, b2, c2) > e2 || Math.max(a2, b2, c2) < -e2) return false;
  // edges f0 = b − a, f1 = c − b, f2 = a − c
  const f00 = b0 - a0, f01 = b1 - a1, f02 = b2 - a2, f10 = c0 - b0, f11 = c1 - b1, f12 = c2 - b2, f20 = a0 - c0, f21 = a1 - c1, f22 = a2 - c2;
  if (!axisMeets(f01 * f12 - f02 * f11, f02 * f10 - f00 * f12, f00 * f11 - f01 * f10, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  // box axis × edge: X × f = (0, −f2, f1), Y × f = (f2, 0, −f0), Z × f = (−f1, f0, 0)
  if (!axisMeets(0, -f02, f01, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(0, -f12, f11, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(0, -f22, f21, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(f02, 0, -f00, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(f12, 0, -f10, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(f22, 0, -f20, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(-f01, f00, 0, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(-f11, f10, 0, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  if (!axisMeets(-f21, f20, 0, e0, e1, e2, a0, a1, a2, b0, b1, b2, c0, c1, c2)) return false;
  return true;
}

/** The body as the solver's inside test, with its exact line cuts and box hints attached. */
export function insideOf(b: Body): import("./quad").Inside {
  const f = ((x: number, y: number, z: number) => b.inside(x, y, z)) as import("./quad").Inside;
  if (b.hits) f.hits = (a, p) => b.hits!(a, p);
  if (b.hint) f.hint = (l, h) => b.hint!(l, h);
  if (b instanceof MeshBody) f.tris = b.tris;
  return f;
}
