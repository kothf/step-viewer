// Copper from the board's Gerber set (FRS-thermal FR-TBRD-020): each copper layer's coverage on a grid of cells, the
// plated barrels of the drill files, and from them the board's conductivity cell by cell. The rasterising takes a
// 2D canvas from the caller; everything else is pure.

import { K_COPPER, K_FR4, plateAxis, type BoardStack } from "./study";
import type { KMap } from "../sim/thermal";

/** Plating in a drilled hole, mm. */
export const PLATING = 0.025;
/** Most cells a map keeps (its cell size grows to stay under). */
export const MAP_CELLS = 40000;
/** Barrel copper area share is stored as a byte of this many steps per 1. */
const VIA_SCALE = 2550;

/**
 * A board's copper as kept in a study: per copper layer (top first) the share of each cell that is copper, and the
 * plated barrels' copper as a share of the cell area, on a grid of `nu` × `nv` cells of `cell` mm in board
 * coordinates from (`x0`, `y0`); `swap` = the board's X runs along the model's second in-plane axis.
 */
export interface CopperMap {
  name: string;
  x0: number; y0: number; cell: number; nu: number; nv: number;
  /** Base64 bytes, 0..255 = 0..1, row by row from y0. */
  cov: string[];
  /** Base64 bytes, the barrels' copper area per cell area × 2550. */
  vias: string;
  /** Layer labels and mean coverage, for the panel. */
  labels: string[];
  means: number[];
  holes: number;
  /** Where the board's box centre lands in the model, along its two in-plane axes, and whether X and Y are swapped. */
  at?: { u: number; v: number; swap: boolean };
}

export const b64 = (a: Uint8Array) => { let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = (s: string) => { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };

/**
 * Conductivity of a stack whose copper layers cover the shares `cov` (W/(m·K)): along the board the layers in
 * parallel, through it in series; plated barrels covering `via` of the area add copper straight through.
 */
export function stackK(t: number, s: BoardStack, cov: ArrayLike<number>, via = 0): { along: number; through: number } {
  const n = cov.length, tc = Math.min(s.copper * 1e-3, t / Math.max(1, n + 1));
  let sum = 0, series = 0;
  for (let i = 0; i < n; i++) { const c = Math.min(1, Math.max(0, cov[i])); sum += tc * c; series += tc / (K_FR4 * (1 - c) + K_COPPER * c); }
  const lam = Math.max(t - n * tc, 1e-6), share = sum / t;
  return { along: K_FR4 * (1 - share) + K_COPPER * share, through: t / (lam / K_FR4 + series) + Math.min(1, via) * K_COPPER };
}

/** The grid a board box is cut into: about 1 mm cells, coarser for big boards. */
export function gridFor(box: [number, number, number, number], cells = MAP_CELLS): { cell: number; nu: number; nv: number } {
  const w = Math.max(box[2] - box[0], 1e-3), h = Math.max(box[3] - box[1], 1e-3);
  let cell = 1;
  while ((Math.ceil(w / cell) * Math.ceil(h / cell)) > cells) cell *= 1.25;
  return { cell, nu: Math.ceil(w / cell), nv: Math.ceil(h / cell) };
}

/** A hole or slot of a drill file: ends, diameter, plated. */
export interface DrillHole { x1: number; y1: number; x2: number; y2: number; d: number; plated: boolean | null }

/** The plated barrels' copper area share per cell (holes not marked unplated count; slots as their length). */
export function viaShare(holes: DrillHole[], g: { x0: number; y0: number; cell: number; nu: number; nv: number }): Float64Array {
  const out = new Float64Array(g.nu * g.nv), area = g.cell * g.cell;
  for (const h of holes) {
    if (h.plated === false || !(h.d > 0)) continue;
    const len = Math.hypot(h.x2 - h.x1, h.y2 - h.y1), cu = (Math.PI * h.d + 2 * len) * PLATING;
    const mx = (h.x1 + h.x2) / 2, my = (h.y1 + h.y2) / 2;
    const i = Math.floor((mx - g.x0) / g.cell), j = Math.floor((my - g.y0) / g.cell);
    if (i < 0 || j < 0 || i >= g.nu || j >= g.nv) continue;
    out[j * g.nu + i] += cu / area;
  }
  return out;
}

/**
 * The map's conductivity for the solver, W/(mm·K): `axis` = the board's thin world axis, (`cu`, `cv`) = its box centre
 * along the other two (in order), `t` = its thickness.
 */
export function kmapOf(m: CopperMap, s: BoardStack, t: number, axis: number, cu: number, cv: number, swapped = false): KMap {
  const n = m.nu * m.nv, layers = m.cov.map(unb64), vias = unb64(m.vias);
  const along = new Float32Array(n), through = new Float32Array(n), cov = new Float64Array(layers.length);
  for (let k = 0; k < n; k++) {
    for (let l = 0; l < layers.length; l++) cov[l] = layers[l][k] / 255;
    const q = stackK(t, s, cov, vias[k] / VIA_SCALE);
    along[k] = q.along * 1e-3; through[k] = q.through * 1e-3;
  }
  const ua = (axis + 1) % 3 < (axis + 2) % 3 ? (axis + 1) % 3 : (axis + 2) % 3, va = 3 - axis - ua;
  const swap = m.at?.swap ?? swapped, w = m.nu * m.cell, h = m.nv * m.cell;
  const du = m.at ? m.at.u - cu : 0, dv = m.at ? m.at.v - cv : 0;
  if (!swap) return { axis, ua, va, u0: cu + du - w / 2, v0: cv + dv - h / 2, cell: m.cell, nu: m.nu, nv: m.nv, along, through };
  // the board's X along the model's second axis: the grid transposed
  const a2 = new Float32Array(n), t2 = new Float32Array(n);
  for (let j = 0; j < m.nv; j++) for (let i = 0; i < m.nu; i++) { a2[i * m.nv + j] = along[j * m.nu + i]; t2[i * m.nv + j] = through[j * m.nu + i]; }
  return { axis, ua, va, u0: cu + du - h / 2, v0: cv + dv - w / 2, cell: m.cell, nu: m.nv, nv: m.nu, along: a2, through: t2 };
}

/** Whether the board's X runs along the model's second in-plane axis: the box sizes match better that way. */
export function swapFits(board: [number, number], model: [number, number]): boolean {
  const same = Math.abs(board[0] - model[0]) + Math.abs(board[1] - model[1]), cross = Math.abs(board[0] - model[1]) + Math.abs(board[1] - model[0]);
  return cross < same;
}

/** Copper layers top first, then inner ones by their number, then bottom. */
export function copperOrder<L extends { kind: string; side: string | null; label: string }>(layers: L[]): L[] {
  const rank = (l: L) => (l.side === "top" ? 0 : l.side === "bottom" ? 2 : 1), num = (l: L) => Number(/(\d+)/.exec(l.label)?.[1] ?? 0);
  return layers.filter(l => l.kind === "copper").sort((a, b) => rank(a) - rank(b) || num(a) - num(b));
}

/** The mean of each cell's alpha (0..255) over `px` × `px` pixels of an image `nu·px` wide. */
export function cellMeans(alpha: Uint8ClampedArray | Uint8Array, nu: number, nv: number, px: number, stride = 4): Uint8Array {
  const out = new Uint8Array(nu * nv), W = nu * px, n = px * px;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    let s = 0;
    for (let y = 0; y < px; y++) { const row = (j * px + y) * W; for (let x = 0; x < px; x++) s += alpha[(row + i * px + x) * stride + (stride - 1)]; }
    out[j * nu + i] = Math.round(s / n);
  }
  return out;
}

/** Encodes the barrel shares for keeping. */
export function viaBytes(share: Float64Array): Uint8Array { return Uint8Array.from(share, v => Math.min(255, Math.round(v * VIA_SCALE))); }

/** The mean copper share of a map's layers, for the panel; and the map as an image (copper of all layers, darker = more). */
export function mapPicture(m: CopperMap): { w: number; h: number; rgba: Uint8ClampedArray } {
  const layers = m.cov.map(unb64), n = m.nu * m.nv, rgba = new Uint8ClampedArray(4 * n);
  for (let j = 0; j < m.nv; j++) for (let i = 0; i < m.nu; i++) {
    let c = 0;
    for (const L of layers) c += L[j * m.nu + i];
    c /= 255 * Math.max(1, layers.length);
    // drawn with Y up: the image's first row is the board's top edge
    const o = 4 * ((m.nv - 1 - j) * m.nu + i);
    rgba[o] = 40 + 160 * c; rgba[o + 1] = 70 + 50 * c; rgba[o + 2] = 40; rgba[o + 3] = 255;
  }
  return { w: m.nu, h: m.nv, rgba };
}

/**
 * A board body's conductivity map from its copper map (null when the body is not a flat plate square to an axis):
 * the map's box centred on the body's, its X along the body's longer side when the sizes say so.
 */
export function boardMap(tris: ArrayLike<number>, s: BoardStack & { map?: CopperMap }, t: number): KMap | null {
  const pl = plateAxis(tris);
  if (!pl || !s.map) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) { const a = i % 3; lo[a] = Math.min(lo[a], tris[i]); hi[a] = Math.max(hi[a], tris[i]); }
  const axis = pl.axis, ua = (axis + 1) % 3 < (axis + 2) % 3 ? (axis + 1) % 3 : (axis + 2) % 3, va = 3 - axis - ua;
  const swap = swapFits([s.map.nu * s.map.cell, s.map.nv * s.map.cell], [hi[ua] - lo[ua], hi[va] - lo[va]]);
  return kmapOf(s.map, s, t, axis, (lo[ua] + hi[ua]) / 2, (lo[va] + hi[va]) / 2, swap);
}

/** A conductivity map's mean along and through, W/(m·K). */
export function kmapMeans(k: KMap): { along: number; through: number } {
  let a = 0, t = 0;
  for (let i = 0; i < k.along.length; i++) { a += k.along[i]; t += k.through[i]; }
  const n = Math.max(1, k.along.length);
  return { along: (a / n) * 1e3, through: (t / n) * 1e3 };
}

/** A Gerber set's name: the file names' common start without a trailing separator (or the one file's stem). */
export function gerberName(names: string[]): string {
  const stems = names.map(n => n.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, ""));
  if (!stems.length) return "";
  if (stems.length === 1) return stems[0];
  let p = stems[0];
  for (const s of stems) while (!s.startsWith(p)) p = p.slice(0, -1);
  p = p.replace(/[-_. ]+$/, "");
  return p || stems[0];
}
