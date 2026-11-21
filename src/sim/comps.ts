/**
 * Results per component of an assembly study (FR-CON-030): the highest stress and
 * displacement of each solver domain on the plot mesh, and the plot mesh cut down
 * to one of them.
 */

export interface CompRow {
  /** The solver's domain (index into the results' component list). */
  d: number;
  /** Highest von Mises stress, MPa, and the plot-mesh vertex that has it. */
  maxVm: number;
  at: number;
  /** Largest displacement, mm. */
  maxU: number;
  /** Lowest safety factor against the component's own yield strength; null without one. */
  sf: number | null;
  /** Plot-mesh vertices of the component. */
  n: number;
}

/**
 * One row per domain that has vertices on the plot mesh.
 * `dom` = domain per vertex, `vm` per vertex, `u` = 3 numbers per vertex, `sy` = yield strength per domain (0 = none).
 */
export function componentRows(dom: ArrayLike<number>, vm: ArrayLike<number>, u: ArrayLike<number>, count: number, sy: ArrayLike<number> = []): CompRow[] {
  const rows: CompRow[] = [];
  for (let d = 0; d < count; d++) rows.push({ d, maxVm: 0, at: -1, maxU: 0, sf: null, n: 0 });
  for (let i = 0; i < dom.length; i++) {
    const r = rows[dom[i]];
    if (!r) continue;
    r.n++;
    if (r.at < 0 || vm[i] > r.maxVm) { r.maxVm = vm[i]; r.at = i; }
    const m = Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]);
    if (m > r.maxU) r.maxU = m;
  }
  for (const r of rows) { const y = sy[r.d] ?? 0; if (y > 0 && r.maxVm > 0) r.sf = y / r.maxVm; }
  return rows.filter(r => r.n > 0);
}

/**
 * The plot mesh's triangles with every triangle outside domain `d` made degenerate:
 * the triangle count and order stay, so a ray hit's face index still names the same triangle.
 */
export function aloneIndex(index: Uint32Array, dom: ArrayLike<number>, d: number): Uint32Array {
  const out = new Uint32Array(index.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t];
    if (dom[a] === d && dom[index[t + 1]] === d && dom[index[t + 2]] === d) { out[t] = a; out[t + 1] = index[t + 1]; out[t + 2] = index[t + 2]; }
    else { out[t] = a; out[t + 1] = a; out[t + 2] = a; }
  }
  return out;
}

/**
 * Which part each vertex of the plot mesh belongs to. The first vertices are the joined display mesh's, `counts[k]`
 * of them per part in order; the refined mesh adds midpoints after them, which take the part of their triangle
 * (parts share no vertices). -1 = a vertex no triangle uses.
 */
export function vertexParts(index: ArrayLike<number>, counts: number[], n: number): Int32Array {
  const of = new Int32Array(n).fill(-1);
  let v = 0;
  counts.forEach((c, k) => { for (let i = 0; i < c && v < n; i++) of[v++] = k; });
  for (let again = true, round = 0; again && round < 64; round++) {
    again = false;
    for (let i = 0; i + 2 < index.length; i += 3) {
      const a = index[i], b = index[i + 1], c = index[i + 2];
      const k = of[a] >= 0 ? of[a] : of[b] >= 0 ? of[b] : of[c];
      if (k < 0) { again = true; continue; }
      if (of[a] < 0) of[a] = k;
      if (of[b] < 0) of[b] = k;
      if (of[c] < 0) of[c] = k;
    }
  }
  return of;
}

/** The index with the triangles of the parts in `off` made degenerate (order kept, as `aloneIndex`). */
export function withoutParts(index: ArrayLike<number>, partOf: ArrayLike<number>, off: ArrayLike<boolean | number>): Uint32Array {
  const out = Uint32Array.from(index);
  for (let i = 0; i + 2 < out.length; i += 3) {
    const k = partOf[out[i]];
    if (k >= 0 && off[k]) out[i + 1] = out[i + 2] = out[i];
  }
  return out;
}

/**
 * Moves points (or, with `dirs`, directions) with their parts: `tfs[k]` is part k's 4×4 matrix, column-major,
 * null = left where it is.
 */
export function moveWithParts(arr: Float32Array, partOf: ArrayLike<number>, tfs: (ArrayLike<number> | null)[], dirs = false): void {
  const w = dirs ? 0 : 1;
  for (let i = 0, q = 0; q + 2 < arr.length; i++, q += 3) {
    const m = tfs[partOf[i]];
    if (!m) continue;
    const x = arr[q], y = arr[q + 1], z = arr[q + 2];
    arr[q] = m[0] * x + m[4] * y + m[8] * z + w * m[12];
    arr[q + 1] = m[1] * x + m[5] * y + m[9] * z + w * m[13];
    arr[q + 2] = m[2] * x + m[6] * y + m[10] * z + w * m[14];
  }
}
