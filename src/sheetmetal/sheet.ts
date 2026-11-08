// Sheet metal model (FR-FT-120), pure geometry with no kernel.
//
// The sheet is a set of flat panels joined by bends. Every panel is a 2D outline in one shared
// flat-pattern plane (the "flat" coordinates) plus a rigid transform M that carries the flat
// coordinates to where the panel sits once folded; a panel occupies z ∈ [0, T] in its own frame.
// A bend is a strip of the flat pattern, as wide as its bend allowance, rolled round an axis.
// So folding is M, and unfolding is just dropping it: the flat pattern is the union of the
// outlines, which is why it comes out exact, with bend lines and K-factor, without unrolling
// any faces.
//
// Face names: a panel's faces are `<panel>:top`, `<panel>:bot` and `<panel>:<edge id>` for its
// sides; a bend's `<bend>:in`, `:out`, `:s0`, `:s1`, `:start`, `:end`. Panel ids are
// `<feature id>:p<n>` and bend ids `<feature id>:b<n>`, so a picked edge between `…:top` and
// `…:<edge>` says which panel edge it is without looking at geometry.
import type { Frame, SketchFeature, V2, V3 } from "../model/types";
import { inPolygon, loopPolygon, polyArea, sketchPath, sketchProfile, type Seg } from "../sketch/profile";
import type { BendCalc, BendPosition, SmBaseFeature, SmFlangeFeature, SmHemFeature, SmJogFeature, SmSketchBendFeature, SmTabFeature } from "./types";

export class SheetError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A rigid transform: x, y, z are where the unit axes go, o where the origin goes. */
export interface Mat { o: V3; x: V3; y: V3; z: V3 }

export interface Panel {
  id: string;
  /** Counter-clockwise outer loop and clockwise holes, in flat coordinates; `ent` is the edge id. */
  outer: Seg[];
  holes: Seg[][];
  M: Mat;
  /** Edge ids handed out so far (new edges are `x<n>`). */
  n: number;
}

export interface Bend {
  id: string;
  /** The bend's strip in the flat pattern starts on the line a0 → a1 and runs `ba` along o = (e.y, -e.x). */
  a0: V2; a1: V2; ba: number;
  /** Bends towards the panel's top (+z) face. */
  up: boolean;
  angle: number;
  /** Inside radius. */
  r: number;
  /** The transform of the panel the bend starts from. */
  M: Mat;
}

export interface SheetState {
  T: number;
  R: number;
  calc: BendCalc;
  k: number;
  ba?: number;
  bd?: number;
  relief: "rect" | "obround" | "none";
  reliefRatio: number;
  /** Where the flat pattern lies: the first panel's transform. */
  root: Mat;
  panels: Panel[];
  bends: Bend[];
  /** Panel faces (`<panel>:<edge>`) that already carry a flange. */
  used: string[];
  /** Set by the Flat-Pattern feature when later features cut the sheet: the pattern's real outline. */
  flatEdges?: FlatEdge[];
}

/** A piece of the flat pattern's outline (arcs counter-clockwise from a0 to a1, as DXF draws them). */
export type FlatEdge =
  | { kind: "line"; a: V2; b: V2 }
  | { kind: "circle"; c: V2; r: number }
  | { kind: "arc"; c: V2; r: number; a0: number; a1: number }
  | { kind: "poly"; pts: V2[] };

/** What a sheet metal feature does to the solid: cut prisms (panel frame, z across the sheet), then new panels and bends. */
export type SheetOp =
  | { kind: "cut"; M: Mat; loop: V2[] }
  | { kind: "panel"; panel: Panel }
  | { kind: "bend"; bend: Bend };

// ---------- small vector helpers ----------

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const p2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const s2 = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const d2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** M applied to a point. */
export function apply(M: Mat, p: V3): V3 { return add(add(add(M.o, mul(M.x, p[0])), mul(M.y, p[1])), mul(M.z, p[2])); }
/** M applied to a direction. */
export function applyDir(M: Mat, d: V3): V3 { return add(add(mul(M.x, d[0]), mul(M.y, d[1])), mul(M.z, d[2])); }
/** M ∘ N: first N, then M. */
export function compose(M: Mat, N: Mat): Mat { return { o: apply(M, N.o), x: applyDir(M, N.x), y: applyDir(M, N.y), z: applyDir(M, N.z) }; }
/** The frame a sketch plane gives: flat x, y in the plane and z along its normal. */
export const matOf = (f: Frame, zShift = 0): Mat => ({ o: add(f.o, mul(f.n, zShift)), x: f.x, y: f.y, z: f.n });
const rodrigues = (v: V3, u: V3, a: number): V3 => {
  const c = Math.cos(a), s = Math.sin(a), k = dot(u, v) * (1 - c), w = cross(u, v);
  return [v[0] * c + w[0] * s + u[0] * k, v[1] * c + w[1] * s + u[1] * k, v[2] * c + w[2] * s + u[2] * k];
};
/** Rotation by angle a about the axis through c along the unit direction u. */
function rotation(c: V3, u: V3, a: number): Mat {
  const r = (v: V3) => rodrigues(v, u, a);
  return { o: add(c, r(mul(c, -1))), x: r([1, 0, 0]), y: r([0, 1, 0]), z: r([0, 0, 1]) };
}
const translation = (t: V3): Mat => ({ o: t, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });

// ---------- bend arithmetic ----------

/** Bend allowance: the flat length a bend of `angle` and inside radius `r` takes. */
export function bendAllowance(s: Pick<SheetState, "T" | "calc" | "k" | "ba" | "bd">, angle: number, r: number): number {
  if (s.calc === "ba") return s.ba ?? 0;
  if (s.calc === "bd") return 2 * outerSetback(s.T, angle, r) - (s.bd ?? 0);
  return angle * (r + s.k * s.T);
}
/** Outside setback: from the outer virtual sharp to the bend's start (past 90°, to the tangent). */
export const outerSetback = (T: number, angle: number, r: number) => (angle <= Math.PI / 2 + 1e-12 ? Math.tan(angle / 2) : 1) * (r + T);
const innerSetback = (angle: number, r: number) => (angle <= Math.PI / 2 + 1e-12 ? Math.tan(angle / 2) : 1) * r;

/**
 * A bend on the panel transform M, starting on the flat line a0 → a1 and running towards o = (e.y, -e.x):
 * the bend, and the transform of what comes after it in the flat pattern (the next panel).
 */
function makeBend(st: SheetState, M: Mat, a0: V2, a1: V2, up: boolean, angle: number, r: number, id: string): { bend: Bend; next: Mat } {
  const e = s2([a1[0] - a0[0], a1[1] - a0[1]], 1 / d2(a0, a1));
  const o: V3 = [e[1], -e[0], 0];
  const ba = bendAllowance(st, angle, r);
  if (!(ba > 1e-9)) throw new SheetError("E-SM-BA", "The bend allowance must be more than 0.");
  // Up: the axis is r above the top face and turning about -e lifts o towards +z; down: r below the bottom, about +e.
  const c: V3 = [a0[0], a0[1], up ? st.T + r : -r];
  const G = compose(rotation(c, up ? [-e[0], -e[1], 0] : [e[0], e[1], 0], angle), translation(mul(o, -ba)));
  return { bend: { id, a0, a1, ba, up, angle, r, M }, next: compose(M, G) };
}

// ---------- outlines ----------

const line = (ent: string, a: V2, b: V2): Seg => ({ ent, kind: "line", a, b });
/** Line segments through the points in order, closing the loop, made counter-clockwise. */
function polyLoop(pts: V2[], ids: string[]): Seg[] {
  const segs = pts.map((p, i) => line(ids[i], p, pts[(i + 1) % pts.length]));
  return polyArea(pts) >= 0 ? segs : reverseLoop(segs);
}
export function reverseLoop(loop: Seg[]): Seg[] {
  return [...loop].reverse().map(s => s.kind === "line" ? { ...s, a: s.b, b: s.a } : s.kind === "arc" ? { ...s, a: s.b, b: s.a, ccw: !s.ccw } : s);
}
const oriented = (loop: Seg[], ccw: boolean) => (polyArea(loopPolygon(loop)) > 0) === ccw ? loop : reverseLoop(loop);

/** The rectangle between the flat lines p0 → p1 and the same line moved by `w` along o, counter-clockwise. */
function strip(p0: V2, p1: V2, o: V2, w: number, ids: [string, string, string, string]): Seg[] {
  // p0, p0 + w·o, p1 + w·o, p1 runs counter-clockwise when o is to the right of p0 → p1.
  const q0 = p2(p0, s2(o, w)), q1 = p2(p1, s2(o, w));
  return polyLoop([p0, q0, q1, p1], ids);
}

// ---------- features ----------

function startState(f: SmBaseFeature, root: Mat): SheetState {
  const T = f.thickness.v, R = f.radius.v;
  if (!(T > 1e-6)) throw new SheetError("E-SM-T", "The thickness must be more than 0.");
  if (!(R >= 0)) throw new SheetError("E-SM-R", "The bend radius can't be negative.");
  const k = f.k ?? 0.5;
  if (!(k >= 0 && k <= 1)) throw new SheetError("E-SM-K", "The K-factor must be between 0 and 1.");
  return { T, R, calc: f.calc ?? "k", k, ba: f.ba?.v, bd: f.bd?.v, relief: f.relief ?? "rect", reliefRatio: f.reliefRatio ?? 0.5, root, panels: [], bends: [], used: [] };
}

/** Base flange: a flat plate from a closed sketch, or a bent strip from an open chain of lines. */
export function baseFlange(f: SmBaseFeature, sk: SketchFeature, frame: Frame): { state: SheetState; ops: SheetOp[] } {
  const prof = sketchProfile(sk);
  if (!prof.error) {
    const st = startState(f, matOf(frame));
    const M = matOf(frame, f.reverse ? -st.T : 0);
    st.root = M;
    const ops: SheetOp[] = [];
    prof.faces.forEach((pf, i) => {
      for (const s of [pf.outer, ...pf.holes].flat()) if (s.kind !== "line" && s.kind !== "arc" && s.kind !== "circle") throw new SheetError("E-SM-CURVE", "Sheet metal profiles use lines, arcs and circles.");
      const panel: Panel = { id: `${f.id}:p${i}`, outer: oriented(pf.outer, true), holes: pf.holes.map(h => oriented(h, false)), M, n: 0 };
      st.panels.push(panel);
      ops.push({ kind: "panel", panel });
    });
    return { state: st, ops };
  }
  const path = sketchPath(sk);
  if (path.error || path.closed) throw new SheetError("E-SM-PROFILE", "Use a closed sketch for a flat plate, or an open chain of lines for a bent flange.");
  if (path.segs.some(s => s.kind !== "line")) throw new SheetError("E-SM-LINES", "An open base flange profile is made of lines; the bends are added at the corners.");
  const st = startState(f, matOf(frame));
  const D = f.depth.v;
  if (!(D > 1e-6)) throw new SheetError("E-SM-DEPTH", "The depth must be more than 0.");
  const segs = path.segs as Extract<Seg, { kind: "line" }>[];
  const w = (p: V2): V3 => add(add(frame.o, mul(frame.x, p[0])), mul(frame.y, p[1]));
  const dirs = segs.map(s => { const l = d2(s.a, s.b); return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l] as V2; });
  // Flat axes: u along the strip, v across it. y = -n puts the thickness on the left of the first line (z = d0 × y).
  const y: V3 = f.reverse ? frame.n : mul(frame.n, -1);
  const x = unit(sub3(w(dirs[0]), w([0, 0])));
  let M: Mat = { o: w(segs[0].a), x, y, z: cross(x, y) };
  st.root = M;
  // Depth along the sketch normal from s0 to s1; v = -s when y = -n.
  const [s0, s1] = f.mid ? [-D / 2, D / 2] : f.flip ? [-D, 0] : [0, D];
  const [v0, v1] = f.reverse ? [s0, s1] : [-s1, -s0];
  const turn = dirs.slice(1).map((d, i) => {
    const p = dirs[i], c = p[0] * d[1] - p[1] * d[0], dt = p[0] * d[0] + p[1] * d[1];
    return Math.atan2(c, dt);
  });
  const up = turn.map(a => (a > 0) !== !!f.reverse);
  const sb = turn.map((a, i) => Math.tan(Math.abs(a) / 2) * (up[i] ? st.R + st.T : st.R));
  if (turn.some(a => Math.abs(a) > Math.PI - 1e-3)) throw new SheetError("E-SM-FOLD", "Two lines of the profile fold back onto each other.");
  const ops: SheetOp[] = [];
  let u = 0;
  segs.forEach((s, i) => {
    const len = d2(s.a, s.b) - (i > 0 ? sb[i - 1] : 0) - (i < segs.length - 1 ? sb[i] : 0);
    if (!(len > 1e-6)) throw new SheetError("E-SM-SHORT", "A line of the profile is too short for its bends.");
    const panel: Panel = { id: `${f.id}:p${i}`, outer: polyLoop([[u, v0], [u + len, v0], [u + len, v1], [u, v1]], ["v0", "u1", "v1", "u0"]), holes: [], M, n: 0 };
    st.panels.push(panel);
    ops.push({ kind: "panel", panel });
    u += len;
    if (i < segs.length - 1) {
      const { bend, next } = makeBend(st, M, [u, v0], [u, v1], up[i], Math.abs(turn[i]), st.R, `${f.id}:b${i}`);
      st.bends.push(bend);
      ops.push({ kind: "bend", bend });
      u += bend.ba;
      M = next;
    }
  });
  return { state: st, ops };
}
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** The panel edge a picked model edge stands for: from the two face names either side of it. */
export function findEdge(st: SheetState, faces: [string, string]): { panel: Panel; index: number; up: boolean } {
  const split = (n: string) => { const i = n.lastIndexOf(":"); return [n.slice(0, i), n.slice(i + 1)] as const; };
  for (const [side, other] of [faces, [faces[1], faces[0]]] as const) {
    const [pid, eid] = split(side);
    const [oid, which] = split(other);
    if (oid !== pid || (which !== "top" && which !== "bot")) continue;
    const panel = st.panels.find(p => p.id === pid);
    const index = panel ? panel.outer.findIndex(s => s.ent === eid) : -1;
    if (panel && index >= 0) return { panel, index, up: which === "top" };
  }
  throw new SheetError("E-SM-EDGE", "Pick an outside edge of a flat sheet metal face.");
}

interface FlangeSpec { angle: number; r: number; /** flat length after the bend */ s: number; /** how far inside the edge the bend starts */ d: number; off0: number; off1: number; flip: boolean; /** Flange (not bend) run past the edge start / end, cut back later by a mitre. */ ext0?: number; ext1?: number }

/** Adds a bend and a flange panel on one picked edge (edge flange and hem). */
function addFlange(st: SheetState, faces: [string, string], spec: FlangeSpec, pid: string, bid: string): SheetOp[] {
  const { panel, index, up: upSide } = findEdge(st, faces);
  const seg = panel.outer[index];
  if (seg.kind !== "line") throw new SheetError("E-SM-STRAIGHT", "A flange goes on a straight edge.");
  const key = `${panel.id}:${seg.ent}`;
  if (st.used.includes(key)) throw new SheetError("E-SM-USED", "That edge already has a flange.");
  const up = upSide !== spec.flip;
  const a = seg.a, b = seg.b, l = d2(a, b);
  const e = s2([b[0] - a[0], b[1] - a[1]], 1 / l), o: V2 = [e[1], -e[0]];
  const t0 = spec.off0, t1 = l - spec.off1;
  if (!(t1 - t0 > 1e-6)) throw new SheetError("E-SM-OFFSET", "The offsets leave nothing of the edge.");
  if (!(spec.s > 1e-6)) throw new SheetError("E-SM-LENGTH", "The flange is too short for its bend.");
  const P = (t: number, n: number): V2 => [a[0] + t * e[0] - n * o[0], a[1] + t * e[1] - n * o[1]];
  const d = spec.d;
  const ops: SheetOp[] = [];
  const eps = 1e-7 * (1 + l);
  if (d > eps) {
    // The bend starts inside the panel: trim the edge back by d where the flange is, with reliefs at partial ends.
    const n = panel.outer.length;
    const prev = panel.outer[(index + n - 1) % n], next = panel.outer[(index + 1) % n];
    const moveIn = (other: Seg): V2 => {
      if (other.kind !== "line") throw new SheetError("E-SM-CORNER", "The edges next to a flange with material inside must be straight.");
      // Where the edge moved in by d meets the neighbouring edge's line.
      const p = P(0, d), q = other.a, r = [other.b[0] - other.a[0], other.b[1] - other.a[1]] as V2;
      const den = e[0] * r[1] - e[1] * r[0];
      if (Math.abs(den) < 1e-9) throw new SheetError("E-SM-CORNER", "The edges next to a flange with material inside must not be parallel to it.");
      const tt = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
      return p2(p, s2(e, tt));
    };
    const rel = st.relief === "none" ? 0 : st.reliefRatio * st.T;
    const dr = st.relief === "none" ? d : d + rel;
    const pts: V2[] = [];
    const startAt = t0 <= eps ? moveIn(prev) : a;
    pts.push(startAt);
    if (t0 > eps) { const w = Math.min(rel, t0); pts.push(P(t0 - w, 0), P(t0 - w, dr), P(t0, dr), P(t0, d)); } else pts.push(P(0, d));
    if (t1 < l - eps) { const w = Math.min(rel, l - t1); pts.push(P(t1, d), P(t1, dr), P(t1 + w, dr), P(t1 + w, 0)); } else pts.push(P(l, d));
    const endAt = t1 >= l - eps ? moveIn(next) : b;
    pts.push(endAt);
    const clean = cleanPath(pts);
    // The removed material: the old edge, then back along the new path.
    ops.push({ kind: "cut", M: panel.M, loop: cyclic([a, b, ...[...clean].reverse()]) });
    // How far inside the old edge a point is.
    const inward = (p: V2) => -((p[0] - a[0]) * o[0] + (p[1] - a[1]) * o[1]);
    const newSegs: Seg[] = [];
    for (let i = 0; i + 1 < clean.length; i++) {
      const isAtt = Math.abs(inward(clean[i]) - d) < eps && Math.abs(inward(clean[i + 1]) - d) < eps;
      newSegs.push(line(isAtt ? seg.ent : `x${panel.n++}`, clean[i], clean[i + 1]));
    }
    if (t0 <= eps) panel.outer[(index + n - 1) % n] = { ...prev, b: clean[0] } as Seg;
    if (t1 >= l - eps) panel.outer[(index + 1) % n] = { ...next, a: clean.at(-1)! } as Seg;
    panel.outer.splice(index, 1, ...newSegs);
  }
  st.used.push(key);
  const A0 = P(t0, d), A1 = P(t1, d);
  const { bend, next } = makeBend(st, panel.M, A0, A1, up, spec.angle, spec.r, bid);
  st.bends.push(bend);
  ops.push({ kind: "bend", bend });
  const c0 = p2(p2(A0, s2(o, bend.ba)), s2(e, -(spec.ext0 ?? 0))), c1 = p2(p2(A1, s2(o, bend.ba)), s2(e, spec.ext1 ?? 0));
  // c0, c0 + s·o, c1 + s·o, c1: counter-clockwise (o is to the right of A0 → A1).
  const fl: Panel = { id: pid, outer: strip(c0, c1, o, spec.s, ["s0", "tip", "s1", "att"]), holes: [], M: next, n: 0 };
  st.used.push(`${pid}:att`);
  st.panels.push(fl);
  ops.push({ kind: "panel", panel: fl });
  return ops;
}

/** A closed loop's points without repeats (also last = first). */
function cyclic(pts: V2[]): V2[] {
  const out = cleanPath(pts);
  while (out.length > 1 && d2(out[0], out.at(-1)!) < 1e-9) out.pop();
  return out;
}

/** Points with repeats and straight-through points removed. */
function cleanPath(pts: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of pts) if (!out.length || d2(out.at(-1)!, p) > 1e-9) out.push(p);
  for (let i = 1; i + 1 < out.length;) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dt = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cr) < 1e-12 * (1 + d2(a, c) ** 2) && dt > 0) out.splice(i, 1); else i++;
  }
  return out;
}

const clone = (st: SheetState): SheetState => structuredClone(st);

/** Edge flange on each picked edge. */
export function edgeFlange(prev: SheetState, f: SmFlangeFeature): { state: SheetState; ops: SheetOp[] } {
  if (!f.edges.length) throw new SheetError("E-SM-NOEDGE", "Pick the edges for the flange.");
  const st = clone(prev);
  const angle = f.angle.v;
  if (!(angle > 1e-6 && angle < Math.PI - 1e-3)) throw new SheetError("E-SM-ANGLE", "The flange angle must be between 0° and 180°.");
  const r = f.radius?.v ?? st.R;
  const L = f.length.v;
  const s = L - (f.lengthRef === "inner" ? innerSetback(angle, r) : outerSetback(st.T, angle, r));
  const pos = f.position ?? "inside";
  const d = pos === "inside" ? outerSetback(st.T, angle, r) : pos === "outside" ? innerSetback(angle, r) : 0;
  const ops: SheetOp[] = [];
  const off0 = f.off0?.v ?? 0, off1 = f.off1?.v ?? 0;
  // Picked edges meeting at a corner of the same face: their flanges run on past it and are mitred (SolidWorks).
  const corners = off0 > 1e-9 || off1 > 1e-9 ? [] : flangeCorners(st, f.edges.map(x => x.faces));
  const E = 2 * (s + d + bendAllowance(st, angle, r) + 2 * st.T);
  f.edges.forEach((ref, i) => ops.push(...addFlange(st, ref.faces, {
    angle, r, s, d, off0, off1, flip: !!f.flip,
    ext0: corners.some(c => c[1] === i) ? E : 0, ext1: corners.some(c => c[0] === i) ? E : 0,
  }, `${f.id}:p${i}`, `${f.id}:b${i}`)));
  const gap = Math.max(f.gap?.v ?? 0.1, 0);
  for (const [i, j] of corners) mitre(st, `${f.id}:p${i}`, `${f.id}:p${j}`, gap);
  return { state: st, ops };
}

/** Pairs [i, j] of picked edges where edge i ends where edge j starts on the same face. */
function flangeCorners(st: SheetState, picks: [string, string][]): [number, number][] {
  const found = picks.map(f => { try { const r = findEdge(st, f); return { panel: r.panel.id, seg: r.panel.outer[r.index] }; } catch { return null; } });
  const out: [number, number][] = [];
  found.forEach((a, i) => found.forEach((b, j) => {
    if (i === j || !a || !b || a.panel !== b.panel || a.seg.kind !== "line" || b.seg.kind !== "line") return;
    const ua: V2 = [a.seg.b[0] - a.seg.a[0], a.seg.b[1] - a.seg.a[1]], ub: V2 = [b.seg.b[0] - b.seg.a[0], b.seg.b[1] - b.seg.a[1]];
    const turn = Math.abs(ua[0] * ub[1] - ua[1] * ub[0]) / (Math.hypot(...ua) * Math.hypot(...ub));
    if (d2(a.seg.b, b.seg.a) < 1e-6 && turn > 1e-6) out.push([i, j]);
  }));
  return out;
}

/** Mitres two flanges that run past a shared corner: each is cut where the flanges' mid-planes meet, gap/2 back. */
function mitre(st: SheetState, ida: string, idb: string, gap: number) {
  const A = st.panels.find(p => p.id === ida), B = st.panels.find(p => p.id === idb);
  if (!A || !B) return;
  const T = st.T;
  const na = A.M.z, nb = B.M.z;
  const L: V3 = [na[1] * nb[2] - na[2] * nb[1], na[2] * nb[0] - na[0] * nb[2], na[0] * nb[1] - na[1] * nb[0]];
  const ll = Math.hypot(...L);
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (ll < 1e-6) return;
  const ha = dot(na, apply(A.M, [0, 0, T / 2])), hb = dot(nb, apply(B.M, [0, 0, T / 2]));
  const c = dot(na, nb), den = 1 - c * c;
  const X: V3 = add(mul(na, (ha - hb * c) / den), mul(nb, (hb - ha * c) / den));
  const cut = (P: Panel) => {
    const to2 = (q: V3): V2 => { const v: V3 = [q[0] - P.M.o[0], q[1] - P.M.o[1], q[2] - P.M.o[2]]; return [dot(v, P.M.x), dot(v, P.M.y)]; };
    const p0 = to2(X), p1 = to2(add(X, mul(L, 1 / ll)));
    const dl = d2(p0, p1);
    if (dl < 1e-9) return;
    const n: V2 = [-(p1[1] - p0[1]) / dl, (p1[0] - p0[0]) / dl];
    let k = n[0] * p0[0] + n[1] * p0[1];
    // Keep the side the flange's bend edge (its attached part) is on.
    const att = P.outer.find(x => x.ent === "att");
    const bendSide = P.id === ida ? "s0" : "s1";
    const ref = P.outer.find(x => x.ent === bendSide);
    const q = ref && ref.kind === "line" ? [(ref.a[0] + ref.b[0]) / 2, (ref.a[1] + ref.b[1]) / 2] as V2 : att && att.kind === "line" ? att.a : p0;
    const keep: 1 | -1 = n[0] * q[0] + n[1] * q[1] - k >= 0 ? 1 : -1;
    k += keep * gap / 2;
    try { P.outer = clipOuter(P.outer, n, k, keep, "miter", 1e-7 * (1 + st.T)); } catch { /* the cut misses: leave the flange */ }
  };
  cut(A); cut(B);
}

/** Hem: a 180° fold, closed (radius next to nothing) or open (radius half the gap). */
export function hem(prev: SheetState, f: SmHemFeature): { state: SheetState; ops: SheetOp[] } {
  if (!f.edges.length) throw new SheetError("E-SM-NOEDGE", "Pick the edges for the hem.");
  const st = clone(prev);
  const r = f.kind === "open" ? (f.gap?.v ?? st.T) / 2 : Math.max(st.T * 1e-3, 1e-3);
  if (!(r > 0)) throw new SheetError("E-SM-GAP", "The gap must be more than 0.");
  const s = f.length.v - (r + st.T);
  const d = (f.position ?? "inside") === "inside" ? r + st.T : 0;
  const ops: SheetOp[] = [];
  f.edges.forEach((ref, i) => ops.push(...addFlange(st, ref.faces, { angle: Math.PI, r, s, d, off0: 0, off1: 0, flip: !!f.flip }, `${f.id}:p${i}`, `${f.id}:b${i}`)));
  return { state: st, ops };
}

// ---------- sketched bends and jogs ----------

type Line = Extract<Seg, { kind: "line" }>;
type Arc = Extract<Seg, { kind: "arc" }>;

/** Distance from a flat point to an outline piece. */
function segDist(s: Seg, p: V2): number {
  if (s.kind === "line") {
    const ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], l2 = ux * ux + uy * uy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * ux + (p[1] - s.a[1]) * uy) / l2));
    return Math.hypot(p[0] - s.a[0] - t * ux, p[1] - s.a[1] - t * uy);
  }
  if (s.kind === "arc" || s.kind === "circle") return Math.abs(d2(p, s.c) - s.r);
  return Infinity;
}
const onLoop = (loop: Seg[], p: V2, tol: number) => loop.some(s => segDist(s, p) < tol);

/** Where a flat point is on the sheet: the rigid inverse of M. */
const local = (M: Mat, p: V3): V3 => { const d = sub3(p, M.o); return [dot(d, M.x), dot(d, M.y), dot(d, M.z)]; };

/** An arc's angle sweep: start angle and signed sweep (positive counter-clockwise). */
function arcSweep(s: Arc): { a0: number; sw: number } {
  const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
  let sw = a1 - a0;
  if (s.ccw) { while (sw <= 1e-12) sw += 2 * Math.PI; } else { while (sw >= -1e-12) sw -= 2 * Math.PI; }
  return { a0, sw };
}
const arcAt = (s: Arc, a: number): V2 => [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)];

/** A loop's pieces cut where the line side(p) = 0 crosses them. */
function splitAt(loop: Seg[], side: (p: V2) => number, n: V2, k: number, tol: number): Seg[] {
  const out: Seg[] = [];
  for (const s of loop) {
    if (s.kind === "line") {
      const fa = side(s.a), fb = side(s.b);
      if ((fa > tol && fb < -tol) || (fa < -tol && fb > tol)) {
        const t = fa / (fa - fb), m: V2 = [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])];
        out.push({ ...s, b: m }, { ...s, a: m });
      } else out.push(s);
    } else if (s.kind === "arc") {
      // Circle ∩ line n·p = k: the foot of the centre, then ± along the line.
      const dc = n[0] * s.c[0] + n[1] * s.c[1] - k;
      if (Math.abs(dc) >= s.r - tol) { out.push(s); continue; }
      const h = Math.sqrt(s.r * s.r - dc * dc), f: V2 = [s.c[0] - dc * n[0], s.c[1] - dc * n[1]], e: V2 = [-n[1], n[0]];
      const { a0, sw } = arcSweep(s);
      const ts = [p2(f, s2(e, h)), p2(f, s2(e, -h))].map(q => {
        let a = Math.atan2(q[1] - s.c[1], q[0] - s.c[0]) - a0;
        if (sw > 0) { while (a < 0) a += 2 * Math.PI; } else { while (a > 0) a -= 2 * Math.PI; }
        return a / sw;
      }).filter(t => t > 1e-9 && t < 1 - 1e-9).sort((x, y) => x - y);
      let at = s.a;
      for (const t of ts) { const q = arcAt(s, a0 + t * sw); out.push({ ...s, a: at, b: q }); at = q; }
      out.push({ ...s, a: at, b: s.b });
    } else if (s.kind === "circle") {
      if (Math.abs(n[0] * s.c[0] + n[1] * s.c[1] - k) < s.r - tol) throw new SheetError("E-SM-CROSS", "The bend line can't cross a circle of the outline.");
      out.push(s);
    } else throw new SheetError("E-SM-CURVE", "Sheet metal profiles use lines, arcs and circles.");
  }
  return out;
}

/** A piece's middle point (for which side of a line it is on). */
function midOf(s: Seg): V2 {
  if (s.kind === "line") return [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
  if (s.kind === "arc") { const { a0, sw } = arcSweep(s); return arcAt(s, a0 + sw / 2); }
  if (s.kind === "circle") return s.c;
  return [0, 0];
}

/**
 * The part of an outer loop on one side of the line n·p = k (`keep` = +1: n·p ≥ k), closed along the
 * line by a straight edge with id `ent`. The line must cross the loop once (two crossings).
 */
function clipOuter(loop: Seg[], n: V2, k: number, keep: 1 | -1, ent: string, tol: number): Seg[] {
  const side = (p: V2) => keep * (n[0] * p[0] + n[1] * p[1] - k);
  const pieces = splitAt(loop, side, n, k, tol);
  const kept = pieces.map(s => side(midOf(s)) > 0);
  if (kept.every(x => x)) return loop;
  if (!kept.some(x => x)) throw new SheetError("E-SM-CROSS", "The bend line must cross the face.");
  // Start right after a dropped piece, so each run of kept pieces is whole.
  const start = kept.findIndex((x, i) => x && !kept[(i + pieces.length - 1) % pieces.length]);
  const out: Seg[] = [];
  let runs = 0;
  for (let j = 0; j < pieces.length; j++) {
    const i = (start + j) % pieces.length;
    if (!kept[i]) continue;
    if (!kept[(i + pieces.length - 1) % pieces.length]) {
      runs++;
      if (out.length) out.push(line(ent, (out.at(-1) as Line).b, (pieces[i] as Line).a));
    }
    out.push(pieces[i]);
  }
  if (runs !== 1) throw new SheetError("E-SM-CROSS", "The bend line must cross the face once.");
  out.push(line(ent, (out.at(-1) as Line).b, (out[0] as Line).a));
  return out;
}

/** The points where the line n·p = k crosses a loop, sorted along e. */
function crossings(loop: Seg[], n: V2, k: number, tol: number): V2[] {
  const side = (p: V2) => n[0] * p[0] + n[1] * p[1] - k;
  const e: V2 = [-n[1], n[0]];
  const pts: V2[] = [];
  for (const s of splitAt(loop, side, n, k, tol)) {
    if (s.kind === "circle") continue;
    const a = (s as Line).a, b = (s as Line).b;
    if (Math.abs(side(a)) <= tol && !pts.some(q => d2(q, a) < tol * 10)) pts.push(a);
    if (Math.abs(side(b)) <= tol && !pts.some(q => d2(q, b) < tol * 10)) pts.push(b);
  }
  return pts.sort((p, q) => (p[0] - q[0]) * e[0] + (p[1] - q[1]) * e[1]);
}

/** The panel a sketched line lies on, the line in flat coordinates and the face it was sketched on. */
function linePanel(st: SheetState, p: V3, q: V3): { panel: Panel; a: V2; b: V2; top: boolean } {
  const tol = 1e-4 * (1 + st.T);
  for (const panel of st.panels) {
    const lp = local(panel.M, p), lq = local(panel.M, q);
    for (const [z, top] of [[st.T, true], [0, false]] as const) {
      if (Math.abs(lp[2] - z) > tol || Math.abs(lq[2] - z) > tol) continue;
      const a: V2 = [lp[0], lp[1]], b: V2 = [lq[0], lq[1]];
      const poly = loopPolygon(panel.outer, 32);
      const inside = (x: V2) => inPolygon(x, poly) || onLoop(panel.outer, x, tol);
      if (inside(a) || inside(b) || inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) return { panel, a, b, top };
    }
  }
  throw new SheetError("E-SM-SKFACE", "Sketch the bend line on a flat face of the sheet.");
}

/** The one line of a sketched bend's sketch, in world coordinates. */
export function bendSketchLine(sk: SketchFeature, frame: Frame): [V3, V3] {
  const path = sketchPath(sk);
  if (path.error || path.segs.length !== 1 || path.segs[0].kind !== "line") throw new SheetError("E-SM-SKLINE", "The sketch must hold one line.");
  const s = path.segs[0];
  const w = (p: V2): V3 => add(add(frame.o, mul(frame.x, p[0])), mul(frame.y, p[1]));
  return [w(s.a), w(s.b)];
}

interface Fold { up: boolean; angle: number; r: number }

/**
 * Folds a panel along a flat line: the panel is split there, the moving side becomes new panels joined
 * by the bends `folds` (with flat gaps `gaps` between them). The flat pattern keeps its outline.
 */
function foldPanel(st: SheetState, panel: Panel, a: V2, b: V2, flip: boolean, position: BendPosition, folds: Fold[], gaps: number[], fid: string): SheetOp[] {
  const size = Math.max(1, ...loopPolygon(panel.outer, 8).flatMap(p => [Math.abs(p[0]), Math.abs(p[1])]));
  const tol = size * 1e-7;
  const l = d2(a, b);
  if (!(l > tol)) throw new SheetError("E-SM-SKLINE", "The sketch must hold one line.");
  let e: V2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  let n: V2 = [e[1], -e[0]];
  const sideOf = (p: V2) => n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1]);
  // Which side folds: not the one bends hang from; else the smaller one; `flip` swaps.
  const touching = st.bends.flatMap(bd => {
    const m0: V2 = [(bd.a0[0] + bd.a1[0]) / 2, (bd.a0[1] + bd.a1[1]) / 2];
    const lb = d2(bd.a0, bd.a1), o: V2 = [(bd.a1[1] - bd.a0[1]) / lb, -(bd.a1[0] - bd.a0[0]) / lb];
    return [m0, p2(m0, s2(o, bd.ba))].filter(m => onLoop(panel.outer, m, size * 1e-6)).map(m => Math.sign(sideOf(m)));
  });
  const area = (sgn: 1 | -1) => { try { return Math.abs(polyArea(loopPolygon(clipOuter(panel.outer, n, n[0] * a[0] + n[1] * a[1], sgn, "_", tol), 16))); } catch { return 0; } };
  const pos = touching.includes(1), neg = touching.includes(-1);
  let moving: 1 | -1 = pos && !neg ? -1 : neg && !pos ? 1 : area(1) <= area(-1) ? 1 : -1;
  if (flip) moving = -moving as 1 | -1;
  if ((moving > 0 && pos) || (moving < 0 && neg)) throw new SheetError("E-SM-SKSIDE", "The side that would fold already has bends on it; flip the fixed side.");
  if (moving < 0) { e = [-e[0], -e[1]]; n = [-n[0], -n[1]]; }
  // Bend strip starts along n, measured from the line.
  const bas = folds.map(f => bendAllowance(st, f.angle, f.r));
  if (bas.some(x => !(x > 1e-9))) throw new SheetError("E-SM-BA", "The bend allowance must be more than 0.");
  const k0 = n[0] * a[0] + n[1] * a[1];
  let t = position === "start" ? 0 : position === "end" ? -bas[0] : -bas[0] / 2;
  const starts: number[] = [];
  folds.forEach((_f, i) => { starts.push(t); t += bas[i]; if (i < folds.length - 1) t += gaps[i]; });
  const kFix = k0 + starts[0], kEnd = k0 + t;
  // No bend on this face may run across the new bends.
  for (const bd of st.bends) {
    const lb = d2(bd.a0, bd.a1), o: V2 = [(bd.a1[1] - bd.a0[1]) / lb, -(bd.a1[0] - bd.a0[0]) / lb];
    for (const [q0, q1] of [[bd.a0, bd.a1], [p2(bd.a0, s2(o, bd.ba)), p2(bd.a1, s2(o, bd.ba))]] as [V2, V2][]) {
      if (!onLoop(panel.outer, [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2], size * 1e-6)) continue;
      const v0 = n[0] * q0[0] + n[1] * q0[1], v1 = n[0] * q1[0] + n[1] * q1[1];
      if (Math.min(v0, v1) < kEnd - tol && Math.max(v0, v1) > kFix + tol) throw new SheetError("E-SM-SKBENDX", "Another bend on the face runs across the bend line.");
    }
  }
  // Holes go with the side they are on; none may cross the bends.
  const fixedHoles: Seg[][] = [], movingHoles: Seg[][] = [];
  for (const h of panel.holes) {
    const sv = loopPolygon(h, 24).map(p => n[0] * p[0] + n[1] * p[1]);
    if (Math.max(...sv) <= kFix + tol) fixedHoles.push(h);
    else if (Math.min(...sv) >= kEnd - tol) movingHoles.push(h);
    else throw new SheetError("E-SM-SKHOLE", "A hole of the face crosses the bend.");
  }
  const ops: SheetOp[] = [];
  // Cut away everything past the start of the first bend.
  const big = size * 4 + 10;
  const P = (u: number, v: number): V2 => [e[0] * u + n[0] * v, e[1] * u + n[1] * v];
  ops.push({ kind: "cut", M: panel.M, loop: [P(-big, kFix), P(big, kFix), P(big, kFix + big), P(-big, kFix + big)] });
  const outer0 = panel.outer;
  let M = panel.M;
  folds.forEach((f, i) => {
    const k = k0 + starts[i];
    const c0 = crossings(outer0, n, k, tol), c1 = crossings(outer0, n, k + bas[i], tol);
    if (c0.length !== 2 || c1.length !== 2) throw new SheetError("E-SM-CROSS", "The bend line must cross the face once.");
    const [A0, A1] = c0;
    const sq = tol * 100 + bas[i] * 1e-6;
    if (d2(c1[0], p2(A0, s2(n, bas[i]))) > sq || d2(c1[1], p2(A1, s2(n, bas[i]))) > sq) throw new SheetError("E-SM-SKSQUARE", "The edges the bend crosses must be square to the bend line.");
    // makeBend runs towards (e.y, -e.x) = n from A0 → A1 along e.
    const { bend, next } = makeBend(st, M, A0, A1, f.up, f.angle, f.r, `${fid}:b${i}`);
    st.bends.push(bend);
    ops.push({ kind: "bend", bend });
    M = next;
    const from = k + bas[i];
    const last = i === folds.length - 1;
    if (!last && gaps[i] <= tol) return;
    let outer = clipOuter(outer0, n, from, 1, `j${i}`, tol);
    if (!last) outer = clipOuter(outer, n, k0 + starts[i + 1], -1, `j${i}e`, tol);
    const np: Panel = { id: `${fid}:p${i}`, outer: oriented(outer, true), holes: last ? movingHoles : [], M, n: 0 };
    st.panels.push(np);
    ops.push({ kind: "panel", panel: np });
  });
  panel.outer = oriented(clipOuter(outer0, n, kFix, -1, `x${panel.n++}`, tol), true);
  panel.holes = fixedHoles;
  return ops;
}

/** Sketched bend: the face the line is on folds along it. */
export function sketchedBend(prev: SheetState, f: SmSketchBendFeature, line3: [V3, V3]): { state: SheetState; ops: SheetOp[] } {
  const st = clone(prev);
  const angle = f.angle.v;
  if (!(angle > 1e-6 && angle < Math.PI - 1e-3)) throw new SheetError("E-SM-ANGLE", "The bend angle must be between 0° and 180°.");
  const r = f.radius?.v ?? st.R;
  if (!(r >= 0)) throw new SheetError("E-SM-R", "The bend radius can't be negative.");
  const { panel, a, b, top } = linePanel(st, line3[0], line3[1]);
  const ops = foldPanel(st, panel, a, b, !!f.flip, f.position ?? "center", [{ up: top !== !!f.reverse, angle, r }], [], f.id);
  return { state: st, ops };
}

/** Jog: a bend and the opposite bend, far enough apart to offset the rest of the face. */
export function jog(prev: SheetState, f: SmJogFeature, line3: [V3, V3]): { state: SheetState; ops: SheetOp[] } {
  const angle = f.angle.v;
  if (!(angle > 1e-3 && angle < Math.PI - 1e-3)) throw new SheetError("E-SM-ANGLE", "The bend angle must be between 0° and 180°.");
  const r = f.radius?.v ?? prev.R;
  if (!(r >= 0)) throw new SheetError("E-SM-R", "The bend radius can't be negative.");
  const D = f.offset.v;
  if (!(D > 0)) throw new SheetError("E-SM-JOG", "The jog offset must be more than 0.");
  const T = prev.T;
  const want = f.dim === "inside" ? D + T : f.dim === "face" ? D : D - T;
  const at = (gap: number) => {
    const st = clone(prev);
    const { panel, a, b, top } = linePanel(st, line3[0], line3[1]);
    const up = top !== !!f.reverse;
    const M0 = panel.M;
    const ops = foldPanel(st, panel, a, b, !!f.flip, f.position ?? "center", [{ up, angle, r }, { up: !up, angle, r }], [gap], f.id);
    const h = Math.abs(dot(sub3(st.panels.at(-1)!.M.o, M0.o), M0.z));
    return { st, ops, h };
  };
  // The offset grows linearly with the flat gap between the bends.
  const g1 = at(1).h, g2 = at(2).h;
  const slope = g2 - g1, h0 = g1 - slope;
  if (!(slope > 1e-9)) throw new SheetError("E-SM-JOG", "The jog offset could not be reached.");
  const gap = (want - h0) / slope;
  if (gap < -1e-9) throw new SheetError("E-SM-JOGSMALL", "The jog offset is too small for the bend radius and angle.");
  const { st, ops } = at(Math.max(0, gap));
  return { state: st, ops };
}

/** Tab: the closed regions of a sketch on a flat face become panels joined to that face. */
export function tab(prev: SheetState, f: SmTabFeature, sk: SketchFeature, frame: Frame): { state: SheetState; ops: SheetOp[] } {
  const st = clone(prev);
  const prof = sketchProfile(sk);
  if (prof.error || !prof.faces.length) throw new SheetError("E-SM-TABSKETCH", "A tab needs a closed sketch on a flat face of the sheet.");
  const w = (p: V2): V3 => add(add(frame.o, mul(frame.x, p[0])), mul(frame.y, p[1]));
  const tol = 1e-4 * (1 + st.T);
  const first = (() => { const s0 = prof.faces[0].outer[0]; return s0.kind === "circle" ? [s0.c[0] + s0.r, s0.c[1]] as V2 : (s0 as Line).a; })();
  const host = st.panels.find(p => { const z = local(p.M, w(first))[2]; return Math.abs(z) < tol || Math.abs(z - st.T) < tol; });
  if (!host) throw new SheetError("E-SM-TABFACE", "Sketch the tab on a flat face of the sheet.");
  const to = (p: V2): V2 => { const l = local(host.M, w(p)); return [l[0], l[1]]; };
  // The sketch's normal along the panel's or against it (then arcs turn the other way).
  const same = dot(frame.n, host.M.z) > 0;
  const map = (s: Seg): Seg => {
    if (s.kind === "line") return { ...s, a: to(s.a), b: to(s.b) };
    if (s.kind === "arc") return { ...s, c: to(s.c), a: to(s.a), b: to(s.b), ccw: same ? s.ccw : !s.ccw };
    if (s.kind === "circle") return { ...s, c: to(s.c) };
    throw new SheetError("E-SM-CURVE", "Sheet metal profiles use lines, arcs and circles.");
  };
  const hostPoly = loopPolygon(host.outer, 32);
  const size = Math.max(1, ...hostPoly.flatMap(p => [Math.abs(p[0]), Math.abs(p[1])]));
  const ops: SheetOp[] = [];
  prof.faces.forEach((pf, i) => {
    const outer = oriented(pf.outer.map(map), true);
    const poly = loopPolygon(outer, 32);
    // The tab sits beside the face: no corner inside it, and some edge shared with it.
    if (poly.some(p => inPolygon(p, hostPoly) && !onLoop(host.outer, p, size * 1e-6))) throw new SheetError("E-SM-TABOVER", "Draw the tab beside the face, touching its edge, not over it.");
    if (!poly.some(p => onLoop(host.outer, p, size * 1e-6))) throw new SheetError("E-SM-TABTOUCH", "The tab must touch an edge of the face.");
    const panel: Panel = { id: `${f.id}:p${i}`, outer, holes: pf.holes.map(h => oriented(h.map(map), false)), M: host.M, n: 0 };
    st.panels.push(panel);
    ops.push({ kind: "panel", panel });
  });
  return { state: st, ops };
}

// ---------- flat pattern ----------

/** A bend's strip in the flat pattern, counter-clockwise. */
export function bendStrip(b: Bend): Seg[] {
  const l = d2(b.a0, b.a1), e: V2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l];
  return strip(b.a0, b.a1, [e[1], -e[0]], b.ba, ["s0", "end", "s1", "start"]);
}

/** A bend's centre line in the flat pattern. */
export function bendLine(b: Bend): [V2, V2] {
  const l = d2(b.a0, b.a1), o: V2 = [(b.a1[1] - b.a0[1]) / l, -(b.a1[0] - b.a0[0]) / l];
  return [p2(b.a0, s2(o, b.ba / 2)), p2(b.a1, s2(o, b.ba / 2))];
}

/**
 * The flat pattern's outline: the union of the panels and bend strips. They meet along shared
 * edges (sometimes part of an edge), so the union is the edges left once each shared piece and
 * its opposite are taken out, chained back into loops.
 */
export function flatLoops(st: SheetState): { outer: Seg[][]; holes: Seg[][] } {
  const loops = [...st.panels.flatMap(p => [p.outer, ...p.holes]), ...st.bends.map(bendStrip)] as FlatSeg[][];
  const size = Math.max(1, ...loops.flat().flatMap(s => s.kind === "circle" ? [Math.abs(s.c[0]) + s.r, Math.abs(s.c[1]) + s.r] : [Math.abs(s.a[0]), Math.abs(s.a[1]), Math.abs(s.b[0]), Math.abs(s.b[1])]));
  const tol = size * 1e-7;
  const verts: V2[] = loops.flat().flatMap(s => (s.kind === "circle" ? [] : [s.a, s.b]));
  // Split lines where another loop's corner lies on them.
  let segs: FlatSeg[] = [];
  for (const s of loops.flat()) {
    if (s.kind !== "line") { segs.push(s); continue; }
    const l = d2(s.a, s.b), e: V2 = [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
    const cuts = verts.map(v => ({ v, t: (v[0] - s.a[0]) * e[0] + (v[1] - s.a[1]) * e[1] }))
      .filter(({ v, t }) => t > tol && t < l - tol && Math.abs((v[0] - s.a[0]) * e[1] - (v[1] - s.a[1]) * e[0]) < tol)
      .sort((x, y) => x.t - y.t);
    let at = s.a;
    for (const c of cuts) { if (d2(at, c.v) > tol) { segs.push({ ...s, a: at, b: c.v }); at = c.v; } }
    segs.push({ ...s, a: at, b: s.b });
  }
  // Take out each line together with an opposite one.
  const gone = new Set<number>();
  segs.forEach((s, i) => {
    if (gone.has(i) || s.kind !== "line") return;
    const j = segs.findIndex((q, k) => k !== i && !gone.has(k) && q.kind === "line" && d2(q.a, s.b) < tol && d2(q.b, s.a) < tol);
    if (j >= 0) { gone.add(i); gone.add(j); }
  });
  segs = segs.filter((_s, i) => !gone.has(i));
  // Chain the rest back into loops.
  const out: FlatSeg[][] = [];
  const left = [...segs];
  while (left.length) {
    const first = left.shift()!;
    if (first.kind === "circle") { out.push([first]); continue; }
    const loop: FlatSeg[] = [first];
    for (;;) {
      const end = (loop.at(-1) as { b: V2 }).b;
      if (d2(end, (loop[0] as { a: V2 }).a) < tol * 10) break;
      const i = left.findIndex(q => q.kind !== "circle" && d2(q.a, end) < tol * 10);
      if (i < 0) break;
      loop.push(left.splice(i, 1)[0]);
    }
    out.push(mergeLines(loop, tol) as FlatSeg[]);
  }
  const area = (l: Seg[]) => polyArea(loopPolygon(l));
  return { outer: out.filter(l => area(l) > 0), holes: out.filter(l => area(l) <= 0) };
}

/** The pieces a sheet metal outline is made of. */
type FlatSeg = Extract<Seg, { kind: "line" | "arc" | "circle" }>;

/** Joins consecutive straight pieces of one line. */
function mergeLines(loop: Seg[], tol: number): Seg[] {
  const out = [...loop];
  const same = (s: Seg, q: Seg) => {
    if (s.kind !== "line" || q.kind !== "line") return false;
    const ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], vx = q.b[0] - q.a[0], vy = q.b[1] - q.a[1];
    return Math.abs(ux * vy - uy * vx) < tol * (Math.hypot(ux, uy) + Math.hypot(vx, vy)) && ux * vx + uy * vy > 0;
  };
  for (let i = 0; out.length > 1 && i < out.length;) {
    const j = (i + 1) % out.length;
    if (j !== i && same(out[i], out[j])) {
      const s = out[i] as Extract<Seg, { kind: "line" }>, q = out[j] as Extract<Seg, { kind: "line" }>;
      out[i] = { ...s, b: q.b };
      out.splice(j, 1);
      if (j < i) i--;
    } else i++;
  }
  return out;
}

/** Flat-pattern size: the bounding box of the outline (mm). */
export function flatSize(st: SheetState): { w: number; h: number; min: V2; max: V2 } {
  const { outer } = flatLoops(st);
  const pts = outer.flatMap(l => loopPolygon(l, 32));
  const min: V2 = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))];
  const max: V2 = [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  return { w: max[0] - min[0], h: max[1] - min[1], min, max };
}

/** Bend lines on the flat pattern's top face, in world coordinates (drawn in the view when flattened). */
export function flatBendLines(st: SheetState): { a: V3; b: V3; up: boolean }[] {
  return st.bends.map(b => { const [p, q] = bendLine(b); return { a: apply(st.root, [p[0], p[1], st.T]), b: apply(st.root, [q[0], q[1], st.T]), up: b.up }; });
}
