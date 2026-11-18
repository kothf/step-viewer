/**
 * Flex (FR-FT-105): the pure point map. Coordinates in the triad: s along `a` (the flex axis), u along
 * `b` (the axis a bend turns to), w along `c` = a × b, all from the triad origin `o`. Between the trim
 * planes s1..s2 the map bends, twists, tapers or stretches; outside them it is the rigid (or affine) run-on
 * of the nearer trim plane, so the ends move as solid pieces. s0 (the triad, clamped to s1..s2) stays put.
 */
import type { FlexFeature, V3 } from "./types";

export interface FlexMap {
  kind: FlexFeature["kind"];
  o: V3; a: V3; b: V3; c: V3;
  s1: number; s2: number; s0: number;
  /** Bend/twist angle (rad), taper factor, stretch distance (mm). */
  angle: number; factor: number; distance: number;
}

const AX: Record<"x" | "y" | "z", V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const lin = (...t: [number, V3][]): V3 => t.reduce<V3>((s, [k, v]) => [s[0] + k * v[0], s[1] + k * v[1], s[2] + k * v[2]], [0, 0, 0]);

/** The axis a bend turns to when none is set. */
export const defaultToward = (axis: FlexFeature["axis"]): "x" | "y" | "z" => (axis === "z" ? "x" : "z");

export class FlexError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

/** The map for a feature on bodies whose box is `box` (min, max). */
export function flexMap(f: FlexFeature, box: [V3, V3]): FlexMap {
  const a = AX[f.axis], toward = f.toward ?? defaultToward(f.axis);
  if (toward === f.axis) throw new FlexError("E-FLEX-AXIS", "The bend direction must be square to the flex axis.");
  const b = AX[toward], c = cross(a, b);
  const o: V3 = f.origin ?? lin([0.5, box[0]], [0.5, box[1]]);
  const lo = dot(box[0], a) - dot(o, a), hi = dot(box[1], a) - dot(o, a);
  const s1 = lo + (f.trim1?.v ?? 0), s2 = hi - (f.trim2?.v ?? 0);
  if (!(s2 - s1 > 1e-6)) throw new FlexError("E-FLEX-TRIM", "The trim planes must leave some length between them.");
  const s0 = Math.min(s2, Math.max(s1, 0));
  const m: FlexMap = { kind: f.kind, o, a, b, c, s1, s2, s0, angle: f.angle.v, factor: f.factor?.v ?? 1, distance: f.distance?.v ?? 0 };
  if (f.kind === "taper" && !(m.factor > 1e-6)) throw new FlexError("E-FLEX-FACTOR", "The taper factor must be more than 0.");
  if (f.kind === "stretch" && !(s2 - s1 + m.distance > 1e-6)) throw new FlexError("E-FLEX-SHORT", "The stretch cannot shorten the region to nothing.");
  return m;
}

/** True when the map does nothing (angle 0, factor 1, distance 0). */
export const flexIdle = (m: FlexMap) => (m.kind === "bend" || m.kind === "twist" ? Math.abs(m.angle) < 1e-12 : m.kind === "taper" ? Math.abs(m.factor - 1) < 1e-12 : Math.abs(m.distance) < 1e-12);

/** Where a point goes. */
export function flexPoint(m: FlexMap, p: V3): V3 {
  const r = lin([1, p], [-1, m.o]);
  const s = dot(r, m.a), u = dot(r, m.b), w = dot(r, m.c);
  const sc = Math.min(m.s2, Math.max(m.s1, s)), L = m.s2 - m.s1, run = s - sc;
  if (m.kind === "bend") {
    if (Math.abs(m.angle) < 1e-12) return p;
    const R = L / m.angle, phi = (sc - m.s0) / R, k = R - u;
    const ta: V3 = lin([Math.cos(phi), m.a], [Math.sin(phi), m.b]);
    return lin([1, m.o], [m.s0, m.a], [R, m.b], [k * Math.sin(phi), m.a], [-k * Math.cos(phi), m.b], [run, ta], [w, m.c]);
  }
  if (m.kind === "twist") {
    const psi = (m.angle * (sc - m.s0)) / L, cs = Math.cos(psi), sn = Math.sin(psi);
    return lin([1, m.o], [s, m.a], [u * cs - w * sn, m.b], [u * sn + w * cs, m.c]);
  }
  if (m.kind === "taper") {
    const k = 1 + ((m.factor - 1) * (sc - m.s1)) / L;
    return lin([1, m.o], [s, m.a], [k * u, m.b], [k * w, m.c]);
  }
  const g = 1 + m.distance / L;
  return lin([1, m.o], [m.s0 + (sc - m.s0) * g + run, m.a], [u, m.b], [w, m.c]);
}

/** The affine map that agrees with `flexPoint` on [s, s + 1] (below the region, above it, or anywhere for a stretch): 3×3 row-major + translation. */
export function flexAffine(m: FlexMap, s: number): { M: number[]; t: V3 } {
  const p0 = lin([1, m.o], [s, m.a]);
  const f0 = flexPoint(m, p0);
  const h = Math.min(1, (m.s2 - m.s1) / 4);
  const cols = [m.a, m.b, m.c].map(e => lin([1 / h, flexPoint(m, lin([1, p0], [h, e]))], [-1 / h, f0]));
  // M = Σ col_k e_kᵀ.
  const M: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M.push(cols[0][i] * m.a[j] + cols[1][i] * m.b[j] + cols[2][i] * m.c[j]);
  const t: V3 = [0, 1, 2].map(i => f0[i] - (M[3 * i] * p0[0] + M[3 * i + 1] * p0[1] + M[3 * i + 2] * p0[2])) as V3;
  return { M, t };
}

/** Is the map affine over the whole region (so pieces there move exactly)? */
export const flexLinear = (m: FlexMap) => m.kind === "stretch" || flexIdle(m);
