/**
 * Quick snaps and snap preferences (FR-SK-046): the snap types, and the pure geometry behind the ones the
 * automatic snapping did not have (midpoints, quadrants, intersections, tangent and perpendicular points).
 */
import type { V2 } from "../model/types";

export type SnapKind = "end" | "mid" | "centre" | "quadrant" | "intersection" | "tangent" | "perpendicular" | "parallel" | "nearest" | "hv";

/** Snap types in menu order, with their English labels (keys for `t`). */
export const SNAP_KINDS: [SnapKind, string][] = [
  ["end", "End point"], ["mid", "Midpoint"], ["centre", "Centre point"], ["quadrant", "Quadrant point"],
  ["intersection", "Intersection"], ["tangent", "Tangent"], ["perpendicular", "Perpendicular"], ["parallel", "Parallel"],
  ["nearest", "Nearest"], ["hv", "Horizontal/vertical"],
];

/** Snaps on while drawing until the user turns one off; midpoints, quadrants and intersections are opt-in. */
export const DEFAULT_SNAPS: SnapKind[] = ["end", "centre", "tangent", "perpendicular", "parallel", "nearest", "hv"];

/** The snaps stored in localStorage `mc:skSnaps` (a JSON list), or the defaults. */
export function parseSnaps(s: string | null): Set<SnapKind> {
  if (!s) return new Set(DEFAULT_SNAPS);
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return new Set(v.filter((k): k is SnapKind => SNAP_KINDS.some(([x]) => x === k)));
  } catch { /* bad value: defaults */ }
  return new Set(DEFAULT_SNAPS);
}

/** A sketch curve for snapping: a segment, or a circle (an arc has its ccw span from `a0` through `sw`). */
export type SnapCurve = { id: string; k: "l"; a: V2; b: V2 } | { id: string; k: "c"; c: V2; r: number; a0?: number; sw?: number };

const TAU = Math.PI * 2;

/** Is the direction at angle `ang` inside the arc's span (always for a full circle)? */
export function inSpan(cv: SnapCurve & { k: "c" }, ang: number, tol = 1e-9): boolean {
  if (cv.a0 === undefined || cv.sw === undefined) return true;
  let d = (ang - cv.a0) % TAU;
  if (d < 0) d += TAU;
  return d <= cv.sw + tol || d >= TAU - tol;
}

/** Arc from centre `c`, start `a`, end `b`, counter-clockwise. */
export function arcCurve(id: string, c: V2, a: V2, b: V2): SnapCurve {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let sw = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
  while (sw <= 0) sw += TAU;
  return { id, k: "c", c, r, a0, sw };
}

/** The quadrant points (0°, 90°, 180°, 270°) of a circle, or those inside an arc. */
export function quadrants(cv: SnapCurve & { k: "c" }): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    if (inSpan(cv, a, 1e-7)) out.push([cv.c[0] + cv.r * Math.cos(a), cv.c[1] + cv.r * Math.sin(a)]);
  }
  return out;
}

/** Where two curves cross (segments and arcs only within their ends). */
export function intersections(p: SnapCurve, q: SnapCurve): V2[] {
  const eps = 1e-9;
  const onSeg = (s: SnapCurve & { k: "l" }, x: V2) => {
    const u: V2 = [s.b[0] - s.a[0], s.b[1] - s.a[1]], l2 = u[0] * u[0] + u[1] * u[1];
    if (l2 < eps) return false;
    const tt = ((x[0] - s.a[0]) * u[0] + (x[1] - s.a[1]) * u[1]) / l2;
    return tt >= -1e-7 && tt <= 1 + 1e-7;
  };
  const ok = (c: SnapCurve, x: V2) => c.k === "l" ? onSeg(c, x) : inSpan(c, Math.atan2(x[1] - c.c[1], x[0] - c.c[0]), 1e-7);
  let pts: V2[] = [];
  if (p.k === "l" && q.k === "l") {
    const d1: V2 = [p.b[0] - p.a[0], p.b[1] - p.a[1]], d2: V2 = [q.b[0] - q.a[0], q.b[1] - q.a[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < eps * Math.hypot(...d1) * Math.hypot(...d2) + 1e-15) return [];
    const s = ((q.a[0] - p.a[0]) * d2[1] - (q.a[1] - p.a[1]) * d2[0]) / den;
    pts = [[p.a[0] + d1[0] * s, p.a[1] + d1[1] * s]];
  } else if (p.k === "c" && q.k === "c") {
    const dx = q.c[0] - p.c[0], dy = q.c[1] - p.c[1], d = Math.hypot(dx, dy);
    if (d < eps || d > p.r + q.r + 1e-9 || d < Math.abs(p.r - q.r) - 1e-9) return [];
    const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
    const m: V2 = [p.c[0] + (dx * a) / d, p.c[1] + (dy * a) / d];
    pts = h < 1e-12 ? [m] : [[m[0] - (dy * h) / d, m[1] + (dx * h) / d], [m[0] + (dy * h) / d, m[1] - (dx * h) / d]];
  } else {
    const l = (p.k === "l" ? p : q) as SnapCurve & { k: "l" }, c = (p.k === "c" ? p : q) as SnapCurve & { k: "c" };
    const u: V2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]], L = Math.hypot(u[0], u[1]);
    if (L < eps) return [];
    const n: V2 = [u[0] / L, u[1] / L];
    const tt = (c.c[0] - l.a[0]) * n[0] + (c.c[1] - l.a[1]) * n[1];
    const f: V2 = [l.a[0] + n[0] * tt, l.a[1] + n[1] * tt];
    const dd = Math.hypot(c.c[0] - f[0], c.c[1] - f[1]);
    if (dd > c.r + 1e-9) return [];
    const h = Math.sqrt(Math.max(0, c.r * c.r - dd * dd));
    pts = h < 1e-12 ? [f] : [[f[0] - n[0] * h, f[1] - n[1] * h], [f[0] + n[0] * h, f[1] + n[1] * h]];
  }
  return pts.filter(x => ok(p, x) && ok(q, x));
}

/** The points of a circle (or arc) where a line from `from` touches it; none when `from` is inside. */
export function tangentPoints(from: V2, cv: SnapCurve & { k: "c" }): V2[] {
  const dx = from[0] - cv.c[0], dy = from[1] - cv.c[1], d = Math.hypot(dx, dy);
  if (d <= cv.r * (1 + 1e-9)) return [];
  const base = Math.atan2(dy, dx), off = Math.acos(cv.r / d);
  return [base + off, base - off].filter(a => inSpan(cv, a, 1e-7)).map(a => [cv.c[0] + cv.r * Math.cos(a), cv.c[1] + cv.r * Math.sin(a)] as V2);
}

/** The foot of the perpendicular from `from` onto the (infinite) line through a segment, or null when `from` is on it. */
export function perpendicularFoot(from: V2, l: SnapCurve & { k: "l" }): V2 | null {
  const u: V2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]], l2 = u[0] * u[0] + u[1] * u[1];
  if (l2 < 1e-18) return null;
  const tt = ((from[0] - l.a[0]) * u[0] + (from[1] - l.a[1]) * u[1]) / l2;
  const f: V2 = [l.a[0] + u[0] * tt, l.a[1] + u[1] * tt];
  return Math.hypot(f[0] - from[0], f[1] - from[1]) < 1e-9 * Math.sqrt(l2) ? null : f;
}
