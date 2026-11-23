// Section caps under a board thermal map (FRS-thermal FR-TMAP-041). A package holds surface temperatures only, so a
// cap shows them in a band along the cut outline, where the cut meets the map's surface; the inside stays plain.
// Pure: the UI hands in the map's points, the plane and the cap's grid points, all in the package's coordinates.

/** Where the plane cuts the map: points along the cut lines with their temperature. */
export interface MapSlice { pts: Float32Array; t: Float32Array }

/**
 * Cuts the map's triangles (`tris` = indices into `tri` / 3, null = all) with the plane n·p + c = 0 and samples each
 * cut line every `step` (ends included), the temperature interpolated along the triangle's edges.
 */
export function sliceMap(pos: ArrayLike<number>, tri: ArrayLike<number>, temp: ArrayLike<number>, tris: ArrayLike<number> | null,
  n: readonly [number, number, number], c: number, step: number): MapSlice {
  const pts: number[] = [], ts: number[] = [];
  const count = tris ? tris.length : tri.length / 3;
  const d = [0, 0, 0], v = [0, 0, 0];
  const cut: number[] = [];
  for (let j = 0; j < count; j++) {
    const k = tris ? tris[j] : j;
    for (let a = 0; a < 3; a++) {
      v[a] = tri[k * 3 + a];
      d[a] = n[0] * pos[v[a] * 3] + n[1] * pos[v[a] * 3 + 1] + n[2] * pos[v[a] * 3 + 2] + c;
    }
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
    // the two crossings of the plane (a vertex on it counts once)
    cut.length = 0;
    for (let a = 0; a < 3 && cut.length < 8; a++) {
      const b = (a + 1) % 3, i = v[a], q = v[b];
      if (d[a] === 0) { cut.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], temp[i]); continue; }
      if ((d[a] < 0) === (d[b] < 0) || d[b] === 0) continue;
      const s = d[a] / (d[a] - d[b]);
      cut.push(pos[i * 3] + s * (pos[q * 3] - pos[i * 3]), pos[i * 3 + 1] + s * (pos[q * 3 + 1] - pos[i * 3 + 1]),
        pos[i * 3 + 2] + s * (pos[q * 3 + 2] - pos[i * 3 + 2]), temp[i] + s * (temp[q] - temp[i]));
    }
    if (cut.length < 8) { if (cut.length === 4) { pts.push(cut[0], cut[1], cut[2]); ts.push(cut[3]); } continue; }
    const len = Math.hypot(cut[4] - cut[0], cut[5] - cut[1], cut[6] - cut[2]), m = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s <= m; s++) {
      const f = s / m;
      pts.push(cut[0] + f * (cut[4] - cut[0]), cut[1] + f * (cut[5] - cut[1]), cut[2] + f * (cut[6] - cut[2]));
      ts.push(cut[3] + f * (cut[7] - cut[3]));
    }
  }
  return { pts: Float32Array.from(pts), t: Float32Array.from(ts) };
}

/**
 * Temperature at each query point (x, y, z per point) from the nearest slice point within `band`; NaN farther away
 * (the cap's inside, which a package says nothing about). Searches only the 27 cells around a point.
 */
export function capValues(q: ArrayLike<number>, slice: MapSlice, band: number): Float32Array {
  const nq = q.length / 3, out = new Float32Array(nq).fill(NaN), np = slice.t.length;
  if (!np || !(band > 0)) return out;
  const cells = new Map<string, number[]>(), p = slice.pts;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = 0; i < np; i++) {
    const k = key(Math.floor(p[i * 3] / band), Math.floor(p[i * 3 + 1] / band), Math.floor(p[i * 3 + 2] / band));
    const c = cells.get(k);
    if (c) c.push(i); else cells.set(k, [i]);
  }
  const b2 = band * band;
  for (let j = 0; j < nq; j++) {
    const x = q[j * 3], y = q[j * 3 + 1], z = q[j * 3 + 2];
    const cx = Math.floor(x / band), cy = Math.floor(y / band), cz = Math.floor(z / band);
    let best = -1, bd = b2;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = cells.get(key(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const i of list) {
        const ex = p[i * 3] - x, ey = p[i * 3 + 1] - y, ez = p[i * 3 + 2] - z, d = ex * ex + ey * ey + ez * ez;
        if (d <= bd) { bd = d; best = i; }
      }
    }
    if (best >= 0) out[j] = slice.t[best];
  }
  return out;
}
