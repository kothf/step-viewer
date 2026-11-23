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
export function hotSpots(pos: ArrayLike<number>, index: ArrayLike<number>, passes: HotPass[], radius: number, count = 5, two = Infinity): HotSpot[] {
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
    const singular = settled && (k === 3 ? pk[0] > 0 && pk[1] / pk[0] > SINGULAR_STEP && pk[2] / pk[1] > SINGULAR_STEP && pk[2] / pk[0] > SINGULAR_GROWTH : k === 2 && growth !== null && growth > two);
    out.push({ v, at: [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]], vm: vm[v], growth, singular });
    if (!singular) real++;
  }
  return out;
}

/** Size of each vertex's vector (3 numbers per vertex), e.g. the heat flux. */
export function vectorSize(u: ArrayLike<number>): Float32Array {
  const n = Math.floor(u.length / 3), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]);
  return out;
}

/** With two passes only, a flux peak that grew by more than this is a sharp corner's. */
export const FLUX_STEP = 1.22;

export interface ThermalHot {
  /** The hottest points: local maxima of the temperature, °C, hottest first (temperatures have no singular points). */
  temps: HotSpot[];
  /** Sharp corners where the heat flux keeps rising with accuracy, W/mm² (`vm` holds the flux). */
  corners: HotSpot[];
  /** 1 per plot point at or along a sharp corner (its flux grows like the corners'). */
  sharp: Uint8Array;
}

/**
 * Hot spots of a thermal result (FRS-thermal FR-TRES-003): the hottest local maxima of the temperature, and the heat
 * flux peaks that grow pass after pass as a stress singularity does (an inside corner: the flux goes as r^(−1/3)).
 * `vm` is the temperature, `u` the flux, `change` the temperature change of the pass, %.
 */
export function thermalHotSpots(pos: ArrayLike<number>, index: ArrayLike<number>, passes: { vm: ArrayLike<number>; u: ArrayLike<number>; change: number | null }[], radius: number, count = 5): ThermalHot {
  const last = passes.at(-1);
  if (!last) return { temps: [], corners: [], sharp: new Uint8Array(0) };
  // the rise over the coolest point, so "a ripple far below the highest" is measured from there
  let lo = Infinity;
  for (let i = 0; i < last.vm.length; i++) if (last.vm[i] < lo) lo = last.vm[i];
  const rise = Float32Array.from(last.vm, v => v - lo);
  // a face at one temperature has a "peak" at every corner of it: points within 2 % of the range of a hotter one
  // nearby are that one; points along one sharp edge are one corner
  const far = (4 * radius) ** 2, d2 = (a: HotSpot, b: HotSpot) => (a.at[0] - b.at[0]) ** 2 + (a.at[1] - b.at[1]) ** 2 + (a.at[2] - b.at[2]) ** 2;
  let hi = 0;
  for (let i = 0; i < rise.length; i++) if (rise[i] > hi) hi = rise[i];
  const thin = (list: HotSpot[], same: (a: HotSpot, b: HotSpot) => boolean) => list.reduce<HotSpot[]>((out, h) => (out.length < count && !out.some(k => d2(k, h) <= far && same(k, h)) ? [...out, h] : out), []);
  // a real hot spot is the hottest point around it, not a ripple on a slope: nothing within `radius` is hotter
  const r2 = radius * radius, n = rise.length;
  const top = (h: HotSpot) => { for (let i = 0; i < n; i++) if (rise[i] > h.vm + 1e-3 * hi && (pos[3 * i] - h.at[0]) ** 2 + (pos[3 * i + 1] - h.at[1]) ** 2 + (pos[3 * i + 2] - h.at[2]) ** 2 < r2) return false; return true; };
  const temps = thin(hotSpots(pos, index, [{ vm: rise, change: null }], radius, 4 * count).filter(top), (k, h) => k.vm - h.vm <= 0.02 * hi)
    .map(h => ({ ...h, vm: h.vm + lo, growth: null, singular: false }));
  // a thermal study often stops after two passes (the temperatures settle quickly): then one step of more than
  // `FLUX_STEP` counts (an inside corner's flux grew 29 % from p = 2 to 3; where a faceted fillet meets a face, 17 %)
  const corners = thin(hotSpots(pos, index, passes.map(p => ({ vm: vectorSize(p.u), change: p.change })), radius, 2 * count, FLUX_STEP).filter(h => h.singular), () => true);
  // the points whose flux grows like the corners' (the whole sharp edge): the Max label of the flux plot skips them
  const prev = passes.length > 1 ? vectorSize(passes[passes.length - 2].u) : null, now = vectorSize(last.u);
  const sharp = new Uint8Array(n);
  if (corners.length && prev) {
    const q = Math.min(...corners.map(h => h.vm));
    for (let i = 0; i < n; i++) if (now[i] >= 0.5 * q && prev[i] > 0 && now[i] / prev[i] > SINGULAR_STEP) sharp[i] = 1;
  }
  // and everything within the radius of the edge (its ends, where three faces meet, grow less)
  const seeds: number[][] = corners.map(h => h.at);
  for (let i = 0; i < n; i++) if (sharp[i]) seeds.push([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
  const cell = radius, key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`, grid = new Map<string, number[][]>();
  for (const p of seeds) { const k = key(p[0], p[1], p[2]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  if (seeds.length) for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2], cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    near: for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (const p of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) if ((x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2 < r2) { sharp[i] = 1; break near; }
  }
  return { temps, corners, sharp };
}
