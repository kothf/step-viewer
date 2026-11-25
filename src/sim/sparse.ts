// Structural analysis (FR-SOL-003): element-block sparse matrix and a direct envelope solver.
// Element e carries ms[e] unknowns (the same for all, or more where the degree was raised), so the matrix
// is a set of dense ms[a]×ms[b] blocks, one per pair of elements that share a face. The direct solver orders elements by reverse Cuthill–McKee, then runs
// an envelope (variable band) Cholesky; for the slender bodies of the first phases the band stays narrow.

export class BlockMatrix {
  /** blocks.get(a * nel + b) = rows of a × columns of b, row-major. */
  readonly blocks = new Map<number, Float64Array>();
  readonly adj: Set<number>[];
  /** Unknowns per element and where each element's start (nel + 1 entries). */
  readonly ms: Int32Array;
  readonly off: Int32Array;
  constructor(readonly nel: number, m: number | ArrayLike<number>) {
    this.adj = Array.from({ length: nel }, (_, i) => new Set([i]));
    this.ms = typeof m === "number" ? new Int32Array(nel).fill(m) : Int32Array.from(m);
    this.off = new Int32Array(nel + 1);
    for (let e = 0; e < nel; e++) this.off[e + 1] = this.off[e] + this.ms[e];
  }
  block(a: number, b: number) {
    const k = a * this.nel + b;
    let B = this.blocks.get(k);
    if (!B) {
      B = new Float64Array(this.ms[a] * this.ms[b]);
      this.blocks.set(k, B);
      this.adj[a].add(b); this.adj[b].add(a);
    }
    return B;
  }
  /** Takes `B` (already filled, of the block's size) as the diagonal block of element a. */
  adopt(a: number, B: Float64Array) { this.blocks.set(a * this.nel + a, B); }
  get size() { return this.off[this.nel]; }
  /** y = A x. */
  mul(x: Float64Array, y = new Float64Array(this.size)) {
    y.fill(0);
    const nel = this.nel, ms = this.ms, off = this.off;
    for (const [k, B] of this.blocks) {
      const a = Math.floor(k / nel), b = k - a * nel;
      const ra = off[a], cb = off[b], ma = ms[a], mb = ms[b];
      for (let i = 0; i < ma; i++) {
        let s = 0;
        const o = i * mb;
        for (let j = 0; j < mb; j++) s += B[o + j] * x[cb + j];
        y[ra + i] += s;
      }
    }
    return y;
  }
}

/**
 * A fingerprint of a matrix: its layout and every value, bit for bit (two 32-bit hashes over the words, the sizes
 * beside them). Two matrices put together the same way from the same numbers give the same text.
 */
export function matrixKey(A: BlockMatrix): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x9e3779b9 | 0, words = 0;
  for (const [k, B] of A.blocks) {
    h1 = Math.imul(h1 ^ k, 0x01000193); h2 = Math.imul((h2 << 5) | (h2 >>> 27), 0x85ebca6b) ^ k;
    const W = new Uint32Array(B.buffer, B.byteOffset, 2 * B.length), n = W.length;
    for (let i = 0; i < n; i++) {
      const w = W[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul(((h2 << 5) | (h2 >>> 27)) ^ w, 0x85ebca6b);
    }
    words += n;
  }
  return `${A.nel}:${A.size}:${A.blocks.size}:${words}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

/** Reverse Cuthill–McKee order of a graph given by neighbour sets (self loops ignored). */
export function rcm(adj: Set<number>[]): Int32Array {
  const n = adj.length, deg = adj.map(s => s.size);
  const seen = new Uint8Array(n);
  const order: number[] = [];
  while (order.length < n) {
    // start from an unvisited node of least degree, then a pseudo-peripheral one from it
    let s = -1;
    for (let i = 0; i < n; i++) if (!seen[i] && (s < 0 || deg[i] < deg[s])) s = i;
    s = peripheral(adj, s, seen);
    const start = order.length;
    order.push(s); seen[s] = 1;
    for (let h = start; h < order.length; h++) {
      const nb = [...adj[order[h]]].filter(v => !seen[v]).sort((a, b) => deg[a] - deg[b]);
      for (const v of nb) { seen[v] = 1; order.push(v); }
    }
  }
  return Int32Array.from(order.reverse());
}

function peripheral(adj: Set<number>[], s: number, seen: Uint8Array) {
  let last = -1;
  for (let it = 0; it < 4; it++) {
    const lvl = new Map<number, number>([[s, 0]]);
    const q = [s];
    for (let h = 0; h < q.length; h++) for (const v of adj[q[h]]) if (!seen[v] && !lvl.has(v)) { lvl.set(v, lvl.get(q[h])! + 1); q.push(v); }
    const far = q[q.length - 1];
    const depth = lvl.get(far)!;
    if (depth <= last) break;
    last = depth; s = far;
  }
  return s;
}

/**
 * What an envelope factorisation of A would take, without making it: the element order, the values it stores
 * and the multiplications of the factorisation (Σ row width²: a slender part's are few, a bulky part's many).
 */
export function envelopeCost(A: BlockMatrix): { order: Int32Array; values: number; flops: number } {
  const nel = A.nel, ms = A.ms, order = rcm(A.adj), pos = new Int32Array(nel);
  order.forEach((e, k) => (pos[e] = k));
  const poff = new Float64Array(nel + 1);
  for (let k = 0; k < nel; k++) poff[k + 1] = poff[k] + ms[order[k]];
  let values = 0, flops = 0;
  for (let k = 0; k < nel; k++) {
    let lo = k;
    for (const b of A.adj[order[k]]) lo = Math.min(lo, pos[b]);
    // rows poff[k] .. poff[k + 1] − 1 start at column poff[lo]
    const m = ms[order[k]], w0 = poff[k] - poff[lo] + 1;
    for (let i = 0; i < m; i++) { const w = w0 + i; values += w; flops += w * w; }
  }
  return { order, values, flops };
}

/** Envelope Cholesky factor of a BlockMatrix (symmetric positive definite). */
export class Envelope {
  readonly n: number;
  /** Element order: perm[k] = element at position k; pos[e] = its position. */
  readonly perm: Int32Array;
  readonly pos: Int32Array;
  /** Row r holds L[r][first[r] .. r] at data[start[r] ...]. */
  private readonly first: Int32Array;
  private readonly start: Float64Array;
  private readonly data: Float64Array;
  private rows: Float64Array[] = [];
  /** Unknowns per element and the start of each position's rows in the new order. */
  private readonly ms: Int32Array;
  private readonly poff: Int32Array;
  constructor(A: BlockMatrix, order?: Int32Array) {
    const nel = A.nel, n = (this.n = A.size), ms = (this.ms = A.ms);
    this.perm = order ?? rcm(A.adj);
    this.pos = new Int32Array(nel);
    this.perm.forEach((e, k) => (this.pos[e] = k));
    const poff = (this.poff = new Int32Array(nel + 1));
    for (let k = 0; k < nel; k++) poff[k + 1] = poff[k] + ms[this.perm[k]];
    this.first = new Int32Array(n);
    this.start = new Float64Array(n + 1);
    for (let k = 0; k < nel; k++) {
      let lo = k;
      for (const b of A.adj[this.perm[k]]) lo = Math.min(lo, this.pos[b]);
      for (let r = poff[k]; r < poff[k + 1]; r++) this.first[r] = poff[lo];
    }
    for (let r = 0; r < n; r++) this.start[r + 1] = this.start[r] + (r - this.first[r] + 1);
    const total = this.start[n];
    if (total > 2 ** 28) throw new Error(`E-SIM-MEMORY: envelope of ${total} values`);
    const L = (this.data = new Float64Array(total));
    // scatter the lower triangle (rows by new order)
    for (const [key, B] of A.blocks) {
      const a = Math.floor(key / nel), b = key - a * nel;
      const ka = this.pos[a], kb = this.pos[b];
      if (kb > ka) continue;
      const ma = ms[a], mb = ms[b];
      for (let i = 0; i < ma; i++) {
        const r = poff[ka] + i, base = this.start[r] - this.first[r];
        for (let j = 0; j < mb; j++) {
          const c = poff[kb] + j;
          if (c > r) continue;
          L[base + c] += B[i * mb + j];
        }
      }
    }
    // factor row by row: L[r][c] = (A[r][c] − Σ L[r][k] L[c][k]) / L[c][c]. Each row is a view of its own, so
    // the inner product runs over two plain typed arrays with integer offsets (four terms a step).
    const first = this.first, start = this.start;
    const rows: Float64Array[] = new Array(n);
    for (let r = 0; r < n; r++) rows[r] = L.subarray(start[r], start[r + 1]);
    this.rows = rows;
    for (let r = 0; r < n; r++) {
      const fr = first[r], R = rows[r];
      for (let c = fr; c <= r; c++) {
        const fc = first[c], C = rows[c];
        const k0 = fr > fc ? fr : fc, len = c - k0;
        let i = k0 - fr, j = k0 - fc, s = R[c - fr];
        const end = i + len, end4 = i + (len & ~3);
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (; i < end4; i += 4, j += 4) { s0 += R[i] * C[j]; s1 += R[i + 1] * C[j + 1]; s2 += R[i + 2] * C[j + 2]; s3 += R[i + 3] * C[j + 3]; }
        for (; i < end; i++, j++) s0 += R[i] * C[j];
        s -= s0 + s1 + s2 + s3;
        if (c < r) R[c - fr] = s / C[c - fc];
        else {
          if (!(s > 0)) throw new Error(`E-SIM-SINGULAR: pivot ${s} at ${r}`);
          R[r - fr] = Math.sqrt(s);
        }
      }
    }
  }
  get values() { return this.data.length; }
  /** Solves A x = b (b in element-dof order); returns x in the same order. */
  solve(b: Float64Array): Float64Array {
    const n = this.n, ms = this.ms, poff = this.poff, nel = this.perm.length;
    const off = new Int32Array(nel + 1);
    for (let e = 0; e < nel; e++) off[e + 1] = off[e] + ms[e];
    const y = new Float64Array(n);
    for (let k = 0; k < nel; k++) { const e = this.perm[k]; for (let i = 0; i < ms[e]; i++) y[poff[k] + i] = b[off[e] + i]; }
    const first = this.first, rows = this.rows;
    for (let r = 0; r < n; r++) {
      const fr = first[r], R = rows[r], len = r - fr;
      let s = 0;
      for (let i = 0, k = fr; i < len; i++, k++) s += R[i] * y[k];
      y[r] = (y[r] - s) / R[len];
    }
    for (let r = n - 1; r >= 0; r--) {
      const fr = first[r], R = rows[r], len = r - fr;
      const v = (y[r] /= R[len]);
      if (v !== 0) for (let i = 0, k = fr; i < len; i++, k++) y[k] -= R[i] * v;
    }
    const x = new Float64Array(n);
    for (let k = 0; k < nel; k++) { const e = this.perm[k]; for (let i = 0; i < ms[e]; i++) x[off[e] + i] = y[poff[k] + i]; }
    return x;
  }
}
