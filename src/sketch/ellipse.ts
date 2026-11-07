// Ellipse geometry shared by the sketcher, the solver and profiles (FR-SK-018).
// An ellipse is its centre c, the unit direction u of its first axis (towards
// point a), the radius r1 along u and r2 square to it (towards point b).
// Parameter t gives c + u·r1·cos t + n·r2·sin t, with n = u turned +90°.
import type { V2 } from "../model/types";

export interface Ell { c: V2; u: V2; r1: number; r2: number }

/** The ellipse through its centre, axis end a and other-axis point b (b's distance from the a-axis is r2). */
export function ellOf(c: V2, a: V2, b: V2): Ell {
  const dx = a[0] - c[0], dy = a[1] - c[1];
  const r1 = Math.hypot(dx, dy) || 1e-12;
  const u: V2 = [dx / r1, dy / r1];
  const r2 = Math.abs(u[0] * (b[1] - c[1]) - u[1] * (b[0] - c[0])) || 1e-12;
  return { c, u, r1, r2 };
}

export function ellPt(E: Ell, t: number): V2 {
  const x = E.r1 * Math.cos(t), y = E.r2 * Math.sin(t);
  return [E.c[0] + E.u[0] * x - E.u[1] * y, E.c[1] + E.u[1] * x + E.u[0] * y];
}

/** Local coordinates of p (along u, along n). */
export function ellLocal(E: Ell, p: V2): V2 {
  const dx = p[0] - E.c[0], dy = p[1] - E.c[1];
  return [dx * E.u[0] + dy * E.u[1], -dx * E.u[1] + dy * E.u[0]];
}

/** Parameter of the point of the ellipse closest to p (a few Newton steps from the eccentric angle). */
export function ellParam(E: Ell, p: V2): number {
  const [x, y] = ellLocal(E, p);
  let t = Math.atan2(y / E.r2, x / E.r1);
  for (let k = 0; k < 8; k++) {
    const c = Math.cos(t), s = Math.sin(t);
    const ex = E.r1 * c, ey = E.r2 * s, dx = -E.r1 * s, dy = E.r2 * c;
    const f = (ex - x) * dx + (ey - y) * dy;
    const df = dx * dx + dy * dy + (ex - x) * -ex + (ey - y) * -ey;
    if (Math.abs(df) < 1e-18) break;
    const step = f / df;
    t -= Math.max(-0.5, Math.min(0.5, step));
    if (Math.abs(step) < 1e-12) break;
  }
  return t;
}

/** Distance from p to the whole ellipse. */
export function ellDist(E: Ell, p: V2): number {
  const q = ellPt(E, ellParam(E, p));
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/** Counter-clockwise sweep from parameter t0 to t1, in (0, 2π]. */
export function ellSweep(t0: number, t1: number): number {
  let s = t1 - t0;
  while (s <= 1e-12) s += 2 * Math.PI;
  while (s > 2 * Math.PI + 1e-12) s -= 2 * Math.PI;
  return s;
}

/** Points along the ellipse from t0 sweeping by `sweep` (n + 1 points). */
export function ellPts(E: Ell, t0 = 0, sweep = 2 * Math.PI, n = 72): V2[] {
  return Array.from({ length: n + 1 }, (_, i) => ellPt(E, t0 + (sweep * i) / n));
}

/** Distance from p to an elliptical arc from p0 counter-clockwise to p1. */
export function earcDist(E: Ell, p0: V2, p1: V2, p: V2): number {
  const t0 = ellParam(E, p0), sw = ellSweep(t0, ellParam(E, p1));
  const t = ellParam(E, p);
  if (ellSweep(t0, t) <= sw + 1e-9 || Math.abs(ellSweep(t0, t) - 2 * Math.PI) < 1e-9) return ellDist(E, p);
  return Math.min(Math.hypot(p[0] - p0[0], p[1] - p0[1]), Math.hypot(p[0] - p1[0], p[1] - p1[1]));
}

/** Area of the full ellipse. */
export const ellArea = (E: Ell) => Math.PI * E.r1 * E.r2;
