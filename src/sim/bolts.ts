// Structural analysis of assemblies (FR-CON-020): bolts found from the fasteners placed in an assembly.
// A screw with what sits on its axis (a nut, washers) is one bolt: the patch of the clamped component under
// its head, and the patch the nut presses on, or the wall of the tapped hole it is screwed into. The patches
// are the pieces of the other components' surfaces that lie on the fasteners, found as connections are.

import { findConnections } from "./connect";

export interface FastenerBody {
  /** Index in the bodies. */
  body: number;
  kind: "screw" | "nut" | "washer";
  /** Thread diameter and pitch, mm. */
  d: number;
  pitch: number;
  /** A point on the axis (the seat) and the axis as a unit vector pointing out of the hole on the head's side. */
  o: number[];
  z: number[];
}

export interface FoundBolt {
  /** The screw's body, and every body of the bolt (the screw, its nut and washers). */
  screw: number;
  members: number[];
  /** Patch under the head and patch of the nut or thread (triangles, 9 numbers each), and the bodies they are on. */
  a: Float64Array; b: Float64Array;
  ia: number; ib: number;
  /** Screwed into a tapped hole (no nut). */
  tapped: boolean;
  d: number;
  pitch: number;
}

/** Tensile stress area of a thread, mm². */
export const stressArea = (d: number, pitch: number) => (Math.PI / 4) * (d - 0.9382 * pitch) ** 2;

/**
 * What a bolt bears beside its proof stress `sp` (MPa): the equivalent stress on the stress area of the
 * tension with the bending moment (on the stress area's diameter) and the shear, and the safety factor.
 */
export function boltCheck(r: { axial: number; shear: number; moment: number; torsion?: number }, d: number, pitch: number, sp: number) {
  const As = stressArea(d, pitch), ds = Math.sqrt((4 * As) / Math.PI), Z = (Math.PI * ds ** 3) / 32;
  const sigma = Math.max(0, r.axial) / As + r.moment / Z, tau = r.shear / As + (r.torsion ?? 0) / (2 * Z);
  const eq = Math.sqrt(sigma * sigma + 3 * tau * tau);
  return { area: As, sigma, tau, eq, sf: eq > 0 ? sp / eq : Infinity };
}

interface Piece { body: number; t: Float64Array; n: number[]; c: number[]; area: number }

/** The bolts among `bodies` (closed triangle soups in one coordinate system); `missed` = screws that are not one. */
export function findBolts(bodies: ArrayLike<number>[], fast: FastenerBody[], gap = 0.05): { bolts: FoundBolt[]; missed: { screw: number; why: "head" | "nut" | "thread" }[] } {
  const isF = new Set(fast.map(f => f.body));
  const screws = fast.filter(f => f.kind === "screw");
  if (!screws.length) return { bolts: [], missed: [] };
  const conns = findConnections(bodies, gap, (a, b) => isF.has(a) !== isF.has(b));
  // the pieces of the other bodies' surfaces lying on each fastener
  const on = new Map<number, Piece[]>();
  for (const c of conns) {
    const fa = isF.has(c.a), f = fa ? c.a : c.b, other = fa ? c.b : c.a, P = fa ? c.pb : c.pa;
    let list = on.get(f);
    if (!list) { list = []; on.set(f, list); }
    for (let o = 0; o + 8 < P.length; o += 9) {
      const e1 = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]], e2 = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(n[0], n[1], n[2]);
      if (!(l > 1e-12)) continue;
      list.push({ body: other, t: Float64Array.from(P.subarray(o, o + 9)), n: n.map(v => v / l), c: [(P[o] + P[o + 3] + P[o + 6]) / 3, (P[o + 1] + P[o + 4] + P[o + 7]) / 3, (P[o + 2] + P[o + 5] + P[o + 8]) / 3], area: l / 2 });
    }
  }
  const taken = new Set<number>();
  const bolts: FoundBolt[] = [], missed: { screw: number; why: "head" | "nut" | "thread" }[] = [];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const s of screws) {
    const z = s.z, along = (p: ArrayLike<number>, o = 0) => (p[o] - s.o[0]) * z[0] + (p[o + 1] - s.o[1]) * z[1] + (p[o + 2] - s.o[2]) * z[2];
    // how far the screw reaches along its axis
    let tmin = Infinity, tmax = -Infinity;
    const T = bodies[s.body];
    for (let o = 0; o + 2 < T.length; o += 3) { const t = along(T, o); if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    // nuts and washers on the same axis
    const stack = fast.filter(f => {
      if (f.kind === "screw" || taken.has(f.body) || Math.abs(dot(f.z, z)) < 0.99) return false;
      const t = along(f.o), r = Math.hypot(f.o[0] - s.o[0] - t * z[0], f.o[1] - s.o[1] - t * z[1], f.o[2] - s.o[2] - t * z[2]);
      return r < 0.3 * s.d && t > tmin - 2 * s.d && t < tmax + s.d;
    });
    const nuts = stack.filter(f => f.kind === "nut").sort((p, q) => along(p.o) - along(q.o)), nut = nuts[0];
    const tn = nut ? along(nut.o) : -Infinity;
    const headSide = (f: FastenerBody) => !nut || Math.abs(along(f.o)) < Math.abs(along(f.o) - tn);
    const washers = stack.filter(f => f.kind === "washer");
    const pick = (from: number[], ok: (p: Piece) => boolean, not = -1) => {
      const by = new Map<number, Piece[]>();
      for (const f of from) for (const p of on.get(f) ?? []) if (p.body !== not && ok(p)) { const l = by.get(p.body); if (l) l.push(p); else by.set(p.body, [p]); }
      let best = -1, area = 0;
      for (const [b, l] of by) { const a = l.reduce((v, p) => v + p.area, 0); if (a > area) { area = a; best = b; } }
      if (best < 0) return null;
      const l = by.get(best)!, out = new Float64Array(9 * l.length);
      l.forEach((p, i) => out.set(p.t, 9 * i));
      return { body: best, tris: out };
    };
    // under the head: faces looking up at it, near the seat
    const low = -1.2 * s.d - washers.filter(headSide).length * 0.3 * s.d;
    const head = pick([s.body, ...washers.filter(headSide).map(f => f.body)], p => dot(p.n, z) > 0.3 && along(p.c) > low);
    if (!head) { missed.push({ screw: s.body, why: "head" }); continue; }
    // the other end: faces the nut presses on, looking away from the head; else the wall of the tapped hole
    const far = nut
      ? pick([nut.body, ...washers.filter(f => !headSide(f)).map(f => f.body)], p => dot(p.n, z) < -0.3)
      : pick([s.body], p => Math.abs(dot(p.n, z)) < 0.3, head.body);
    if (!far) { missed.push({ screw: s.body, why: nut ? "nut" : "thread" }); continue; }
    const members = [s.body, ...(nut ? [nut.body] : []), ...washers.map(f => f.body)];
    for (const m of members) taken.add(m);
    bolts.push({ screw: s.body, members, a: head.tris, b: far.tris, ia: head.body, ib: far.body, tapped: !nut, d: s.d, pitch: s.pitch });
  }
  return { bolts, missed };
}
