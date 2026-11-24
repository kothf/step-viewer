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
  private readonly cols: { a1: number; a2: number; n1: number; n2: number; o1: number; o2: number; s: number; idx: Int32Array; start: Int32Array }[] = [];
  /** 3D buckets for box queries. */
  private readonly g3: { n: number[]; o: number[]; s: number; idx: Int32Array; start: Int32Array };
  /** Irrational offsets keep lines off triangle edges and vertices. */
  private readonly jit: number;

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
        for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) lists[ii * n2 + jj].push(i);
      }
      const { idx, start } = flatten(lists);
      this.cols.push({ a1, a2, n1, n2, o1, o2, s, idx, start });
    }
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

  inside(x: number, y: number, z: number): boolean {
    const h = this.hits(0, [x, y, z]);
    let c = 0;
    for (const v of h) if (v > x) c++;
    return (c & 1) === 1;
  }

  hint(lo: ArrayLike<number>, hi: ArrayLike<number>) {
    const G = this.g3, t = this.t;
    const r = [0, 1, 2].map(a => [Math.max(0, Math.floor((lo[a] - G.o[a]) / G.s)), Math.min(G.n[a] - 1, Math.floor((hi[a] - G.o[a]) / G.s))]);
    const seen = new Set<number>();
    const m = [0, 0, 0];
    let first = -1, edge = false, any = false;
    for (let x = r[0][0]; x <= r[0][1]; x++) for (let y = r[1][0]; y <= r[1][1]; y++) for (let z = r[2][0]; z <= r[2][1]; z++) {
      const b = (z * G.n[1] + y) * G.n[0] + x;
      for (let k = G.start[b]; k < G.start[b + 1]; k++) {
        const i = G.idx[k];
        if (seen.has(i)) continue;
        seen.add(i);
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

/** Triangle (at t[o]) meets box [lo, hi]: separating axis test. */
export function triBox(t: ArrayLike<number>, o: number, lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const e = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  const v = [0, 1, 2].map(k => [t[o + 3 * k] - c[0], t[o + 3 * k + 1] - c[1], t[o + 3 * k + 2] - c[2]]);
  for (let a = 0; a < 3; a++) {
    if (Math.min(v[0][a], v[1][a], v[2][a]) > e[a] || Math.max(v[0][a], v[1][a], v[2][a]) < -e[a]) return false;
  }
  const f = [0, 1, 2].map(k => [v[(k + 1) % 3][0] - v[k][0], v[(k + 1) % 3][1] - v[k][1], v[(k + 1) % 3][2] - v[k][2]]);
  const n = [f[0][1] * f[1][2] - f[0][2] * f[1][1], f[0][2] * f[1][0] - f[0][0] * f[1][2], f[0][0] * f[1][1] - f[0][1] * f[1][0]];
  const test = (ax: number[]) => {
    const p = v.map(w => w[0] * ax[0] + w[1] * ax[1] + w[2] * ax[2]);
    const r = e[0] * Math.abs(ax[0]) + e[1] * Math.abs(ax[1]) + e[2] * Math.abs(ax[2]);
    return !(Math.min(...p) > r || Math.max(...p) < -r);
  };
  if (!test(n)) return false;
  for (let a = 0; a < 3; a++) for (const fk of f) {
    const u = [0, 0, 0];
    u[a] = 1;
    const ax = [u[1] * fk[2] - u[2] * fk[1], u[2] * fk[0] - u[0] * fk[2], u[0] * fk[1] - u[1] * fk[0]];
    if (!test(ax)) return false;
  }
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
