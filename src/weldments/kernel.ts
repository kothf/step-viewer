// Weldment features on OpenCASCADE (FR-FT-121): structural members, trim/extend, end caps, gussets,
// fillet weld beads, and the cut list. Runs inside `Modeller.evaluate` (kernel worker) through the
// small `WeldHost` view of the modeller: every weldment item is its own solid in the body compound.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FaceRef, Feature, Frame, PartDoc, PlaneRef, V2, V3 } from "../model/types";
import { FeatureError, type Named } from "../kernel/model";
import { anchorPoint, loopSegs, outline, profileName, profileShape, type Loop, type LoopSeg, type ProfileShape } from "./profiles";
import { sketchShape } from "./custom";
import type { CutItem, EndCapFeature, GussetFeature, MemberFeature, TrimExtendFeature, WeldBeadFeature, WeldSegRef, WeldFeature } from "./types";
import { capDir, cornerKey } from "./types";

/** The parts of `Modeller` the weldment features use (its private helpers, reached at run time). */
export interface WeldHost {
  oc: any;
  warning: string;
  sub(shape: any, kind: "FACE" | "EDGE"): any[];
  carry(mk: any, inputs: Named[], result: any, fallback: string): Named;
  bodyList(body: Named): Named[];
  compoundOf(parts: Named[]): Named;
  resolveFace(body: Named | null, ref: FaceRef): any;
  planeFrame(ref: PlaneRef, body: Named | null, frames: Record<string, Frame>): Frame;
  volume(shape: any): number;
  edgeMid(edge: any): V3;
  list(l: any): any[];
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const d3 = (a: V3, b: V3) => len(sub(a, b));

export const isWeld = (f: Feature): f is WeldFeature => f.type === "member" || f.type === "trimext" || f.type === "endcap" || f.type === "gusset" || f.type === "weldbead";

/**
 * A member's path segment in the world: a straight line, or an arc of a 2D sketch (`arc`: centre,
 * axis = the sketch normal, radius and sweep from `a` to `b` about it). `wa`/`wb` are the tangents at
 * the ends, running from `a` to `b`; `w` is the chord direction and `L` the length along the path.
 */
export interface PathSeg { ent: string; a: V3; b: V3; w: V3; L: number; wa: V3; wb: V3; arc?: { c: V3; n: V3; r: number; ang: number } }

/** The point halfway along a segment. */
export function segMid(s: PathSeg): V3 {
  if (!s.arc) return add(s.a, mul(s.w, s.L / 2));
  const { c, n, ang } = s.arc, x = sub(s.a, c), y = cross(n, x), t = ang / 2;
  return add(c, add(mul(x, Math.cos(t)), mul(y, Math.sin(t))));
}

/** The world ends of a member segment: a 2D sketch line or arc placed on its plane, or a 3D sketch line. */
export function segOf(ref: { sketch: string; ent: string }, doc: PartDoc, frames: Record<string, Frame>): PathSeg {
  const sk = doc.features.find(x => x.id === ref.sketch);
  const lost = () => new FeatureError("E-WLD-PATH", "A path segment of the member is missing: pick lines of a sketch or 3D sketch.");
  if (!sk || sk.suppressed) throw lost();
  let a: V3, b: V3;
  if (sk.type === "sketch") {
    const fr = frames[sk.id];
    const e = sk.ents.find(x => x.id === ref.ent);
    if (!fr || !e || (e.t !== "line" && e.t !== "arc")) throw lost();
    const pt = (id: string): V3 => {
      const p = sk.ents.find(x => x.id === id);
      if (!p || p.t !== "point") throw lost();
      return add(add(fr.o, mul(fr.x, p.x)), mul(fr.y, p.y));
    };
    a = pt(e.a); b = pt(e.b);
    if (e.t === "arc") {
      // Counter-clockwise from a to b about the centre, seen down the sketch normal.
      const c = pt(e.c), n = fr.n, r = d3(a, c);
      if (r < 1e-6) throw new FeatureError("E-WLD-PATH", "A path segment of the member has no length.");
      const x = unit(sub(a, c)), y = cross(n, x), q = sub(b, c);
      let ang = Math.atan2(dot(q, y), dot(q, x));
      if (ang <= 1e-9) ang += 2 * Math.PI;
      const wb = unit(cross(n, sub(b, c)));
      const ch = d3(a, b);
      return { ent: ref.ent, a, b, w: ch > 1e-9 ? mul(sub(b, a), 1 / ch) : y, L: r * ang, wa: y, wb, arc: { c, n, r, ang } };
    }
  } else if (sk.type === "sketch3d") {
    const s = sk.segs.find(x => x.id === ref.ent);
    if (!s || s.t !== "line") throw lost();
    const pt = (id: string): V3 => { const p = sk.pts.find(x => x.id === id); if (!p) throw lost(); return p.p; };
    a = pt(s.pts[0]); b = pt(s.pts[s.pts.length - 1]);
  } else throw lost();
  const L = d3(a, b);
  if (L < 1e-6) throw new FeatureError("E-WLD-PATH", "A path segment of the member has no length.");
  const w = mul(sub(b, a), 1 / L);
  return { ent: ref.ent, a, b, w, L, wa: w, wb: w };
}

/** The "up" direction of a profile on a segment: a 2D sketch's normal, else world Z (X for vertical members). */
function upOf(ref: { sketch: string }, seg: PathSeg, doc: PartDoc, frames: Record<string, Frame>): V3 {
  const sk = doc.features.find(x => x.id === ref.sketch);
  let up: V3 = sk?.type === "sketch" && frames[sk.id] ? frames[sk.id].n : [0, 0, 1];
  if (Math.abs(dot(up, seg.wa)) > 0.99) up = Math.abs(seg.wa[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(sub(up, mul(seg.wa, dot(up, seg.wa))));
}

/** How a member's profile is placed on one segment: profile (u, v) to world, on the plane through `at`. */
interface Placement { u: V3; v: V3; w: V3; p2: (q: V2) => V2; R: number; shape: ProfileShape }

/** A member's cross-section: a library profile, or its profile sketch. */
export function memberShape(f: MemberFeature, doc: PartDoc): ProfileShape {
  if (f.profile === "sketch") {
    const sk = doc.features.find(x => x.id === f.psketch);
    if (!sk || sk.type !== "sketch" || sk.suppressed) throw new FeatureError("E-WLD-PROFILE", "Pick a closed sketch for the profile.");
    const s = sketchShape(sk);
    if ("error" in s) throw new FeatureError("E-WLD-PROFILE", s.error);
    return s;
  }
  const shape = profileShape(f.profile, f.size);
  if (!shape) throw new FeatureError("E-WLD-SIZE", "Unknown profile size: pick one from the list.");
  return shape;
}

/** The cut list description of a member's profile: "SHS 40x40x3", or the profile sketch's name. */
export function memberDesc(f: MemberFeature, doc: PartDoc): string {
  if (f.desc?.trim()) return f.desc.trim();
  return f.profile === "sketch" ? doc.features.find(x => x.id === f.psketch)?.name ?? "Sketch" : profileName(f.profile, f.size);
}

/** The profile settings a segment uses: its group's, else the feature's (group 1). */
export function groupOf(f: MemberFeature, ent: string): Pick<MemberFeature, "anchor" | "angle" | "mirror"> {
  return f.groups?.find(g => g.ents.includes(ent)) ?? f;
}

function placement(f: MemberFeature, seg: PathSeg, ref: { sketch: string; ent: string }, doc: PartDoc, frames: Record<string, Frame>, shape = memberShape(f, doc)): Placement {
  const v = upOf(ref, seg, doc, frames);
  const u = cross(v, seg.wa);
  const g = groupOf(f, ref.ent);
  const an = g.anchor ? anchorPoint(shape, g.anchor) : shape.origin ?? [0, 0];
  const a = g.angle?.v ?? 0, c = Math.cos(a), s = Math.sin(a);
  const p2 = (q: V2): V2 => {
    let x = q[0] - an[0];
    const y = q[1] - an[1];
    if (g.mirror) x = -x;
    return [x * c - y * s, x * s + y * c];
  };
  const R = Math.max(...outline(shape.outer, 8).map(q => Math.hypot(...p2(q))));
  return { u, v, w: seg.wa, p2, R, shape };
}

const at3 = (pl: Placement, o: V3, q: V2): V3 => add(add(o, mul(pl.u, pl.p2(q)[0])), mul(pl.v, pl.p2(q)[1]));

/** OCCT edges of a profile loop placed at `o`, with their seg numbers (for face names). */
function loopEdges(h: WeldHost, pl: Placement, o: V3, l: Loop, k0: number): [any, number][] {
  const oc = h.oc;
  const P = (p: V3) => new oc.gp_Pnt_3(p[0], p[1], p[2]);
  return loopSegs(l).map((s: LoopSeg, i): [any, number] => {
    if (s.kind === "line") return [new oc.BRepBuilderAPI_MakeEdge_3(P(at3(pl, o, s.a)), P(at3(pl, o, s.b))).Edge(), k0 + i];
    const arc = new oc.GC_MakeArcOfCircle_4(P(at3(pl, o, s.a)), P(at3(pl, o, s.m)), P(at3(pl, o, s.b))).Value();
    return [new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(arc.get())).Edge(), k0 + i];
  });
}

/** The profile face placed at `o` (filled: without its holes), and its edges with seg numbers. */
function profileFace(h: WeldHost, pl: Placement, o: V3, filled = false): { face: any; edges: [any, number][] } {
  const oc = h.oc;
  const loops = filled ? [pl.shape.outer] : [pl.shape.outer, ...pl.shape.holes];
  const edges: [any, number][] = [];
  const wires = loops.map(l => {
    const es = loopEdges(h, pl, o, l, edges.length);
    edges.push(...es);
    const mk = new oc.BRepBuilderAPI_MakeWire_1();
    for (const [e] of es) mk.Add_1(e);
    if (!mk.IsDone()) throw new FeatureError("E-WLD-PROFILE", "The profile outline could not be closed.");
    return mk.Wire();
  });
  const mk = new oc.BRepBuilderAPI_MakeFace_15(wires[0], true);
  // Holes run the same way round as the outline in the profile plane: reversed, they cut it.
  for (const w of wires.slice(1)) mk.Add(oc.TopoDS.Wire_1(w.Reversed()));
  const fix = new oc.ShapeFix_Face_2(mk.Face());
  fix.Perform();
  const face = fix.Face();
  // Healing may copy edges: match the face's edges to the loop segments by their middles.
  const mids = edges.map(([e, k]) => [h.edgeMid(e), k] as [V3, number]);
  const named: [any, number][] = h.sub(face, "EDGE").map(e => {
    const m = h.edgeMid(e);
    let best = 0, bd = Infinity;
    for (const [q, k] of mids) { const d = d3(q, m); if (d < bd) { bd = d; best = k; } }
    return [e, best];
  });
  return { face, edges: named };
}

/** A straight piece of the member's profile from `a` to `b` (filled: the outer outline only), faces named `<base>:side:k`, `<base>:start`, `<base>:end`. */
function prism(h: WeldHost, pl: Placement, a: V3, b: V3, base: string, filled = false): Named {
  const oc = h.oc;
  const { face, edges } = profileFace(h, pl, a, filled);
  const dv = sub(b, a);
  const mk = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(dv[0], dv[1], dv[2]), false, true);
  const shape0 = mk.Shape();
  const shape = h.volume(shape0) < 0 ? shape0.Reversed() : shape0;
  const faces = h.sub(shape, "FACE");
  const names: (string | null)[] = faces.map(() => null);
  for (const [e, k] of edges) for (const g of h.list(mk.Generated(e))) { const i = faces.findIndex(x => x.IsSame(g)); if (i >= 0) names[i] = `${base}:side:${k}`; }
  const first = h.sub(mk.FirstShape(), "FACE"), last = h.sub(mk.LastShape(), "FACE");
  let n = 0;
  return { shape, faces, names: faces.map((x, i) => names[i] ?? (first.some(g => g.IsSame(x)) ? `${base}:start` : last.some(g => g.IsSame(x)) ? `${base}:end` : `${base}:new:${n++}`)) };
}

/** A member's profile revolved along an arc segment, faces named like `prism`'s. */
function revolveArc(h: WeldHost, pl: Placement, s: PathSeg, base: string): Named {
  const oc = h.oc, { c, n, ang } = s.arc!;
  const { face, edges } = profileFace(h, pl, s.a);
  const ax = new oc.gp_Ax1_2(new oc.gp_Pnt_3(c[0], c[1], c[2]), new oc.gp_Dir_4(n[0], n[1], n[2]));
  const mk = new oc.BRepPrimAPI_MakeRevol_1(face, ax, ang, true);
  const shape0 = mk.Shape();
  const shape = h.volume(shape0) < 0 ? shape0.Reversed() : shape0;
  const faces = h.sub(shape, "FACE");
  const names: (string | null)[] = faces.map(() => null);
  for (const [e, k] of edges) for (const g of h.list(mk.Generated(e))) { const i = faces.findIndex(x => x.IsSame(g)); if (i >= 0) names[i] = `${base}:side:${k}`; }
  const first = h.sub(mk.FirstShape(), "FACE"), last = h.sub(mk.LastShape(), "FACE");
  let m = 0;
  return { shape, faces, names: faces.map((x, i) => names[i] ?? (first.some(g => g.IsSame(x)) ? `${base}:start` : last.some(g => g.IsSame(x)) ? `${base}:end` : `${base}:new:${m++}`)) };
}

/** A big box on the side of the plane (p, n) that `n` points to, its faces all named `name`. */
function halfBox(h: WeldHost, p: V3, n: V3, big: number, name: string): Named {
  const oc = h.oc;
  n = unit(n);
  const x = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const y = cross(n, x);
  const o = add(add(p, mul(x, -big)), mul(y, -big));
  const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(o[0], o[1], o[2]), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(x[0], x[1], x[2]));
  const shape = new oc.BRepPrimAPI_MakeBox_5(ax, 2 * big, 2 * big, big).Shape();
  const faces = h.sub(shape, "FACE");
  return { shape, faces, names: faces.map(() => name) };
}

function bool(h: WeldHost, kind: "fuse" | "cut", a: Named, b: Named, fid: string): Named {
  const oc = h.oc;
  const pr = new oc.Message_ProgressRange_1();
  const mk = kind === "fuse" ? new oc.BRepAlgoAPI_Fuse_3(a.shape, b.shape, pr) : new oc.BRepAlgoAPI_Cut_3(a.shape, b.shape, pr);
  if (!mk.IsDone() || mk.HasErrors()) throw new FeatureError("E-WLD-BOOL", "A weldment cut or join failed.");
  return h.carry(mk, [a, b], mk.Shape(), fid);
}

/** The solid of a shape nearest a point (pieces a cut leaves on the far side are dropped). */
function pieceNear(h: WeldHost, body: Named, p: V3): Named {
  const oc = h.oc;
  const parts = h.bodyList(body);
  if (parts.length <= 1) return parts[0] ?? body;
  let best = parts[0], bd = Infinity;
  const v = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt_3(p[0], p[1], p[2])).Vertex();
  for (const q of parts) {
    const dist = new oc.BRepExtrema_DistShapeShape_2(q.shape, v, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
    const d = dist.IsDone() ? dist.Value() : Infinity;
    if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && h.volume(q.shape) > h.volume(best.shape))) { bd = d; best = q; }
  }
  return best;
}

/** Coplanar pieces a fuse left on a member merged back into whole faces (each keeps the first name it had). */
function unify(h: WeldHost, b: Named): Named {
  const oc = h.oc;
  const u = new oc.ShapeUpgrade_UnifySameDomain_2(b.shape, true, true, false);
  try { u.Build(); } catch { return b; }
  const shape = u.Shape(), hist = u.History_1().get();
  const faces = h.sub(shape, "FACE");
  const names: (string | null)[] = faces.map(() => null);
  b.faces.forEach((f, i) => {
    const mods = h.list(hist.Modified(f));
    for (const m of mods.length ? mods : [f]) { const j = faces.findIndex(x => x.IsSame(m)); if (j >= 0 && !names[j]) names[j] = b.names[i]; }
  });
  let k = 0;
  return { shape, faces, names: names.map(n => n ?? `${b.names[0]?.split(":")[0] ?? "w"}:new:${k++}`) };
}

/** End treatment of one end of a member segment. */
type End = { kind: "free" } | { kind: "miter"; n: V3 } | { kind: "through"; ext: number } | { kind: "trimmed"; other: number };

/** One solid per segment: profiles swept along the segments, corners mitred or butted (FR-FT-121). */
export function member(h: WeldHost, f: MemberFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
  if (!f.segs.length) throw new FeatureError("E-WLD-PATH", "Pick the sketch lines the member runs along.");
  const segs = f.segs.map(r => segOf(r, doc, frames));
  const shape = memberShape(f, doc);
  const pls = segs.map((s, i) => placement(f, s, f.segs[i], doc, frames, shape));
  const tol = 1e-6 * (1 + Math.max(...segs.map(s => s.L)));
  const gap = Math.max(0, f.gap?.v ?? 0);
  const endPt = (i: number, e: 0 | 1) => (e ? segs[i].b : segs[i].a);
  /** The tangent at an end, pointing out of the segment. */
  const outAt = (i: number, e: 0 | 1) => (e ? segs[i].wb : mul(segs[i].wa, -1));
  /** The profile's placement at an end (an arc's turns along it). */
  const plAt = (i: number, e: 0 | 1) => (e && segs[i].arc ? placement(f, { ...segs[i], wa: segs[i].wb }, f.segs[i], doc, frames, shape) : pls[i]);
  const ends: [End, End][] = segs.map((_s, i) => ([0, 1] as const).map(e => {
    const P = endPt(i, e);
    const others: [number, 0 | 1][] = [];
    segs.forEach((_t, j) => { if (j !== i) for (const k of [0, 1] as const) if (d3(endPt(j, k), P) < tol) others.push([j, k]); });
    const corner = f.corners?.[cornerKey([segs[i].ent, ...others.map(([j]) => segs[j].ent)])] ?? f.corner;
    if (!others.length || corner === "none") return { kind: "free" } as End;
    const din = outAt(i, e);
    /** Run past the corner until the other members' outlines are covered. */
    const cover = (js: [number, 0 | 1][]) => Math.max(0, ...js.flatMap(([j, k]) => { const p = plAt(j, k); return outline(p.shape.outer, 8).map(q => dot(sub(at3(p, P, q), P), din)); }));
    if (others.length > 1) {
      // Three or more meet: the first straight one (butt2: the last) runs through, the others stop at its face.
      const all = [i, ...others.map(([j]) => j)].filter(x => !segs[x].arc);
      if (!all.length) return { kind: "free" } as End;
      const through = corner === "butt2" ? Math.max(...all) : Math.min(...all);
      if (through !== i) return Math.abs(dot(din, segs[through].w)) > 1 - 1e-9 ? { kind: "free" } as End : { kind: "trimmed", other: through } as End;
      return { kind: "through", ext: cover(others) } as End;
    }
    const [j, k] = others[0];
    const dout = mul(outAt(j, k), -1);
    if (Math.abs(dot(din, dout)) > 1 - 1e-9) return { kind: "free" } as End;
    // An arc can't run through a corner: a butt with an arc makes the straight member run through, two arcs are mitred.
    const arcs = (segs[i].arc ? 1 : 0) + (segs[j].arc ? 1 : 0);
    if (corner === "miter" || arcs === 2) return { kind: "miter", n: unit(add(din, dout)) } as End;
    const through = arcs ? (segs[i].arc ? j : i) : corner === "butt1" ? Math.min(i, j) : Math.max(i, j);
    if (through !== i) return { kind: "trimmed", other: j } as End;
    return { kind: "through", ext: cover([[j, k]]) } as End;
  }) as [End, End]);
  const items: Named[] = segs.map((s, i) => {
    const pl = pls[i], base = `${f.id}:${s.ent}`;
    const extOf = (e: End, k: 0 | 1) => e.kind === "through" ? e.ext : e.kind === "miter" ? pl.R / Math.max(Math.abs(dot(e.n, outAt(i, k))), 0.05) + pl.R : e.kind === "trimmed" ? pls[e.other].R + pl.R * 2 : 0;
    const [e0, e1] = ends[i];
    let body: Named;
    if (s.arc) {
      // Revolved about the arc's axis; ends that need more material get a straight run along the tangent.
      body = revolveArc(h, pl, s, base);
      ([0, 1] as const).forEach(k => {
        const x = extOf(ends[i][k], k);
        if (x <= 1e-9) return;
        const P = endPt(i, k), out = outAt(i, k);
        const tail = prism(h, plAt(i, k), sub(P, mul(out, 1e-3)), add(P, mul(out, x)), base);
        body = bool(h, "fuse", body, tail, f.id);
      });
    } else body = prism(h, pl, sub(s.a, mul(s.w, extOf(e0, 0))), add(s.b, mul(s.w, extOf(e1, 1))), base);
    const big = 4 * (s.L + pl.R * 40);
    ([e0, e1] as End[]).forEach((e, k) => {
      const P = k ? s.b : s.a;
      const nm = `${base}:${k ? "end" : "start"}`;
      // A mitre gap is split between the two ends, measured square to the mitre plane.
      if (e.kind === "miter") body = bool(h, "cut", body, halfBox(h, sub(P, mul(e.n, gap / 2)), e.n, big, nm), f.id);
      if (e.kind === "trimmed") {
        // Cut square to the other member's face that looks at this one (the plane holds its axis).
        const o = segs[e.other], op = pls[e.other];
        const din = outAt(i, k as 0 | 1);
        const m = unit(sub(mul(din, -1), mul(o.w, dot(mul(din, -1), o.w))));
        const ext = Math.max(0, ...outline(op.shape.outer, 8).map(q => dot(sub(at3(op, P, q), P), m)));
        body = bool(h, "cut", body, halfBox(h, add(P, mul(m, ext + gap)), mul(m, -1), big, nm), f.id);
      }
    });
    const piece = pieceNear(h, body, segMid(s));
    return s.arc ? unify(h, piece) : piece;
  });
  // Merge miter trimmed bodies: the two ends of a mitred corner touch only without a weld gap.
  const mitred = f.mergeMiter && gap <= 1e-9 ? ends.map(es => es.map(e => e.kind === "miter")) : null;
  const merged = f.mergeArcs || mitred ? mergeBodies(h, f, segs, items, tol, !!f.mergeArcs, mitred) : items;
  return h.compoundOf([...(prev ? h.bodyList(prev) : []), ...merged]);
}

/**
 * Merged member bodies: segments that meet alone end to end are fused into one body where they run on tangent,
 * one of them an arc (Merge arc segment bodies), or where their corner is mitred (Merge miter trimmed bodies).
 */
function mergeBodies(h: WeldHost, f: MemberFeature, segs: PathSeg[], items: Named[], tol: number, arcs: boolean, mitred: boolean[][] | null): Named[] {
  const root = segs.map((_s, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const ends = (i: number) => [{ p: segs[i].a, out: mul(segs[i].wa, -1) }, { p: segs[i].b, out: segs[i].wb }];
  segs.forEach((s, i) => segs.forEach((t, j) => {
    if (j <= i) return;
    ends(i).forEach((ei, ki) => ends(j).forEach((ej, kj) => {
      if (d3(ei.p, ej.p) >= tol) return;
      const tangent = arcs && (!!s.arc || !!t.arc) && dot(ei.out, ej.out) <= -1 + 1e-6;
      const mitre = !!mitred?.[i][ki] && !!mitred[j][kj];
      if (!tangent && !mitre) return;
      // Only where the two meet alone: a third member at the point keeps them apart.
      if (segs.some((_u, k) => k !== i && k !== j && ends(k).some(e => d3(e.p, ei.p) < tol))) return;
      root[find(j)] = find(i);
    }));
  }));
  const groups = new Map<number, number[]>();
  segs.forEach((_s, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  return [...groups.values()].map(g => {
    if (g.length === 1) return items[g[0]];
    let body = items[g[0]];
    for (const k of g.slice(1)) body = bool(h, "fuse", body, items[k], f.id);
    const piece = pieceNear(h, body, segMid(segs[g[0]]));
    // Straight mitred pieces keep their faces (the mitre plane splits the sides); arcs are unified as before.
    return g.some(k => segs[k].arc) ? unify(h, piece) : piece;
  });
}

/** The member feature and segment a member body's face belongs to. */
function memberOfFace(name: string, doc: PartDoc): { f: MemberFeature; ent: string } | null {
  const [id, ent] = name.split(":");
  const f = doc.features.find(x => x.id === id);
  return f?.type === "member" && f.segs.some(s => s.ent === ent) ? { f, ent } : null;
}

/** Index of the body holding a face. */
function bodyOf(h: WeldHost, list: Named[], body: Named, ref: FaceRef): number {
  const face = h.resolveFace(body, ref);
  const i = list.findIndex(b => b.faces.some(x => x.IsSame(face)));
  if (i < 0) throw new FeatureError("E-TN-LOST", `Reference lost: face ${ref.name}`);
  return i;
}

function distTo(h: WeldHost, shape: any, p: V3): number {
  const oc = h.oc;
  const v = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt_3(p[0], p[1], p[2])).Vertex();
  const dist = new oc.BRepExtrema_DistShapeShape_2(shape, v, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
  return dist.IsDone() ? dist.Value() : Infinity;
}

function boxSize(h: WeldHost, shape: any) {
  const oc = h.oc;
  const box = new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(shape, box, false);
  const a = box.CornerMin(), b = box.CornerMax();
  return Math.hypot(b.X() - a.X(), b.Y() - a.Y(), b.Z() - a.Z());
}

/** Trim/Extend: member ends cut back to, or lengthened up to, a plane or another body. */
export function trimExtend(h: WeldHost, f: TrimExtendFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
  if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
  if (!f.bodies.length) throw new FeatureError("E-WLD-TRIM", "Pick the member bodies to trim.");
  const byPlane = f.kind === "face" && !!f.plane;
  if (!f.boundary && !byPlane) throw new FeatureError("E-WLD-TRIM", "Pick the boundary: a flat face or a body.");
  const list = h.bodyList(prev);
  const bi = byPlane ? -1 : bodyOf(h, list, prev, f.boundary!);
  if (f.kind === "mitre" || f.kind === "butt1" || f.kind === "butt2") return endMitre(h, f, doc, prev, list, bi, frames);
  let plane: { p: V3; n: V3 } | null = null;
  if (f.kind === "face") {
    const fr = h.planeFrame(f.plane ?? { face: f.boundary! }, prev, frames);
    plane = { p: fr.o, n: fr.n };
  }
  const bound = list[bi];
  const gap = Math.max(0, f.gap?.v ?? 0);
  for (const ref of f.bodies) {
    const mo = memberOfFace(ref.name, doc);
    if (!mo) throw new FeatureError("E-WLD-TRIM", "Only structural member bodies can be trimmed: pick a face of a member.");
    const i = bodyOf(h, list, prev, ref);
    if (i === bi) throw new FeatureError("E-WLD-TRIM", "A member can't be trimmed by itself.");
    const sref = mo.f.segs.find(s => s.ent === mo.ent)!;
    const s = segOf(sref, doc, frames);
    if (s.arc) throw new FeatureError("E-WLD-TRIM", "Curved members can't be trimmed or extended.");
    const pl = placement(mo.f, s, sref, doc, frames);
    const base = `${mo.f.id}:${mo.ent}`;
    const mid = add(s.a, mul(s.w, s.L / 2));
    let body = list[i];
    // Which end meets the boundary, and how far it has to go.
    let end: 0 | 1, reach: number;
    if (plane) {
      const sa = dot(sub(s.a, plane.p), plane.n), sb = dot(sub(s.b, plane.p), plane.n);
      const along = Math.abs(dot(s.w, plane.n));
      if (along < 1e-6) throw new FeatureError("E-WLD-TRIM", "The member runs parallel to the boundary plane.");
      end = sa * sb < 0 ? (Math.abs(sa) < Math.abs(sb) ? 0 : 1) : Math.abs(sa) < Math.abs(sb) ? 0 : 1;
      reach = (sa * sb < 0 ? 0 : Math.abs(end ? sb : sa) / along) + pl.R / along + pl.R;
    } else {
      const da = distTo(h, bound.shape, s.a), db = distTo(h, bound.shape, s.b);
      end = da <= db ? 0 : 1;
      reach = Math.min(da, db) + boxSize(h, bound.shape) + pl.R;
    }
    const P = end ? s.b : s.a, out = end ? s.w : mul(s.w, -1);
    const nm = `${base}:${end ? "end" : "start"}`;
    if (!f.noExtend) {
      const ext = prism(h, pl, sub(P, mul(out, 1e-3)), add(P, mul(out, reach)), base);
      body = bool(h, "fuse", body, ext, f.id);
    }
    if (plane) {
      const away = dot(out, plane.n) > 0 ? plane.n : mul(plane.n, -1);
      body = bool(h, "cut", body, halfBox(h, sub(plane.p, mul(away, gap)), away, 4 * (s.L + reach + pl.R * 10), nm), f.id);
    } else if (f.planar) {
      // Planar trim: a flat end square to the member where it first meets the body.
      const pr = new h.oc.Message_ProgressRange_1();
      const mk = new h.oc.BRepAlgoAPI_Common_3(body.shape, bound.shape, pr);
      const pts = mk.IsDone() && !mk.HasErrors() ? edgePoints(h, mk.Shape()) : [];
      if (!pts.length) throw new FeatureError("E-WLD-TRIM", "The member doesn't reach the boundary body.");
      const t = Math.min(...pts.map(q => dot(sub(q, P), out)));
      body = bool(h, "cut", body, halfBox(h, add(P, mul(out, t - gap)), out, 4 * (s.L + reach + pl.R * 10), nm), f.id);
    } else {
      // A weld gap against a body: the boundary moved back along the member by the gap.
      const tool = gap > 0 ? shifted(h, bound, mul(out, -gap)) : bound;
      body = bool(h, "cut", body, { ...tool, names: bound.names.map(() => nm) }, f.id);
    }
    list[i] = unify(h, pieceNear(h, body, mid));
  }
  return h.compoundOf(list);
}

/** A body moved by `d` (Moved keeps its faces in order, so the names still line up). */
function shifted(h: WeldHost, b: Named, d: V3): Named {
  const oc = h.oc;
  const trsf = new oc.gp_Trsf_1();
  trsf.SetTranslation_1(new oc.gp_Vec_4(d[0], d[1], d[2]));
  const loc = new oc.TopLoc_Location_2(trsf);
  return { shape: b.shape.Moved(loc, false), faces: b.faces.map(f => oc.TopoDS.Face_1(f.Moved(loc, false))), names: b.names };
}

/**
 * End miter (SolidWorks Trim/Extend corner type): the picked member and the boundary member are both
 * lengthened to the point where their axes meet (the middle of the shortest join for skew axes) and cut
 * on the plane that halves the corner, so their end faces meet flush.
 */
function endMitre(h: WeldHost, f: TrimExtendFeature, doc: PartDoc, prev: Named, list: Named[], bi: number, frames: Record<string, Frame>): Named {
  const bad = (msg: string) => new FeatureError("E-WLD-TRIM", msg);
  const m1 = memberOfFace(f.bodies[0].name, doc), m2 = memberOfFace(f.boundary!.name, doc);
  if (!m1 || !m2) throw bad("Only structural member bodies can be trimmed: pick a face of a member.");
  const i1 = bodyOf(h, list, prev, f.bodies[0]);
  if (i1 === bi) throw bad("A member can't be trimmed by itself.");
  const ends = [{ mo: m1, i: i1 }, { mo: m2, i: bi }].map(({ mo, i }) => {
    const sref = mo.f.segs.find(s => s.ent === mo.ent)!;
    const s = segOf(sref, doc, frames);
    if (s.arc) throw bad("Curved members can't be trimmed or extended.");
    return { mo, i, s, sref, pl: placement(mo.f, s, sref, doc, frames) };
  });
  // Closest points of the two axes.
  const [A, B] = ends.map(e => e.s);
  const r = sub(A.a, B.a), b = dot(A.w, B.w), d = dot(A.w, r), e2 = dot(B.w, r), den = 1 - b * b;
  if (den < 1e-9) throw bad("The members are parallel: an end miter needs members at an angle.");
  const butt = f.kind === "butt1" ? 0 : f.kind === "butt2" ? 1 : -1;
  const gap = Math.max(0, f.gap?.v ?? 0);
  const ta = (b * e2 - d) / den, tb = (e2 - b * d) / den;
  const C = mul(add(add(A.a, mul(A.w, ta)), add(B.a, mul(B.w, tb))), 0.5);
  // Each member's end nearer C, and the direction out of that end.
  const outs = ends.map(({ s }) => {
    const nearB = d3(s.b, C) < d3(s.a, C);
    return { end: nearB ? 1 as const : 0 as const, out: nearB ? s.w : mul(s.w, -1) };
  });
  // Bisector plane normal: along member 1 into the corner, then out along member 2.
  const n = unit(sub(outs[0].out, outs[1].out));
  const R = Math.max(ends[0].pl.R, ends[1].pl.R);
  ends.forEach(({ i, s, pl, mo }, k) => {
    const { end, out } = outs[k];
    const P = end ? s.b : s.a, base = `${mo.f.id}:${mo.ent}`, nm = `${base}:${end ? "end" : "start"}`;
    const mid = add(s.a, mul(s.w, s.L / 2));
    let body = list[i];
    const reach = Math.max(0, dot(sub(C, P), out)) + 4 * R;
    if (!f.noExtend) body = bool(h, "fuse", body, prism(h, pl, sub(P, mul(out, 1e-3)), add(P, mul(out, reach)), base), f.id);
    let away = dot(out, n) > 0 ? n : mul(n, -1), at = sub(C, mul(away, gap / 2));
    if (butt >= 0) {
      // Butt: one member stops at the other's near side (cut on that side's plane), the other runs on
      // to the first one's far side and is cut square.
      const o = ends[1 - k], q = unit(sub(out, mul(o.s.w, dot(out, o.s.w))));
      const ext = outline(o.pl.shape.outer, 8).map(p => { const v = o.pl.p2(p); return dot(add(mul(o.pl.u, v[0]), mul(o.pl.v, v[1])), q); });
      if (k === butt) { at = add(C, mul(q, Math.min(...ext) - gap)); away = q; }
      else { at = add(C, mul(out, Math.max(...ext) / Math.max(1e-6, dot(out, q)))); away = out; }
    }
    body = bool(h, "cut", body, halfBox(h, at, away, 4 * (s.L + reach + R * 10), nm), f.id);
    list[i] = unify(h, pieceNear(h, body, mid));
  });
  return h.compoundOf(list);
}

/** In-plane axes of a flat face: along its longest straight edge (else any), and the normal. */
function faceAxes(h: WeldHost, face: any, n: V3): { x: V3; y: V3 } {
  const oc = h.oc;
  let best: V3 | null = null, bl = 0;
  for (const e of h.sub(face, "EDGE")) {
    const ad = new oc.BRepAdaptor_Curve_2(e);
    if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
    const p0 = ad.Value(ad.FirstParameter()), p1 = ad.Value(ad.LastParameter());
    const d: V3 = [p1.X() - p0.X(), p1.Y() - p0.Y(), p1.Z() - p0.Z()];
    if (len(d) > bl) { bl = len(d); best = d; }
  }
  const x = unit(best ? sub(best, mul(n, dot(best, n))) : Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  return { x, y: cross(n, x) };
}

/** Points along a shape's edges (vertices and edge middles and quarters), for extents. */
function edgePoints(h: WeldHost, shape: any): V3[] {
  const oc = h.oc;
  const out: V3[] = [];
  for (const e of h.sub(shape, "EDGE")) {
    const ad = new oc.BRepAdaptor_Curve_2(e);
    const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
    for (let k = 0; k <= 8; k++) { const p = ad.Value(t0 + ((t1 - t0) * k) / 8); out.push([p.X(), p.Y(), p.Z()]); }
  }
  return out;
}

/** A member's wall thickness at a flat end face: the distance between its outer and largest inner outline, or 2 × area / perimeter for a solid section (an angle's or channel's leg thickness). */
export function wallThickness(h: WeldHost, face: any): number {
  const oc = h.oc;
  const outer = oc.BRepTools.OuterWire(face);
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, map);
  const wires: any[] = [];
  for (let i = 1; i <= map.Extent(); i++) { const w = oc.TopoDS.Wire_1(map.FindKey(i)); if (!w.IsSame(outer)) wires.push(w); }
  const areaOf = (w: any) => { const ff = new oc.BRepBuilderAPI_MakeFace_15(w, true).Face(); const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(ff, p, false, false); return Math.abs(p.Mass()); };
  if (wires.length) {
    let best = wires[0], ba = areaOf(best);
    for (const w of wires.slice(1)) { const a = areaOf(w); if (a > ba) { ba = a; best = w; } }
    const d = new oc.BRepExtrema_DistShapeShape_2(outer, best, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
    if (d.IsDone() && d.Value() > 1e-9) return d.Value();
  }
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, p, false, false);
  const a = Math.abs(p.Mass());
  const lp = new oc.GProp_GProps_1();
  oc.BRepGProp.LinearProperties(face, lp, false, false);
  return lp.Mass() > 1e-12 ? 2 * a / lp.Mass() : 0;
}

/** End cap: a plate on each picked flat end face, `inset` in from its outline, `thickness` outwards. */
export function endCap(h: WeldHost, f: EndCapFeature, prev: Named | null, frames: Record<string, Frame>): Named {
  const oc = h.oc;
  if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
  if (!f.faces.length) throw new FeatureError("E-WLD-CAP", "Pick the end faces of members to cap.");
  const t = f.thickness.v;
  const how = capDir(f);
  // "in": each capped member is cut back by the thickness (a prism of its whole end face), so the overall length stays.
  const trims: { face: any; tool: Named }[] = [];
  const caps = f.faces.map((ref, k): Named => {
    const face = h.resolveFace(prev, ref);
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) throw new FeatureError("E-WLD-CAP", "An end cap goes on a flat end face.");
    const fr = h.planeFrame({ face: ref }, prev, frames);
    const area = (w: any) => { const ff = new oc.BRepBuilderAPI_MakeFace_15(w, true).Face(); const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(ff, p, false, false); return Math.abs(p.Mass()); };
    let wire = oc.BRepTools.OuterWire(face);
    if (how === "internal") {
      // The hollow profile's inner outline: the largest wire of the end face other than the outer one.
      const map = new oc.TopTools_IndexedMapOfShape_1();
      oc.TopExp.MapShapes_1(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, map);
      let best: any = null, ba = 0;
      for (let i = 1; i <= map.Extent(); i++) {
        const w = oc.TopoDS.Wire_1(map.FindKey(i));
        if (w.IsSame(wire)) continue;
        const a = area(w);
        if (a > ba) { ba = a; best = w; }
      }
      if (!best) throw new FeatureError("E-WLD-CAPIN", "An internal end cap needs a hollow profile (a tube or pipe).");
      wire = best;
    }
    if (how === "in") {
      const whole = new oc.BRepBuilderAPI_MakeFace_15(oc.BRepTools.OuterWire(face), true).Face();
      const v = mul(fr.n, -t);
      const shape = new oc.BRepPrimAPI_MakePrism_1(whole, new oc.gp_Vec_4(v[0], v[1], v[2]), false, true).Shape();
      const faces = h.sub(shape, "FACE");
      // The far cap becomes the member's new end face, so it keeps the end face's name.
      const names = faces.map((x, i) => {
        const fa = new oc.BRepAdaptor_Surface_2(x, true);
        if (fa.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
          const p = fa.Plane().Location();
          if (Math.abs(Math.abs(dot(sub([p.X(), p.Y(), p.Z()], fr.o), fr.n)) - t) < 1e-6 * (1 + t) && Math.abs(dot([fa.Plane().Axis().Direction().X(), fa.Plane().Axis().Direction().Y(), fa.Plane().Axis().Direction().Z()], fr.n)) > 0.999) return ref.name;
        }
        return `${f.id}:c${k}:trim:${i}`;
      });
      trims.push({ face, tool: { shape, faces, names } });
    }
    // Thickness ratio: the inset follows the member's wall (the gap between the end face's outer and inner outline).
    const ratio = how !== "internal" && f.ratio ? f.ratio.v : 0;
    const inset = ratio > 0 ? ratio * wallThickness(h, face) : f.inset.v;
    if (inset > 1e-9) {
      const off = (d: number) => {
        const mk = new oc.BRepOffsetAPI_MakeOffset_3(wire, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
        mk.Perform(d, 0);
        if (!mk.IsDone()) throw new FeatureError("E-WLD-CAP", "The inset is too big for the end face.");
        return oc.TopoDS.Wire_1(mk.Shape());
      };
      const a0 = area(wire);
      let w = off(-inset);
      if (area(w) > a0) w = off(inset);
      if (area(w) >= a0) throw new FeatureError("E-WLD-CAP", "The inset is too big for the end face.");
      wire = w;
    }
    const base = new oc.BRepBuilderAPI_MakeFace_15(wire, true).Face();
    const dir = mul(fr.n, how === "out" ? t : -t);
    const mk = new oc.BRepPrimAPI_MakePrism_1(base, new oc.gp_Vec_4(dir[0], dir[1], dir[2]), false, true);
    let shape = mk.Shape();
    if (f.chamfer && f.chamfer.v > 1e-9) {
      // Straight edges along the thickness are the plate's corners.
      const ch = f.fillet ? new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational) : new oc.BRepFilletAPI_MakeChamfer(shape);
      const what = f.fillet ? "The plate corners could not be rounded." : "The plate corners could not be chamfered.";
      let any = false;
      const plates = h.sub(shape, "FACE");
      const planeOf = (x: any): V3 | null => { const fa = new oc.BRepAdaptor_Surface_2(x, true); if (fa.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null; const d = fa.Plane().Axis().Direction(); return [d.X(), d.Y(), d.Z()]; };
      for (const e of h.sub(shape, "EDGE")) {
        const ca = new oc.BRepAdaptor_Curve_2(e);
        if (ca.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
        const p0 = ca.Value(ca.FirstParameter()), p1 = ca.Value(ca.LastParameter());
        const d = unit([p1.X() - p0.X(), p1.Y() - p0.Y(), p1.Z() - p0.Z()]);
        if (Math.abs(dot(d, fr.n)) <= 0.999) continue;
        // Only sharp corners: two flat sides at an angle (a rounded outline's tangent seams are left alone).
        const ns = plates.filter(x => h.sub(x, "EDGE").some(y => y.IsSame(e))).map(planeOf);
        if (ns.length !== 2 || !ns[0] || !ns[1] || Math.abs(dot(ns[0], ns[1])) > 0.999) continue;
        ch.Add_2(f.chamfer.v, e); any = true;
      }
      if (any) {
        try { ch.Build(new oc.Message_ProgressRange_1()); if (ch.IsDone()) shape = ch.Shape(); else h.warning = what; }
        catch { h.warning = what; }
      }
    }
    if (h.volume(shape) < 0) shape = shape.Reversed();
    const faces = h.sub(shape, "FACE");
    const names = faces.map((x, i) => {
      const fa = new oc.BRepAdaptor_Surface_2(x, true);
      if (fa.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const p = fa.Plane().Location(), nn: V3 = [fa.Plane().Axis().Direction().X(), fa.Plane().Axis().Direction().Y(), fa.Plane().Axis().Direction().Z()];
        if (Math.abs(dot(nn, fr.n)) > 0.999) return Math.abs(dot(sub([p.X(), p.Y(), p.Z()], fr.o), fr.n)) < t / 2 ? `${f.id}:c${k}:start` : `${f.id}:c${k}:end`;
      }
      return `${f.id}:c${k}:side:${i}`;
    });
    return { shape, faces, names };
  });
  const bodies = h.bodyList(prev).map(b => {
    for (const tr of trims) if (b.faces.some(x => x.IsSame(tr.face))) b = bool(h, "cut", b, tr.tool, f.id);
    return b;
  });
  return h.compoundOf([...bodies, ...caps]);
}

/** Gusset: a plate in the corner between two flat faces that meet, centred on (or flush with an end of) their common line. */
export function gusset(h: WeldHost, f: GussetFeature, prev: Named | null, frames: Record<string, Frame>): Named {
  const oc = h.oc;
  if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
  if (!f.face1 || !f.face2) throw new FeatureError("E-WLD-GUSSET", "Pick two flat faces that meet at a corner.");
  const a = h.planeFrame({ face: f.face1 }, prev, frames), b = h.planeFrame({ face: f.face2 }, prev, frames);
  const L0 = cross(a.n, b.n), s = len(L0);
  if (s < 1e-6) throw new FeatureError("E-WLD-GUSSET", "The two faces are parallel: a gusset needs faces that meet at a corner.");
  const L = mul(L0, 1 / s);
  const da = dot(a.o, a.n), db = dot(b.o, b.n);
  const o = mul(add(mul(cross(b.n, L0), da), mul(cross(L0, a.n), db)), 1 / (s * s));
  // The stretch of the corner line both faces reach.
  const span = (ref: FaceRef) => { const ts = edgePoints(h, h.resolveFace(prev, ref)).map(p => dot(sub(p, o), L)); return [Math.min(...ts), Math.max(...ts)]; };
  const [a0, a1] = span(f.face1), [b0, b1] = span(f.face2);
  let t0 = Math.max(a0, b0), t1 = Math.min(a1, b1);
  if (t1 < t0) { t0 = Math.min(a0, b0); t1 = Math.max(a1, b1); }
  const th = f.thickness.v;
  // The location point (moved by the offset), then the plate's centre from the thickness side.
  const off = f.offset?.v ?? 0, side = f.loc === "mid" ? "both" : f.side ?? "in";
  const R = f.loc === "start" ? t0 + off : f.loc === "end" ? t1 - off : (t0 + t1) / 2 + off;
  const inward = f.loc === "end" ? -1 : 1;
  const tc = side === "both" ? R : R + inward * (side === "in" ? 1 : -1) * th / 2;
  const P = add(o, mul(L, tc));
  // Legs: along each face, away from the other (into the space the other face looks at).
  const leg = (n: V3, other: V3) => { let d = unit(cross(L, n)); if (dot(d, other) < 0) d = mul(d, -1); return d; };
  const u1 = leg(a.n, b.n), u2 = leg(b.n, a.n);
  const d1 = f.d1.v, d2 = f.d2.v, c = Math.min(f.chamfer?.v ?? 0, Math.min(d1, d2) * 0.9);
  const at = (x: number, y: number) => add(add(P, mul(u1, x)), mul(u2, y));
  const pts: V3[] = c > 1e-9 ? [at(c, 0)] : [at(0, 0)];
  if (f.shape === "poly" && f.d3 && f.d3.v > 1e-9) {
    const d3v = Math.min(f.d3.v, Math.min(d1, d2) * 0.9);
    pts.push(at(d1, 0), at(d1, d3v), at(d3v, d2), at(0, d2));
  } else pts.push(at(d1, 0), at(0, d2));
  if (c > 1e-9) pts.push(at(0, c));
  const shifted = pts.map(p => sub(p, mul(L, th / 2)));
  const mk = new oc.BRepBuilderAPI_MakePolygon_1();
  for (const p of shifted) mk.Add_1(new oc.gp_Pnt_3(p[0], p[1], p[2]));
  mk.Close();
  const face = new oc.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();
  const dv = mul(L, th);
  let shape = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(dv[0], dv[1], dv[2]), false, true).Shape();
  if (h.volume(shape) < 0) shape = shape.Reversed();
  const faces = h.sub(shape, "FACE");
  // The faces lying on face 1 and face 2 are named for the leg arrows; the others by number.
  const onPlane = (x: any, fr: Frame) => {
    const ad = new oc.BRepAdaptor_Surface_2(x, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return false;
    const d = ad.Plane().Axis().Direction(), q = ad.Plane().Location();
    return Math.abs(Math.abs(dot([d.X(), d.Y(), d.Z()], fr.n)) - 1) < 1e-6 && Math.abs(dot(sub([q.X(), q.Y(), q.Z()], fr.o), fr.n)) < 1e-6 * (1 + d1 + d2);
  };
  const plate: Named = { shape, faces, names: faces.map((x, i) => onPlane(x, a) ? `${f.id}:on1` : onPlane(x, b) ? `${f.id}:on2` : `${f.id}:side:${i}`) };
  return h.compoundOf([...h.bodyList(prev), plate]);
}

/** A bead's legs as text: "6", or "6×8" (set 1 × set 2) when they differ. */
export function beadLegs(f: WeldBeadFeature): string {
  const a = f.size.v, b = f.size2 ? f.size2.v : a;
  return Math.abs(a - b) < 1e-9 ? `${a}` : `${a}×${b}`;
}

/** Fillet weld beads: a triangular bead of leg `size` along every line where a face of set 1 meets a face of set 2. */
export function weldBead(h: WeldHost, f: WeldBeadFeature, prev: Named | null, _frames: Record<string, Frame>): Named {
  const oc = h.oc;
  if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
  if (!f.faces1.length || !f.faces2.length) throw new FeatureError("E-WLD-BEAD", "Pick the faces of set 1 and set 2: the bead runs where they meet.");
  const sz = f.size.v, sz2 = f.size2 ? f.size2.v : sz;
  if (!(sz > 0) || !(sz2 > 0)) throw new FeatureError("E-WLD-BEAD", "The bead legs must be more than zero.");
  const beads: Named[] = [];
  let skipped = 0;
  const S = oc.GeomAbs_SurfaceType;
  /** Outward normal of a flat or cylindrical face at a point on it (null for other surfaces). */
  const normalAt = (face: any, p: V3): V3 | null => {
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    let n: V3;
    if (ad.GetType() === S.GeomAbs_Plane) { const d = ad.Plane().Axis().Direction(); n = [d.X(), d.Y(), d.Z()]; }
    else if (ad.GetType() === S.GeomAbs_Cylinder) {
      const ax = ad.Cylinder().Axis(), c = ax.Location(), d = ax.Direction();
      const a: V3 = [d.X(), d.Y(), d.Z()], q = sub(p, [c.X(), c.Y(), c.Z()]);
      n = unit(sub(q, mul(a, dot(q, a))));
      // The surface's own normal points away from the axis on a right-handed frame, towards it on a left-handed one.
      if (!ad.Cylinder().Position().Direct()) n = mul(n, -1);
    } else return null;
    return face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? mul(n, -1) : n;
  };
  /** The bead's cross-section at `p`, and its edges by role: the legs on face 1 and face 2, and the weld face. */
  const tri = (p: V3, ua: V3, ub: V3) => {
    const mk = new oc.BRepBuilderAPI_MakePolygon_1();
    for (const q of [p, add(p, mul(ua, sz)), add(p, mul(ub, sz2))]) mk.Add_1(new oc.gp_Pnt_3(q[0], q[1], q[2]));
    mk.Close();
    const face = new oc.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();
    const mids: [V3, string][] = [[add(p, mul(ua, sz / 2)), "leg1"], [add(p, mul(ub, sz2 / 2)), "leg2"], [add(p, add(mul(ua, sz / 2), mul(ub, sz2 / 2))), "face"]];
    const edges = h.sub(face, "EDGE").map((e): [any, string] => { const m = h.edgeMid(e); return [e, mids.reduce((b, q) => d3(q[0], m) < d3(b[0], m) ? q : b)[1]]; });
    return { face, edges };
  };
  const push = (mk: any, edges: [any, string][]) => {
    let shape = mk.Shape();
    if (h.volume(shape) < 0) shape = shape.Reversed();
    const faces = h.sub(shape, "FACE"), k = beads.length;
    const names: (string | null)[] = faces.map(() => null);
    for (const [e, role] of edges) for (const g of h.list(mk.Generated(e))) { const i = faces.findIndex(x => x.IsSame(g)); if (i >= 0) names[i] = `${f.id}:b${k}:${role}`; }
    const caps = [...h.sub(mk.FirstShape(), "FACE"), ...h.sub(mk.LastShape(), "FACE")];
    beads.push({ shape, faces, names: faces.map((x, i) => names[i] ?? (caps.some(c => c.IsSame(x)) ? `${f.id}:b${k}:cap` : `${f.id}:b${k}:side:${i}`)) });
  };
  // Tangent propagation: faces that run on smoothly from a picked one (the sides and round corners of a tube) join its set.
  const grow = (refs: FaceRef[]): any[] => {
    const set = refs.map(r => h.resolveFace(prev, r));
    if (f.tangent === false) return set;
    const all = prev.faces, edgesOf = new Map<any, any[]>();
    const es = (x: any) => { let l = edgesOf.get(x); if (!l) { l = h.sub(x, "EDGE"); edgesOf.set(x, l); } return l; };
    for (let i = 0; i < set.length; i++) {
      for (const g of all) {
        if (set.some(x => x.IsSame(g))) continue;
        const shared = es(set[i]).find(e => es(g).some(e2 => e2.IsSame(e)));
        if (!shared) continue;
        const m = h.edgeMid(shared), n1 = normalAt(set[i], m), n2 = normalAt(g, m);
        if (n1 && n2 && dot(n1, n2) > 1 - 1e-6) set.push(g);
      }
    }
    return set;
  };
  const set1 = grow(f.faces1), set2 = grow(f.faces2);
  /** One straight or round stretch of the root: its ends, length, and a builder for the bead from distance a to b along it. */
  type Run = { p0: V3; p1: V3; len: number; make: (a: number, b: number) => void };
  const runs: Run[] = [];
  for (const fa of set1) for (const fb of set2) {
    if (fa.IsSame(fb)) continue;
    const sec = new oc.BRepAlgoAPI_Section_3(fa, fb, true);
    if (!sec.IsDone()) continue;
    for (const e of h.sub(sec.Shape(), "EDGE")) {
      const ad = new oc.BRepAdaptor_Curve_2(e);
      const ty = ad.GetType(), t0 = ad.FirstParameter(), t1 = ad.LastParameter();
      const at = (t: number) => {
        const pt = new oc.gp_Pnt_1(), tv = new oc.gp_Vec_1();
        ad.D1(t, pt, tv);
        return { p: [pt.X(), pt.Y(), pt.Z()] as V3, tdir: unit([tv.X(), tv.Y(), tv.Z()]) };
      };
      /** The cross-section at parameter t (null where a face is neither flat nor round, or the faces are tangent). */
      const section = (t: number) => {
        const { p, tdir } = at(t);
        const na = normalAt(fa, p), nb = normalAt(fb, p);
        if (!na || !nb || len(cross(na, nb)) < 1e-6) return null;
        // Legs: along each face, square to the edge, towards the side the other face looks at.
        const inFace = (v: V3, n: V3) => unit(sub(sub(v, mul(n, dot(v, n))), mul(tdir, dot(v, tdir))));
        return tri(p, inFace(nb, na), inFace(na, nb));
      };
      if (!section(t0)) { skipped++; continue; }
      const p0 = at(t0).p, p1 = at(t1).p;
      if (ty === oc.GeomAbs_CurveType.GeomAbs_Line) {
        const dv = sub(p1, p0), L = len(dv);
        if (L < 1e-6) continue;
        const w = mul(dv, 1 / L);
        runs.push({ p0, p1, len: L, make: (a, b) => {
          const { face, edges } = section(t0 + (a * (t1 - t0)) / L)!;
          const v = mul(w, b - a);
          push(new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(v[0], v[1], v[2]), false, true), edges);
        } });
      } else if (ty === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        // Round the circle's axis: a tube standing on a plate, or the round corners of a hollow section.
        const ax = ad.Circle().Axis(), r = ad.Circle().Radius();
        runs.push({ p0, p1, len: r * (t1 - t0), make: (a, b) => {
          const { face, edges } = section(t0 + a / r)!;
          push(new oc.BRepPrimAPI_MakeRevol_1(face, ax, (b - a) / r, true), edges);
        } });
      } else skipped++;
    }
  }
  if (!f.inter) for (const r of runs) r.make(0, r.len);
  else {
    // Intermittent: runs chained end to end, then welds of length l every pitch along each chain from its start
    // (staggered: every other chain starts half a pitch on, so the welds on two sides of a joint alternate).
    const l = f.inter.len.v, e = Math.max(f.inter.pitch.v, l);
    if (!(l > 0)) throw new FeatureError("E-WLD-BEAD", "The weld length must be more than zero.");
    const tol = 1e-4 * (1 + Math.max(sz, sz2)), left = new Set(runs.map((_r, i) => i));
    const touches = (p: V3, skip: number) => [...left].some(j => j !== skip && (d3(runs[j].p0, p) < tol || d3(runs[j].p1, p) < tol));
    let chain = 0;
    while (left.size) {
      // An open chain starts at a free end; a closed one anywhere.
      let first = [...left][0], rev = false;
      for (const i of left) {
        if (!touches(runs[i].p0, i)) { first = i; rev = false; break; }
        if (!touches(runs[i].p1, i)) { first = i; rev = true; break; }
      }
      const off = f.inter.stagger && chain % 2 ? e / 2 : 0;
      let s = 0, cur: number | undefined = first;
      while (cur != null) {
        left.delete(cur);
        const r: Run = runs[cur];
        for (let w0 = off + Math.max(0, Math.floor((s - off - l) / e)) * e; w0 < s + r.len; w0 += e) {
          const x = Math.max(w0, s), y = Math.min(w0 + l, s + r.len);
          if (y - x < 0.05) continue;
          const a = x - s, b = y - s;
          if (rev) r.make(r.len - b, r.len - a); else r.make(a, b);
        }
        s += r.len;
        const end: V3 = rev ? r.p0 : r.p1;
        cur = [...left].find(j => d3(runs[j].p0, end) < tol || d3(runs[j].p1, end) < tol);
        if (cur != null) rev = d3(runs[cur].p1, end) < tol && !(d3(runs[cur].p0, end) < tol);
      }
      chain++;
    }
  }
  // Pieces that meet end to end become one bead (all round a tube, along a side and round its corners).
  if (beads.length > 1) {
    try {
      let all = beads[0];
      for (const b of beads.slice(1)) all = bool(h, "fuse", all, b, f.id);
      const joined = h.bodyList(unify(h, all));
      if (joined.length && joined.length < beads.length) beads.splice(0, beads.length, ...joined);
    } catch { /* kept as separate pieces */ }
  }
  if (skipped) h.warning = "Weld beads follow straight and round edges between flat and cylindrical faces; other edges were skipped.";
  if (!beads.length) throw new FeatureError("E-WLD-BEAD", "The faces of the two sets do not meet along a straight or round edge.");
  return h.compoundOf([...h.bodyList(prev), ...beads]);
}

/** Evaluates a weldment feature (called from `Modeller.evaluate`). */
export function evalWeld(h: WeldHost, f: WeldFeature, doc: PartDoc, body: Named | null, frames: Record<string, Frame>): Named {
  switch (f.type) {
    case "member": return member(h, f, doc, body, frames);
    case "trimext": return trimExtend(h, f, doc, body, frames);
    case "endcap": return endCap(h, f, body, frames);
    case "gusset": return gusset(h, f, body, frames);
    case "weldbead": return weldBead(h, f, body, frames);
  }
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** A curved member's length on its path: the arc between the end faces, measured by the angle about the axis of the points of each end face nearest the start and end, and straight runs beyond. */
/** The faces of a body whose names start with `prefix`, as a compound. */
function facesOf(h: WeldHost, part: Named, prefix: string, skip?: (face: any) => boolean): Named {
  const oc = h.oc;
  const b = new oc.BRep_Builder(), c = new oc.TopoDS_Compound();
  b.MakeCompound(c);
  const faces: any[] = [], names: string[] = [];
  part.faces.forEach((x, i) => { if (part.names[i].startsWith(prefix) && !skip?.(x)) { b.Add(c, x); faces.push(x); names.push(part.names[i]); } });
  return { shape: c, faces, names };
}

function arcLength(h: WeldHost, part: Named, s: PathSeg): number {
  const { c, n, r, ang } = s.arc!;
  const x = unit(sub(s.a, c)), y = cross(n, x);
  // Each point's position along the path: angle × r on the arc, or the distance past an end along its tangent.
  const along = (p: V3) => {
    const q = sub(p, c), t = Math.atan2(dot(q, y), dot(q, x));
    const tt = t < -1e-9 ? t + 2 * Math.PI : t;
    if (tt <= ang + 1e-9) return tt * r;
    // Past the end, or before the start (angles beyond the sweep wrap round): the nearer tangent run.
    const pastEnd = dot(sub(p, s.b), s.wb), beforeStart = dot(sub(p, s.a), mul(s.wa, -1));
    return pastEnd >= beforeStart ? s.L + pastEnd : -beforeStart;
  };
  const ts = edgePoints(h, part.shape).map(along);
  return Math.max(...ts) - Math.min(...ts);
}

/** The weldment cut list (FR-FT-121): members by profile, length and end angles; plates by size; weld beads by size. */
export function cutList(h: WeldHost, parts: { key: string; part: Named; volume: number }[], doc: PartDoc, frames: Record<string, Frame>): CutItem[] {
  const oc = h.oc;
  const rows = new Map<string, CutItem>();
  const put = (key: string, item: Omit<CutItem, "qty" | "bodies">, body: string) => {
    const r = rows.get(key);
    if (r) { r.qty++; r.bodies.push(body); } else rows.set(key, { ...item, qty: 1, bodies: [body] });
  };
  const planeN = (face: any): V3 | null => {
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
    const d = ad.Plane().Axis().Direction();
    return [d.X(), d.Y(), d.Z()];
  };
  for (const { key, part, volume } of parts) {
    const owner = part.names.map(n => doc.features.find(x => x.id === n.split(":")[0])).find(x => x && (x.type === "member" || x.type === "endcap" || x.type === "gusset" || x.type === "weldbead"));
    if (!owner) continue;
    try {
      if (owner.type === "member") {
        // A merged body (Merge arc segment bodies) holds several segments: each one's faces give its part of the length.
        const ents = [...new Set(part.names.filter(n => n.startsWith(`${owner.id}:`)).map(n => n.split(":")[1]))];
        const refs = ents.map(e => owner.segs.find(s => s.ent === e)).filter((r): r is WeldSegRef => !!r);
        if (!refs.length) continue;
        const one = refs.length === 1;
        let length = 0;
        const angs: number[] = [];
        const segsIn = refs.map(r => segOf(r, doc, frames));
        // Flat faces square to an arc's axis run on across the merged segments (UnifySameDomain joins them): left out of each segment's own faces.
        const axes = segsIn.flatMap(s => (s.arc ? [s.arc.n] : []));
        const across = (x: any) => { const n = planeN(x); return !!n && axes.some(a => Math.abs(dot(n, a)) > 1 - 1e-6); };
        for (const [k, ref] of refs.entries()) {
          const s = segsIn[k];
          const own = one ? part : facesOf(h, part, `${owner.id}:${ref.ent}:`, across);
          // Straight: the extent along the segment; curved: the length along the arc's centreline (plus straight runs past its ends).
          const ts = edgePoints(h, own.shape).map(p => dot(sub(p, s.a), s.w));
          length += s.arc ? arcLength(h, own, s) : Math.max(...ts) - Math.min(...ts);
          for (const end of ["start", "end"]) {
            const i = part.names.findIndex(n => n === `${owner.id}:${ref.ent}:${end}`);
            const n = i >= 0 ? planeN(part.faces[i]) : null;
            if (n) angs.push((Math.acos(Math.min(1, Math.abs(dot(n, end === "start" ? s.wa : s.wb)))) * 180) / Math.PI);
            else if (one) angs.push(0);
          }
        }
        while (angs.length < 2) angs.push(0);
        const a1 = r1(angs[0]), a2 = r1(angs[angs.length - 1]);
        const [lo, hi] = a1 <= a2 ? [a1, a2] : [a2, a1];
        const desc = memberDesc(owner, doc);
        put(`m|${desc}|${r1(length)}|${lo}|${hi}`, { kind: "member", desc, length: r1(length), angle1: lo, angle2: hi, volume }, key);
      } else if (owner.type === "weldbead") {
        // The root: where the two legs meet, all along the bead (round corners included).
        const elen = (e: any) => { const p = new oc.GProp_GProps_1(); oc.BRepGProp.LinearProperties(e, p, false, false); return p.Mass(); };
        const legEdges = (role: string) => part.faces.filter((_x, i) => part.names[i].endsWith(`:${role}`)).flatMap(x => h.sub(x, "EDGE"));
        const l2 = legEdges("leg2");
        const roots = legEdges("leg1").filter((e, i, arr) => l2.some(x => x.IsSame(e)) && arr.findIndex(y => y.IsSame(e)) === i);
        const length = roots.length ? roots.reduce((t, e) => t + elen(e), 0) : volume / (owner.size.v * (owner.size2 ?? owner.size).v / 2);
        const it = owner.inter, pl = it ? Math.max(it.pitch.v, it.len.v) : 0, inter: CutItem["inter"] = it ? (it.stagger ? [it.len.v, pl, 1] : [it.len.v, pl]) : undefined;
        const legs = beadLegs(owner);
        const bk = `b|${legs}${inter ? `|${inter.join("|")}` : ""}`;
        put(bk, { kind: "bead", desc: legs, length: 0, volume: 0, ...(inter ? { inter } : {}) }, key);
        const r = rows.get(bk)!;
        r.length = r1((r.length ?? 0) + length);
        r.volume += volume;
      } else {
        const t = (owner as EndCapFeature | GussetFeature).thickness.v;
        // The biggest flat face is the plate's top: its extents in its own axes.
        let best = -1, ba = 0;
        part.faces.forEach((x, i) => { if (!planeN(x)) return; const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(x, p, false, false); if (p.Mass() > ba) { ba = p.Mass(); best = i; } });
        if (best < 0) continue;
        const n = planeN(part.faces[best])!, ax = faceAxes(h, part.faces[best], n);
        const pts = edgePoints(h, part.faces[best]);
        const ext = (d: V3) => { const ts = pts.map(p => dot(p, d)); return Math.max(...ts) - Math.min(...ts); };
        const [w, l] = [r1(ext(ax.x)), r1(ext(ax.y))].sort((p, q) => q - p);
        put(`p|${t}|${w}|${l}`, { kind: "plate", desc: `${t}`, plate: [w, l, t], volume }, key);
      }
    } catch { /* a body whose path is gone is left out */ }
  }
  // Members first, then plates, then beads; within a kind by description and length.
  const order = { member: 0, plate: 1, bead: 2 };
  return [...rows.values()].sort((p, q) => order[p.kind] - order[q.kind] || p.desc.localeCompare(q.desc, "en", { numeric: true }) || (q.length ?? 0) - (p.length ?? 0));
}
