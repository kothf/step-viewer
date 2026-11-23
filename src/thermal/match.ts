// Matching a thermal package's parts to the bodies of the model it is shown on (FRS-thermal FR-TPKG-020..022). Pure.
import type { PartStat, ThermalPart } from "./package";

export type Box = [number, number, number, number, number, number];

/** A body of the open model: its name and box (min x, y, z, max x, y, z; mm). */
export interface ModelBody { name: string; box: Box }

export interface PartMatch {
  /** Model bodies of each package part id (0 = the board). */
  bodies: Map<number, number[]>;
  /** How each part was found. */
  by: Map<number, "name" | "box" | "plate">;
  /** Package parts no body was found for. */
  missing: number[];
  /** Parts found by name whose box differs from the package's by more than `CHANGED` mm (after the common offset). */
  changed: number[];
  /** Mean distance (mm) between the matched parts' centres in the package and in the model. */
  off: number;
  /** The translation that brings the package onto the model (least squares = the mean centre difference). */
  shift: [number, number, number];
}

/** Centres and sizes within this many mm count as the same box. */
export const BOX_TOL = 0.5;
/** A map whose parts lie further off than this on average does not fit the model. */
export const FIT_TOL = 0.5;
/** A named part whose box differs by more than this was changed after the package was written. */
export const CHANGED = 1;

const centre = (b: Box): [number, number, number] => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
const size = (b: Box): [number, number, number] => [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
const union = (a: Box | null, b: Box): Box => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])] : [...b] as Box;
const norm = (s: string) => s.trim().toLowerCase();

/** Largest difference between two boxes' centres and sizes, with the second moved by `d`. */
function boxDiff(a: Box, b: Box, d: [number, number, number] = [0, 0, 0]) {
  const ca = centre(a), cb = centre(b), sa = size(a), sb = size(b);
  let m = 0;
  for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(ca[k] - cb[k] - d[k]), Math.abs(sa[k] - sb[k]));
  return m;
}

/** The box a package part has: the manifest's, else the box of its triangles in the mesh. */
export function partBox(p: ThermalPart | null, id: number, stats: Map<number, PartStat>): Box | null {
  return p?.box ?? stats.get(id)?.box ?? null;
}

/**
 * Finds each package part among the model's bodies: by the names in `step_bodies` (else the designator), then by box.
 * The board (id 0) is the body named like a board, else the one whose box is the board's.
 */
export function matchParts(parts: ThermalPart[], stats: Map<number, PartStat>, bodies: ModelBody[]): PartMatch {
  const out: PartMatch = { bodies: new Map(), by: new Map(), missing: [], changed: [], off: 0, shift: [0, 0, 0] };
  const byName = new Map<string, number[]>();
  bodies.forEach((b, i) => { const k = norm(b.name); if (k) byName.set(k, [...(byName.get(k) ?? []), i]); });
  const used = new Set<number>();
  const ids = [...new Set([...(stats.has(0) ? [0] : []), ...parts.map(p => p.id)])];
  const partOf = new Map(parts.map(p => [p.id, p]));
  // by name
  for (const id of ids) {
    const p = partOf.get(id);
    const names = id === 0 ? ["board", "pcb"] : p ? (p.bodies.length ? p.bodies : [p.designator]) : [];
    const hit: number[] = [];
    for (const n of names) for (const i of byName.get(norm(n)) ?? []) if (!used.has(i) && !hit.includes(i)) hit.push(i);
    if (!hit.length) continue;
    hit.forEach(i => used.add(i));
    out.bodies.set(id, hit);
    out.by.set(id, "name");
  }
  // the common offset of what the names found, so a moved package still matches the rest by box
  const offsetOf = () => {
    let n = 0; const s: [number, number, number] = [0, 0, 0];
    for (const [id, list] of out.bodies) {
      const pb = partBox(partOf.get(id) ?? null, id, stats);
      if (!pb) continue;
      let mb: Box | null = null;
      for (const i of list) mb = union(mb, bodies[i].box);
      const a = centre(mb!), b = centre(pb);
      for (let k = 0; k < 3; k++) s[k] += a[k] - b[k];
      n++;
    }
    return n ? (s.map(x => x / n) as [number, number, number]) : null;
  };
  const d0 = offsetOf() ?? [0, 0, 0];
  // by box: the nearest free body within the tolerance
  for (const id of ids) {
    if (out.bodies.has(id)) continue;
    const pb = partBox(partOf.get(id) ?? null, id, stats);
    if (!pb) continue;
    let best = -1, bd = BOX_TOL;
    bodies.forEach((b, i) => { if (used.has(i)) return; const d = boxDiff(b.box, pb, d0); if (d <= bd) { bd = d; best = i; } });
    if (best < 0) continue;
    used.add(best);
    out.bodies.set(id, [best]);
    out.by.set(id, "box");
  }
  // the board by its outline (a board STEP written by MöbiusCAD itself from Gerbers lies centred on z = 0 and is named
  // after the Gerber set): a free flat body whose footprint is the package board's and whose thickness is its own
  if (!out.bodies.has(0) && stats.has(0) && !out.bodies.size) {
    const pb = partBox(null, 0, stats);
    if (pb) {
      let best = -1, bd = BOX_TOL;
      bodies.forEach((b, i) => {
        if (used.has(i)) return;
        const t = b.box[5] - b.box[2];
        if (!(t > 0 && t <= 6)) return;
        const d = boxDiff([b.box[0], b.box[1], 0, b.box[3], b.box[4], t], [pb[0], pb[1], 0, pb[3], pb[4], pb[5] - pb[2]]);
        if (d <= bd) { bd = d; best = i; }
      });
      if (best >= 0) { used.add(best); out.bodies.set(0, [best]); out.by.set(0, "plate"); }
    }
  }
  for (const id of ids) if (!out.bodies.has(id)) out.missing.push(id);
  const d = offsetOf();
  if (d) {
    out.shift = d;
    let n = 0, sum = 0;
    for (const [id, list] of out.bodies) {
      const pb = partBox(partOf.get(id) ?? null, id, stats);
      if (!pb) continue;
      let mb: Box | null = null;
      for (const i of list) mb = union(mb, bodies[i].box);
      const a = centre(mb!), b = centre(pb);
      sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      n++;
      if (out.by.get(id) === "name" && boxDiff(mb!, pb, d) > CHANGED) out.changed.push(id);
    }
    out.off = n ? sum / n : 0;
  }
  return out;
}

/** True when the map lies off the model by more than the tolerance (FR-TPKG-021). */
export const misfit = (m: PartMatch) => m.bodies.size > 0 && m.off > FIT_TOL;

/** Only the board was found, by its outline: the package goes onto it by `shift` without asking. */
export const boardOnly = (m: PartMatch) => m.bodies.size === 1 && m.by.get(0) === "plate";

/** Temperature at a point of a triangle from its corner values (barycentric weights of the nearest point). */
export function triWeights(p: [number, number, number], a: [number, number, number], b: [number, number, number], c: [number, number, number]): [number, number, number] {
  const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v2 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-20) return [1, 0, 0];
  let v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  v = Math.min(1, Math.max(0, v)); w = Math.min(1 - v, Math.max(0, w));
  return [1 - v - w, v, w];
}

// ---------- colour scales ----------

export type PaletteName = "heat" | "rainbow" | "grey";
type Stops = [number, number, number][];
/** Heat: dark = coolest, light yellow = hottest, even in lightness. Rainbow: blue to red. Grey: dark to light. */
const PALETTES: Record<PaletteName, Stops> = {
  heat: [[0.05, 0.03, 0.2], [0.33, 0.06, 0.43], [0.62, 0.16, 0.39], [0.86, 0.3, 0.24], [0.97, 0.55, 0.12], [0.98, 0.8, 0.3], [0.99, 0.97, 0.7]],
  rainbow: [[0.11, 0.3, 0.85], [0.1, 0.75, 0.85], [0.25, 0.75, 0.3], [0.95, 0.85, 0.2], [0.88, 0.2, 0.15]],
  grey: [[0.12, 0.12, 0.13], [0.95, 0.95, 0.95]],
};
/** Cool blue through white to warm red, for differences centred on 0. */
const DIVERGING: Stops = [[0.13, 0.33, 0.75], [0.55, 0.72, 0.9], [0.96, 0.96, 0.96], [0.94, 0.6, 0.48], [0.76, 0.15, 0.15]];
export const PALETTE_NAMES: PaletteName[] = ["heat", "rainbow", "grey"];

function stopsOf(name: PaletteName | "diverging") { return name === "diverging" ? DIVERGING : PALETTES[name] ?? PALETTES.heat; }
/** Writes the colour of x (0..1) into out[o..o+2]. */
export function paletteColor(name: PaletteName | "diverging", x: number, out: Float32Array | number[], o = 0) {
  const st = stopsOf(name);
  const s = Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0)) * (st.length - 1), i = Math.min(st.length - 2, Math.floor(s)), f = s - i;
  for (let k = 0; k < 3; k++) out[o + k] = st[i][k] + (st[i + 1][k] - st[i][k]) * f;
}
export function paletteCss(name: PaletteName | "diverging") {
  return `linear-gradient(90deg, ${stopsOf(name).map(c => `rgb(${c.map(x => Math.round(x * 255)).join(",")})`).join(", ")})`;
}
