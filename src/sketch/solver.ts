// 2D geometric constraint solver for sketches (FRS 8.6, decision D-2: our own
// TypeScript solver, so there is no licence question).
//
// Unknowns are point coordinates and circle radii. Each relation and driving
// dimension adds residual equations. Newton steps take the minimum-norm update
// (Jᵀ(JJᵀ + μI)⁻¹r), so an under-defined sketch moves as little as possible:
// that is what makes dragging feel natural. Degrees of freedom and which
// entities are fully defined come from the rank and null space of the Jacobian.
import type { SkDim, SkEnt, SkRel, SketchFeature, V2 } from "../model/types";
import { entBezier } from "./conic";

/** The sketch origin: a fixed point every sketch has. */
export const ORIGIN = "O";

type Term = { vars: number[]; f: (x: Float64Array) => number };

interface System {
  x: Float64Array;
  /** Variable index of each point's x (y is +1), circle radius; -1 for fixed values. */
  px: Map<string, number>;
  rad: Map<string, number>;
  terms: Term[];
  /** Which relation or dimension each term came from. */
  owner: string[];
  /** Entity → its variables. */
  entVars: Map<string, number[]>;
  fixedXY: Map<string, V2>;
  fixedR: Map<string, number>;
  /** Point pairs held together by a coincident relation ("a|b", both orders). */
  coin: Set<string>;
}

export type SolveStatus = "ok" | "conflict" | "failed";

export interface SolveResult {
  status: SolveStatus;
  /** Degrees of freedom left. */
  dof: number;
  /** Entities whose position is fully determined. */
  defined: Set<string>;
  /** Largest remaining residual. */
  residual: number;
  /** Relations/dimensions involved when the sketch is over-defined. */
  conflicting: string[];
}

export type Drag = { point: string; to: V2 } | { circle: string; to: V2 } | { points: { id: string; to: V2 }[] };

const TOL = 1e-9;

// ---------- building the system ----------

function fixedSet(sk: SketchFeature) {
  const fixed = new Set<string>([ORIGIN]);
  const ent = new Map(sk.ents.map(e => [e.id, e] as const));
  for (const r of sk.rels) if (r.t === "fix" || r.t === "pierce") for (const id of r.e) {
    const e = ent.get(id);
    if (!e) continue;
    if (e.t === "point") fixed.add(e.id);
    else if (e.t === "line") { fixed.add(e.a); fixed.add(e.b); }
    else if (e.t === "circle") { fixed.add(e.c); fixed.add(`${e.id}#r`); }
    else if (e.t === "arc") { fixed.add(e.c); fixed.add(e.a); fixed.add(e.b); }
    else if (e.t === "ellipse") { for (const q of [e.c, e.a, e.b, e.p0, e.p1]) if (q) fixed.add(q); }
    else if (e.t === "spline") for (const q of e.pts) fixed.add(q);
    else if (e.t === "text") fixed.add(e.p);
  }
  return fixed;
}

function build(sk: SketchFeature, extra: Term[] = []): System {
  const fixed = fixedSet(sk);
  const vals: number[] = [];
  const px = new Map<string, number>(), rad = new Map<string, number>();
  const fixedXY = new Map<string, V2>([[ORIGIN, [0, 0]]]), fixedR = new Map<string, number>();
  for (const e of sk.ents) {
    if (e.t === "point") {
      if (fixed.has(e.id)) { fixedXY.set(e.id, [e.x, e.y]); px.set(e.id, -1); }
      else { px.set(e.id, vals.length); vals.push(e.x, e.y); }
    } else if (e.t === "circle") {
      if (fixed.has(`${e.id}#r`)) { fixedR.set(e.id, e.r); rad.set(e.id, -1); }
      else { rad.set(e.id, vals.length); vals.push(e.r); }
    }
  }
  const sys: System = { x: Float64Array.from(vals), px, rad, terms: [], owner: [], entVars: new Map(), fixedXY, fixedR, coin: coinPairs(sk) };
  const ents = new Map(sk.ents.map(e => [e.id, e] as const));
  const pv = (id: string) => { const i = px.get(id); return i === undefined || i < 0 ? [] : [i, i + 1]; };
  for (const e of sk.ents) {
    sys.entVars.set(e.id,
      e.t === "point" ? pv(e.id)
      : e.t === "line" ? [...pv(e.a), ...pv(e.b)]
      : e.t === "circle" ? [...pv(e.c), ...((rad.get(e.id) ?? -1) >= 0 ? [rad.get(e.id)!] : [])]
      : e.t === "ellipse" ? [e.c, e.a, e.b, e.p0, e.p1].flatMap(q => (q ? pv(q) : []))
      : e.t === "spline" ? e.pts.flatMap(pv)
      : e.t === "text" ? pv(e.p)
      : [...pv(e.c), ...pv(e.a), ...pv(e.b)]);
  }
  const add = (owner: string, t: Term) => { sys.terms.push(t); sys.owner.push(owner); };
  // Arcs: both ends on the same circle.
  for (const e of sk.ents) if (e.t === "arc") {
    const C = P(sys, e.c), A = P(sys, e.a), B = P(sys, e.b);
    add(e.id, term([C, A, B], x => dist(C(x), A(x)) - dist(C(x), B(x))));
  }
  // Ellipses: the minor-axis point square to the major axis; arc ends on the ellipse.
  for (const e of sk.ents) if (e.t === "ellipse") {
    const C = P(sys, e.c), A = P(sys, e.a), B = P(sys, e.b);
    add(e.id, term([C, A, B], x => dot(sub(A(x), C(x)), sub(B(x), C(x))) / nrm(sub(A(x), C(x)))));
    for (const q of [e.p0, e.p1]) if (q) { const Q = P(sys, q); add(e.id, onEllipse(C, A, B, Q)); }
  }
  const relMap = new Map(sk.rels.map(r => [r.id, r] as const));
  for (const r of sk.rels) for (const t of relTerms(sys, ents, r, relMap)) add(r.id, t);
  for (const d of sk.dims) if (!d.driven) { const t = dimTerm(sys, ents, d); if (t) add(d.id, t); }
  for (const t of extra) add("drag", t);
  return sys;
}

type Pt = ((x: Float64Array) => V2) & { vars: number[] };
type Sc = ((x: Float64Array) => number) & { vars: number[] };

function P(sys: System, id: string): Pt {
  const i = sys.px.get(id);
  if (i === undefined || i < 0) {
    const v = sys.fixedXY.get(id) ?? [0, 0];
    const f = (() => v) as unknown as Pt; f.vars = []; return f;
  }
  const f = ((x: Float64Array) => [x[i], x[i + 1]] as V2) as Pt; f.vars = [i, i + 1]; return f;
}
function R(sys: System, ents: Map<string, SkEnt>, id: string): Sc {
  const e = ents.get(id)!;
  if (e.t === "arc") {
    const C = P(sys, e.c), A = P(sys, e.a);
    const f = ((x: Float64Array) => dist(C(x), A(x))) as Sc; f.vars = [...C.vars, ...A.vars]; return f;
  }
  const i = sys.rad.get(id);
  if (i === undefined || i < 0) { const v = sys.fixedR.get(id) ?? (e.t === "circle" ? e.r : 0); const f = (() => v) as unknown as Sc; f.vars = []; return f; }
  const f = ((x: Float64Array) => x[i]) as Sc; f.vars = [i]; return f;
}
/** Centre of a circle, arc or ellipse, or a point itself. */
function center(sys: System, ents: Map<string, SkEnt>, id: string): Pt {
  const e = ents.get(id);
  return e && (e.t === "circle" || e.t === "arc" || e.t === "ellipse") ? P(sys, e.c) : P(sys, id);
}
/** Roughly the distance of q from the ellipse (c, major end a, minor end b): zero on it. */
function onEllipse(C: Pt, A: Pt, B: Pt, Q: Pt): Term {
  return term([C, A, B, Q], x => {
    const c = C(x), a = A(x), q = Q(x);
    const r1 = nrm(sub(a, c)), u: V2 = [(a[0] - c[0]) / r1, (a[1] - c[1]) / r1];
    const r2 = Math.abs(cross(u, sub(B(x), c))) || 1e-12, d = sub(q, c);
    return (Math.hypot(dot(d, u) / r1, cross(u, d) / r2) - 1) * Math.sqrt(r1 * r2);
  });
}
function ends(sys: System, ents: Map<string, SkEnt>, id: string): [Pt, Pt] {
  const e = ents.get(id);
  if (!e || e.t !== "line") throw new Error(`Not a line: ${id}`);
  return [P(sys, e.a), P(sys, e.b)];
}
function term(parts: { vars: number[] }[], f: (x: Float64Array) => number): Term {
  return { vars: [...new Set(parts.flatMap(p => p.vars))], f };
}

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const nrm = (a: V2) => Math.hypot(a[0], a[1]) || 1e-12;
/** Signed distance from p to the line through a, b. */
const lineDist = (p: V2, a: V2, b: V2) => cross(sub(b, a), sub(p, a)) / nrm(sub(b, a));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function relTerms(sys: System, ents: Map<string, SkEnt>, r: SkRel, rels: Map<string, SkRel> = new Map()): Term[] {
  const E = (i: number) => ents.get(r.e[i]);
  const kind = (i: number) => (r.e[i] === ORIGIN ? "point" : E(i)?.t);
  switch (r.t) {
    case "coincident": {
      if (kind(0) === "point" && kind(1) === "point") {
        const A = P(sys, r.e[0]), B = P(sys, r.e[1]);
        return [term([A, B], x => A(x)[0] - B(x)[0]), term([A, B], x => A(x)[1] - B(x)[1])];
      }
      return relTerms(sys, ents, { ...r, t: "onCurve", e: kind(0) === "point" ? r.e : [r.e[1], r.e[0]] });
    }
    case "onCurve": {
      const p = P(sys, r.e[0]), k = kind(1);
      if (k === "line") { const [a, b] = ends(sys, ents, r.e[1]); return [term([p, a, b], x => lineDist(p(x), a(x), b(x)))]; }
      const el = ents.get(r.e[1]);
      if (el?.t === "ellipse") return [onEllipse(P(sys, el.c), P(sys, el.a), P(sys, el.b), p)];
      const c = center(sys, ents, r.e[1]), rr = R(sys, ents, r.e[1]);
      return [term([p, c, rr], x => dist(p(x), c(x)) - rr(x))];
    }
    case "intersection":
      return [...relTerms(sys, ents, { ...r, t: "onCurve", e: [r.e[0], r.e[1]] }), ...relTerms(sys, ents, { ...r, t: "onCurve", e: [r.e[0], r.e[2]] })];
    case "horizontal": case "vertical": {
      const k = r.t === "horizontal" ? 1 : 0;
      const [a, b] = r.e.length === 1 ? ends(sys, ents, r.e[0]) : [P(sys, r.e[0]), P(sys, r.e[1])];
      return [term([a, b], x => a(x)[k] - b(x)[k])];
    }
    case "parallel": case "perpendicular": case "collinear": {
      const [a, b] = ends(sys, ents, r.e[0]), [c, d] = ends(sys, ents, r.e[1]);
      const u = (x: Float64Array) => sub(b(x), a(x)), v = (x: Float64Array) => sub(d(x), c(x));
      if (r.t === "perpendicular") return [term([a, b, c, d], x => dot(u(x), v(x)) / (nrm(u(x)) * nrm(v(x))))];
      const par = term([a, b, c, d], x => cross(u(x), v(x)) / (nrm(u(x)) * nrm(v(x))));
      if (r.t === "parallel") return [par];
      return [par, term([a, b, c], x => lineDist(c(x), a(x), b(x)))];
    }
    case "equal": {
      const len = (i: number): Sc => {
        if (kind(i) === "line") { const [a, b] = ends(sys, ents, r.e[i]); const f = ((x: Float64Array) => dist(a(x), b(x))) as Sc; f.vars = [...a.vars, ...b.vars]; return f; }
        return R(sys, ents, r.e[i]);
      };
      const A = len(0), B = len(1);
      return [term([A, B], x => A(x) - B(x))];
    }
    case "curvature": return jointTerms(sys, ents, r, true);
    case "tangent": {
      if (kind(0) === "spline" || kind(1) === "spline") return jointTerms(sys, ents, r, false);
      const li = kind(0) === "line" ? 0 : kind(1) === "line" ? 1 : -1;
      // Curves that share an end (a sketch fillet's arc and its lines): tangent there means the radius to that
      // end is square to the line, or both centres and the end are in line. The distance form below is flat
      // at the solution in that case (its gradient vanishes), so the solver counted 1 spare DOF per tangency.
      const endIds = (i: number) => { const e = E(i); return e && (e.t === "line" || e.t === "arc") ? [e.a, e.b] : []; };
      const shared = endIds(0).find(q => endIds(1).includes(q));
      if (shared) {
        const S = P(sys, shared);
        if (li >= 0) {
          const [a, b] = ends(sys, ents, r.e[li]);
          const c = center(sys, ents, r.e[1 - li]);
          return [term([a, b, c, S], x => dot(sub(c(x), S(x)), sub(b(x), a(x))) / nrm(sub(b(x), a(x))))];
        }
        const c1 = center(sys, ents, r.e[0]), c2 = center(sys, ents, r.e[1]);
        return [term([c1, c2, S], x => cross(sub(c1(x), S(x)), sub(c2(x), S(x))) / (nrm(sub(c1(x), S(x))) + nrm(sub(c2(x), S(x)))))];
      }
      if (li >= 0) {
        const [a, b] = ends(sys, ents, r.e[li]);
        const c = center(sys, ents, r.e[1 - li]), rr = R(sys, ents, r.e[1 - li]);
        return [term([a, b, c, rr], x => Math.abs(lineDist(c(x), a(x), b(x))) - rr(x))];
      }
      const c1 = center(sys, ents, r.e[0]), r1 = R(sys, ents, r.e[0]), c2 = center(sys, ents, r.e[1]), r2 = R(sys, ents, r.e[1]);
      return [term([c1, r1, c2, r2], x => dist(c1(x), c2(x)) - (r.inner ? Math.abs(r1(x) - r2(x)) : r1(x) + r2(x)))];
    }
    case "concentric": {
      const A = center(sys, ents, r.e[0]), B = center(sys, ents, r.e[1]);
      return [term([A, B], x => A(x)[0] - B(x)[0]), term([A, B], x => A(x)[1] - B(x)[1])];
    }
    case "midpoint": {
      const pi = kind(0) === "point" ? 0 : 1;
      const p = P(sys, r.e[pi]), [a, b] = ends(sys, ents, r.e[1 - pi]);
      return [term([p, a, b], x => p(x)[0] - (a(x)[0] + b(x)[0]) / 2), term([p, a, b], x => p(x)[1] - (a(x)[1] + b(x)[1]) / 2)];
    }
    case "symmetric": {
      // Two points (or the ends of two lines, matched) mirrored about a line.
      const [a, b] = ends(sys, ents, r.e[2]);
      const pairs: [Pt, Pt][] = kind(0) === "point" ? [[P(sys, r.e[0]), P(sys, r.e[1])]] : (() => {
        const [p1, p2] = ends(sys, ents, r.e[0]), [q1, q2] = ends(sys, ents, r.e[1]);
        return [[p1, q1], [p2, q2]] as [Pt, Pt][];
      })();
      return pairs.flatMap(([p, q]) => [
        term([p, q, a, b], x => lineDist([(p(x)[0] + q(x)[0]) / 2, (p(x)[1] + q(x)[1]) / 2], a(x), b(x))),
        term([p, q, a, b], x => dot(sub(q(x), p(x)), sub(b(x), a(x))) / nrm(sub(b(x), a(x)))),
      ]);
    }
    case "offset": {
      // Signed offset of a curve from its source: line from line, or radius difference of concentric curves.
      const offOf = (src: string, dst: string): Sc | null => {
        const a = ents.get(src), b = ents.get(dst);
        if (!a || !b) return null;
        if (a.t === "line" && b.t === "line") {
          const [p, q] = ends(sys, ents, src), [c] = ends(sys, ents, dst);
          const f = ((x: Float64Array) => lineDist(c(x), p(x), q(x))) as Sc; f.vars = [...new Set([...p.vars, ...q.vars, ...c.vars])]; return f;
        }
        if ((a.t === "arc" || a.t === "circle") && (b.t === "arc" || b.t === "circle")) {
          const r0 = R(sys, ents, src), r1 = R(sys, ents, dst);
          const f = ((x: Float64Array) => r1(x) - r0(x)) as Sc; f.vars = [...new Set([...r0.vars, ...r1.vars])]; return f;
        }
        return null;
      };
      const out: Term[] = [];
      // Open chain ends: the offset end lies on the normal to the source through the source end.
      const s = ents.get(r.e[0]);
      for (let k = 2; k + 1 < r.e.length; k += 2) {
        const Ps = P(sys, r.e[k]), Pd = P(sys, r.e[k + 1]);
        if (s?.t === "line") { const [a, b] = ends(sys, ents, r.e[0]); out.push(term([Ps, Pd, a, b], x => dot(sub(Pd(x), Ps(x)), sub(b(x), a(x))) / nrm(sub(b(x), a(x))))); }
        else if (s?.t === "arc" || s?.t === "circle") { const c = P(sys, s.c); out.push(term([Ps, Pd, c], x => cross(sub(Ps(x), c(x)), sub(Pd(x), c(x))) / (nrm(sub(Ps(x), c(x))) + nrm(sub(Pd(x), c(x)))))); }
      }
      const lead = r.of ? rels.get(r.of) : undefined;
      if (lead) {
        const A = offOf(r.e[0], r.e[1]), B = offOf(lead.e[0], lead.e[1]);
        if (A && B) out.push(term([A, B], x => Math.abs(A(x)) - Math.abs(B(x))));
      }
      return out;
    }
    case "fix": case "pierce": return [];
  }
}

function coinPairs(sk: SketchFeature): Set<string> {
  const out = new Set<string>();
  for (const r of sk.rels) if (r.t === "coincident" && r.e.length === 2) { out.add(`${r.e[0]}|${r.e[1]}`); out.add(`${r.e[1]}|${r.e[0]}`); }
  return out;
}

/** End point ids of a line, arc or open spline (others have none). */
function curveEnds(e: SkEnt | undefined): string[] {
  if (!e) return [];
  if (e.t === "line" || e.t === "arc") return [e.a, e.b];
  if (e.t === "spline" && !e.closed && e.pts.length >= 2) return [e.pts[0], e.pts[e.pts.length - 1]];
  return [];
}

/**
 * Where two curves meet (FR-SK-050 tangent with splines, FR-SK-051 equal curvature): an end of each that is
 * the same point or held to it by a coincident relation. Null when they do not share an end.
 */
export function curveJoint(sk: SketchFeature, a: string, b: string): [string, string] | null {
  const ents = new Map(sk.ents.map(e => [e.id, e] as const));
  return jointIn(ents, coinPairs(sk), a, b);
}
function jointIn(ents: Map<string, SkEnt>, coin: Set<string>, a: string, b: string): [string, string] | null {
  const ea = curveEnds(ents.get(a)), eb = curveEnds(ents.get(b));
  for (const p of ea) for (const q of eb) if (p === q || coin.has(`${p}|${q}`)) return [p, q];
  return null;
}

type EndGeo = ((x: Float64Array) => { t: V2; k: number }) & { vars: number[] };
/**
 * A curve leaving its end q: the outgoing tangent (any length) and the signed curvature seen along it
 * (positive = turning left). Splines use their end Bézier piece: B' = 3(B1 - B0), B'' = 6(B2 - 2B1 + B0).
 */
function endGeo(sys: System, ents: Map<string, SkEnt>, id: string, q: string): EndGeo | null {
  const e = ents.get(id);
  if (!e) return null;
  const mk = (vars: number[], f: (x: Float64Array) => { t: V2; k: number }) => { const g = f as EndGeo; g.vars = [...new Set(vars)]; return g; };
  if (e.t === "line") {
    const A = P(sys, e.a), B = P(sys, e.b), first = q === e.a;
    return mk([...A.vars, ...B.vars], x => ({ t: first ? sub(B(x), A(x)) : sub(A(x), B(x)), k: 0 }));
  }
  if (e.t === "arc") {
    const C = P(sys, e.c), A = P(sys, e.a), B = P(sys, e.b), first = q === e.a;
    return mk([...C.vars, ...A.vars, ...B.vars], x => {
      const v = sub(first ? A(x) : B(x), C(x)), r = nrm(v);
      // Counter-clockwise from a: the radius turned left; leaving b goes clockwise.
      return first ? { t: [-v[1], v[0]], k: 1 / r } : { t: [v[1], -v[0]], k: -1 / r };
    });
  }
  if (e.t === "spline") {
    const pts = e.pts.map(p => P(sys, p)), first = q === e.pts[0];
    return mk(pts.flatMap(p => p.vars), x => {
      const bz = entBezier(e, pid => pts[e.pts.indexOf(pid)](x));
      const [b0, b1, b2] = first ? [bz[0], bz[1], bz[2]] : [bz[bz.length - 1], bz[bz.length - 2], bz[bz.length - 3]];
      const d1 = sub(b1, b0), d2: V2 = [b2[0] - 2 * b1[0] + b0[0], b2[1] - 2 * b1[1] + b0[1]];
      const l = nrm(d1);
      return { t: [3 * d1[0], 3 * d1[1]], k: (2 / 3) * cross(d1, d2) / (l * l * l) };
    });
  }
  return null;
}

/**
 * Tangent (with a spline) and equal curvature at the shared end of two curves: the curves leave the joint in
 * opposite directions, and for curvature their signed curvatures along those directions cancel (G2).
 * The curvature residual is scaled by the curves' size now, so it reads in millimetres like the others.
 */
function jointTerms(sys: System, ents: Map<string, SkEnt>, r: SkRel, curvature: boolean): Term[] {
  const j = jointIn(ents, sys.coin, r.e[0], r.e[1]);
  if (!j) return [];
  const g0 = endGeo(sys, ents, r.e[0], j[0]), g1 = endGeo(sys, ents, r.e[1], j[1]);
  if (!g0 || !g1) return [];
  const out: Term[] = [term([g0, g1], x => { const a = g0(x).t, b = g1(x).t; return cross(a, b) / (nrm(a) * nrm(b)); })];
  if (curvature) {
    const L = Math.max(1e-6, (nrm(g0(sys.x).t) + nrm(g1(sys.x).t)) / 2);
    out.push(term([g0, g1], x => (g0(x).k + g1(x).k) * L));
  }
  return out;
}

/** Current value of a dimension (for driven ones, and to start new ones). */
export function measureDim(sk: SketchFeature, d: Pick<SkDim, "t" | "e" | "flip" | "dia" | "off" | "cond">): number {
  const sys = build({ ...sk, rels: [], dims: [] });
  const ents = new Map(sk.ents.map(e => [e.id, e] as const));
  const f = dimFn(sys, ents, d);
  return f ? f(sys.x) : NaN;
}

function dimFn(sys: System, ents: Map<string, SkEnt>, d: Pick<SkDim, "t" | "e" | "flip" | "dia" | "off" | "cond">): Sc | null {
  const kind = (i: number) => (d.e[i] === ORIGIN ? "point" : ents.get(d.e[i])?.t);
  const mk = (parts: { vars: number[] }[], f: (x: Float64Array) => number) => { const g = f as Sc; g.vars = [...new Set(parts.flatMap(p => p.vars))]; return g; };
  switch (d.t) {
    case "radius": case "diameter": { const r = R(sys, ents, d.e[0]); const k = d.t === "diameter" ? 2 : 1; return mk([r], x => k * r(x)); }
    case "angle": {
      const [a, b] = ends(sys, ents, d.e[0]), [c, e] = ends(sys, ents, d.e[1]);
      const s1 = d.flip?.[0] ? -1 : 1, s2 = d.flip?.[1] ? -1 : 1;
      return mk([a, b, c, e], x => {
        const u = sub(b(x), a(x)), v = sub(e(x), c(x));
        return Math.abs(Math.atan2(cross([u[0] * s1, u[1] * s1], [v[0] * s2, v[1] * s2]), dot([u[0] * s1, u[1] * s1], [v[0] * s2, v[1] * s2])));
      });
    }
    case "arclen": {
      const e = ents.get(d.e[0]);
      if (e?.t !== "arc") return null;
      const C = P(sys, e.c), A = P(sys, e.a), B = P(sys, e.b);
      return mk([C, A, B], x => {
        const c = C(x), u = sub(A(x), c), v = sub(B(x), c);
        let s = Math.atan2(cross(u, v), dot(u, v));
        if (s <= 1e-12) s += 2 * Math.PI;
        return nrm(u) * s;
      });
    }
    case "distance": case "hdistance": case "vdistance": {
      const base = distFn(sys, ents, d, kind, mk);
      if (!base || !d.cond?.some(c => c === "min" || c === "max")) return base;
      // Arc conditions: each circle/arc measured from its near side takes its radius off, from its far side adds it.
      const adj: { s: number; r: Sc }[] = [];
      d.cond.forEach((c, i) => { const k = kind(i); if ((c === "min" || c === "max") && (k === "circle" || k === "arc")) adj.push({ s: c === "min" ? -1 : 1, r: R(sys, ents, d.e[i]) }); });
      return mk([base, ...adj.map(a => a.r)], x => adj.reduce((v, a) => v + a.s * a.r(x), base(x)));
    }
  }
  return null;
}

function distFn(sys: System, ents: Map<string, SkEnt>, d: Pick<SkDim, "t" | "e" | "flip" | "dia" | "off" | "cond">, kind: (i: number) => string | undefined, mk: (parts: { vars: number[] }[], f: (x: Float64Array) => number) => Sc): Sc | null {
  switch (d.t) {
    case "distance": case "hdistance": case "vdistance": {
      let A: Pt, B: Pt;
      if (d.e.length === 1 && kind(0) === "line") [A, B] = ends(sys, ents, d.e[0]);
      else if (d.t === "distance" && kind(0) === "line" && kind(1) === "line") {
        // Between parallel lines: from the second line's start to the first line.
        const [a, b] = ends(sys, ents, d.e[0]), [c] = ends(sys, ents, d.e[1]);
        const k = d.dia ? 2 : 1;
        return mk([a, b, c], x => k * Math.abs(lineDist(c(x), a(x), b(x))));
      } else if (d.t === "distance" && (kind(0) === "line" || kind(1) === "line")) {
        const li = kind(0) === "line" ? 0 : 1;
        const [a, b] = ends(sys, ents, d.e[li]), p = center(sys, ents, d.e[1 - li]);
        const k = d.dia ? 2 : 1;
        return mk([a, b, p], x => k * Math.abs(lineDist(p(x), a(x), b(x))));
      } else if (d.off) {
        const r0 = R(sys, ents, d.e[0]), r1 = R(sys, ents, d.e[1]);
        return mk([r0, r1], x => Math.abs(r1(x) - r0(x)));
      } else { A = center(sys, ents, d.e[0]); B = center(sys, ents, d.e[1]); }
      if (d.t === "hdistance") return mk([A, B], x => Math.abs(B(x)[0] - A(x)[0]));
      if (d.t === "vdistance") return mk([A, B], x => Math.abs(B(x)[1] - A(x)[1]));
      return mk([A, B], x => dist(A(x), B(x)));
    }
  }
  return null;
}

function dimTerm(sys: System, ents: Map<string, SkEnt>, d: SkDim): Term | null {
  const f = dimFn(sys, ents, d);
  if (!f) return null;
  const v = d.val.v;
  if (d.t === "angle") return { vars: f.vars, f: x => wrap(f(x) - v) };
  return { vars: f.vars, f: x => f(x) - v };
}

// ---------- numerics ----------

function residuals(sys: System, x: Float64Array) {
  const r = new Float64Array(sys.terms.length);
  for (let k = 0; k < r.length; k++) r[k] = sys.terms[k].f(x);
  return r;
}

/** Sparse Jacobian by central differences over each term's own variables. */
function jacobian(sys: System, x: Float64Array): { rows: { idx: number[]; val: number[] }[] } {
  const rows = sys.terms.map(t => {
    const val = t.vars.map(i => {
      const h = 1e-7 * Math.max(1, Math.abs(x[i]));
      const o = x[i];
      x[i] = o + h; const fp = t.f(x);
      x[i] = o - h; const fm = t.f(x);
      x[i] = o;
      return (fp - fm) / (2 * h);
    });
    return { idx: t.vars, val };
  });
  return { rows };
}

/** Solves (A + μI) y = b for symmetric A in place (Gaussian elimination with partial pivoting). */
function solveSym(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-300) continue;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const y = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * y[k];
    y[r] = Math.abs(A[r][r]) < 1e-300 ? 0 : s / A[r][r];
  }
  return y;
}

const maxAbs = (r: Float64Array) => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Damped minimum-norm Newton. Returns the final residual. */
function newton(sys: System, scale: number, iters = 80): number {
  const x = sys.x;
  const m = sys.terms.length;
  if (!m) return 0;
  let r = residuals(sys, x);
  let err = maxAbs(r);
  let mu = 1e-9;
  const tol = TOL * scale;
  for (let it = 0; it < iters && err > tol; it++) {
    const { rows } = jacobian(sys, x);
    // A = J Jᵀ (m×m), computed from the sparse rows.
    const A: Float64Array[] = Array.from({ length: m }, () => new Float64Array(m));
    for (let i = 0; i < m; i++) {
      const ri = rows[i];
      for (let j = i; j < m; j++) {
        const rj = rows[j];
        let s = 0;
        for (let a = 0; a < ri.idx.length; a++) {
          const k = rj.idx.indexOf(ri.idx[a]);
          if (k >= 0) s += ri.val[a] * rj.val[k];
        }
        A[i][j] = s; A[j][i] = s;
      }
    }
    let accepted = false;
    for (let tries = 0; tries < 12 && !accepted; tries++) {
      const M = A.map((row, i) => { const c = Float64Array.from(row); c[i] += mu * (1 + row[i]); return c; });
      const y = solveSym(M, Float64Array.from(r));
      const step = new Float64Array(x.length);
      rows.forEach((row, i) => row.idx.forEach((v, a) => { step[v] += row.val[a] * y[i]; }));
      const old = Float64Array.from(x);
      for (let k = 0; k < x.length; k++) x[k] -= step[k];
      const r2 = residuals(sys, x);
      const e2 = maxAbs(r2);
      if (Number.isFinite(e2) && e2 < err * (1 - 1e-4) + tol * 0.1) { r = r2; err = e2; mu = Math.max(mu / 10, 1e-15); accepted = true; }
      else { x.set(old); mu *= 10; }
    }
    if (!accepted) break;
  }
  return err;
}

/** Rank and the variables pinned by the constraints (not free in any direction of the null space). */
function analyse(sys: System): { rank: number; pinned: boolean[] } {
  const { rank, pinned } = nullSpace(sys);
  return { rank, pinned };
}

/** Row-reduces the Jacobian: rank, pinned variables and a basis of the null space (the free motions). */
function nullSpace(sys: System): { rank: number; pinned: boolean[]; basis: Float64Array[] } {
  const n = sys.x.length;
  const { rows } = jacobian(sys, sys.x);
  const M = rows.map(r => { const a = new Float64Array(n); r.idx.forEach((v, k) => { a[v] = r.val[k]; }); return a; });
  // Row-reduce to echelon form with column pivots.
  const pivCols: number[] = [];
  let row = 0;
  const scale = M.reduce((s, r) => Math.max(s, maxAbs(r)), 0) || 1;
  for (let c = 0; c < n && row < M.length; c++) {
    let p = row;
    for (let r = row + 1; r < M.length; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    // Derivatives are central differences (noise about 1e-9 at 100 mm), so the threshold sits well above that.
    if (Math.abs(M[p][c]) < 1e-6 * scale) continue;
    [M[p], M[row]] = [M[row], M[p]];
    const piv = M[row][c];
    for (let k = c; k < n; k++) M[row][k] /= piv;
    for (let r = 0; r < M.length; r++) {
      if (r === row) continue;
      const f = M[r][c];
      if (f) for (let k = c; k < n; k++) M[r][k] -= f * M[row][k];
    }
    pivCols.push(c);
    row++;
  }
  const rank = pivCols.length;
  const free = [];
  const isPiv = new Array(n).fill(false);
  for (const c of pivCols) isPiv[c] = true;
  for (let c = 0; c < n; c++) if (!isPiv[c]) free.push(c);
  // Null space basis: for each free column f, x_f = 1 and x_pivot = -M[row][f].
  const pinned = new Array(n).fill(true);
  const basis: Float64Array[] = [];
  for (const f of free) {
    pinned[f] = false;
    const v = new Float64Array(n);
    v[f] = 1;
    pivCols.forEach((c, r) => { if (Math.abs(M[r][f]) > 1e-7) { pinned[c] = false; v[c] = -M[r][f]; } });
    basis.push(v);
  }
  return { rank, pinned, basis };
}

/**
 * Under-defined analysis (FR-SLV-010): for each point, the unit directions in which it can still
 * move (none when it is fully defined, one along a curve, two when it is free in the plane).
 */
export function freeDirections(sk: SketchFeature, points: string[]): Map<string, V2[]> {
  const sys = build(sk);
  const { basis } = nullSpace(sys);
  const out = new Map<string, V2[]>();
  for (const id of points) {
    const i = sys.px.get(id);
    if (i === undefined || i < 0) { out.set(id, []); continue; }
    // Gram–Schmidt on the point's share of each free motion.
    const dirs: V2[] = [];
    for (const v of basis) {
      let d: V2 = [v[i], v[i + 1]];
      for (const u of dirs) { const k = d[0] * u[0] + d[1] * u[1]; d = [d[0] - k * u[0], d[1] - k * u[1]]; }
      const l = Math.hypot(d[0], d[1]);
      if (l > 1e-6 && dirs.length < 2) dirs.push([d[0] / l, d[1] / l]);
    }
    out.set(id, dirs);
  }
  return out;
}

function writeBack(sk: SketchFeature, sys: System) {
  for (const e of sk.ents) {
    if (e.t === "point") { const i = sys.px.get(e.id)!; if (i >= 0) { e.x = sys.x[i]; e.y = sys.x[i + 1]; } }
    else if (e.t === "circle") { const i = sys.rad.get(e.id)!; if (i >= 0) e.r = sys.x[i]; }
  }
}

function sizeOf(sk: SketchFeature) {
  let s = 1;
  for (const e of sk.ents) if (e.t === "point") s = Math.max(s, Math.abs(e.x), Math.abs(e.y));
  for (const d of sk.dims) if (d.t !== "angle") s = Math.max(s, Math.abs(d.val.v));
  return s;
}

/**
 * Solves the sketch in place: moves points and radii so every relation and
 * driving dimension holds, with the least movement. With a drag, the dragged
 * point follows the cursor as far as the constraints allow.
 */
export function solve(sk: SketchFeature, drag?: Drag): SolveResult {
  const scale = sizeOf(sk);
  const ents = new Map(sk.ents.map(e => [e.id, e] as const));
  if (drag) {
    const probe = build(sk);
    let extra: Term[] = [];
    const pointTerms = (id: string, to: V2) => { const p = P(probe, id); return p.vars.length ? [term([p], x => p(x)[0] - to[0]), term([p], x => p(x)[1] - to[1])] : []; };
    if ("point" in drag) extra = pointTerms(drag.point, drag.to);
    else if ("points" in drag) extra = drag.points.flatMap(q => pointTerms(q.id, q.to));
    else {
      const c = center(probe, ents, drag.circle), r = R(probe, ents, drag.circle);
      if (r.vars.length) extra = [term([c, r], x => dist(c(x), drag.to) - r(x))];
    }
    if (extra.length) {
      const sys = build(sk, extra);
      const err = newton(sys, scale, 30);
      if (err <= TOL * scale * 1e3) {
        // Tidy up without the drag terms, so the constraints hold exactly.
        writeBack(sk, sys);
        return solve(sk);
      }
      // The drag cannot be followed: stay where the constraints hold.
    }
  }
  const sys = build(sk);
  const err = newton(sys, scale);
  const ok = err <= TOL * scale * 1e3;
  if (ok) {
    writeBack(sk, sys);
    // Reference dimensions keep the value the geometry has now, so the property panel, equations and
    // drawings never show the value from when they were placed.
    for (const d of sk.dims) if (d.driven) { const v = measureDim(sk, d); if (Number.isFinite(v) && v !== d.val.v) d.val = { ...d.val, v }; }
  }
  const { rank, pinned } = analyse(sys);
  const defined = new Set<string>();
  for (const [id, vars] of sys.entVars) if (vars.every(v => pinned[v])) defined.add(id);
  return {
    status: ok ? "ok" : "conflict",
    dof: sys.x.length - rank,
    defined,
    residual: err,
    conflicting: ok ? [] : [...new Set(sys.terms.map((t, i) => (Math.abs(t.f(sys.x)) > TOL * scale * 1e3 ? sys.owner[i] : "")).filter(Boolean))],
  };
}

/**
 * Sketch assistant (FR-SLV-009): for an over-defined sketch, sets of relations and driving dimensions
 * whose removal makes it solvable again, smallest first. The conflicting items are tried first, then
 * the rest; pairs only when no single item does it. Bounded by `budgetMs`.
 */
export function repairs(sk: SketchFeature, max = 5, budgetMs = 1500): string[][] {
  const t0 = Date.now();
  const first = solve(structuredClone(sk));
  if (first.status === "ok") return [];
  const all = [...sk.rels.map(r => r.id), ...sk.dims.filter(d => !d.driven).map(d => d.id)];
  const bad = new Set(first.conflicting);
  const pool = [...all.filter(i => bad.has(i)), ...all.filter(i => !bad.has(i))];
  const fixes = (ids: string[]) => {
    const c: SketchFeature = structuredClone(sk);
    c.rels = c.rels.filter(r => !ids.includes(r.id));
    c.dims = c.dims.filter(d => !ids.includes(d.id));
    return solve(c).status === "ok";
  };
  const out: string[][] = [];
  const late = () => out.length >= max || Date.now() - t0 > budgetMs;
  for (const id of pool) { if (late()) break; if (fixes([id])) out.push([id]); }
  if (!out.length) {
    const few = pool.slice(0, 14);
    for (let i = 0; i < few.length && !late(); i++) for (let j = i + 1; j < few.length && !late(); j++) if (fixes([few[i], few[j]])) out.push([few[i], few[j]]);
  }
  return out;
}

/** Whether adding this relation/dimension keeps the sketch solvable, and whether it adds information. */
export function tryAdd(sk: SketchFeature, item: { rel?: SkRel; dim?: SkDim }): { ok: boolean; redundant: boolean; sketch: SketchFeature; result: SolveResult } {
  const before = analyseOnly(sk);
  const next: SketchFeature = structuredClone(sk);
  if (item.rel) next.rels.push(item.rel);
  if (item.dim) next.dims.push(item.dim);
  if (item.rel) holdOthers(next, item.rel);
  const result = solve(next);
  if (result.status !== "ok") return { ok: false, redundant: false, sketch: sk, result };
  return { ok: true, redundant: result.dof === before.dof && !item.dim?.driven, sketch: next, result };
}

/**
 * A new relation between points and curves moves the points, as in other CAD apps: a free point given a
 * Midpoint on a line goes to the middle instead of the line (and what hangs on it) shifting towards it.
 * Solves once with every other point held; when that works, those positions are the start of the real
 * solve, which then has nothing left to move. Otherwise the usual least-movement solve decides.
 */
function holdOthers(sk: SketchFeature, rel: SkRel) {
  const ent = new Map(sk.ents.map(e => [e.id, e] as const));
  const movers = rel.e.filter(id => id !== ORIGIN && ent.get(id)?.t === "point");
  if (!movers.length || movers.length === rel.e.length) return;
  const held = sk.ents.filter(e => e.t === "point" && !movers.includes(e.id)).map(e => e.id);
  const trial: SketchFeature = structuredClone(sk);
  trial.rels.push({ id: "__hold", t: "fix", e: held });
  if (solve(trial).status !== "ok") return;
  const moved = new Map(trial.ents.map(e => [e.id, e] as const));
  for (const e of sk.ents) {
    const m = moved.get(e.id);
    if (e.t === "point" && m?.t === "point") { e.x = m.x; e.y = m.y; }
  }
}

function analyseOnly(sk: SketchFeature) {
  const copy: SketchFeature = structuredClone(sk);
  return solve(copy);
}
