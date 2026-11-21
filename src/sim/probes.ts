// Probes of a result (FRS-structural FR-RES-005): a point of the model found again on the plot mesh, and the
// probe table as CSV. Pure: no DOM, no three.js.

/** A point on the plot mesh: a triangle's three vertices, the point's weights in it, and how far it was. */
export interface Located { i: [number, number, number]; w: [number, number, number]; d: number }

/** The point of the mesh nearest `p`. Null on an empty mesh. */
export function locate(pos: ArrayLike<number>, index: ArrayLike<number>, p: ArrayLike<number>): Located | null {
  let best: Located | null = null;
  const px = p[0], py = p[1], pz = p[2];
  for (let k = 0; k + 2 < index.length; k += 3) {
    const a = 3 * index[k], b = 3 * index[k + 1], c = 3 * index[k + 2];
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const apx = px - pos[a], apy = py - pos[a + 1], apz = pz - pos[a + 2];
    // the closest point of a triangle by its Voronoi regions (Ericson, Real-Time Collision Detection 5.1.5)
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let v: number, w: number;
    if (d1 <= 0 && d2 <= 0) { v = 0; w = 0; }
    else {
      const bpx = px - pos[b], bpy = py - pos[b + 1], bpz = pz - pos[b + 2];
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { v = 1; w = 0; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3 || 1); w = 0; }
        else {
          const cpx = px - pos[c], cpy = py - pos[c + 1], cpz = pz - pos[c + 2];
          const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { v = 0; w = 1; }
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { v = 0; w = d2 / (d2 - d6 || 1); }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / (d4 - d3 + (d5 - d6) || 1); v = 1 - w; }
              else { const den = va + vb + vc || 1; v = vb / den; w = vc / den; }
            }
          }
        }
      }
    }
    const qx = pos[a] + v * abx + w * acx - px, qy = pos[a + 1] + v * aby + w * acy - py, qz = pos[a + 2] + v * abz + w * acz - pz;
    const d = Math.hypot(qx, qy, qz);
    if (!best || d < best.d) best = { i: [index[k], index[k + 1], index[k + 2]], w: [1 - v - w, v, w], d };
  }
  return best;
}

/** A value per vertex (`stride` numbers each) read at a located point; component `c`. */
export function valueAt(a: ArrayLike<number>, at: Located, stride = 1, c = 0): number {
  return at.w[0] * a[stride * at.i[0] + c] + at.w[1] * a[stride * at.i[1] + c] + at.w[2] * a[stride * at.i[2] + c];
}

export interface ProbeRow { at: ArrayLike<number>; vm: number; u: [number, number, number]; sf?: number | null }

/** The probe table: place (mm), von Mises stress (MPa), displacement and its components (mm), safety factor when known. */
export function probeCsv(rows: ProbeRow[]): string {
  const withSf = rows.some(r => r.sf != null);
  const n = (x: number) => Number.isFinite(x) ? String(Number(x.toPrecision(7))) : "";
  const out = [["Probe", "X (mm)", "Y (mm)", "Z (mm)", "von Mises (MPa)", "Displacement (mm)", "UX (mm)", "UY (mm)", "UZ (mm)", ...(withSf ? ["Safety factor"] : [])].join(",")];
  // places to a nanometre: a point on a face reads 20, not 19.99999997
  const at = (x: number) => String(Number(x.toFixed(6)) || 0);
  rows.forEach((r, i) => out.push([String(i + 1), at(r.at[0]), at(r.at[1]), at(r.at[2]), n(r.vm), n(Math.hypot(r.u[0], r.u[1], r.u[2])), n(r.u[0]), n(r.u[1]), n(r.u[2]), ...(withSf ? [r.sf == null ? "" : n(r.sf)] : [])].join(",")));
  return out.join("\r\n") + "\r\n";
}
