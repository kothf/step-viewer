// What a study's results are saved as besides the report (FR-REP-003), and the load balance check (FR-RES-006). Pure.

/** Hot spots as CSV: place, stress, and whether the peak is a singularity. English, like the other exports. */
export function hotCsv(rows: { at: number[]; vm: number; singular: boolean }[]): string {
  const n = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(7))) : "");
  const at = (x: number) => String(Number(x.toFixed(6)) || 0);
  const out = ["Hot spot,X (mm),Y (mm),Z (mm),von Mises (MPa),Singularity"];
  rows.forEach((r, i) => out.push([String(i + 1), at(r.at[0]), at(r.at[1]), at(r.at[2]), n(r.vm), r.singular ? "yes" : "no"].join(",")));
  return out.join("\r\n") + "\r\n";
}

/** A thermal result's hottest points and the sharp corners where the heat flux depends on refinement, as CSV. */
export function thermalHotCsv(temps: { at: number[]; vm: number }[], corners: { at: number[]; vm: number }[]): string {
  const n = (x: number) => (Number.isFinite(x) ? String(Number(x.toPrecision(7))) : "");
  const at = (x: number) => String(Number(x.toFixed(6)) || 0);
  const out = ["Kind,#,X (mm),Y (mm),Z (mm),Temperature (C),Heat flux (W/m2)"];
  temps.forEach((r, i) => out.push(["Hottest point", String(i + 1), at(r.at[0]), at(r.at[1]), at(r.at[2]), n(r.vm), ""].join(",")));
  corners.forEach((r, i) => out.push(["Sharp corner", String(i + 1), at(r.at[0]), at(r.at[1]), at(r.at[2]), "", n(r.vm * 1e6)].join(",")));
  return out.join("\r\n") + "\r\n";
}

/**
 * A binary STL of a triangle mesh moved by `scale` × `u` (the deformed shape; `u` null = as it is).
 * Triangles with a repeated vertex (left out of the plot) are skipped.
 */
export function stlBytes(pos: ArrayLike<number>, index: ArrayLike<number>, u: ArrayLike<number> | null, scale: number): Uint8Array {
  const tris: number[] = [];
  for (let t = 0; t + 2 < index.length; t += 3) if (index[t] !== index[t + 1] && index[t + 1] !== index[t + 2] && index[t] !== index[t + 2]) tris.push(t);
  const buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  const P = (v: number, c: number) => pos[3 * v + c] + (u ? scale * u[3 * v + c] : 0);
  let o = 84;
  for (const t of tris) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const e1 = [0, 1, 2].map(k => P(b, k) - P(a, k)), e2 = [0, 1, 2].map(k => P(c, k) - P(a, k));
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, n[k] / l, true);
    [a, b, c].forEach((v, i) => { for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + 12 * i + 4 * k, P(v, k), true); });
    o += 50;
  }
  return new Uint8Array(buf);
}

export interface Balance {
  /** Sum of the supports' reactions: force N and moment about the origin N·mm. */
  force: [number, number, number];
  moment: [number, number, number];
  /** |Σ reactions + Σ loads| as a share of the larger of the two, in %; null when there is nothing to balance. */
  off: number | null;
}

/** The reactions in total, and how far they are from balancing the applied loads. */
export function loadBalance(reactions: { force: number[]; moment: number[] }[], applied: { force: number[]; moment?: number[] }): Balance {
  const force: [number, number, number] = [0, 0, 0], moment: [number, number, number] = [0, 0, 0];
  for (const r of reactions) for (let k = 0; k < 3; k++) { force[k] += r.force[k]; moment[k] += r.moment[k] ?? 0; }
  const F = Math.hypot(...applied.force), R = Math.hypot(...force), top = Math.max(F, R);
  const d = Math.hypot(force[0] + applied.force[0], force[1] + applied.force[1], force[2] + applied.force[2]);
  return { force, moment, off: reactions.length && top > 1e-12 ? (100 * d) / top : null };
}
