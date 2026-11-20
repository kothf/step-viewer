// Structural analysis (FR-SOL-003): element-block sparse matrix and a direct envelope solver.
// Every element carries m unknowns, so the matrix is a set of dense m×m blocks, one per pair of
// elements that share a face. The direct solver orders elements by reverse Cuthill–McKee, then runs
// an envelope (variable band) Cholesky; for the slender bodies of the first phases the band stays narrow.

export class BlockMatrix {
  /** blocks.get(a * nel + b) = rows of a × columns of b, row-major. */
  readonly blocks = new Map<number, Float64Array>();
  readonly adj: Set<number>[];
  constructor(readonly nel: number, readonly m: number) {
    this.adj = Array.from({ length: nel }, (_, i) => new Set([i]));
  }
  block(a: number, b: number) {
    const k = a * this.nel + b;
    let B = this.blocks.get(k);
    if (!B) {
      B = new Float64Array(this.m * this.m);
      this.blocks.set(k, B);
      this.adj[a].add(b); this.adj[b].add(a);
    }
    return B;
  }
  get size() { return this.nel * this.m; }
  /** y = A x. */
  mul(x: Float64Array, y = new Float64Array(this.size)) {
    y.fill(0);
    const m = this.m, nel = this.nel;
    for (const [k, B] of this.blocks) {
      const a = Math.floor(k / nel), b = k - a * nel;
      const ra = a * m, cb = b * m;
      for (let i = 0; i < m; i++) {
        let s = 0;
        const o = i * m;
        for (let j = 0; j < m; j++) s += B[o + j] * x[cb + j];
        y[ra + i] += s;
      }
    }
    return y;
  }
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
  constructor(A: BlockMatrix) {
    const m = A.m, nel = A.nel, n = (this.n = A.size);
    this.perm = rcm(A.adj);
    this.pos = new Int32Array(nel);
    this.perm.forEach((e, k) => (this.pos[e] = k));
    this.first = new Int32Array(n);
    this.start = new Float64Array(n + 1);
    for (let k = 0; k < nel; k++) {
      let lo = k;
      for (const b of A.adj[this.perm[k]]) lo = Math.min(lo, this.pos[b]);
      for (let i = 0; i < m; i++) this.first[k * m + i] = lo * m;
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
      for (let i = 0; i < m; i++) {
        const r = ka * m + i, base = this.start[r] - this.first[r];
        for (let j = 0; j < m; j++) {
          const c = kb * m + j;
          if (c > r) continue;
          L[base + c] += B[i * m + j];
        }
      }
    }
    // factor row by row: L[r][c] = (A[r][c] − Σ L[r][k] L[c][k]) / L[c][c]
    for (let r = 0; r < n; r++) {
      const fr = this.first[r], br = this.start[r] - fr;
      for (let c = fr; c <= r; c++) {
        const fc = this.first[c], bc = this.start[c] - fc;
        const k0 = Math.max(fr, fc);
        let s = L[br + c];
        for (let k = k0; k < c; k++) s -= L[br + k] * L[bc + k];
        if (c < r) L[br + c] = s / L[bc + c];
        else {
          if (!(s > 0)) throw new Error(`E-SIM-SINGULAR: pivot ${s} at ${r}`);
          L[br + r] = Math.sqrt(s);
        }
      }
    }
  }
  get values() { return this.data.length; }
  /** Solves A x = b (b in element-dof order); returns x in the same order. */
  solve(b: Float64Array): Float64Array {
    const n = this.n, m = b.length / this.perm.length, L = this.data;
    const y = new Float64Array(n);
    for (let k = 0; k < this.perm.length; k++) for (let i = 0; i < m; i++) y[k * m + i] = b[this.perm[k] * m + i];
    for (let r = 0; r < n; r++) {
      const fr = this.first[r], br = this.start[r] - fr;
      let s = y[r];
      for (let k = fr; k < r; k++) s -= L[br + k] * y[k];
      y[r] = s / L[br + r];
    }
    for (let r = n - 1; r >= 0; r--) {
      const fr = this.first[r], br = this.start[r] - fr;
      const v = (y[r] /= L[br + r]);
      for (let k = fr; k < r; k++) y[k] -= L[br + k] * v;
    }
    const x = new Float64Array(n);
    for (let k = 0; k < this.perm.length; k++) for (let i = 0; i < m; i++) x[this.perm[k] * m + i] = y[k * m + i];
    return x;
  }
}
