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
import type { Frame, PartDoc, SketchFeature, V2, V3 } from "../model/types";
import { inPolygon, loopPolygon, polyArea, sketchCurves, sketchPath, sketchProfile, type Seg } from "../sketch/profile";
import type { SmGussetFeature, ReliefKind, SmReliefFeature, FormTool, SmFormFeature, SmUnfoldFeature, BendCalc, BendPosition, SmCrossFeature, SmLoftFeature, SmBaseFeature, SmClosedFeature, SmCornerFeature, SmFlangeFeature, SmHemFeature, SmJogFeature, SmMiterFeature, SmSketchBendFeature, SmTabFeature } from "./types";
import { isSheetBase } from "./types";

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
  /** Sharp folds between flat facets (lofted bends), in flat coordinates. */
  folds?: SheetFold[];
  /** The folded solid is a faceted shell (lofted bend), not the panels' prisms and bends. */
  faceted?: boolean;
  /** Cross break lines, in flat coordinates on a panel's top or bottom face. */
  crosses?: CrossLine[];
  /** Forming tools pressed into panels: footprints in flat coordinates (left out of the flat pattern). */
  forms?: FormMark[];
  /** Sheet metal gussets: the groove each one presses into the sheet, left out of the flat pattern. */
  gussets?: GussetMark[];
  /** Unfold (FR-FT-120): bends flattened, with `fixed`'s panel held at `anchor`. Panels and bends keep their folded M. */
  unfold?: { fixed: string; anchor: Mat; bends: string[] };
}

/** Where a forming tool sits on the flat pattern: its footprint loop and, for an extruded hole, the pre-pierce hole radius. */
export interface FormMark { pid: string; fid: string; tool: FormTool; c: V2; loop: Seg[]; /** The footprint drawn on the flat pattern. */ mark: Seg[]; pierce?: number }

/** A gusset's rib and groove in folded coordinates: triangles at the near end, swept along `e` by `w` / `wg`. */
export interface GussetMark {
  fid: string; bend: string; rib: V3[]; e: V3; w: number; groove: V3[]; wg: number;
  /** Radii of the rib's / groove's chord edges (0 = sharp): a rounded or filleted tip. */
  rr?: number; rg?: number;
}

/** One line of a cross break: raised towards the panel's top face when `up`. */
export interface CrossLine { pid: string; a: V2; b: V2; side: "top" | "bot"; up: boolean; angle: number; r: number }

/** A sharp fold line between two facets of a lofted bend: towards the top face when `up`. */
export interface SheetFold { a: V2; b: V2; up: boolean; angle: number }

/** A lofted bend's folded solid as facets: bottom and top points per vertex, triangles (ccw seen from the top) and boundary sides. */
export interface SheetMesh {
  bot: V3[]; top: V3[];
  tris: { v: [number, number, number]; pid: string }[];
  /** Boundary edges a → b (in a triangle's ccw order) with the panel and its outline edge they belong to. */
  sides: { a: number; b: number; pid: string; ent: string }[];
}

/** A piece of the flat pattern's outline (arcs counter-clockwise from a0 to a1, as DXF draws them). */
export type FlatEdge =
  | { kind: "line"; a: V2; b: V2 }
  | { kind: "circle"; c: V2; r: number }
  | { kind: "arc"; c: V2; r: number; a0: number; a1: number }
  | { kind: "poly"; pts: V2[] };

/** What a sheet metal feature does to the solid: cut prisms (panel frame, z across the sheet), then new panels and bends. */
export type SheetOp =
  | { kind: "cut"; M: Mat; loop: V2[]; /** A closed outline used instead of `loop`; a piece whose `ent` holds ":" names the face it leaves. */ segs?: Seg[] }
  | { kind: "panel"; panel: Panel }
  | { kind: "bend"; bend: Bend }
  | { kind: "mesh"; mesh: SheetMesh };

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

/**
 * Convert to Sheet Metal: a flange on each bend edge of the fixed plate, each with its own length (to the outer virtual
 * sharp) and angle, material inside so the outer faces stay where the solid's were; flanges meeting at a corner are
 * mitred `gap` apart (the rip). Panels `<fid>:p<i + 1>`, bends `<fid>:b<i>`.
 */
export function convertFlanges(prev: SheetState, items: { faces: [string, string]; length: number; angle: number }[], fid: string, gap: number): { state: SheetState; ops: SheetOp[] } {
  const st = clone(prev);
  const r = st.R;
  const corners = flangeCorners(st, items.map(x => x.faces));
  const ops: SheetOp[] = [];
  items.forEach((it, i) => {
    if (!(it.angle > 1e-6 && it.angle < Math.PI - 1e-3)) throw new SheetError("E-SM-CONVANGLE", "The faces at a bend edge must meet at an angle between 0° and 180°.");
    const d = outerSetback(st.T, it.angle, r);
    const s = it.length - d;
    const E = 2 * (s + d + bendAllowance(st, it.angle, r) + 2 * st.T);
    ops.push(...addFlange(st, it.faces, {
      angle: it.angle, r, s, d, off0: 0, off1: 0, flip: false,
      ext0: corners.some(c => c[1] === i) ? E : 0, ext1: corners.some(c => c[0] === i) ? E : 0,
    }, `${fid}:p${i + 1}`, `${fid}:b${i}`));
  });
  for (const [i, j] of corners) mitre(st, `${fid}:p${i + 1}`, `${fid}:p${j + 1}`, gap);
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

/** A miter flange's profile: the sketch's open chain of lines as world points, in chain order. */
export function miterProfile(sk: SketchFeature, frame: Frame): V3[] {
  const path = sketchPath(sk);
  if (path.error || path.closed || !path.segs.length || path.segs.some(x => x.kind !== "line")) throw new SheetError("E-SM-MITERSK", "The miter flange sketch must be an open chain of lines.");
  const w = (p: V2): V3 => add(add(frame.o, mul(frame.x, p[0])), mul(frame.y, p[1]));
  const segs = path.segs as Extract<Seg, { kind: "line" }>[];
  return [w(segs[0].a), ...segs.map(x => w(x.b))];
}

/**
 * A swept flange's profile: an open chain that starts and ends with a line, with lines meeting either at a sharp
 * corner or through one tangent arc. Returns the virtual-sharp polyline as world points and, per corner (index k =
 * the corner before line k, so `radii[0]` is the edge's bend and always null), the arc radius there or null.
 */
export function sweptProfile(sk: SketchFeature, frame: Frame): { pts: V3[]; radii: (number | null)[] } {
  const path = sketchPath(sk);
  const bad = () => new SheetError("E-SM-SWEPTSK", "The swept flange sketch must be an open chain of lines joined by sharp corners or tangent arcs, starting and ending with a line.");
  if (path.error || path.closed || !path.segs.length || path.segs.some(x => x.kind !== "line" && x.kind !== "arc")) throw bad();
  const segs = path.segs as Extract<Seg, { kind: "line" | "arc" }>[];
  if (segs[0].kind !== "line" || segs.at(-1)!.kind !== "line") throw bad();
  const w = (p: V2): V3 => add(add(frame.o, mul(frame.x, p[0])), mul(frame.y, p[1]));
  const size = Math.max(1, ...segs.flatMap(x => [...x.a, ...x.b].map(Math.abs)));
  const lines: { a: V2; b: V2; r: number | null }[] = [];
  let arc: number | null = null;
  for (const x of segs) {
    if (x.kind === "arc") {
      if (arc != null || !lines.length) throw bad();
      arc = x.r;
      continue;
    }
    lines.push({ a: x.a, b: x.b, r: lines.length ? arc : null });
    arc = null;
  }
  // Each corner's virtual sharp: where the two lines' extensions meet (the lines' own ends when they meet sharp).
  const pts: V2[] = [lines[0].a];
  for (let k = 1; k < lines.length; k++) {
    const A = lines[k - 1], B = lines[k];
    if (B.r == null) { pts.push(A.b); continue; }
    const u: V2 = [A.b[0] - A.a[0], A.b[1] - A.a[1]], v: V2 = [B.b[0] - B.a[0], B.b[1] - B.a[1]];
    const den = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(den) < 1e-12 * size * size) throw bad();
    const t = ((B.a[0] - A.a[0]) * v[1] - (B.a[1] - A.a[1]) * v[0]) / den;
    pts.push([A.a[0] + u[0] * t, A.a[1] + u[1] * t]);
  }
  pts.push(lines.at(-1)!.b);
  return { pts: pts.map(w), radii: lines.map(x => x.r) };
}

/**
 * Miter flange (SolidWorks): the profile, drawn on a plane square to one of the picked edges and starting at it,
 * becomes a chain of bends and flat flanges on every picked edge. Each line of the profile is one level of flanges;
 * the lengths run to the virtual sharps on the profile's side, which is the outside of the first bend.
 * Flanges of edges meeting at a corner of the face run on and are mitred, level by level.
 */
export function miterFlange(prev: SheetState, f: SmMiterFeature, prof: V3[], arcs?: (number | null)[]): { state: SheetState; ops: SheetOp[] } {
  if (!f.edges.length) throw new SheetError("E-SM-NOEDGE", "Pick the edges for the flange.");
  if (prof.length < 2) throw new SheetError("E-SM-MITERSK", "The miter flange sketch must be an open chain of lines.");
  const st = clone(prev);
  const T = st.T, r = f.radius?.v ?? st.R;
  if (!(r >= 0)) throw new SheetError("E-SM-R", "The bend radius can't be negative.");
  // The edge the profile starts at: the picked edge nearest either end of the chain.
  const size = Math.max(1, ...prof.flatMap(p => p.map(Math.abs)));
  type Start = { j: number; pts: V3[]; radii: (number | null)[]; dist: number; o: V3; z: V3; e: V3 };
  const radii = arcs ?? prof.slice(1).map(() => null);
  let best = null as Start | null;
  f.edges.forEach((ref, j) => {
    let found;
    try { found = findEdge(st, ref.faces); } catch { return; }
    const seg = found.panel.outer[found.index];
    if (seg.kind !== "line") return;
    const M = found.panel.M, l = d2(seg.a, seg.b);
    const e2: V2 = [(seg.b[0] - seg.a[0]) / l, (seg.b[1] - seg.a[1]) / l];
    const A = apply(M, [seg.a[0], seg.a[1], T / 2]), e = applyDir(M, [e2[0], e2[1], 0]);
    // Reversed, the corner before line k is the one after line n − 1 − k: shift the radii by one.
    for (const [pts, rr] of [[prof, radii], [[...prof].reverse(), [null, ...[...radii].reverse().slice(0, -1)]]] as [V3[], (number | null)[]][]) {
      const v = sub3(pts[0], A), t = Math.min(Math.max(dot(v, e), 0), l);
      const dist = Math.hypot(...sub3(v, mul(e, t)));
      if (!best || dist < best.dist) best = { j, pts, radii: rr, dist, o: applyDir(M, [e2[1], -e2[0], 0]), z: M.z, e };
    }
  });
  const b = best as Start | null;
  if (!b || b.dist > T + 1e-4 * size) throw new SheetError("E-SM-MITERSTART", "The miter flange profile must start at one of the picked edges.");
  const P0 = b.pts[0];
  if (b.pts.some(p => Math.abs(dot(sub3(p, P0), b.e)) > 1e-5 * size)) throw new SheetError("E-SM-MITERSQ", "Sketch the miter flange profile on a plane square to the edge.");
  // The profile in the edge's (outward, normal) plane; collinear lines joined.
  const lines: { d: V2; L: number; arc: number | null }[] = [];
  for (let i = 1; i < b.pts.length; i++) {
    const q = sub3(b.pts[i], b.pts[i - 1]);
    const u = dot(q, b.o), v = dot(q, b.z), L = Math.hypot(u, v);
    if (L < 1e-9 * size) continue;
    const d: V2 = [u / L, v / L], last = lines.at(-1);
    if (last && Math.abs(last.d[0] * d[1] - last.d[1] * d[0]) < 1e-9 && last.d[0] * d[0] + last.d[1] * d[1] > 0) last.L += L;
    else lines.push({ d, L, arc: lines.length ? b.radii[i - 1] ?? null : null });
  }
  const levels = lines.map((x, k) => {
    const p = k ? lines[k - 1].d : [1, 0] as V2;
    const angle = Math.acos(Math.min(1, Math.max(-1, p[0] * x.d[0] + p[1] * x.d[1])));
    if (!(angle > 1e-6)) throw new SheetError("E-SM-MITERTURN", "The miter flange profile must turn away from the face at the edge.");
    if (!(angle < Math.PI - 1e-3)) throw new SheetError("E-SM-ANGLE", "The flange angle must be between 0° and 180°.");
    return { angle, up: p[0] * x.d[1] - p[1] * x.d[0] > 0, L: x.L, arc: x.arc };
  });
  // A sketched arc is the profile side of its bend: the outside when it turns like the first bend, else the inside.
  const rs = levels.map(x => {
    if (x.arc == null) return r;
    const ri = x.up === levels[0].up ? x.arc - T : x.arc;
    if (!(ri >= -1e-9)) throw new SheetError("E-SM-SWEPTR", "An arc of the swept flange profile is smaller than the sheet thickness on the outside of its bend.");
    return Math.max(ri, 0);
  });
  // The profile lies on the outside of the first bend: later bends the same way have it outside too, the others inside.
  const back = levels.map((x, k) => x.up === levels[0].up ? outerSetback(T, x.angle, rs[k]) : innerSetback(x.angle, rs[k]));
  const flat = levels.map((x, k) => x.L - back[k]);
  levels.forEach((x, k) => {
    if (!(flat[k] - (back[k + 1] ?? 0) > 1e-6)) throw new SheetError("E-SM-MITERLEN", "A line of the miter flange profile is too short for its bends.");
  });
  const nE = f.edges.length;
  const corners = flangeCorners(st, f.edges.map(x => x.faces));
  // Each corner's mitre plane: through the face's corner, square to the face, bisecting the two edges. The same
  // profile on both edges meets itself there at every level (coplanar flanges too, which mid-planes can't place).
  const planes = corners.map(([i, j]) => {
    const a = findEdge(st, f.edges[i].faces), c = findEdge(st, f.edges[j].faces);
    const sa = a.panel.outer[a.index], sc = c.panel.outer[c.index];
    if (sa.kind !== "line" || sc.kind !== "line") return null;
    const ua = applyDir(a.panel.M, [sa.b[0] - sa.a[0], sa.b[1] - sa.a[1], 0]), uc = applyDir(a.panel.M, [sc.b[0] - sc.a[0], sc.b[1] - sc.a[1], 0]);
    const n = add(mul(ua, 1 / Math.hypot(...ua)), mul(uc, 1 / Math.hypot(...uc))), nl = Math.hypot(...n);
    return nl < 1e-9 ? null : { V: apply(a.panel.M, [sa.b[0], sa.b[1], T / 2]), n: mul(n, 1 / nl) };
  });
  const E = 2 * Math.max(...levels.map((x, k) => flat[k] + back[k] + bendAllowance(st, x.angle, rs[k]) + 2 * T));
  const gap = Math.max(f.gap?.v ?? 0.1, 0);
  const ops: SheetOp[] = [];
  const pid = (k: number, j: number) => `${f.id}:p${k * nE + j}`;
  levels.forEach((x, k) => {
    f.edges.forEach((ref, j) => {
      let faces: [string, string], flip: boolean;
      if (k === 0) { faces = ref.faces; flip = findEdge(st, ref.faces).up !== x.up; }
      else { faces = [`${pid(k - 1, j)}:tip`, `${pid(k - 1, j)}:top`]; flip = !x.up; }
      ops.push(...addFlange(st, faces, {
        angle: x.angle, r: rs[k], s: flat[k], d: back[k], off0: 0, off1: 0, flip,
        ext0: corners.some(c => c[1] === j) ? E : 0, ext1: corners.some(c => c[0] === j) ? E : 0,
      }, pid(k, j), `${f.id}:b${k * nE + j}`));
    });
    corners.forEach(([i, j], c) => { const pl = planes[c]; if (pl) { planeCut(st, pid(k, i), pl.V, pl.n, -1, gap); planeCut(st, pid(k, j), pl.V, pl.n, 1, gap); } });
  });
  return { state: st, ops };
}

/** Clips a panel's outline where the world plane through V with unit normal n crosses its mid-plane, keeping the
 * side `keep` (+1: n·(X − V) ≥ gap/2, −1: ≤ −gap/2); the new edges are named "miter". */
function planeCut(st: SheetState, id: string, V: V3, n: V3, keep: 1 | -1, gap: number) {
  const P = st.panels.find(p => p.id === id);
  if (!P) return;
  const n2: V2 = [dot(n, P.M.x), dot(n, P.M.y)], l = Math.hypot(...n2);
  if (l < 1e-9) return;
  const k = (dot(n, V) - dot(n, P.M.o) - (st.T / 2) * dot(n, P.M.z)) / l + keep * gap / (2 * l);
  try { P.outer = clipOuter(P.outer, [n2[0] / l, n2[1] / l], k, keep, "miter", 1e-7 * (1 + st.T)); } catch { /* the plane misses the panel */ }
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

/** Break corner: each picked thickness edge's corner of a flat face chamfered or rounded, in the outline itself, so the flat pattern follows. */
export function breakCorner(prev: SheetState, f: SmCornerFeature): { state: SheetState; ops: SheetOp[] } {
  if (!f.edges.length) throw new SheetError("E-SM-NOCORNER", "Pick the corner edges to break.");
  const size = f.size.v;
  if (!(size > 1e-6)) throw new SheetError("E-SM-SIZE", "The size must be more than 0.");
  const st = clone(prev);
  const ops: SheetOp[] = [];
  for (const ref of f.edges) {
    const { panel, i, j } = cornerOf(st, ref.faces);
    const sa = panel.outer[i], sb = panel.outer[j];
    if (sa.kind !== "line" || sb.kind !== "line") throw new SheetError("E-SM-CORNERLINE", "Break corners between straight edges.");
    const V = sa.b;
    const l1 = d2(sa.a, sa.b), l2 = d2(sb.a, sb.b);
    const u1: V2 = [(sa.b[0] - sa.a[0]) / l1, (sa.b[1] - sa.a[1]) / l1], u2: V2 = [(sb.b[0] - sb.a[0]) / l2, (sb.b[1] - sb.a[1]) / l2];
    const turn = Math.atan2(u1[0] * u2[1] - u1[1] * u2[0], u1[0] * u2[0] + u1[1] * u2[1]);
    // Outer loops run counter-clockwise, so an outside corner turns left.
    if (turn < 1e-6 || turn > Math.PI - 1e-6) throw new SheetError("E-SM-CONVEX", "Break outside corners only.");
    // Along each edge from the corner: the chamfer distance, or the fillet's tangent length r·tan(turn / 2).
    const t = f.kind === "fillet" ? size * Math.tan(turn / 2) : size;
    if (t >= l1 - 1e-6 || t >= l2 - 1e-6) throw new SheetError("E-SM-CORNERBIG", "The corner size is longer than an edge at the corner.");
    const P1 = p2(V, s2(u1, -t)), P2 = p2(V, s2(u2, t));
    const ent = `x${panel.n++}`;
    const piece: Seg = f.kind === "fillet"
      ? { ent, kind: "arc", c: p2(P1, [-u1[1] * size, u1[0] * size]), r: size, a: P1, b: P2, ccw: true }
      : line(ent, P1, P2);
    panel.outer[i] = { ...sa, b: P1 };
    panel.outer[j] = { ...sb, a: P2 };
    panel.outer.splice(j === 0 ? panel.outer.length : j, 0, piece);
    // The corner piece cut away; its side on the new piece names the new face.
    const back: Seg = piece.kind === "arc" ? { ...piece, ent: `${panel.id}:${ent}`, a: P2, b: P1, ccw: false } : line(`${panel.id}:${ent}`, P2, P1);
    ops.push({ kind: "cut", M: panel.M, loop: [P1, V, P2], segs: [line("c0", P1, V), line("c1", V, P2), back] });
  }
  return { state: st, ops };
}

/** Closed corner (SolidWorks): each picked flange end face moves along its flange to the neighbouring flange,
 * over that flange's end (overlap) or up to its inside face less the gap (underlap), and the neighbour's end
 * facing it moves the other way to close the corner. The flat outlines move with them. */
export function closedCorner(prev: SheetState, f: SmClosedFeature): { state: SheetState; ops: SheetOp[] } {
  if (!f.faces.length) throw new SheetError("E-SM-NOFACE", "Pick the end faces of the flanges to close.");
  const st = clone(prev);
  const T = st.T, gap = Math.max(f.gap?.v ?? 0.1, 0);
  const reach = 2 * T + st.R + gap + 1e-6;
  const ops: SheetOp[] = [];
  for (const ref of f.faces) {
    const k = ref.name.lastIndexOf(":");
    const pid = ref.name.slice(0, k), eid = ref.name.slice(k + 1);
    const A = st.panels.find(p => p.id === pid);
    const i = A ? A.outer.findIndex(x => x.ent === eid) : -1;
    if (!A || i < 0) throw new SheetError("E-SM-ENDFACE", "Pick an end face of a flange (a side face across its thickness).");
    const ea = endFace(A, i, T);
    if (!ea) throw new SheetError("E-SM-CLOSEDSHAPE", "The end face must be flat and square to the flange's edges.");
    // The nearest other flat face ahead whose planes the end face would cross, beside its outline.
    let best: { B: Panel; near: number; far: number } | null = null;
    for (const B of st.panels) {
      if (B === A) continue;
      const h = planeHits(ea.P, ea.dir, B, T);
      if (!h || h.far < -1e-6 || !beside(B, add(ea.P, mul(ea.dir, (h.near + h.far) / 2)), reach)) continue;
      if (!best || h.far < best.far) best = { B, ...h };
    }
    if (!best) throw new SheetError("E-SM-NOMATE", "No flange to close against was found beyond this face.");
    const over = f.kind === "overlap";
    moveEnd(A, i, over ? best.far : best.near - gap, ops);
    // The neighbour's end facing this flange closes the rest: up to its inside face less the gap, or over it.
    const B = best.B;
    let back: { j: number; near: number; far: number } | null = null;
    B.outer.forEach((_s, j) => {
      const eb = endFace(B, j, T);
      if (!eb) return;
      const h = planeHits(eb.P, eb.dir, A, T);
      if (!h || h.far < -1e-6 || h.near > reach || !beside(A, add(eb.P, mul(eb.dir, h.near)), reach)) return;
      if (!back || h.near < back.near) back = { j, ...h };
    });
    if (back) { const bk = back as { j: number; near: number; far: number }; moveEnd(B, bk.j, over ? bk.near - gap : bk.far, ops); }
  }
  return { state: st, ops };
}

/** A flat end face of a panel: a straight piece with straight neighbours square to it; its middle and outward direction in 3D. */
function endFace(A: Panel, i: number, T: number): { n: V2; P: V3; dir: V3 } | null {
  const nO = A.outer.length;
  const seg = A.outer[i], pre = A.outer[(i + nO - 1) % nO], nxt = A.outer[(i + 1) % nO];
  if (seg.kind !== "line" || pre.kind !== "line" || nxt.kind !== "line") return null;
  const l = d2(seg.a, seg.b);
  if (l < 1e-9) return null;
  // Out of the face: to the right of a counter-clockwise outline.
  const n: V2 = [(seg.b[1] - seg.a[1]) / l, -(seg.b[0] - seg.a[0]) / l];
  const skew = (s: Line) => { const u: V2 = [s.b[0] - s.a[0], s.b[1] - s.a[1]]; return Math.abs(u[0] * n[1] - u[1] * n[0]) / (Math.hypot(...u) || 1); };
  if (skew(pre) > 1e-6 || skew(nxt) > 1e-6) return null;
  const m: V2 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
  return { n, P: apply(A.M, [m[0], m[1], T / 2]), dir: applyDir(A.M, [n[0], n[1], 0]) };
}

/** Where a ray from P along dir crosses panel B's two faces (near and far), if it meets them squarely enough. */
function planeHits(P: V3, dir: V3, B: Panel, T: number): { near: number; far: number } | null {
  const den = dot(B.M.z, dir);
  if (Math.abs(den) < 0.5) return null;
  const h0 = dot(B.M.z, B.M.o) - dot(B.M.z, P);
  const t0 = h0 / den, t1 = (h0 + T) / den;
  return { near: Math.min(t0, t1), far: Math.max(t0, t1) };
}

/** A 3D point lies over panel B's outline, or within `reach` of it. */
function beside(B: Panel, Q: V3, reach: number): boolean {
  const q3 = local(B.M, Q), q: V2 = [q3[0], q3[1]];
  return inPolygon(q, loopPolygon(B.outer)) || onLoop(B.outer, q, reach);
}

/** Moves panel A's end piece i out by d (back when negative): a strip joined on, or cut off, and the outline updated. */
function moveEnd(A: Panel, i: number, d: number, ops: SheetOp[]) {
  if (Math.abs(d) < 1e-7) return;
  const nO = A.outer.length;
  const seg = A.outer[i] as Line, pre = A.outer[(i + nO - 1) % nO] as Line, nxt = A.outer[(i + 1) % nO] as Line;
  const l = d2(seg.a, seg.b), n: V2 = [(seg.b[1] - seg.a[1]) / l, -(seg.b[0] - seg.a[0]) / l];
  const a2 = p2(seg.a, s2(n, d)), b2 = p2(seg.b, s2(n, d));
  if (d > 0) {
    // A strip on the end, named as the panel so its faces read as the flange's.
    ops.push({ kind: "panel", panel: { id: A.id, outer: polyLoop([seg.a, a2, b2, seg.b], [pre.ent, seg.ent, nxt.ent, "join"]), holes: [], M: A.M, n: 0 } });
  } else {
    if (-d >= Math.min(d2(pre.a, pre.b), d2(nxt.a, nxt.b)) - 1e-6) throw new SheetError("E-SM-CLOSEDBIG", "The flange would be cut away.");
    ops.push({ kind: "cut", M: A.M, loop: [a2, seg.a, seg.b, b2], segs: [line(`${A.id}:${seg.ent}`, a2, b2), line("c0", b2, seg.b), line("c1", seg.b, seg.a), line("c2", seg.a, a2)] });
  }
  A.outer[(i + nO - 1) % nO] = { ...pre, b: a2 };
  A.outer[i] = { ...seg, a: a2, b: b2 };
  A.outer[(i + 1) % nO] = { ...nxt, a: b2 };
}

/** The panel and the two outline pieces (i ends where j starts) at a picked thickness edge. */
function cornerOf(st: SheetState, faces: [string, string]): { panel: Panel; i: number; j: number } {
  const split = (n: string) => { const k = n.lastIndexOf(":"); return [n.slice(0, k), n.slice(k + 1)] as const; };
  const [pa, ea] = split(faces[0]), [pb, eb] = split(faces[1]);
  const panel = pa === pb ? st.panels.find(p => p.id === pa) : undefined;
  if (panel) {
    const ia = panel.outer.findIndex(s => s.ent === ea), ib = panel.outer.findIndex(s => s.ent === eb);
    const n = panel.outer.length;
    if (ia >= 0 && ib >= 0) {
      if ((ia + 1) % n === ib) return { panel, i: ia, j: ib };
      if ((ib + 1) % n === ia) return { panel, i: ib, j: ia };
    }
  }
  throw new SheetError("E-SM-CORNER", "Pick an edge across the thickness at an outside corner of a flat face.");
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

interface BendFold { up: boolean; angle: number; r: number }

/**
 * Folds a panel along a flat line: the panel is split there, the moving side becomes new panels joined
 * by the bends `folds` (with flat gaps `gaps` between them). The flat pattern keeps its outline.
 */
function foldPanel(st: SheetState, panel: Panel, a: V2, b: V2, flip: boolean, position: BendPosition, folds: BendFold[], gaps: number[], fid: string): SheetOp[] {
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
  return [...st.bends.map(b => { const [p, q] = bendLine(b); return { a: apply(st.root, [p[0], p[1], st.T]), b: apply(st.root, [q[0], q[1], st.T]), up: b.up }; }),
    ...(st.folds ?? []).map(f => ({ a: apply(st.root, [f.a[0], f.a[1], st.T]), b: apply(st.root, [f.b[0], f.b[1], st.T]), up: f.up }))];
}

/** A copy of a sheet metal part with its flat pattern shown (the Flat-Pattern feature on, or added last); null for other parts. */
export function flatPatternDoc(doc: PartDoc): PartDoc | null {
  if (!doc.features.some(isSheetBase)) return null;
  const d: PartDoc = structuredClone(doc);
  d.rollback = null;
  const f = d.features.find(x => x.type === "smflat");
  if (f) f.suppressed = false;
  else d.features.push({ id: "__flat", type: "smflat", name: "Flat-Pattern" });
  return d;
}

/** A bend line on the flat pattern, in flat coordinates on the top face (z = T), with what its note says. */
export interface FlatBend { a: V3; b: V3; up: boolean; angle: number; r: number }
export function flatBends(st: SheetState): FlatBend[] {
  return [...st.bends.map(b => { const [p, q] = bendLine(b); return { a: [p[0], p[1], st.T], b: [q[0], q[1], st.T], up: b.up, angle: b.angle, r: b.r } as FlatBend; }),
    ...(st.folds ?? []).map(f => ({ a: [f.a[0], f.a[1], st.T], b: [f.b[0], f.b[1], st.T], up: f.up, angle: f.angle, r: 0 } as FlatBend))];
}

/** The rigid move that lays the flat pattern on the world XY plane (flat coordinates), as a 3×4 row-major matrix: root⁻¹. */
export function flatToXY(st: SheetState): number[] {
  const R = st.root, rows = [R.x, R.y, R.z];
  return rows.flatMap(r => [r[0], r[1], r[2], -(r[0] * R.o[0] + r[1] * R.o[1] + r[2] * R.o[2])]);
}

// ---------- lofted bend ----------

/** An open profile of lines and arcs as world points, each arc split into `n` straight pieces. */
function loftProfile(sk: SketchFeature, frame: Frame, n: number): V3[] {
  const path = sketchPath(sk);
  if (path.error || path.closed || !path.segs.length || path.segs.some(x => x.kind !== "line" && x.kind !== "arc"))
    throw new SheetError("E-SM-LOFTSK", "Each lofted bend profile must be an open chain of lines and arcs.");
  const w = (p: V2): V3 => add(add(frame.o, mul(frame.x, p[0])), mul(frame.y, p[1]));
  const segs = path.segs as Extract<Seg, { kind: "line" | "arc" }>[];
  const pts: V2[] = [segs[0].a];
  for (const s of segs) {
    if (s.kind === "arc") {
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
      let sw = a1 - a0;
      if (s.ccw) { while (sw <= 1e-12) sw += 2 * Math.PI; } else { while (sw >= -1e-12) sw -= 2 * Math.PI; }
      for (let i = 1; i < n; i++) pts.push([s.c[0] + s.r * Math.cos(a0 + sw * i / n), s.c[1] + s.r * Math.sin(a0 + sw * i / n)]);
    }
    pts.push(s.b);
  }
  return pts.map(w);
}

/** Normalised arc-length parameter of each point of a polyline. */
function arcParams(p: V3[]): number[] {
  const t = [0];
  for (let i = 1; i < p.length; i++) t.push(t[i - 1] + Math.hypot(...sub3(p[i], p[i - 1])));
  const L = t.at(-1)!;
  if (!(L > 1e-9)) throw new SheetError("E-SM-LOFTSK", "Each lofted bend profile must be an open chain of lines and arcs.");
  return t.map(x => x / L);
}

/** The point at parameter u along a polyline with parameters t. */
function atParam(p: V3[], t: number[], u: number): V3 {
  let i = 0;
  while (i < t.length - 2 && t[i + 1] < u) i++;
  const s = t[i + 1] - t[i] > 0 ? Math.min(1, Math.max(0, (u - t[i]) / (t[i + 1] - t[i]))) : 0;
  return add(p[i], mul(sub3(p[i + 1], p[i]), s));
}

/** The offset direction at a vertex: v · n = 1 for each (different) facet normal n there, least squares past three. */
function offsetDir(ns: V3[]): V3 {
  const dist: V3[] = [];
  for (const n of ns) if (!dist.some(m => dot(m, n) > 1 - 1e-10)) dist.push(n);
  if (dist.length === 1) return dist[0];
  if (dist.length === 2) { const c = 1 + dot(dist[0], dist[1]); return mul(add(dist[0], dist[1]), 1 / Math.max(c, 0.05)); }
  // (Aᵀ A + λ I) v = Aᵀ 1 + λ m: nearly parallel normals leave v close to the mitre of their mean m.
  const m0 = unit(dist.reduce((a, n) => add(a, n), [0, 0, 0] as V3));
  const m = mul(m0, 1 / Math.max(0.05, dist.reduce((a, n) => a + dot(m0, n), 0) / dist.length));
  const lam = 1e-4;
  const A = [0, 1, 2].map(r => [0, 1, 2].map(c => dist.reduce((a, n) => a + n[r] * n[c], 0) + (r === c ? lam : 0)));
  const b = [0, 1, 2].map(r => dist.reduce((a, n) => a + n[r], 0) + lam * m[r]);
  const det = (M: number[][]) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return m;
  const v = [0, 1, 2].map(j => det(A.map((row, r) => row.map((x, c) => (c === j ? b[r] : x)))) / D) as V3;
  return Math.hypot(...v) > 20 ? m : v;
}

/**
 * Lofted bend: the two profiles are sampled at matching arc-length parameters (every corner of either kept), the
 * strip between them split into triangles along the shorter diagonal of each quad, and triangles lying in one
 * plane joined into panels. The profiles are the sheet's bottom face; the neutral surface (K-factor) is unfolded
 * triangle by triangle, so lengths there are kept and the folds between panels become the flat pattern's bend lines.
 */
export function loftedBend(f: SmLoftFeature, sk1: SketchFeature, fr1: Frame, sk2: SketchFeature, fr2: Frame): { state: SheetState; ops: SheetOp[] } {
  const T = f.thickness.v, k = f.k ?? 0.5, R = f.radius.v;
  if (!(T > 1e-6)) throw new SheetError("E-SM-T", "The thickness must be more than 0.");
  if (!(R >= 0)) throw new SheetError("E-SM-R", "The bend radius can't be negative.");
  if (!(k >= 0 && k <= 1)) throw new SheetError("E-SM-K", "The K-factor must be between 0 and 1.");
  if (sk1.id === sk2.id) throw new SheetError("E-SM-LOFT2", "Pick two different sketches for the lofted bend.");
  const n = Math.max(1, Math.min(64, Math.round(f.facets ?? 8)));
  const A0 = loftProfile(sk1, fr1, n);
  let B0 = loftProfile(sk2, fr2, n);
  const d = (a: V3, b: V3) => Math.hypot(...sub3(a, b));
  if (d(A0[0], B0[0]) + d(A0.at(-1)!, B0.at(-1)!) > d(A0[0], B0.at(-1)!) + d(A0.at(-1)!, B0[0])) B0 = [...B0].reverse();
  const ta = arcParams(A0), tb = arcParams(B0);
  const us: number[] = [];
  for (const u of [...ta, ...tb].sort((x, y) => x - y)) if (!us.length || u - us.at(-1)! > 1e-6) us.push(u);
  us[us.length - 1] = 1;
  const m = us.length;
  const pts: V3[] = [...us.map(u => atParam(A0, ta, u)), ...us.map(u => atParam(B0, tb, u))];
  const size = Math.max(1, ...pts.flatMap(p => p.map(Math.abs)));
  const tol = size * 1e-9;
  const ia = (i: number) => i, ib = (i: number) => (d(pts[i], pts[m + i]) < tol ? i : m + i);
  // Triangles in strip order, each sharing an edge with one before it; quad i is a_i, a_i+1, b_i+1, b_i.
  const raw: [number, number, number][] = [];
  for (let i = 0; i < m - 1; i++) {
    const a = ia(i), a1 = ia(i + 1), b = ib(i), b1 = ib(i + 1);
    if (d(pts[a], pts[b1]) <= d(pts[a1], pts[b])) raw.push([a, b1, b], [a, a1, b1]);
    else raw.push([a, a1, b], [a1, b1, b]);
  }
  const nrm = (t: [number, number, number]) => cross(sub3(pts[t[1]], pts[t[0]]), sub3(pts[t[2]], pts[t[0]]));
  let tris = raw.filter(t => new Set(t).size === 3 && Math.hypot(...nrm(t)) > tol * size);
  if (!tris.length) throw new SheetError("E-SM-LOFTFLAT", "The two profiles make no sheet between them.");
  if (f.reverse) tris = tris.map(([p, q, r]) => [p, r, q]);
  const tn = tris.map(t => unit(nrm(t)));
  // Neighbours across shared edges.
  const key = (u: number, v: number) => `${u}>${v}`;
  const owner = new Map<string, number>();
  tris.forEach((t, j) => t.forEach((u, q) => owner.set(key(u, t[(q + 1) % 3]), j)));
  // Panels: triangles in one plane, joined across shared edges.
  const group = tris.map((_t, j) => j);
  const find = (j: number): number => (group[j] === j ? j : (group[j] = find(group[j])));
  tris.forEach((t, j) => t.forEach((u, q) => {
    const o = owner.get(key(t[(q + 1) % 3], u));
    if (o != null && dot(tn[j], tn[o]) > 1 - 1e-10) group[find(o)] = find(j);
  }));
  const roots = [...new Set(tris.map((_t, j) => find(j)))];
  const pidOf = (j: number) => `${f.id}:p${roots.indexOf(find(j))}`;
  // Bottom = the profiles, top = T along each vertex's offset direction, neutral surface k·T.
  const vn: V3[][] = pts.map(() => []);
  tris.forEach((t, j) => t.forEach(u => vn[u].push(tn[j])));
  const off = vn.map(ns => (ns.length ? offsetDir(ns) : [0, 0, 0] as V3));
  const top = pts.map((p, i) => add(p, mul(off[i], T)));
  const neu = pts.map((p, i) => add(p, mul(off[i], k * T)));
  // Unfold the neutral triangles: a vertex's flat point is set by the first triangle that reaches it.
  const flat = new Map<number, V2>();
  for (const t of tris) {
    const placed = t.filter(u => flat.has(u)).length;
    if (placed === 3) continue;
    let [p, q, r] = t;
    if (placed === 0) {
      if (flat.size) throw new SheetError("E-SM-LOFTFLAT", "The lofted bend could not be unfolded.");
      flat.set(p, [0, 0]);
      flat.set(q, [d(neu[p], neu[q]), 0]);
    } else if (placed === 1) throw new SheetError("E-SM-LOFTFLAT", "The lofted bend could not be unfolded.");
    // The unplaced vertex last: it lies left of p → q (counter-clockwise).
    while (flat.has(r)) [p, q, r] = [q, r, p];
    const fp = flat.get(p)!, fq = flat.get(q)!;
    const L = d2(fp, fq), e: V2 = [(fq[0] - fp[0]) / L, (fq[1] - fp[1]) / L];
    const dp = d(neu[r], neu[p]), dq = d(neu[r], neu[q]);
    const x = (dp * dp - dq * dq + L * L) / (2 * L), h = Math.sqrt(Math.max(0, dp * dp - x * x));
    flat.set(r, [fp[0] + x * e[0] - h * e[1], fp[1] + x * e[1] + h * e[0]]);
  }
  // Lay the pattern with the first profile's first piece along +x from the origin.
  const o0 = flat.get(ia(0)), o1 = flat.get(ia(1));
  if (o0 && o1) {
    const th = Math.atan2(o1[1] - o0[1], o1[0] - o0[0]), c = Math.cos(th), sn = Math.sin(th);
    for (const [u, p] of flat) flat.set(u, [(p[0] - o0[0]) * c + (p[1] - o0[1]) * sn, -(p[0] - o0[0]) * sn + (p[1] - o0[1]) * c]);
  }
  // Each panel's transform from its first triangle: flat → neutral at z = k·T.
  const matFor = (t: [number, number, number], nz: V3): Mat => {
    const [p, q] = t;
    const e3 = unit(sub3(neu[q], neu[p])), w3 = cross(nz, e3);
    const fp = flat.get(p)!, fq = flat.get(q)!, L = d2(fp, fq);
    const ex = (fq[0] - fp[0]) / L, ey = (fq[1] - fp[1]) / L;
    const x = add(mul(e3, ex), mul(w3, -ey)), y = add(mul(e3, ey), mul(w3, ex));
    const o = sub3(sub3(sub3(neu[p], mul(nz, k * T)), mul(x, fp[0])), mul(y, fp[1]));
    return { o, x, y, z: nz };
  };
  const st: SheetState = { T, R, calc: "k", k, relief: "rect", reliefRatio: 0.5, root: matFor(tris[0], tn[0]), panels: [], bends: [], used: [], folds: [], faceted: true };
  const fl = (u: number) => flat.get(u)!;
  const sides: SheetMesh["sides"] = [];
  roots.forEach((g, gi) => {
    const mine = tris.map((t, j) => ({ t, j })).filter(x => find(x.j) === g);
    // Boundary edges of the panel, chained into its outline.
    const edges: [number, number][] = [];
    for (const { t, j } of mine) t.forEach((u, q) => {
      const v = t[(q + 1) % 3], o = owner.get(key(v, u));
      if (o == null || find(o) !== g) edges.push([u, v]);
      if (o != null && find(o) !== g && j < o) {
        // A fold between two panels, counted once.
        const other = tris[o], c = other.find(x => x !== u && x !== v)!;
        st.folds!.push({ a: fl(u), b: fl(v), up: dot(sub3(neu[c], neu[u]), tn[j]) > 0, angle: Math.acos(Math.max(-1, Math.min(1, dot(tn[j], tn[o])))) });
      }
    });
    const loop: [number, number][] = [edges.shift()!];
    while (edges.length) {
      const i = edges.findIndex(([u]) => u === loop.at(-1)![1]);
      if (i < 0) break;
      loop.push(edges.splice(i, 1)[0]);
    }
    if (edges.length) throw new SheetError("E-SM-LOFTFLAT", "The lofted bend could not be unfolded.");
    const segs = mergeLines(loop.map(([u, v], q) => line(`x${q}`, fl(u), fl(v))), size * 1e-9).map((s, q) => ({ ...s, ent: `e${q}` }));
    const pid = `${f.id}:p${gi}`;
    st.panels.push({ id: pid, outer: segs, holes: [], M: matFor(mine[0].t, tn[mine[0].j]), n: 0 });
    // The mesh's boundary sides: outline edges no other triangle shares.
    for (const { t } of mine) t.forEach((u, q) => {
      const v = t[(q + 1) % 3];
      if (owner.has(key(v, u))) return;
      const mid: V2 = [(fl(u)[0] + fl(v)[0]) / 2, (fl(u)[1] + fl(v)[1]) / 2];
      let best = segs[0].ent, bd = Infinity;
      for (const s of segs) {
        if (s.kind !== "line") continue;
        const ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], l2 = ux * ux + uy * uy || 1;
        const c = Math.max(0, Math.min(1, ((mid[0] - s.a[0]) * ux + (mid[1] - s.a[1]) * uy) / l2));
        const dd = Math.hypot(mid[0] - s.a[0] - c * ux, mid[1] - s.a[1] - c * uy);
        if (dd < bd) { bd = dd; best = s.ent; }
      }
      sides.push({ a: u, b: v, pid, ent: best });
    });
  });
  const mesh: SheetMesh = { bot: pts, top, tris: tris.map((t, j) => ({ v: t, pid: pidOf(j) })), sides };
  return { state: st, ops: [{ kind: "mesh", mesh }] };
}

// ---------- cross break ----------

/**
 * Cross break: two lines corner to corner across each picked flat face. The first joins the two outline points
 * farthest apart, the second the points farthest out on either side of it; the solid stays as it is.
 */
export function crossBreak(st: SheetState, f: SmCrossFeature): { state: SheetState; ops: SheetOp[] } {
  const angle = f.angle.v, r = f.radius.v;
  if (!(angle > 0 && angle < Math.PI / 2)) throw new SheetError("E-SM-CROSSANG", "The cross break angle must be between 0° and 90°.");
  if (!(r >= 0)) throw new SheetError("E-SM-R", "The bend radius can't be negative.");
  if (!f.faces.length) throw new SheetError("E-SM-CROSSFACE", "Pick a flat face of the sheet (its top or bottom).");
  const out: CrossLine[] = [...(st.crosses ?? [])];
  for (const fr of f.faces) {
    const m = /^(.*):(top|bot)$/.exec(fr.name);
    const panel = m ? st.panels.find(p => p.id === m[1]) : undefined;
    if (!m || !panel) throw new SheetError("E-SM-CROSSFACE", "Pick a flat face of the sheet (its top or bottom).");
    const side = m[2] as "top" | "bot";
    const poly = loopPolygon(panel.outer, 16);
    let p = poly[0], q = poly[0], best = -1;
    for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) { const dd = d2(poly[i], poly[j]); if (dd > best) { best = dd; p = poly[i]; q = poly[j]; } }
    const L = d2(p, q);
    if (!(L > 1e-9)) throw new SheetError("E-SM-CROSSFACE", "Pick a flat face of the sheet (its top or bottom).");
    const left = (x: V2) => ((q[0] - p[0]) * (x[1] - p[1]) - (q[1] - p[1]) * (x[0] - p[0])) / L;
    let a = poly[0], b = poly[0];
    for (const x of poly) { if (left(x) > left(a)) a = x; if (left(x) < left(b)) b = x; }
    if (left(a) < L * 1e-3 || left(b) > -L * 1e-3) throw new SheetError("E-SM-CROSSFACE", "Pick a flat face of the sheet (its top or bottom).");
    const up = (side === "top") !== !!f.flip;
    out.push({ pid: panel.id, a: p, b: q, side, up, angle, r }, { pid: panel.id, a, b, side, up, angle, r });
  }
  return { state: { ...st, crosses: out }, ops: [] };
}

/** Cross break lines in world coordinates: on the panel faces when folded, on the flat pattern's top when flat. */
export function crossBreakLines(st: SheetState, flat: boolean): { a: V3; b: V3; up: boolean }[] {
  return (st.crosses ?? []).flatMap(c => {
    if (flat) return [{ a: apply(st.root, [c.a[0], c.a[1], st.T]), b: apply(st.root, [c.b[0], c.b[1], st.T]), up: c.up }];
    const p = st.panels.find(x => x.id === c.pid);
    if (!p) return [];
    // A hair off the face so the lines aren't hidden in it.
    const z = c.side === "top" ? st.T * 1.01 : -st.T * 0.01;
    return [{ a: apply(p.M, [c.a[0], c.a[1], z]), b: apply(p.M, [c.b[0], c.b[1], z]), up: c.up }];
  });
}

// ---------- vent ----------

/** A vent sketch read as boundary (ccw), ribs (lines) and spars (circles), in sketch coordinates. */
export interface VentLayout { boundary: Seg[]; ribs: { a: V2; b: V2 }[]; spars: { c: V2; r: number }[] }

/**
 * Reads a vent sketch: lines with an end no other curve shares are ribs; the remaining curves form closed loops, the
 * one of largest area is the boundary and every other one must be a circle inside it (a spar).
 */
export function ventLayout(sk: SketchFeature): VentLayout {
  const segs = sketchCurves(sk);
  let size = 1;
  for (const e of sk.ents) if (e.t === "point") size = Math.max(size, Math.abs(e.x), Math.abs(e.y));
  const tol = size * 1e-7 + 1e-9;
  const key = (p: V2) => `${Math.round(p[0] / tol)}:${Math.round(p[1] / tol)}`;
  const count = new Map<string, number>();
  const ends = (x: Seg): V2[] => x.kind === "line" || x.kind === "arc" || x.kind === "earc" ? [x.a, x.b] : [];
  for (const x of segs) for (const p of ends(x)) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
  const ribs: { a: V2; b: V2 }[] = [];
  const skip = new Set<string>();
  for (const x of segs) if (x.kind === "line" && ends(x).some(p => count.get(key(p)) === 1)) { ribs.push({ a: x.a, b: x.b }); skip.add(x.ent); }
  const prof = sketchProfile(sk, skip);
  const loops = prof.error ? [] : prof.faces.flatMap(f => [f.outer, ...f.holes]);
  if (!loops.length) throw new SheetError("E-SM-VENTBOUND", "The vent sketch needs a closed boundary.");
  const area = (l: Seg[]) => Math.abs(polyArea(loopPolygon(l)));
  const bi = loops.reduce((best, l, i) => area(l) > area(loops[best]) ? i : best, 0);
  const boundary = loops[bi];
  const poly = loopPolygon(boundary, 32);
  const spars: { c: V2; r: number }[] = [];
  loops.forEach((l, i) => {
    if (i === bi) return;
    if (l.length !== 1 || l[0].kind !== "circle" || !inPolygon(l[0].c, poly)) throw new SheetError("E-SM-VENTSPAR", "Spars must be circles inside the vent boundary.");
    spars.push({ c: l[0].c, r: l[0].r });
  });
  return { boundary, ribs, spars };
}

/** Checks that a vent sketch lies on a flat face of the sheet (its top or bottom) and touches it. */
export function ventPanel(st: SheetState, pts: V3[]): Panel {
  const tol = 1e-4 * (1 + st.T);
  for (const panel of st.panels) {
    const lp = pts.map(p => local(panel.M, p));
    for (const z of [0, st.T]) {
      if (lp.some(p => Math.abs(p[2] - z) > tol)) continue;
      const poly = loopPolygon(panel.outer, 32);
      if (lp.some(p => inPolygon([p[0], p[1]], poly))) return panel;
    }
  }
  throw new SheetError("E-SM-VENTFACE", "Sketch the vent on a flat face of the sheet.");
}

// ---------- forming tools ----------

/** One placed forming tool: the panel, its centre and turn in flat coordinates, and which way it stands out. */
export interface FormItem { pid: string; M: Mat; c: V2; ang: number; up: boolean; loop: Seg[] }

const rot = (c: V2, a: number, p: V2): V2 => [c[0] + p[0] * Math.cos(a) - p[1] * Math.sin(a), c[1] + p[0] * Math.sin(a) + p[1] * Math.cos(a)];

/** A rounded slot of overall length L and width w along local x, ccw, turned by a about c. */
export function obroundLoop(c: V2, L: number, w: number, a: number, ent = "f"): Seg[] {
  const r = w / 2, h = Math.max(0, L / 2 - r);
  if (h < 1e-9) return [{ ent, kind: "circle", c, r }];
  const P = (x: number, y: number) => rot(c, a, [x, y]);
  return [
    { ent: `${ent}0`, kind: "line", a: P(-h, -r), b: P(h, -r) },
    { ent: `${ent}1`, kind: "arc", c: P(h, 0), r, a: P(h, -r), b: P(h, r), ccw: true },
    { ent: `${ent}2`, kind: "line", a: P(h, r), b: P(-h, r) },
    { ent: `${ent}3`, kind: "arc", c: P(-h, 0), r, a: P(-h, r), b: P(-h, -r), ccw: true },
  ];
}

/** A rectangle L × w centred on c along local x, ccw, turned by a. */
export function rectLoop(c: V2, L: number, w: number, a: number, ent = "f"): Seg[] {
  const q = [[-L / 2, -w / 2], [L / 2, -w / 2], [L / 2, w / 2], [-L / 2, w / 2]].map(p => rot(c, a, p as V2));
  return q.map((p, i) => ({ ent: `${ent}${i}`, kind: "line" as const, a: p, b: q[(i + 1) % 4] }));
}

/** Pre-pierce hole radius of an extruded hole: the collar's neutral length comes out of the flat ring around it. */
export const piercedRadius = (d: number, h: number, T: number) => d / 2 + T - h;

/**
 * Checks a forming tool and places it: one item per point, on the picked face's panel, standing out of that face
 * (or the other one when flipped). Footprints must lie inside the panel.
 */
export function formTools(st: SheetState, f: SmFormFeature): { items: FormItem[]; state: SheetState } {
  const m = /^(.*):(top|bot)$/.exec(f.face?.name ?? "");
  const panel = m ? st.panels.find(p => p.id === m[1]) : undefined;
  if (!m || !panel) throw new SheetError("E-SM-FORMFACE", "Pick a flat face of the sheet (its top or bottom).");
  if (!f.pts.length) throw new SheetError("E-SM-FORMPT", "Click the face to place the forming tool.");
  const T = st.T, size = f.size.v, w = f.width.v, h = f.height.v, dr = f.draft?.v ?? 0, ang = f.angle?.v ?? 0;
  if (!(size > 0) || (f.tool !== "dimple" && f.tool !== "xhole" && !(w > 0))) throw new SheetError("E-SM-FORMSIZE", "The forming tool's sizes must be more than 0.");
  if (!(h > T)) throw new SheetError("E-SM-FORMH", "The form must stand out more than the sheet is thick.");
  if (!(dr >= 0 && dr < Math.PI / 3)) throw new SheetError("E-SM-FORMDRAFT", "The draft must be between 0° and 60°.");
  // The inside of a drafted wall: in by T / cos(draft) at the same height, up to h - T.
  const inside = (r: number) => r - (h - T) * Math.tan(dr) - T / Math.cos(dr);
  if (f.tool === "dimple" && !(inside(size / 2) > 0)) throw new SheetError("E-SM-FORMDRAFT", "The draft closes the form before its full height.");
  if (f.tool === "rib" && !(inside(w / 2) > 0)) throw new SheetError("E-SM-FORMDRAFT", "The draft closes the form before its full height.");
  if (f.tool === "louver" && !(h > T * Math.hypot(1, h / w))) throw new SheetError("E-SM-FORMH", "The form must stand out more than the sheet is thick.");
  if (f.tool === "rib" && !(size >= w)) throw new SheetError("E-SM-FORMSIZE", "A rib must be at least as long as it is wide.");
  if (f.tool === "louver" && !(size > 4 * T && w > T)) throw new SheetError("E-SM-FORMSIZE", "A louver must be longer than four thicknesses.");
  if (f.tool === "xhole" && !(piercedRadius(size, h, T) > 0)) throw new SheetError("E-SM-FORMH", "The extruded hole is too tall for its diameter.");
  const up = (m[2] === "top") !== !!f.flip;
  const poly = loopPolygon(panel.outer, 32);
  const holes = panel.holes.map(x => loopPolygon(x, 32));
  const items: FormItem[] = [];
  const marks: FormMark[] = [];
  f.pts.forEach((c, i) => {
    const loop = f.tool === "dimple" ? [{ ent: "f", kind: "circle" as const, c, r: size / 2 }]
      : f.tool === "xhole" ? [{ ent: "f", kind: "circle" as const, c, r: size / 2 + T }]
      : f.tool === "rib" ? obroundLoop(c, size, w, ang) : rectLoop(c, size, w, ang);
    const fp = loopPolygon(loop, 32);
    if (fp.some(p => !inPolygon(p, poly)) || holes.some(hp => fp.some(p => inPolygon(p, hp)) || hp.some(p => inPolygon(p, fp))))
      throw new SheetError("E-SM-FORMOUT", "A forming tool runs off its face.");
    items.push({ pid: panel.id, M: panel.M, c, ang, up, loop });
    // The flat pattern restores the sheet under the form; an extruded hole leaves its pre-pierce hole.
    // (A louver's opening runs a hair past its front edge.)
    const restore = f.tool === "xhole" ? [{ ent: "f", kind: "circle" as const, c, r: size / 2 }] : f.tool === "louver" ? rectLoop(c, size, w + T * 0.1, ang) : loop;
    marks.push({ pid: panel.id, fid: `${f.id}:${i}`, tool: f.tool, c, loop: restore, mark: loop, ...(f.tool === "xhole" ? { pierce: piercedRadius(size, h, T) } : {}) });
  });
  return { items, state: { ...st, forms: [...(st.forms ?? []), ...marks] } };
}

/** The panel point (flat x, y) under a world point on a panel's top or bottom face, if it lies on one. */
export function flatPointOn(st: SheetState, face: string, p: V3): V2 | null {
  const m = /^(.*):(top|bot)$/.exec(face);
  const panel = m ? st.panels.find(x => x.id === m[1]) : undefined;
  if (!m || !panel) return null;
  const q = local(panel.M, p);
  return [q[0], q[1]];
}

// ---------- unfold / fold ----------

/** M⁻¹ of a rigid transform. */
export function invert(M: Mat): Mat {
  const x: V3 = [M.x[0], M.y[0], M.z[0]], y: V3 = [M.x[1], M.y[1], M.z[1]], z: V3 = [M.x[2], M.y[2], M.z[2]];
  return { o: [-dot(M.x, M.o), -dot(M.y, M.o), -dot(M.z, M.o)], x, y, z };
}

const matEq = (a: Mat, b: Mat, tol: number) =>
  (["o", "x", "y", "z"] as const).every(k => Math.hypot(...sub3(a[k], b[k])) <= (k === "o" ? tol : 1e-9));

/** Where each panel and bend lies: `mats` per panel id (flat → world), `flat` = bends lying flat, `a` = each bend's start panel. */
export interface SheetPlace { mats: Record<string, Mat>; flat: string[]; a: Record<string, string> }

/** Each bend's start panel (same M) and far panel (an outline edge on the strip's far line). */
export function bendLinks(st: SheetState): { bid: string; a: string; b: string | null }[] {
  const size = Math.max(1, ...st.panels.flatMap(p => p.outer.flatMap(s => s.kind === "line" ? [...s.a, ...s.b].map(Math.abs) : [])));
  const tol = size * 1e-6;
  return st.bends.map(b => {
    const A = st.panels.find(p => matEq(p.M, b.M, tol));
    const l = d2(b.a0, b.a1), o: V2 = [(b.a1[1] - b.a0[1]) / l, -(b.a1[0] - b.a0[0]) / l];
    const p0 = p2(b.a0, s2(o, b.ba)), e: V2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l];
    const off = (q: V2) => Math.abs((q[0] - p0[0]) * o[0] + (q[1] - p0[1]) * o[1]);
    const along = (q: V2) => (q[0] - p0[0]) * e[0] + (q[1] - p0[1]) * e[1];
    let best: Panel | undefined, bl = tol;
    for (const p of st.panels) {
      if (A && matEq(p.M, A.M, tol)) continue;
      for (const s of p.outer) {
        if (s.kind !== "line" || off(s.a) > tol * 10 || off(s.b) > tol * 10) continue;
        const lo = Math.max(0, Math.min(along(s.a), along(s.b))), hi = Math.min(l, Math.max(along(s.a), along(s.b)));
        if (hi - lo > bl) { bl = hi - lo; best = p; }
      }
    }
    return { bid: b.id, a: A?.id ?? st.panels[0].id, b: best?.id ?? null };
  });
}

/**
 * Lays the panels out with `fixed` at `anchor` and the bends in `flat` straightened: across a kept bend both panels
 * move together, across a flat one the far panel lies in the start panel's plane (the flat pattern's coordinates are
 * shared by every panel, so its M is the start panel's).
 */
export function placeSheet(st: SheetState, fixed: string, anchor: Mat, flat: string[]): SheetPlace {
  const links = bendLinks(st);
  const size = Math.max(1, ...st.panels.map(p => Math.hypot(...p.M.o)));
  const byId = new Map(st.panels.map(p => [p.id, p]));
  const F = byId.get(fixed) ?? st.panels[0];
  // G = the rigid motion of each panel from where it lies folded.
  const G = new Map<string, Mat>([[F.id, compose(anchor, invert(F.M))]]);
  const queue = [F.id];
  const flatSet = new Set(flat);
  const visit = (id: string, g: Mat) => { if (!G.has(id)) { G.set(id, g); queue.push(id); } };
  while (queue.length) {
    const id = queue.shift()!, P = byId.get(id)!, g = G.get(id)!;
    for (const q of st.panels) if (matEq(q.M, P.M, size * 1e-9)) visit(q.id, g);
    for (const l of links) {
      if (!l.b) continue;
      const A = byId.get(l.a)!, B = byId.get(l.b)!;
      const sameA = matEq(A.M, P.M, size * 1e-9), sameB = matEq(B.M, P.M, size * 1e-9);
      if (!sameA && !sameB) continue;
      const fl = flatSet.has(l.bid);
      // G_B = G_A ∘ M_A ∘ M_B⁻¹ for a flat bend, else G_B = G_A.
      if (sameA) visit(B.id, fl ? compose(compose(g, A.M), invert(B.M)) : g);
      else visit(A.id, fl ? compose(compose(g, B.M), invert(A.M)) : g);
    }
  }
  const g0 = G.get(F.id)!;
  const mats: Record<string, Mat> = {};
  for (const p of st.panels) mats[p.id] = compose(G.get(p.id) ?? g0, p.M);
  return { mats, flat: [...flatSet], a: Object.fromEntries(links.map(l => [l.bid, l.a])) };
}

/** Where the sheet lies now: folded, or as the last Unfold / Fold left it. */
export function sheetPlace(st: SheetState): SheetPlace {
  if (st.unfold) return placeSheet(st, st.unfold.fixed, st.unfold.anchor, st.unfold.bends);
  const mats: Record<string, Mat> = {};
  for (const p of st.panels) mats[p.id] = p.M;
  return { mats, flat: [], a: Object.fromEntries(bendLinks(st).map(l => [l.bid, l.a])) };
}

/** The state with each panel and bend at its current place (for drawing marks on an unfolded sheet). */
export function placedState(st: SheetState): SheetState {
  if (!st.unfold) return st;
  const pl = sheetPlace(st);
  return { ...st, panels: st.panels.map(p => ({ ...p, M: pl.mats[p.id] })), bends: st.bends.map(b => ({ ...b, M: pl.mats[pl.a[b.id]] ?? b.M })) };
}

/** The panel a face belongs to (`<panel>:top`, `<panel>:<edge>`), if any. */
export function panelOfFace(st: SheetState, name: string): Panel | undefined {
  return st.panels.find(p => name.startsWith(p.id + ":") && !name.slice(p.id.length + 1).includes(":"));
}

/** The bend a face belongs to (`<bend>:in`, `<bend>:top` once flat, ...), if any. */
export function bendOfFace(st: SheetState, name: string): Bend | undefined {
  return st.bends.find(b => name.startsWith(b.id + ":") && !name.slice(b.id.length + 1).includes(":"));
}

/** Unfold / Fold: the new state and where the sheet lies before and after. */
export function unfoldSheet(st: SheetState, f: SmUnfoldFeature): { state: SheetState; from: SheetPlace; to: SheetPlace } {
  if (st.faceted) throw new SheetError("E-SM-UNFOLDLOFT", "A lofted bend can't be unfolded; use the Flat-Pattern.");
  if (!st.bends.length) throw new SheetError("E-SM-NOBENDS", "The sheet has no bends to unfold.");
  if (st.gussets?.length) throw new SheetError("E-SM-UNFOLDGUSSET", "Bends with gussets can't be unfolded; use the Flat-Pattern.");
  const from = sheetPlace(st);
  const ids = new Set(st.bends.map(b => b.id));
  for (const b of f.bends) if (!ids.has(b)) throw new SheetError("E-SM-UNFOLDBEND", "A picked bend no longer exists.");
  const now = new Set(from.flat);
  let fixed: string, flat: string[];
  if (f.type === "smunfold") {
    fixed = st.unfold?.fixed ?? st.panels[0].id;
    if (f.face) {
      const p = panelOfFace(st, f.face.name);
      if (!p) throw new SheetError("E-SM-UNFOLDFACE", "Pick a flat face of the sheet to stay fixed.");
      fixed = p.id;
    }
    flat = [...new Set([...now, ...(f.bends.length ? f.bends : [...ids])])];
  } else {
    if (!st.unfold || !now.size) throw new SheetError("E-SM-NOTUNFOLDED", "Unfold some bends first.");
    for (const b of f.bends) if (!now.has(b)) throw new SheetError("E-SM-FOLDBEND", "A picked bend isn't unfolded.");
    fixed = st.unfold.fixed;
    const back = new Set(f.bends.length ? f.bends : [...now]);
    flat = [...now].filter(b => !back.has(b));
  }
  const anchor = from.mats[fixed] ?? st.panels[0].M;
  const to = placeSheet(st, fixed, anchor, flat);
  const home = st.panels.find(p => p.id === fixed)!;
  const folded = !flat.length && matEq(anchor, home.M, 1e-9 * Math.max(1, Math.hypot(...home.M.o)));
  return { state: { ...st, unfold: folded ? undefined : { fixed, anchor, bends: flat } }, from, to };
}

/** Bend lines of the unfolded bends, on the flat strips' top faces, in world coordinates. */
export function unfoldBendLines(st: SheetState): { a: V3; b: V3; up: boolean }[] {
  if (!st.unfold?.bends.length) return [];
  const pl = sheetPlace(st), flat = new Set(pl.flat);
  return st.bends.filter(b => flat.has(b.id)).map(b => {
    const M = pl.mats[pl.a[b.id]] ?? b.M, [p, q] = bendLine(b);
    return { a: apply(M, [p[0], p[1], st.T]), b: apply(M, [q[0], q[1], st.T]), up: b.up };
  });
}

/** A corner where two bends meet (Corner Relief): `c0` is where their start lines cross, `oa`/`ob` the directions
 * each strip runs off its start line. Two bends on one face, or a return: `b` starts on the panel `a` bends onto,
 * next to `a`'s strip. A three-bend corner (`c` = the third bend, a return off `a` or `b`) cuts `box` = [u0, u1, v0,
 * v1] (along `oa`, `ob` from `c0`), which covers all three bend zones; else the box is [0, baA] × [0, baB]. */
export interface ReliefCorner {
  key: string; a: string; b: string; c0: V2; oa: V2; ob: V2; baA: number; baB: number; /** The face's transform. */ M: Mat;
  c?: string; box?: [number, number, number, number]; ret?: boolean;
}

/** Every corner of the sheet where bends meet: two on one face whose start lines cross near an end of both, a bend
 * and its return (a bend off its far panel starting next to its strip), and three-bend corners joining the two. */
export function reliefCorners(st: SheetState): ReliefCorner[] {
  const size = Math.max(1, ...st.panels.flatMap(p => p.outer.flatMap(s => s.kind === "line" || s.kind === "arc" ? [...s.a, ...s.b].map(Math.abs) : [])));
  const two: ReliefCorner[] = [], rets: ReliefCorner[] = [];
  const unit = (b: Bend): V2 => { const l = d2(b.a0, b.a1); return [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l]; };
  const cr = (u: V2, v: V2) => u[0] * v[1] - u[1] * v[0];
  const dt = (u: V2, v: V2) => u[0] * v[0] + u[1] * v[1];
  const far = new Map(bendLinks(st).map(l => [l.bid, l.b]));
  const panelM = new Map(st.panels.map(p => [p.id, p.M]));
  const D = (A: Bend, B: Bend) => 4 * (st.T + Math.max(A.r, B.r)) + Math.max(A.ba, B.ba);
  const nearEnd = (t: number, l: number, d: number) => t > -d && t < l + d && Math.min(Math.abs(t), Math.abs(l - t)) <= d;
  st.bends.forEach((A, i) => st.bends.forEach((B, j) => {
    if (i === j) return;
    const same = matEq(A.M, B.M, size * 1e-9);
    const fm = far.get(A.id) ? panelM.get(far.get(A.id)!) : undefined;
    const ret = !same && !!fm && matEq(B.M, fm, size * 1e-9);
    if ((!same || j < i) && !ret) return;
    const ea = unit(A), eb = unit(B), den = cr(ea, eb);
    if (Math.abs(den) < 0.05) return;
    const w: V2 = [B.a0[0] - A.a0[0], B.a0[1] - A.a0[1]];
    const s = cr(w, eb) / den, u = cr(w, ea) / den;
    const la = d2(A.a0, A.a1), lb = d2(B.a0, B.a1), d = D(A, B);
    const oa: V2 = [ea[1], -ea[0]], ob: V2 = [eb[1], -eb[0]];
    const da: V2 = Math.abs(s) < Math.abs(la - s) ? ea : [-ea[0], -ea[1]];
    if (ret) {
      // The return's start line runs off A's far line, close to an end of A; its strip runs away from A's strip.
      const c0 = p2(A.a0, s2(ea, s)), uf = cr([A.a0[0] + oa[0] * A.ba - B.a0[0], A.a0[1] + oa[1] * A.ba - B.a0[1]], ea) / -den;
      if (!nearEnd(s, la, d) || !nearEnd(uf, lb, d) || dt(ob, da) >= 0) return;
      rets.push({ key: `${A.id}+${B.id}`, a: A.id, b: B.id, c0, oa, ob, baA: A.ba, baB: B.ba, M: A.M, ret: true });
      return;
    }
    // Close to an end of both lines: within the setbacks and bend zones a mitred corner leaves.
    if (!nearEnd(s, la, d) || !nearEnd(u, lb, d)) return;
    // Each line runs from the corner into the face; the other strip must run away from it.
    const db: V2 = Math.abs(u) < Math.abs(lb - u) ? eb : [-eb[0], -eb[1]];
    if (dt(oa, db) >= 0 || dt(ob, da) >= 0) return;
    const [a, b] = A.id < B.id ? [A, B] : [B, A];
    two.push({ key: `${a.id}+${b.id}`, a: a.id, b: b.id, c0: p2(A.a0, s2(ea, s)), oa: a === A ? oa : ob, ob: a === A ? ob : oa, baA: a.ba, baB: b.ba, M: A.M });
  }));
  // A return off either bend of a two-bend corner, at that corner, makes it a three-bend corner.
  const used = new Set<ReliefCorner>();
  const out = two.map(c => {
    const r = rets.find(q => !used.has(q) && (q.a === c.a || q.a === c.b) && d2(q.c0, c.c0) <= 2 * (q.baA + q.baB + st.T));
    if (!r) return c;
    used.add(r);
    const uv = (q: V2): V2 => [dt([q[0] - c.c0[0], q[1] - c.c0[1]], c.oa), dt([q[0] - c.c0[0], q[1] - c.c0[1]], c.ob)];
    const pts = [[0, 0], [r.baA, 0], [0, r.baB], [r.baA, r.baB]].map(([x, y]) => uv(p2(r.c0, p2(s2(r.oa, x), s2(r.ob, y)))));
    pts.push([0, 0], [c.baA, c.baB]);
    const box: [number, number, number, number] = [Math.min(...pts.map(q => q[0])), Math.max(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[1]))];
    return { ...c, key: `${c.key}+${r.b}`, c: r.b, box };
  });
  return [...out, ...rets.filter(r => !used.has(r))];
}

/** A corner relief's outline in flat coordinates, counter-clockwise; `w` = clearance (rectangle, circle) or tear radius. */
export function reliefLoop(c: ReliefCorner, kind: ReliefKind, w: number, round = 0): Seg[] {
  const P = (u: number, v: number): V2 => p2(c.c0, p2(s2(c.oa, u), s2(c.ob, v)));
  const [u0, u1, v0, v1] = c.box ?? [0, c.baA, 0, c.baB];
  if (kind === "tear") return [{ ent: "relief", kind: "circle", c: c.c0, r: w }];
  if (kind === "circle") return [{ ent: "relief", kind: "circle", c: P((u0 + u1) / 2, (v0 + v1) / 2), r: Math.hypot(u1 - u0, v1 - v0) / 2 + w }];
  let pts = [P(u0 - w, v0 - w), P(u1 + w, v0 - w), P(u1 + w, v1 + w), P(u0 - w, v1 + w)];
  if (polyArea(pts) < 0) pts = pts.reverse();
  // Obround: rounded as far as it goes (half its narrower side), but for the face's own corner, which keeps the clearance
  // w round it (so it is still cut); rectangular: rounded by `round`.
  if (kind === "obround") {
    const inner = P(u0 - w, v0 - w);
    return filletLoop(pts, pts.map(q => d2(q, inner) < 1e-9 * (1 + w) ? w : Infinity), "relief");
  }
  if (round > 1e-9) return filletLoop(pts, round, "relief");
  return pts.map((a, i) => line(`relief${i}`, a, pts[(i + 1) % 4]));
}

/** A convex counter-clockwise polygon with each corner rounded by r (or r[i]; less where the sides are too short), as lines and arcs. */
export function filletLoop(pts: V2[], r: number | number[], ent: string): Seg[] {
  const n = pts.length;
  const len = pts.map((p, i) => d2(p, pts[(i + 1) % n]));
  const ends = pts.map((q, i) => {
    const p = pts[(i + n - 1) % n], s = pts[(i + 1) % n];
    const u: V2 = s2([p[0] - q[0], p[1] - q[1]], 1 / d2(p, q)), v: V2 = s2([s[0] - q[0], s[1] - q[1]], 1 / d2(s, q));
    const th = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    // Half of each side at most, so neighbouring roundings meet but don't cross.
    const tmax = Math.min(len[(i + n - 1) % n], len[i]) / 2;
    const ri = Array.isArray(r) ? r[i] : r;
    const t = Math.min(ri / Math.tan(th / 2), tmax), rr = t * Math.tan(th / 2);
    const bis = s2(p2(u, v), 1 / Math.hypot(u[0] + v[0], u[1] + v[1]));
    return { a: p2(q, s2(u, t)), b: p2(q, s2(v, t)), c: p2(q, s2(bis, rr / Math.sin(th / 2))), r: rr };
  });
  const out: Seg[] = [];
  ends.forEach((e, i) => {
    out.push({ ent: `${ent}a${i}`, kind: "arc", c: e.c, r: e.r, a: e.a, b: e.b, ccw: true });
    const nx = ends[(i + 1) % n];
    if (d2(e.b, nx.a) > 1e-9) out.push(line(`${ent}${i}`, e.b, nx.a));
  });
  return out;
}

/** Corner relief: the outlines to cut at the picked corners (or at all of them). */
export function cornerRelief(st: SheetState, f: SmReliefFeature): { corners: ReliefCorner[]; loops: Seg[][] } {
  if (st.faceted) throw new SheetError("E-SM-RELIEFLOFT", "A lofted bend has no corners to relieve.");
  const all = reliefCorners(st);
  if (!all.length) throw new SheetError("E-SM-NOCORNER", "The sheet has no corners where two bends meet.");
  const corners = f.corners.length ? all.filter(c => f.corners.includes(c.key)) : all;
  if (!corners.length) throw new SheetError("E-SM-CORNERGONE", "The picked corners are gone.");
  const w = f.size ? f.size.v : (f.ratio ?? 0.5) * st.T;
  if (!(w >= 0) || (f.kind === "tear" && !(w > 1e-6))) throw new SheetError("E-SM-RELIEFSIZE", "The relief size must be more than 0.");
  const round = f.kind === "rect" && f.round ? f.round.v : 0;
  if (!(round >= 0)) throw new SheetError("E-SM-RELIEFSIZE", "The relief size must be more than 0.");
  return { corners, loops: corners.map(c => reliefLoop(c, f.kind, w, round)) };
}

const rot3 = (v: V3, k: V3, a: number): V3 => {
  // Rodrigues: v turned by a about the unit axis k.
  const c = Math.cos(a), sn = Math.sin(a), kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], x = cross(k, v);
  return [v[0] * c + x[0] * sn + k[0] * kv * (1 - c), v[1] * c + x[1] * sn + k[1] * kv * (1 - c), v[2] * c + x[2] * sn + k[2] * kv * (1 - c)];
};

/**
 * Sheet metal gusset (FR-FT-120): the rib inside the bend and the groove outside, in folded coordinates. Seen along
 * the bend, the inside faces meet at the virtual sharp V; the rib is the triangle V, V + d·(along A), V + d·(along B),
 * and the groove is bounded by the outside faces and the rib's chord moved T towards V, T narrower each side.
 */
export function gussetGeom(st: SheetState, f: SmGussetFeature, shift = 0): GussetMark {
  const b = st.bends.find(x => x.id === f.bend);
  if (!b) throw new SheetError("E-SM-GUSSETBEND", "Pick a bend for the gusset.");
  const T = st.T, th = b.angle;
  if (!(th > 0.05 && th < Math.PI - 0.05)) throw new SheetError("E-SM-GUSSETANGLE", "A gusset needs a bend between 3° and 177°.");
  const l = d2(b.a0, b.a1), e: V2 = [(b.a1[0] - b.a0[0]) / l, (b.a1[1] - b.a0[1]) / l], o: V2 = [e[1], -e[0]];
  const d = f.depth.v, d2b = f.depth2 ? f.depth2.v : d, w = f.width.v, at = (f.at ? f.at.v : l / 2) + shift;
  if (!(w > 2 * T + 1e-6)) throw new SheetError("E-SM-GUSSETWIDTH", "The gusset must be wider than twice the thickness.");
  if (!(at - w / 2 >= -1e-9 && at + w / 2 <= l + 1e-9)) throw new SheetError("E-SM-GUSSETPOS", "The gusset must lie within the bend's length.");
  const e3 = applyDir(b.M, [e[0], e[1], 0]), o3 = applyDir(b.M, [o[0], o[1], 0]);
  const ua = applyDir(b.M, b.up ? [-e[0], -e[1], 0] : [e[0], e[1], 0]);
  // Where the bend leaves panel A on its inside face, at the near end of the rib.
  const p0 = p2(b.a0, s2(e, at - w / 2));
  const S0 = apply(b.M, [p0[0], p0[1], b.up ? T : 0]);
  const tb = rot3(o3, ua, th);
  const set = b.r * Math.tan(th / 2);
  const V: V3 = [S0[0] + o3[0] * set, S0[1] + o3[1] * set, S0[2] + o3[2] * set];
  if (!(Math.min(d, d2b) > set + 1e-6)) throw new SheetError("E-SM-GUSSETDEPTH", "The gusset profile must reach past the bend onto both faces.");
  // 2D frame at V: X along face A away from the bend, Y so face B runs at φ = π − θ.
  const X: V3 = [-o3[0], -o3[1], -o3[2]], phi = Math.PI - th;
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const Y: V3 = [(tb[0] - cp * X[0]) / sp, (tb[1] - cp * X[1]) / sp, (tb[2] - cp * X[2]) / sp];
  const to3 = (q: V2, shift = 0): V3 => [V[0] + q[0] * X[0] + q[1] * Y[0] + e3[0] * shift, V[1] + q[0] * X[1] + q[1] * Y[1] + e3[1] * shift, V[2] + q[0] * X[2] + q[1] * Y[2] + e3[2] * shift];
  const dA: V2 = [1, 0], dB: V2 = [cp, sp];
  const PA = s2(dA, d), PB = s2(dB, d2b);
  // Chord normal towards V, and the lines bounding the groove.
  let nc: V2 = [PB[1] - PA[1], -(PB[0] - PA[0])];
  const ln = Math.hypot(...nc); nc = s2(nc, 1 / ln);
  if (nc[0] * -PA[0] + nc[1] * -PA[1] < 0) nc = s2(nc, -1);
  const k = nc[0] * PA[0] + nc[1] * PA[1] + T;
  const nA: V2 = [0, 1], nB: V2 = [sp, -cp];
  const meet = (n1: V2, c1: number, n2: V2, c2: number): V2 => {
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    return [(c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det];
  };
  const G0 = meet(nA, -T, nB, -T), G1 = meet(nA, -T, nc, k), G2 = meet(nB, -T, nc, k);
  // The rib's top wall must clear the bend: its chord at least r + T from the bend's axis.
  const cdist = nc[0] * set + nc[1] * b.r - (k - T);
  if (!(cdist >= b.r + T - 1e-9) || !(nc[0] * G0[0] + nc[1] * G0[1] > k + T * 1e-3)) throw new SheetError("E-SM-GUSSETDEPTH", "The gusset profile must reach past the bend onto both faces.");
  const wg = w - 2 * T;
  let rr = 0, rg = 0;
  if (f.tip === "round") { rr = w / 2 * 0.995; rg = wg / 2 * 0.995; }
  else if (f.fillet && f.fillet.v > 0) {
    if (!(f.fillet.v < w / 2 - 1e-6)) throw new SheetError("E-SM-GUSSETFILLET", "The gusset's edge fillet must be less than half its width.");
    rr = f.fillet.v; rg = f.fillet.v - T > T * 0.05 ? f.fillet.v - T : 0;
  }
  return { fid: f.id, bend: b.id, rib: [[0, 0], PA, PB].map(q => to3(q as V2)), e: e3, w, groove: [G0, G1, G2].map(q => to3(q, T)), wg, rr, rg };
}

/** Adds a gusset to the sheet state. */
export function gussetSheet(st: SheetState, f: SmGussetFeature): { state: SheetState; marks: GussetMark[] } {
  if (st.faceted) throw new SheetError("E-SM-GUSSETLOFT", "A lofted bend's folds take no gussets.");
  const n = f.count ?? 1;
  if (!(Number.isInteger(n) && n >= 1 && n <= 50)) throw new SheetError("E-SM-GUSSETCOUNT", "Use a whole number of gussets from 1 to 50.");
  const sp = n > 1 ? f.spacing?.v ?? 0 : 0;
  if (n > 1 && !(sp >= f.width.v - 1e-9)) throw new SheetError("E-SM-GUSSETSPACE", "The gussets' spacing must be at least their width.");
  const marks = Array.from({ length: n }, (_x, i) => gussetGeom(st, f, (i - (n - 1) / 2) * sp));
  return { state: { ...st, gussets: [...(st.gussets ?? []), ...marks] }, marks };
}
