// Surface analyses (FR-MEA-005): draft against a pull direction, curvature, ray-based wall thickness and undercut.
// Each analysis colours the mesh's vertices and sums the area of every class, so the legend can say how much of
// the part is in it. Everything is in the mesh's own coordinates (mm); the caller turns the pull direction into them.

export type V3 = [number, number, number];
export type AnalysisKind = "draft" | "zebra" | "curvature" | "thickness" | "undercut";

/** A ray against the same part: the distance to the first hit, or null. */
export type RayHit = (o: V3, d: V3, far: number) => number | null;

export interface MeshIn {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  /** Exact face kinds, when known: triangle ranges with the surface and its radius. */
  faces?: { triStart: number; triCount: number; surface?: string; type?: string; radius?: number }[];
}

export interface Analysis {
  /** RGB per vertex, 0..1, linear. */
  colors: Float32Array;
  /** Area (mm²) per class key, by triangle (the mean of its vertex values). */
  areas: Record<string, number>;
  /** Curvature: the largest curvature the scale shows (1/mm). Thickness: the largest wall found (mm). */
  max?: number;
}

/** Legend classes, in order, with their colours (sRGB hex). */
export const DRAFT_CLASSES = [
  { key: "pos", color: "#2f9e44", label: "Positive draft" },
  { key: "low", color: "#f2c200", label: "Draft below the minimum" },
  { key: "neg", color: "#d6336c", label: "Negative draft" },
] as const;
export const UNDERCUT_CLASSES = [
  { key: "up", color: "#2f9e44", label: "Released by the pull direction" },
  { key: "down", color: "#1c7ed6", label: "Released against the pull direction" },
  { key: "side", color: "#f2c200", label: "Parallel to the pull (no draft)" },
  { key: "under", color: "#e03131", label: "Undercut" },
] as const;
export const THICK_CLASSES = [
  { key: "thin", color: "#e03131", label: "Thinner than the minimum" },
  { key: "ok", color: "#2f9e44", label: "Wall thickness" },
  { key: "open", color: "#868e96", label: "No opposite wall" },
] as const;

const hex = (h: string): V3 => {
  const n = parseInt(h.slice(1), 16);
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return [lin(n >> 16), lin((n >> 8) & 255), lin(n & 255)];
};
const RAMP = ["#1c3fbf", "#1c7ed6", "#15aabf", "#40c057", "#fab005", "#fd7e14", "#e03131"].map(hex);
/** Blue (0) → red (1), linear RGB. */
export function ramp(t: number): V3 {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
export const RAMP_CSS = "linear-gradient(90deg, #1c3fbf, #1c7ed6, #15aabf, #40c057, #fab005, #fd7e14, #e03131)";

const unit = (d: V3): V3 => { const l = Math.hypot(...d) || 1; return [d[0] / l, d[1] / l, d[2] / l]; };

function triArea(p: Float32Array, a: number, b: number, c: number) {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Sums triangle areas by the class of each triangle's mean vertex value. */
function areasBy(m: MeshIn, value: Float32Array, cls: (v: number) => string) {
  const out: Record<string, number> = {};
  const ix = m.index;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    const k = cls((value[a] + value[b] + value[c]) / 3);
    out[k] = (out[k] ?? 0) + triArea(m.positions, a, b, c);
  }
  return out;
}

function paint(n: number, color: (i: number) => V3) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set(color(i), i * 3);
  return out;
}

/**
 * Draft analysis: the draft angle of each point is 90° minus its angle to the pull direction. At least `minDeg`
 * is positive draft, at most −`minDeg` negative, anything between needs more draft.
 */
export function draft(m: MeshIn, pull: V3, minDeg: number): Analysis {
  const d = unit(pull), N = m.normals, n = N.length / 3;
  const ang = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = N[i * 3] * d[0] + N[i * 3 + 1] * d[1] + N[i * 3 + 2] * d[2];
    ang[i] = Math.asin(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  }
  const min = Math.max(0, minDeg) - 1e-6;
  const cls = (a: number) => (a >= min && a > 1e-3 ? "pos" : a <= -min && a < -1e-3 ? "neg" : "low");
  const col = Object.fromEntries(DRAFT_CLASSES.map(c => [c.key, hex(c.color)])) as Record<string, V3>;
  return { colors: paint(n, i => col[cls(ang[i])]), areas: areasBy(m, ang, cls) };
}

/**
 * Curvature map: the largest normal curvature at each point, from the turn of the normals along the mesh edges
 * (κ ≈ |Δn · Δp| / |Δp|²). Flat and cylindrical or spherical faces the B-rep knows take their exact value.
 * The scale runs from flat (blue) to `max` (red); without `max`, the 95th percentile of the curved points.
 */
export function curvature(m: MeshIn, max?: number): Analysis {
  const P = m.positions, N = m.normals, ix = m.index, n = P.length / 3;
  const k = new Float32Array(n), exact = new Uint8Array(n);
  for (const f of m.faces ?? []) {
    const s = f.surface ?? f.type;
    const val = s === "plane" ? 0 : (s === "cylinder" || s === "sphere") && f.radius ? 1 / f.radius : -1;
    if (val < 0) continue;
    for (let t = f.triStart * 3; t < (f.triStart + f.triCount) * 3; t++) { k[ix[t]] = val; exact[ix[t]] = 1; }
  }
  const edge = (a: number, b: number) => {
    const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < 1e-18) return;
    const c = Math.abs((N[b * 3] - N[a * 3]) * dx + (N[b * 3 + 1] - N[a * 3 + 1]) * dy + (N[b * 3 + 2] - N[a * 3 + 2]) * dz) / l2;
    if (!exact[a] && c > k[a]) k[a] = c;
    if (!exact[b] && c > k[b]) k[b] = c;
  };
  for (let t = 0; t < ix.length; t += 3) { edge(ix[t], ix[t + 1]); edge(ix[t + 1], ix[t + 2]); edge(ix[t + 2], ix[t]); }
  let top = max;
  if (!top) {
    const curved = Array.from(k).filter(v => v > 1e-6).sort((a, b) => a - b);
    top = curved.length ? curved[Math.min(curved.length - 1, Math.floor(curved.length * 0.95))] : 1;
  }
  const T = top;
  const cls = (v: number) => (v <= 1e-6 ? "flat" : v >= T * 0.999 ? "high" : "curved");
  return { colors: paint(n, i => ramp(k[i] / T)), areas: areasBy(m, k, cls), max: T };
}

/**
 * Wall thickness: a ray from each point into the material (against its normal) to the opposite wall. Points with
 * a wall thinner than `min` are red, the rest go from red-orange to blue as the wall grows to `max` (or 4 × min).
 * Runs in slices so a big mesh does not freeze the page; `stop` ends it early (returns null).
 */
export async function thickness(m: MeshIn, hit: RayHit, min: number, size: number, stop: () => boolean = () => false, max?: number): Promise<Analysis | null> {
  const P = m.positions, N = m.normals, n = P.length / 3;
  const w = new Float32Array(n).fill(-1), eps = Math.max(1e-4, size * 1e-6);
  let widest = 0;
  for (let i = 0; i < n; i++) {
    if (i % 20000 === 19999) { await new Promise(r => setTimeout(r, 0)); if (stop()) return null; }
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    const d: V3 = [-nx, -ny, -nz];
    const h = hit([P[i * 3] + d[0] * eps, P[i * 3 + 1] + d[1] * eps, P[i * 3 + 2] + d[2] * eps], d, size * 2);
    if (h != null) { w[i] = h + eps; if (w[i] > widest) widest = w[i]; }
  }
  const hi = max ?? Math.max(min * 4, min + 1e-3);
  const thin = hex(THICK_CLASSES[0].color), open = hex(THICK_CLASSES[2].color);
  const cls = (v: number) => (v < 0 ? "open" : v < min ? "thin" : "ok");
  return {
    colors: paint(n, i => (w[i] < 0 ? open : w[i] < min ? thin : ramp(0.8 - 0.8 * Math.min(1, (w[i] - min) / (hi - min))))),
    areas: areasBy(m, w, cls), max: widest,
  };
}

/**
 * Undercut: a point facing the pull direction must see out along it, one facing away must see out against it.
 * A ray that meets the part again means the mould cannot release that point. Points within `sideDeg` of
 * parallel to the pull are walls with no draft.
 */
export async function undercut(m: MeshIn, hit: RayHit, pull: V3, size: number, stop: () => boolean = () => false, sideDeg = 0.5): Promise<Analysis | null> {
  const P = m.positions, N = m.normals, n = P.length / 3, d = unit(pull);
  const c = new Float32Array(n), eps = Math.max(1e-4, size * 1e-6), side = Math.sin(sideDeg * Math.PI / 180);
  // 0 up, 1 down, 2 side, 3 undercut
  for (let i = 0; i < n; i++) {
    if (i % 20000 === 19999) { await new Promise(r => setTimeout(r, 0)); if (stop()) return null; }
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    const dot = nx * d[0] + ny * d[1] + nz * d[2];
    if (Math.abs(dot) <= side) { c[i] = 2; continue; }
    const s = dot > 0 ? 1 : -1, r: V3 = [d[0] * s, d[1] * s, d[2] * s];
    const o: V3 = [P[i * 3] + nx * eps + r[0] * eps, P[i * 3 + 1] + ny * eps + r[1] * eps, P[i * 3 + 2] + nz * eps + r[2] * eps];
    c[i] = hit(o, r, size * 4) != null ? 3 : s > 0 ? 0 : 1;
  }
  const keys = UNDERCUT_CLASSES.map(x => x.key), col = UNDERCUT_CLASSES.map(x => hex(x.color));
  // A triangle is undercut if any of its points is; otherwise it takes the class most of its points have.
  const areas: Record<string, number> = {};
  for (let t = 0; t < m.index.length; t += 3) {
    const a = m.index[t], b = m.index[t + 1], e = m.index[t + 2];
    const v = c[a] === 3 || c[b] === 3 || c[e] === 3 ? 3 : c[b] === c[e] ? c[b] : c[a];
    areas[keys[v]] = (areas[keys[v]] ?? 0) + triArea(P, a, b, e);
  }
  return { colors: paint(n, i => col[c[i]]), areas };
}
