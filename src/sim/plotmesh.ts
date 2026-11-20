// Structural analysis: the mesh results are drawn on. A CAD display mesh has two triangles on a flat face,
// far too few points to show a stress field or a bent shape, so its triangles are split until no edge is
// longer than `target`. Only edges are split, always at their middle, so both sides of a shared edge get
// the same points and the refined mesh has no cracks when it is drawn deformed.

export interface PlotMesh {
  pos: Float32Array;
  nrm: Float32Array;
  index: Uint32Array;
}

/** Edge length that keeps the refined mesh under `maxTris` triangles (about), starting from `want`. */
export function plotTarget(area: number, want: number, maxTris = 120000): number {
  // a right triangle with legs `t` has area t²/2; bisection leaves edges between t/2 and t
  const est = area / (0.3 * want * want);
  return est > maxTris ? want * Math.sqrt(est / maxTris) : want;
}

/**
 * Splits the triangles of an indexed (or plain) mesh by longest-edge bisection until every edge is at most
 * `target` long. Normals are averaged along the split edges. Vertices of the input keep their indices.
 */
export function refineMesh(position: ArrayLike<number>, normal: ArrayLike<number> | null, index: ArrayLike<number> | null, target: number): PlotMesh {
  const pos: number[] = Array.from(position), nrm: number[] = normal ? Array.from(normal) : new Array(position.length).fill(0);
  const nt = index ? index.length / 3 : position.length / 9;
  const mids = new Map<number, number>();
  const out: number[] = [];
  const t2 = target * target;
  const len2 = (i: number, j: number) => (pos[3 * i] - pos[3 * j]) ** 2 + (pos[3 * i + 1] - pos[3 * j + 1]) ** 2 + (pos[3 * i + 2] - pos[3 * j + 2]) ** 2;
  const mid = (i: number, j: number) => {
    const a = Math.min(i, j), b = Math.max(i, j), key = a * 4194304 + b;
    let m = mids.get(key);
    if (m != null) return m;
    m = pos.length / 3;
    pos.push((pos[3 * a] + pos[3 * b]) / 2, (pos[3 * a + 1] + pos[3 * b + 1]) / 2, (pos[3 * a + 2] + pos[3 * b + 2]) / 2);
    const nx = nrm[3 * a] + nrm[3 * b], ny = nrm[3 * a + 1] + nrm[3 * b + 1], nz = nrm[3 * a + 2] + nrm[3 * b + 2], l = Math.hypot(nx, ny, nz) || 1;
    nrm.push(nx / l, ny / l, nz / l);
    mids.set(key, m);
    return m;
  };
  const stack: number[] = [];
  for (let t = 0; t < nt; t++) {
    stack.push(index ? index[3 * t] : 3 * t, index ? index[3 * t + 1] : 3 * t + 1, index ? index[3 * t + 2] : 3 * t + 2, 0);
    while (stack.length) {
      const depth = stack.pop()!, k = stack.pop()!, j = stack.pop()!, i = stack.pop()!;
      const a = len2(i, j), b = len2(j, k), c = len2(k, i), top = Math.max(a, b, c);
      if (top <= t2 || depth >= 24 || pos.length > 12e6) { out.push(i, j, k); continue; }
      if (top === a) { const m = mid(i, j); stack.push(i, m, k, depth + 1, m, j, k, depth + 1); }
      else if (top === b) { const m = mid(j, k); stack.push(i, j, m, depth + 1, i, m, k, depth + 1); }
      else { const m = mid(k, i); stack.push(i, j, m, depth + 1, m, j, k, depth + 1); }
    }
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), index: Uint32Array.from(out) };
}

/** Area of an indexed mesh. */
export function meshArea(position: ArrayLike<number>, index: ArrayLike<number> | null): number {
  const nt = index ? index.length / 3 : position.length / 9;
  let s = 0;
  for (let t = 0; t < nt; t++) {
    const i = 3 * (index ? index[3 * t] : 3 * t), j = 3 * (index ? index[3 * t + 1] : 3 * t + 1), k = 3 * (index ? index[3 * t + 2] : 3 * t + 2);
    const ux = position[j] - position[i], uy = position[j + 1] - position[i + 1], uz = position[j + 2] - position[i + 2];
    const vx = position[k] - position[i], vy = position[k + 1] - position[i + 1], vz = position[k + 2] - position[i + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}
