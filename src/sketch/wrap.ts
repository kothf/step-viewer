// Sketch curves as exact 2D B-splines, so an affine map of their poles (Wrap, FR-FT-104) moves them
// exactly: lines are degree 1, circles/arcs/ellipses rational quadratics in quarter turns, splines
// their cubic Bézier chain (or a conic's rational quadratic, a style spline's own B-spline).
import type { V2 } from "../model/types";
import type { Seg } from "./profile";
import { ellParam, ellSweep, type Ell } from "./ellipse";

/** A clamped (rational) B-spline in 2D: poles, weights, distinct knots with multiplicities. */
export interface Spline2 { deg: number; poles: V2[]; w: number[]; knots: number[]; mults: number[] }

/** The curve c + U·cos t + V·sin t from t0 over `sweep` as rational quadratic pieces of at most 90°. */
function conicArc(c: V2, U: V2, V: V2, t0: number, sweep: number): Spline2 {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const P = (t: number, k = 1): V2 => [c[0] + (U[0] * Math.cos(t) + V[0] * Math.sin(t)) * k, c[1] + (U[1] * Math.cos(t) + V[1] * Math.sin(t)) * k];
  const d = sweep / n, wm = Math.cos(d / 2);
  const poles: V2[] = [P(t0)], w = [1], knots = [0], mults = [3];
  for (let i = 0; i < n; i++) {
    const a = t0 + i * d;
    poles.push(P(a + d / 2, 1 / wm), P(a + d));
    w.push(wm, 1);
    knots.push(i + 1);
    mults.push(i === n - 1 ? 3 : 2);
  }
  return { deg: 2, poles, w, knots, mults };
}

const ellUV = (E: Ell): [V2, V2] => [[E.u[0] * E.r1, E.u[1] * E.r1], [-E.u[1] * E.r2, E.u[0] * E.r2]];

/** One sketch segment as an exact 2D B-spline in the direction of travel. */
export function segSpline(s: Seg): Spline2 {
  if (s.kind === "line") return { deg: 1, poles: [s.a, s.b], w: [1, 1], knots: [0, 1], mults: [2, 2] };
  if (s.kind === "circle") return conicArc(s.c, [s.r, 0], [0, s.r], 0, 2 * Math.PI);
  if (s.kind === "arc") {
    const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
    const sw = s.ccw ? ellSweep(a0, a1) : -ellSweep(a1, a0);
    return conicArc(s.c, [s.r, 0], [0, s.r], a0, sw);
  }
  if (s.kind === "ellipse") { const [U, V] = ellUV(s.el); return conicArc(s.el.c, U, V, 0, 2 * Math.PI); }
  if (s.kind === "earc") {
    const [U, V] = ellUV(s.el), ta = ellParam(s.el, s.a), tb = ellParam(s.el, s.b);
    return conicArc(s.el.c, U, V, ta, s.ccw ? ellSweep(ta, tb) : -ellSweep(tb, ta));
  }
  if (s.rq) { const [a, v, b, wt] = s.rq; return { deg: 2, poles: [a, v, b], w: [1, wt, 1], knots: [0, 1], mults: [3, 3] }; }
  if (s.bs) return { deg: s.bs.deg, poles: s.bs.poles, w: s.bs.poles.map(() => 1), knots: s.bs.knots, mults: s.bs.mults };
  // Cubic Bézier chain: knots at whole numbers, C0 joins (the chain is C2 by construction anyway).
  const n = (s.bz.length - 1) / 3;
  return { deg: 3, poles: s.bz, w: s.bz.map(() => 1), knots: Array.from({ length: n + 1 }, (_, i) => i), mults: Array.from({ length: n + 1 }, (_, i) => (i === 0 || i === n ? 4 : 3)) };
}
