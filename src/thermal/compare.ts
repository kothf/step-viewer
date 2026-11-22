// Comparing two thermal maps of one model (FRS-thermal FR-TMAP-030/031): the second map's temperatures carried onto
// the first map's points, and the parts by how much their temperature changed.
import { partTemp, type PartStat, type ThermalPart } from "./package";
import type { ThermalMesh } from "./vtu";

type V3 = [number, number, number];

/** The part of each point: that of the first triangle using it (−1 = none). */
export function vertexParts(m: ThermalMesh): Int32Array {
  const out = new Int32Array(m.temp.length).fill(-1);
  for (let k = 0; k < m.part.length; k++) for (let j = 0; j < 3; j++) { const v = m.tri[3 * k + j]; if (out[v] < 0) out[v] = m.part[k]; }
  return out;
}

/**
 * B's temperature at each point of A: the same point when both meshes are the same, else the nearest point of B on
 * the same part (any part when that part has no point of B nearby). `shift` moves B's points into A's frame.
 */
export function mapOnto(a: ThermalMesh, b: ThermalMesh, shift: V3 = [0, 0, 0]): Float32Array {
  const na = a.temp.length, nb = b.temp.length, out = new Float32Array(na);
  if (!nb) return out.fill(NaN);
  const still = shift.every(s => s === 0);
  if (still && na === nb) {
    let same = true;
    for (let i = 0; i < a.pos.length && same; i++) same = Math.abs(a.pos[i] - b.pos[i]) <= 1e-6 * (1 + Math.abs(a.pos[i]));
    if (same) { out.set(b.temp); return out; }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const P = new Float64Array(3 * nb);
  for (let i = 0; i < nb; i++) for (let k = 0; k < 3; k++) { const v = b.pos[3 * i + k] + shift[k]; P[3 * i + k] = v; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const h = diag / Math.max(8, Math.cbrt(nb) * 2), n = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k] - lo[k]) / h) + 1));
  const cells = new Map<number, number[]>();
  const cellOf = (x: number, k: number) => Math.min(n[k] - 1, Math.max(0, Math.floor((x - lo[k]) / h)));
  for (let i = 0; i < nb; i++) {
    const key = (cellOf(P[3 * i], 0) * n[1] + cellOf(P[3 * i + 1], 1)) * n[2] + cellOf(P[3 * i + 2], 2);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = []));
    c.push(i);
  }
  const pa = vertexParts(a), pb = vertexParts(b), parts = new Set(pb);
  const most = Math.max(n[0], n[1], n[2]);
  for (let v = 0; v < na; v++) {
    const x = a.pos[3 * v], y = a.pos[3 * v + 1], z = a.pos[3 * v + 2], want = parts.has(pa[v]) ? pa[v] : -2;
    const cx = cellOf(x, 0), cy = cellOf(y, 1), cz = cellOf(z, 2);
    let best = -1, bd = Infinity, any = -1, ad = Infinity;
    for (let r = 0; r <= most; r++) {
      // a ring r cells out can hold nothing nearer than (r − 1) h
      const near = (r - 1) * h;
      if (best >= 0 && bd <= near * near) break;
      if (best < 0 && any >= 0 && (want === -2 || r > 4) && ad <= near * near) break;
      for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) for (let k = cz - r; k <= cz + r; k++) {
        if (Math.max(Math.abs(i - cx), Math.abs(j - cy), Math.abs(k - cz)) !== r || i < 0 || j < 0 || k < 0 || i >= n[0] || j >= n[1] || k >= n[2]) continue;
        const c = cells.get((i * n[1] + j) * n[2] + k);
        if (!c) continue;
        for (const q of c) {
          const d = (P[3 * q] - x) ** 2 + (P[3 * q + 1] - y) ** 2 + (P[3 * q + 2] - z) ** 2;
          if (d < ad) { ad = d; any = q; }
          if (pb[q] === want && d < bd) { bd = d; best = q; }
        }
      }
    }
    const q = best >= 0 ? best : any;
    out[v] = q >= 0 ? b.temp[q] : NaN;
  }
  return out;
}

export interface PartChange {
  name: string;
  /** Part ids in A and in B (0 = the board). */
  ia: number;
  ib: number;
  /** Reported temperature in A and B, °C, and B − A. */
  a: number;
  b: number;
  d: number;
}

/**
 * The parts of two maps paired by designator (the board with the board), by how much their temperature changed
 * (largest change first), and the ones found in one map only.
 */
export function partChanges(pa: ThermalPart[], sa: Map<number, PartStat>, pb: ThermalPart[], sb: Map<number, PartStat>): { rows: PartChange[]; onlyA: string[]; onlyB: string[] } {
  const rows: PartChange[] = [], onlyA: string[] = [], onlyB: string[] = [];
  const ba = sa.get(0)?.max, bb = sb.get(0)?.max;
  if (ba !== undefined && bb !== undefined) rows.push({ name: "", ia: 0, ib: 0, a: ba, b: bb, d: bb - ba });
  const byName = new Map<string, ThermalPart>();
  for (const p of pb) byName.set(p.designator, p);
  const seen = new Set<string>();
  for (const p of pa) {
    const q = byName.get(p.designator), ta = partTemp(p, sa);
    seen.add(p.designator);
    if (!q) { onlyA.push(p.designator); continue; }
    const tb = partTemp(q, sb);
    if (ta === undefined || tb === undefined) continue;
    rows.push({ name: p.designator, ia: p.id, ib: q.id, a: ta, b: tb, d: tb - ta });
  }
  for (const q of pb) if (!seen.has(q.designator)) onlyB.push(q.designator);
  rows.sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || x.name.localeCompare(y.name));
  return { rows, onlyA, onlyB };
}

/** The colour range of a ΔT map: symmetric about 0, at least ±1 K. */
export function deltaRange(d: ArrayLike<number>): [number, number] {
  let m = 0;
  for (let i = 0; i < d.length; i++) if (Number.isFinite(d[i]) && Math.abs(d[i]) > m) m = Math.abs(d[i]);
  m = Math.max(1, m);
  return [-m, m];
}
