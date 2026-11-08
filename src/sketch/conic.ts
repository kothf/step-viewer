// Conics, parabolas and equation-driven curves (FR-SK-021). They are spline entities with a `kind`:
// conic/parabola pts = [start, top vertex, end] (the vertex is where the end tangents meet) and `rho`;
// equation curves pts = [start, end] and `eq`. Their shape becomes cubic Bézier poles like an
// interpolating spline's, so profiles, the kernel and everything else that takes splines takes them.
import type { SkEnt, V2 } from "../model/types";
import { evaluate } from "../model/expr";
import { splineBezier } from "./spline";

type Spline = SkEnt & { t: "spline" };
export type CurveEq = NonNullable<Spline["eq"]>;

/** Point and derivative of the rational quadratic Bézier a, v, b with middle weight w. */
function rq(a: V2, v: V2, b: V2, w: number, t: number): { p: V2; d: V2 } {
  const u = 1 - t;
  const B = [u * u, 2 * w * u * t, t * t], dB = [-2 * u, 2 * w * (1 - 2 * t), 2 * t];
  const D = B[0] + B[1] + B[2], dD = dB[0] + dB[1] + dB[2];
  const N: V2 = [B[0] * a[0] + B[1] * v[0] + B[2] * b[0], B[0] * a[1] + B[1] * v[1] + B[2] * b[1]];
  const dN: V2 = [dB[0] * a[0] + dB[1] * v[0] + dB[2] * b[0], dB[0] * a[1] + dB[1] * v[1] + dB[2] * b[1]];
  return { p: [N[0] / D, N[1] / D], d: [(dN[0] * D - N[0] * dD) / (D * D), (dN[1] * D - N[1] * dD) / (D * D)] };
}

/** Cubic Hermite pieces through samples with derivatives (in the sample parameter), as Bézier poles. */
function hermite(s: { p: V2; d: V2 }[], ts: number[]): V2[] {
  const out: V2[] = [s[0].p];
  for (let i = 0; i + 1 < s.length; i++) {
    const h = (ts[i + 1] - ts[i]) / 3, A = s[i], B = s[i + 1];
    out.push([A.p[0] + A.d[0] * h, A.p[1] + A.d[1] * h], [B.p[0] - B.d[0] * h, B.p[1] - B.d[1] * h], B.p);
  }
  return out;
}

/**
 * Conic from a to b with its end tangents meeting at v; rho = where the shoulder lies on the line from the
 * chord's middle to v (0.5 = parabola, below = ellipse, above = hyperbola). A parabola is exact (one
 * elevated quadratic); other conics are 16 Hermite pieces, within about 1e-7 of the size.
 */
export function conicBezier(a: V2, v: V2, b: V2, rho: number): V2[] {
  const r = Math.min(0.98, Math.max(0.02, rho));
  if (Math.abs(r - 0.5) < 1e-12) {
    const k = 2 / 3;
    return [a, [a[0] + k * (v[0] - a[0]), a[1] + k * (v[1] - a[1])], [b[0] + k * (v[0] - b[0]), b[1] + k * (v[1] - b[1])], b];
  }
  const w = r / (1 - r), n = 16;
  const ts = Array.from({ length: n + 1 }, (_, i) => i / n);
  return hermite(ts.map(t => rq(a, v, b, w, t)), ts);
}

/** Shoulder point of a conic (where rho puts it). */
export function conicShoulder(a: V2, v: V2, b: V2, rho: number): V2 {
  const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [m[0] + rho * (v[0] - m[0]), m[1] + rho * (v[1] - m[1])];
}

/** Rho from a point the conic should pass near: its share along the chord middle → vertex line. */
export function rhoAt(a: V2, v: V2, b: V2, p: V2): number {
  const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u: V2 = [v[0] - m[0], v[1] - m[1]];
  const l2 = u[0] * u[0] + u[1] * u[1];
  if (l2 < 1e-18) return 0.5;
  return Math.min(0.95, Math.max(0.05, ((p[0] - m[0]) * u[0] + (p[1] - m[1]) * u[1]) / l2));
}

/**
 * Parabola with focus f and vertex v, from the point over p0 to the point over p1 (the clicks are
 * moved square to the axis onto the curve). Returns its ends and the tangent meeting point, or null.
 */
export function parabolaFrom(f: V2, v: V2, p0: V2, p1: V2): [V2, V2, V2] | null {
  const fl = Math.hypot(f[0] - v[0], f[1] - v[1]);
  if (fl < 1e-9) return null;
  const u: V2 = [(f[0] - v[0]) / fl, (f[1] - v[1]) / fl], n: V2 = [-u[1], u[0]];
  const at = (s: number, q: number): V2 => [v[0] + n[0] * s + u[0] * q, v[1] + n[1] * s + u[1] * q];
  const s0 = (p0[0] - v[0]) * n[0] + (p0[1] - v[1]) * n[1], s1 = (p1[0] - v[0]) * n[0] + (p1[1] - v[1]) * n[1];
  if (Math.abs(s1 - s0) < fl * 1e-6) return null;
  return [at(s0, (s0 * s0) / (4 * fl)), at((s0 + s1) / 2, (s0 * s1) / (4 * fl)), at(s1, (s1 * s1) / (4 * fl))];
}

/** Evaluates the equation's text with x (explicit) or t (parametric) set; angles in radians, as in SolidWorks. */
function fn(src: string, name: string, vars: Record<string, number>): (x: number) => number {
  const extra = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { v, unit: true }]));
  return (x: number) => evaluate(src, "number", "mm", { ...extra, [name]: { v: x, unit: true } });
}

/** Range of the equation (start, end), in its own units. Throws an ExprError on bad text. */
export function eqRange(eq: CurveEq, vars: Record<string, number> = {}): [number, number] {
  const vv = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { v, unit: true }]));
  return [evaluate(eq.t0, "number", "mm", vv), evaluate(eq.t1, "number", "mm", vv)];
}

/**
 * The equation curve in its own coordinates as Bézier poles: 48 Hermite pieces with numeric
 * derivatives. Throws an ExprError on bad text or values that aren't numbers.
 */
export function eqBezier(eq: CurveEq, vars: Record<string, number> = {}): V2[] {
  const [t0, t1] = eqRange(eq, vars);
  if (!(Math.abs(t1 - t0) > 1e-12)) throw new Error("The range is empty.");
  const name = eq.mode === "xy" ? "x" : "t";
  const fy = fn(eq.y, name, vars), fx = eq.mode === "xy" ? (x: number) => x : fn(eq.x ?? "t", name, vars);
  const n = 48, h = (t1 - t0) * 1e-5;
  const ts = Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n);
  const smp = ts.map(t => {
    const p: V2 = [fx(t), fy(t)];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error("The equation has no value somewhere in its range.");
    const lo = t - h < Math.min(t0, t1) - 1e-15 || t - h > Math.max(t0, t1) + 1e-15 ? t : t - h;
    const hi = t + h > Math.max(t0, t1) + 1e-15 || t + h < Math.min(t0, t1) - 1e-15 ? t : t + h;
    const a: V2 = [fx(lo), fy(lo)], b: V2 = [fx(hi), fy(hi)];
    return { p, d: [(b[0] - a[0]) / (hi - lo), (b[1] - a[1]) / (hi - lo)] as V2 };
  });
  return hermite(smp, ts);
}

/** The similarity that takes the equation's own ends p0 → a and p1 → b (mirrored about the chord when flip). */
function placeBy(p0: V2, p1: V2, a: V2, b: V2, flip: boolean): (q: V2) => V2 {
  const d: V2 = [p1[0] - p0[0], p1[1] - p0[1]], e: V2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (l2 < 1e-18 || Math.hypot(e[0], e[1]) < 1e-12) return q => [q[0] - p0[0] + a[0], q[1] - p0[1] + a[1]];
  // Complex ratio e / d: scale and turn.
  const c = (e[0] * d[0] + e[1] * d[1]) / l2, s = (e[1] * d[0] - e[0] * d[1]) / l2;
  return q => {
    let x = q[0] - p0[0], y = q[1] - p0[1];
    if (flip) { // reflect about the chord direction d
      const ux = d[0] / Math.sqrt(l2), uy = d[1] / Math.sqrt(l2), k = x * ux + y * uy;
      x = 2 * k * ux - x; y = 2 * k * uy - y;
    }
    return [a[0] + c * x - s * y, a[1] + s * x + c * y];
  };
}

/** Bézier poles of a spline entity of any kind, its points given by `pt`. Equation curves follow their two end points. */
export function entBezier(e: Spline, pt: (id: string) => V2, vars: Record<string, number> = {}): V2[] {
  const P = e.pts.map(pt);
  if ((e.kind === "conic" || e.kind === "parabola") && P.length === 3) return conicBezier(P[0], P[1], P[2], e.kind === "parabola" ? 0.5 : e.rho ?? 0.5);
  if (e.kind === "eqn" && e.eq && P.length === 2) {
    try {
      const bz = eqBezier(e.eq, vars);
      const f = placeBy(bz[0], bz[bz.length - 1], P[0], P[1], !!e.eq.flip);
      return bz.map(f);
    } catch { return [P[0], P[0], P[1], P[1]]; }
  }
  return splineBezier(P, !!e.closed && P.length >= 3);
}

/** A conic's exact form: start, top vertex, end and the middle weight rho / (1 - rho); null for other splines. */
export function entConic(e: Spline, pt: (id: string) => V2): [V2, V2, V2, number] | null {
  if ((e.kind !== "conic" && e.kind !== "parabola") || e.pts.length !== 3) return null;
  const r = e.kind === "parabola" ? 0.5 : Math.min(0.98, Math.max(0.02, e.rho ?? 0.5));
  return [pt(e.pts[0]), pt(e.pts[1]), pt(e.pts[2]), r / (1 - r)];
}

/** True for spline entities whose points are not all on the curve (the conic's top vertex). */
export const hasControl = (e: SkEnt) => e.t === "spline" && (e.kind === "conic" || e.kind === "parabola");
