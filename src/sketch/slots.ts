// Arc slots (FR-SK-017): the geometry behind the Centerpoint Arc Slot and 3-Point Arc Slot tools.
import type { SkEnt, SkRel } from "../model/types";

type V2 = [number, number];

const TAU = Math.PI * 2;
const ang = (o: V2, p: V2) => Math.atan2(p[1] - o[1], p[0] - o[0]);
/** Counter-clockwise sweep from angle a0 to a1, in (0, 2π]. */
const ccwSweep = (a0: number, a1: number) => { let x = a1 - a0; while (x <= 1e-12) x += TAU; while (x > TAU) x -= TAU; return x; };

/** The arc slot's centre line: centre, radius, start and end centres (counter-clockwise from c1 to c2). */
export interface ArcSlotAxis { o: V2; r: number; c1: V2; c2: V2; /** the clicked start and end were swapped to make it counter-clockwise */ swapped: boolean }

/** Centerpoint arc slot: centre o, the start centre s (sets the radius), the end e projected onto that circle. */
export function centreArcAxis(o: V2, s: V2, e: V2): ArcSlotAxis | null {
  const r = Math.hypot(s[0] - o[0], s[1] - o[1]);
  if (r < 1e-9 || Math.hypot(e[0] - o[0], e[1] - o[1]) < 1e-9) return null;
  const a1 = ang(o, e);
  const c2: V2 = [o[0] + r * Math.cos(a1), o[1] + r * Math.sin(a1)];
  if (Math.hypot(c2[0] - s[0], c2[1] - s[1]) < r * 1e-6) return null;
  return { o, r, c1: s, c2, swapped: false };
}

/** 3-point arc slot: start and end centres and a point the centre line passes through. */
export function threePointArcAxis(a: V2, b: V2, p: V2): ArcSlotAxis | null {
  const d = 2 * (a[0] * (b[1] - p[1]) + b[0] * (p[1] - a[1]) + p[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const s = (q: V2) => q[0] * q[0] + q[1] * q[1];
  const o: V2 = [
    (s(a) * (b[1] - p[1]) + s(b) * (p[1] - a[1]) + s(p) * (a[1] - b[1])) / d,
    (s(a) * (p[0] - b[0]) + s(b) * (a[0] - p[0]) + s(p) * (b[0] - a[0])) / d,
  ];
  const r = Math.hypot(a[0] - o[0], a[1] - o[1]);
  // Counter-clockwise from a to b through p; otherwise the other way round.
  const ccw = ccwSweep(ang(o, a), ang(o, p)) < ccwSweep(ang(o, a), ang(o, b));
  return ccw ? { o, r, c1: a, c2: b, swapped: false } : { o, r, c1: b, c2: a, swapped: true };
}

/** Half-width for a cursor at p: its distance from the centre line circle, below the radius. */
export function arcSlotHalfWidth(ax: ArcSlotAxis, p: V2): number {
  const w = Math.abs(Math.hypot(p[0] - ax.o[0], p[1] - ax.o[1]) - ax.r);
  return Math.min(w, ax.r * 0.999);
}

/** Corner points: outer and inner at each end. */
export function arcSlotCorners(ax: ArcSlotAxis, w: number) {
  const at = (c: V2, k: number): V2 => {
    const u = [c[0] - ax.o[0], c[1] - ax.o[1]], l = Math.hypot(u[0], u[1]);
    return [c[0] + (u[0] / l) * w * k, c[1] + (u[1] / l) * w * k];
  };
  return { o1: at(ax.c1, 1), o2: at(ax.c2, 1), i1: at(ax.c1, -1), i2: at(ax.c2, -1) };
}

const arcPts = (c: V2, r: number, a0: number, sweep: number, n = 48): V2[] =>
  Array.from({ length: n + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + (sweep * i) / n), c[1] + r * Math.sin(a0 + (sweep * i) / n)] as V2);

/** Outline of the slot as polylines (centre line last), for the live preview. */
export function arcSlotOutline(ax: ArcSlotAxis, w: number): V2[][] {
  const a0 = ang(ax.o, ax.c1), sw = ccwSweep(a0, ang(ax.o, ax.c2));
  const out: V2[][] = [];
  if (w > 1e-9) {
    out.push(arcPts(ax.o, ax.r + w, a0, sw), arcPts(ax.o, ax.r - w, a0, sw));
    // Caps: round the far end beyond c2, round the near end before c1.
    out.push(arcPts(ax.c2, w, a0 + sw, Math.PI, 24), arcPts(ax.c1, w, a0 + Math.PI, Math.PI, 24));
  }
  out.push(arcPts(ax.o, ax.r, a0, sw));
  return out;
}

/**
 * Curves and relations of an arc slot on existing point ids: a construction centre-line arc, outer and inner
 * arcs on the same centre, and two end arcs round its ends, tangent to both (internally to the outer one)
 * and equal. Ids: o centre, c1/c2 centre-line ends, o1/o2 outer ends, i1/i2 inner ends.
 */
export function arcSlotEnts(p: { o: string; c1: string; c2: string; o1: string; o2: string; i1: string; i2: string }, uid: (k: string) => string) {
  const centre = uid("a"), outer = uid("a"), inner = uid("a"), cap1 = uid("a"), cap2 = uid("a");
  const ents: SkEnt[] = [
    { id: centre, t: "arc", c: p.o, a: p.c1, b: p.c2, cons: true },
    { id: outer, t: "arc", c: p.o, a: p.o1, b: p.o2 }, { id: inner, t: "arc", c: p.o, a: p.i1, b: p.i2 },
    // Counter-clockwise: round the far end from outer to inner, round the near end from inner to outer.
    { id: cap2, t: "arc", c: p.c2, a: p.o2, b: p.i2 }, { id: cap1, t: "arc", c: p.c1, a: p.i1, b: p.o1 },
  ];
  const rels: SkRel[] = [
    { id: uid("r"), t: "tangent", e: [outer, cap1], inner: true }, { id: uid("r"), t: "tangent", e: [outer, cap2], inner: true },
    { id: uid("r"), t: "tangent", e: [inner, cap1] }, { id: uid("r"), t: "tangent", e: [inner, cap2] },
    { id: uid("r"), t: "equal", e: [cap1, cap2] },
  ];
  return { ents, rels, centre, cap1, cap2, outer, inner };
}
