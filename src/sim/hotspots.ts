// Hot spots of a result (FRS-structural FR-RES-004, FR-SOL-015, FR-RES-012): the highest local maxima of the
// von Mises stress on the plot mesh, each checked for a stress singularity. Pure: no DOM, no three.js.

export interface HotSpot {
  /** Vertex of the plot mesh. */
  v: number;
  at: [number, number, number];
  /** von Mises stress there in the last pass, MPa. */
  vm: number;
  /** Growth of the peak near the point over the last pass, as a factor (null with one pass). */
  growth: number | null;
  /** The peak keeps growing with refinement while the energy has settled: its value depends on refinement. */
  singular: boolean;
}

export interface HotPass {
  vm: ArrayLike<number>;
  /** Change of the strain energy from the pass before, %, null on the first. */
  change: number | null;
}

/**
 * A peak that grew by more than `SINGULAR_STEP` in each of the last two passes and by `SINGULAR_GROWTH` over
 * both is a likely singularity. Raising the degree lifts a singular peak a little less each pass (a sharp
 * inside corner: 24 %, 18 %, 16 %), while a real peak settles within a few percent.
 */
export const SINGULAR_STEP = 1.08, SINGULAR_GROWTH = 1.25;
/** The energy counts as settled under this change, %. */
export const SETTLED = 2;

/**
 * The `count` highest real peaks of the last pass, highest first, with the likely singularities above them kept
 * in the list and flagged. Peaks nearer than `radius` to a higher one are one spot.
 */
export function hotSpots(pos: ArrayLike<number>, index: ArrayLike<number>, passes: HotPass[], radius: number, count = 5): HotSpot[] {
  const last = passes.at(-1);
  if (!last) return [];
  const n = pos.length / 3, vm = last.vm;
  // vertices at one place are one point (faces do not share vertices)
  let size = 0;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const x = pos[3 * i + k]; if (x < lo) lo = x; if (x > hi) hi = x; }
    size = Math.max(size, hi - lo);
  }
  const q = 1 / Math.max(1e-9, size * 1e-6), ids = new Map<string, number>(), group = new Int32Array(n);
  const rep: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[3 * i] * q)},${Math.round(pos[3 * i + 1] * q)},${Math.round(pos[3 * i + 2] * q)}`;
    let g = ids.get(key);
    if (g === undefined) { g = rep.length; ids.set(key, g); rep.push(i); } else if (vm[i] > vm[rep[g]]) rep[g] = i;
    group[i] = g;
  }
  const ng = rep.length, peak = new Uint8Array(ng).fill(1);
  for (let k = 0; k + 2 < index.length; k += 3) {
    for (let j = 0; j < 3; j++) {
      const a = group[index[k + j]], b = group[index[k + (j + 1) % 3]];
      if (a === b) continue;
      const va = vm[rep[a]], vb = vm[rep[b]];
      if (va < vb) peak[a] = 0; else if (vb < va) peak[b] = 0;
    }
  }
  const cand: number[] = [];
  // a ripple far below the highest stress is no hot spot
  let top = 0;
  for (let i = 0; i < n; i++) if (vm[i] > top) top = vm[i];
  for (let g = 0; g < ng; g++) if (peak[g] && vm[rep[g]] > 0.1 * top) cand.push(g);
  cand.sort((a, b) => vm[rep[b]] - vm[rep[a]]);
  const r2 = radius * radius, out: HotSpot[] = [];
  const d2 = (i: number, j: number) => (pos[3 * i] - pos[3 * j]) ** 2 + (pos[3 * i + 1] - pos[3 * j + 1]) ** 2 + (pos[3 * i + 2] - pos[3 * j + 2]) ** 2;
  const settled = last.change != null && Math.abs(last.change) <= SETTLED;
  let real = 0;
  for (const g of cand) {
    if (real >= count || out.length >= 2 * count) break;
    const v = rep[g];
    if (out.some(h => d2(h.v, v) < r2)) continue;
    // the peak near the point in each of the last three passes
    const near: number[] = [];
    for (let i = 0; i < n; i++) if (d2(i, v) < r2 / 4) near.push(i);
    const peakOf = (p: HotPass) => { let m = 0; for (const i of near) if (p.vm[i] > m) m = p.vm[i]; return m; };
    const pk = passes.slice(-3).map(peakOf), k = pk.length;
    const growth = k >= 2 && pk[k - 2] > 0 ? pk[k - 1] / pk[k - 2] : null;
    const singular = settled && k === 3 && pk[0] > 0 && pk[1] / pk[0] > SINGULAR_STEP && pk[2] / pk[1] > SINGULAR_STEP && pk[2] / pk[0] > SINGULAR_GROWTH;
    out.push({ v, at: [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]], vm: vm[v], growth, singular });
    if (!singular) real++;
  }
  return out;
}
