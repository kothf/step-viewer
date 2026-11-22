// Heat flux arrows on a thermal plot (FRS-thermal FR-TRES-001): one arrow on a sampled set of surface points, as
// line segments (shaft and two head strokes), length by the flux there. Pure: no DOM, runs in node.

export interface Arrows {
  /** Line segment ends, 6 numbers per segment (3 segments per arrow). */
  lines: Float32Array;
  /** Vertex of the plot mesh each arrow starts at. */
  at: number[];
  /** Largest flux magnitude among the vertices looked at (the full length). */
  peak: number;
}

/**
 * Arrows along `vec` (3 per vertex) at about `count` vertices that the triangles of `index` use, one per cell of a
 * grid over their box, so they spread over the surface. The largest magnitude gets 1/18 of the box diagonal;
 * vertices under 3 % of it get none. Arrows start a little off the surface along the vertex normal.
 */
export function fluxArrows(pos: ArrayLike<number>, nrm: ArrayLike<number>, vec: ArrayLike<number>, index: ArrayLike<number>, count = 400): Arrows {
  const used = new Uint8Array(pos.length / 3);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    if (a === b || b === c || a === c) continue;
    used[a] = used[b] = used[c] = 1;
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let peak = 0;
  for (let v = 0; v < used.length; v++) {
    if (!used[v]) continue;
    for (let k = 0; k < 3; k++) { const x = pos[3 * v + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    peak = Math.max(peak, Math.hypot(vec[3 * v], vec[3 * v + 1], vec[3 * v + 2]));
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(diag > 0) || !(peak > 0)) return { lines: new Float32Array(0), at: [], peak };
  // a surface of area ~ diag² holds about (diag / h)² cells: pick h so that comes to the count
  const h = diag / Math.sqrt(count * 1.5), cells = new Set<string>(), at: number[] = [];
  for (let v = 0; v < used.length; v++) {
    if (!used[v]) continue;
    const m = Math.hypot(vec[3 * v], vec[3 * v + 1], vec[3 * v + 2]);
    if (m < 0.03 * peak) continue;
    const key = `${Math.floor((pos[3 * v] - lo[0]) / h)},${Math.floor((pos[3 * v + 1] - lo[1]) / h)},${Math.floor((pos[3 * v + 2] - lo[2]) / h)}`;
    if (cells.has(key)) continue;
    cells.add(key);
    at.push(v);
  }
  const full = diag / 18, lift = diag * 0.002, lines = new Float32Array(at.length * 18);
  at.forEach((v, j) => {
    const q = [vec[3 * v], vec[3 * v + 1], vec[3 * v + 2]], m = Math.hypot(q[0], q[1], q[2]), d = q.map(x => x / m);
    const n = [nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]], nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const p = [0, 1, 2].map(k => pos[3 * v + k] + lift * n[k] / nl);
    // at least a third of the full length, so small fluxes still show their direction
    const L = full * Math.max(1 / 3, m / peak), tip = p.map((x, k) => x + L * d[k]);
    // head strokes lie in the plane of the arrow and the surface normal's square, so they face the viewer of the face
    let s = [d[1] * n[2] - d[2] * n[1], d[2] * n[0] - d[0] * n[2], d[0] * n[1] - d[1] * n[0]];
    let sl = Math.hypot(s[0], s[1], s[2]);
    if (sl < 1e-6) { s = Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [-d[2], 0, d[0]]; sl = Math.hypot(s[0], s[1], s[2]); }
    s = s.map(x => x / sl);
    const back = tip.map((x, k) => x - 0.3 * L * d[k]), w = 0.15 * L, o = 18 * j;
    lines.set([...p, ...tip, ...tip, ...back.map((x, k) => x + w * s[k]), ...tip, ...back.map((x, k) => x - w * s[k])], o);
  });
  return { lines, at, peak };
}
