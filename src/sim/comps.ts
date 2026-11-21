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
