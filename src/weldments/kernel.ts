// Weldment features on OpenCASCADE (FR-FT-121): structural members, trim/extend, end caps, gussets,
// fillet weld beads, and the cut list. Runs inside `Modeller.evaluate` (kernel worker) through the
// small `WeldHost` view of the modeller: every weldment item is its own solid in the body compound.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FaceRef, Feature, Frame, PartDoc, PlaneRef, V2, V3 } from "../model/types";
import { FeatureError, type Named } from "../kernel/model";
import { anchorPoint, loopSegs, outline, profileName, profileShape, type Loop, type LoopSeg, type ProfileShape } from "./profiles";
import type { CutItem, EndCapFeature, GussetFeature, MemberFeature, TrimExtendFeature, WeldBeadFeature, WeldFeature } from "./types";

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

/** A member's path segment in the world. */
export interface PathSeg { ent: string; a: V3; b: V3; w: V3; L: number }

/** The world ends of a member segment: a 2D sketch line placed on its plane, or a 3D sketch line. */
export function segOf(ref: { sketch: string; ent: string }, doc: PartDoc, frames: Record<string, Frame>): PathSeg {
  const sk = doc.features.find(x => x.id === ref.sketch);
  const lost = () => new FeatureError("E-WLD-PATH", "A path segment of the member is missing: pick lines of a sketch or 3D sketch.");
  if (!sk || sk.suppressed) throw lost();
  let a: V3, b: V3;
  if (sk.type === "sketch") {
    const fr = frames[sk.id];
    const e = sk.ents.find(x => x.id === ref.ent);
    if (!fr || !e || e.t !== "line") throw lost();
    const pt = (id: string): V3 => {
      const p = sk.ents.find(x => x.id === id);
      if (!p || p.t !== "point") throw lost();
      return add(add(fr.o, mul(fr.x, p.x)), mul(fr.y, p.y));
    };
    a = pt(e.a); b = pt(e.b);
  } else if (sk.type === "sketch3d") {
    const s = sk.segs.find(x => x.id === ref.ent);
    if (!s || s.t !== "line") throw lost();
    const pt = (id: string): V3 => { const p = sk.pts.find(x => x.id === id); if (!p) throw lost(); return p.p; };
    a = pt(s.pts[0]); b = pt(s.pts[s.pts.length - 1]);
  } else throw lost();
  const L = d3(a, b);
  if (L < 1e-6) throw new FeatureError("E-WLD-PATH", "A path segment of the member has no length.");
  return { ent: ref.ent, a, b, w: mul(sub(b, a), 1 / L), L };
}

/** The "up" direction of a profile on a segment: a 2D sketch's normal, else world Z (X for vertical members). */
function upOf(ref: { sketch: string }, seg: PathSeg, doc: PartDoc, frames: Record<string, Frame>): V3 {
  const sk = doc.features.find(x => x.id === ref.sketch);
  let up: V3 = sk?.type === "sketch" && frames[sk.id] ? frames[sk.id].n : [0, 0, 1];
  if (Math.abs(dot(up, seg.w)) > 0.99) up = Math.abs(seg.w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(sub(up, mul(seg.w, dot(up, seg.w))));
}

/** How a member's profile is placed on one segment: profile (u, v) to world, on the plane through `at`. */
interface Placement { u: V3; v: V3; w: V3; p2: (q: V2) => V2; R: number; shape: ProfileShape }

function placement(f: MemberFeature, seg: PathSeg, ref: { sketch: string }, doc: PartDoc, frames: Record<string, Frame>): Placement {
  const shape = profileShape(f.profile, f.size);
  if (!shape) throw new FeatureError("E-WLD-SIZE", "Unknown profile size: pick one from the list.");
  const v = upOf(ref, seg, doc, frames);
  const u = cross(v, seg.w);
  const an = anchorPoint(shape, f.anchor ?? "c");
  const a = f.angle?.v ?? 0, c = Math.cos(a), s = Math.sin(a);
  const p2 = (q: V2): V2 => {
    let x = q[0] - an[0];
    const y = q[1] - an[1];
    if (f.mirror) x = -x;
    return [x * c - y * s, x * s + y * c];
  };
  const R = Math.max(...outline(shape.outer, 8).map(q => Math.hypot(...p2(q))));
  return { u, v, w: seg.w, p2, R, shape };
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
  const pls = segs.map((s, i) => placement(f, s, f.segs[i], doc, frames));
  const tol = 1e-6 * (1 + Math.max(...segs.map(s => s.L)));
  const endPt = (i: number, e: 0 | 1) => (e ? segs[i].b : segs[i].a);
  const ends: [End, End][] = segs.map((_s, i) => ([0, 1] as const).map(e => {
    const P = endPt(i, e);
    const others: [number, 0 | 1][] = [];
    segs.forEach((_t, j) => { if (j !== i) for (const k of [0, 1] as const) if (d3(endPt(j, k), P) < tol) others.push([j, k]); });
    if (others.length !== 1 || f.corner === "none") return { kind: "free" } as End;
    const [j, k] = others[0];
    const din = e ? segs[i].w : mul(segs[i].w, -1);
    const dout = k ? mul(segs[j].w, -1) : segs[j].w;
    if (Math.abs(dot(din, dout)) > 1 - 1e-9) return { kind: "free" } as End;
    if (f.corner === "miter") return { kind: "miter", n: unit(add(din, dout)) } as End;
    const through = f.corner === "butt1" ? Math.min(i, j) : Math.max(i, j);
    if (through !== i) return { kind: "trimmed", other: j } as End;
    // Run past the corner until the other member's outline is covered.
    const ext = Math.max(0, ...outline(pls[j].shape.outer, 8).map(q => dot(sub(at3(pls[j], P, q), P), din)));
    return { kind: "through", ext } as End;
  }) as [End, End]);
  const items: Named[] = segs.map((s, i) => {
    const pl = pls[i], base = `${f.id}:${s.ent}`;
    const extOf = (e: End) => e.kind === "through" ? e.ext : e.kind === "miter" ? pl.R / Math.max(Math.abs(dot(e.n, s.w)), 0.05) + pl.R : e.kind === "trimmed" ? pls[e.other].R + pl.R * 2 : 0;
    const [e0, e1] = ends[i];
    let body = prism(h, pl, sub(s.a, mul(s.w, extOf(e0))), add(s.b, mul(s.w, extOf(e1))), base);
    const big = 4 * (s.L + pl.R * 40);
    ([e0, e1] as End[]).forEach((e, k) => {
      const P = k ? s.b : s.a;
      const nm = `${base}:${k ? "end" : "start"}`;
      if (e.kind === "miter") body = bool(h, "cut", body, halfBox(h, P, e.n, big, nm), f.id);
      if (e.kind === "trimmed") {
        // Cut square to the other member's face that looks at this one (the plane holds its axis).
        const o = segs[e.other], op = pls[e.other];
        const din = k ? s.w : mul(s.w, -1);
        const m = unit(sub(mul(din, -1), mul(o.w, dot(mul(din, -1), o.w))));
        const ext = Math.max(0, ...outline(op.shape.outer, 8).map(q => dot(sub(at3(op, P, q), P), m)));
        body = bool(h, "cut", body, halfBox(h, add(P, mul(m, ext)), mul(m, -1), big, nm), f.id);
      }
    });
    return pieceNear(h, body, add(s.a, mul(s.w, s.L / 2)));
  });
  return h.compoundOf([...(prev ? h.bodyList(prev) : []), ...items]);
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
  if (!f.boundary) throw new FeatureError("E-WLD-TRIM", "Pick the boundary: a flat face or a body.");
  const list = h.bodyList(prev);
  const bi = bodyOf(h, list, prev, f.boundary);
  let plane: { p: V3; n: V3 } | null = null;
  if (f.kind === "face") {
    const fr = h.planeFrame({ face: f.boundary }, prev, frames);
    plane = { p: fr.o, n: fr.n };
  }
  const bound = list[bi];
  for (const ref of f.bodies) {
    const mo = memberOfFace(ref.name, doc);
    if (!mo) throw new FeatureError("E-WLD-TRIM", "Only structural member bodies can be trimmed: pick a face of a member.");
    const i = bodyOf(h, list, prev, ref);
    if (i === bi) throw new FeatureError("E-WLD-TRIM", "A member can't be trimmed by itself.");
    const sref = mo.f.segs.find(s => s.ent === mo.ent)!;
    const s = segOf(sref, doc, frames);
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
      body = bool(h, "cut", body, halfBox(h, plane.p, away, 4 * (s.L + reach + pl.R * 10), nm), f.id);
    } else body = bool(h, "cut", body, { ...bound, names: bound.names.map(() => nm) }, f.id);
    list[i] = unify(h, pieceNear(h, body, mid));
  }
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

/** End cap: a plate on each picked flat end face, `inset` in from its outline, `thickness` outwards. */
export function endCap(h: WeldHost, f: EndCapFeature, prev: Named | null, frames: Record<string, Frame>): Named {
  const oc = h.oc;
  if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
  if (!f.faces.length) throw new FeatureError("E-WLD-CAP", "Pick the end faces of members to cap.");
  const t = f.thickness.v;
  const caps = f.faces.map((ref, k): Named => {
    const face = h.resolveFace(prev, ref);
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) throw new FeatureError("E-WLD-CAP", "An end cap goes on a flat end face.");
    const fr = h.planeFrame({ face: ref }, prev, frames);
    let wire = oc.BRepTools.OuterWire(face);
    const area = (w: any) => { const ff = new oc.BRepBuilderAPI_MakeFace_15(w, true).Face(); const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(ff, p, false, false); return Math.abs(p.Mass()); };
    if (f.inset.v > 1e-9) {
      const off = (d: number) => {
        const mk = new oc.BRepOffsetAPI_MakeOffset_3(wire, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
        mk.Perform(d, 0);
        if (!mk.IsDone()) throw new FeatureError("E-WLD-CAP", "The inset is too big for the end face.");
        return oc.TopoDS.Wire_1(mk.Shape());
      };
      const a0 = area(wire);
      let w = off(-f.inset.v);
      if (area(w) > a0) w = off(f.inset.v);
      if (area(w) >= a0) throw new FeatureError("E-WLD-CAP", "The inset is too big for the end face.");
      wire = w;
    }
    const base = new oc.BRepBuilderAPI_MakeFace_15(wire, true).Face();
    const dir = mul(fr.n, f.inward ? -t : t);
    const mk = new oc.BRepPrimAPI_MakePrism_1(base, new oc.gp_Vec_4(dir[0], dir[1], dir[2]), false, true);
    let shape = mk.Shape();
    if (f.chamfer && f.chamfer.v > 1e-9) {
      // Straight edges along the thickness are the plate's corners.
      const ch = new oc.BRepFilletAPI_MakeChamfer(shape);
      let any = false;
      for (const e of h.sub(shape, "EDGE")) {
        const ca = new oc.BRepAdaptor_Curve_2(e);
        if (ca.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
        const p0 = ca.Value(ca.FirstParameter()), p1 = ca.Value(ca.LastParameter());
        const d = unit([p1.X() - p0.X(), p1.Y() - p0.Y(), p1.Z() - p0.Z()]);
        if (Math.abs(dot(d, fr.n)) > 0.999) { ch.Add_2(f.chamfer.v, e); any = true; }
      }
      if (any) {
        try { ch.Build(new oc.Message_ProgressRange_1()); if (ch.IsDone()) shape = ch.Shape(); else h.warning = "The plate corners could not be chamfered."; }
        catch { h.warning = "The plate corners could not be chamfered."; }
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
  return h.compoundOf([...h.bodyList(prev), ...caps]);
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
  const tc = f.loc === "start" ? t0 + th / 2 : f.loc === "end" ? t1 - th / 2 : (t0 + t1) / 2;
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
  const plate: Named = { shape, faces, names: faces.map((_x, i) => `${f.id}:side:${i}`) };
  return h.compoundOf([...h.bodyList(prev), plate]);
}

/** Fillet weld beads: a triangular bead of leg `size` along every line where a face of set 1 meets a face of set 2. */
export function weldBead(h: WeldHost, f: WeldBeadFeature, prev: Named | null, frames: Record<string, Frame>): Named {
  const oc = h.oc;
  if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
  if (!f.faces1.length || !f.faces2.length) throw new FeatureError("E-WLD-BEAD", "Pick the faces of set 1 and set 2: the bead runs where they meet.");
  const sz = f.size.v;
  const beads: Named[] = [];
  let skipped = 0;
  for (const r1 of f.faces1) for (const r2 of f.faces2) {
    const fa = h.resolveFace(prev, r1), fb = h.resolveFace(prev, r2);
    const flat = (x: any) => new oc.BRepAdaptor_Surface_2(x, true).GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane;
    if (!flat(fa) || !flat(fb)) { skipped++; continue; }
    const A = h.planeFrame({ face: r1 }, prev, frames), B = h.planeFrame({ face: r2 }, prev, frames);
    if (len(cross(A.n, B.n)) < 1e-6) continue;
    const sec = new oc.BRepAlgoAPI_Section_3(fa, fb, true);
    if (!sec.IsDone()) continue;
    for (const e of h.sub(sec.Shape(), "EDGE")) {
      const ad = new oc.BRepAdaptor_Curve_2(e);
      if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) { skipped++; continue; }
      const q0 = ad.Value(ad.FirstParameter()), q1 = ad.Value(ad.LastParameter());
      const p0: V3 = [q0.X(), q0.Y(), q0.Z()], p1: V3 = [q1.X(), q1.Y(), q1.Z()];
      if (d3(p0, p1) < 1e-6) continue;
      const tdir = unit(sub(p1, p0));
      const inPlane = (v: V3, n: V3) => unit(sub(sub(v, mul(n, dot(v, n))), mul(tdir, dot(v, tdir))));
      const ua = inPlane(B.n, A.n), ub = inPlane(A.n, B.n);
      const tri = [p0, add(p0, mul(ua, sz)), add(p0, mul(ub, sz))];
      const mk = new oc.BRepBuilderAPI_MakePolygon_1();
      for (const p of tri) mk.Add_1(new oc.gp_Pnt_3(p[0], p[1], p[2]));
      mk.Close();
      const face = new oc.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();
      const dv = sub(p1, p0);
      let shape = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(dv[0], dv[1], dv[2]), false, true).Shape();
      if (h.volume(shape) < 0) shape = shape.Reversed();
      const faces = h.sub(shape, "FACE"), k = beads.length;
      beads.push({ shape, faces, names: faces.map((_x, i) => `${f.id}:b${k}:side:${i}`) });
    }
  }
  if (skipped) h.warning = "Weld beads run along straight edges between flat faces; curved ones were skipped.";
  if (!beads.length) throw new FeatureError("E-WLD-BEAD", "The faces of the two sets do not meet along a straight edge.");
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
        const ent = part.names.find(n => n.startsWith(`${owner.id}:`))!.split(":")[1];
        const ref = owner.segs.find(s => s.ent === ent);
        if (!ref) continue;
        const s = segOf(ref, doc, frames);
        const ts = edgePoints(h, part.shape).map(p => dot(sub(p, s.a), s.w));
        const length = Math.max(...ts) - Math.min(...ts);
        const ang = (end: string) => {
          const i = part.names.findIndex(n => n === `${owner.id}:${ent}:${end}`);
          const n = i >= 0 ? planeN(part.faces[i]) : null;
          return n ? (Math.acos(Math.min(1, Math.abs(dot(n, s.w)))) * 180) / Math.PI : 0;
        };
        const a1 = r1(ang("start")), a2 = r1(ang("end"));
        const [lo, hi] = a1 <= a2 ? [a1, a2] : [a2, a1];
        const desc = profileName(owner.profile, owner.size);
        put(`m|${desc}|${r1(length)}|${lo}|${hi}`, { kind: "member", desc, length: r1(length), angle1: lo, angle2: hi, volume }, key);
      } else if (owner.type === "weldbead") {
        const length = volume / (owner.size.v * owner.size.v / 2);
        put(`b|${owner.size.v}`, { kind: "bead", desc: `${owner.size.v}`, length: 0, volume: 0 }, key);
        const r = rows.get(`b|${owner.size.v}`)!;
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
