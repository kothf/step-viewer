// Feature evaluation with the full OpenCASCADE kernel (FRS sections 6.3, 9, 9.14).
//
// Runs in the kernel worker. Each feature turns the previous body into a new
// one. Faces carry persistent names: an extruded or revolved face is named after
// the feature and the sketch curve it was swept from (`f3:side:e7`), caps
// `f3:start`/`f3:end`, fillet faces `f5:fillet:<n>`; booleans and fillets pass
// names on through OCCT's Modified() history. Edges are referenced as the edge
// between two named faces, so a fillet stays on "the edge between side e1 and
// side e2" when sizes change.
//
// Works on a raw emscripten instance (`oc: any`), like occ.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { V2 } from "../model/types";
import type { AxisFeature, BodyProps, CircularPatternFeature, EdgeRef, HoleFeature, FaceRef, Feature, FeatureStatus, Frame, LinearPatternFeature, LineRef, MirrorFeature, PartDoc, PlaneFeature, PlaneRef, PointFeature, ShellFeature, DraftFeature, Num, SketchFeature, ThreadFeature, V3 } from "../model/types";
import { featureRefs } from "../model/doc";
import { loopPolygon, polyArea, sketchProfile, type ProfileFace, type Seg } from "../sketch/profile";

export class FeatureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A body and the names of its faces (parallel arrays). */
interface Named { shape: any; faces: any[]; names: string[] }

/** What a feature added or removed, so mirror and patterns can copy it: its tool solids and how each was applied. */
type Tool = { shape: Named; op: "fuse" | "cut" };
interface CacheEntry { key: string; body: Named | null; status: FeatureStatus; frame?: Frame; tools?: Tool[] }

export interface ModelMesh {
  name: string;
  color: number[];
  brep_faces: { first: number; last: number; color: number[] | null }[];
  attributes: { position: { array: number[] }; normal: { array: number[] } };
  index: { array: number[] };
}

export interface ModelResult {
  statuses: FeatureStatus[];
  frames: Record<string, Frame>;
  /** Null when no feature has made a body yet. */
  mesh: ModelMesh | null;
  faceNames: string[];
  volume: number;
  area: number;
  com: V3;
}

export const STD_FRAMES: Record<"XY" | "XZ" | "YZ", Frame> = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] },
};

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const d3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Rodrigues rotation of v about the unit axis u by angle a. */
const rotate = (v: V3, u: V3, a: number): V3 => {
  const c = Math.cos(a), s = Math.sin(a), k = dot(u, v) * (1 - c), w = cross(u, v);
  return [v[0] * c + w[0] * s + u[0] * k, v[1] * c + w[1] * s + u[1] * k, v[2] * c + w[2] * s + u[2] * k];
};
/** A right-handed frame from an origin, an x direction (made square to n) and the normal. */
function frameFrom(o: V3, x: V3, n: V3): Frame {
  n = unit(n);
  x = unit(add(x, mul(n, -dot(x, n))));
  return { o, x, y: cross(n, x), n };
}

export class Modeller {
  private cache: CacheEntry[] = [];
  /** Tools of the features evaluated so far in this evaluation (by feature id). */
  private tools = new Map<string, Tool[]>();
  /** A warning set while evaluating the current feature. */
  private warning = "";

  constructor(private oc: any) {}

  // ---------- small helpers ----------

  private P(p: V3) { return new this.oc.gp_Pnt_3(p[0], p[1], p[2]); }
  private D(d: V3) { return new this.oc.gp_Dir_4(d[0], d[1], d[2]); }
  private V(d: V3) { return new this.oc.gp_Vec_4(d[0], d[1], d[2]); }
  private xyz(p: any): V3 { return [p.X(), p.Y(), p.Z()]; }
  private w(f: Frame, p: [number, number], off: V3 = [0, 0, 0]): V3 { return add(add(add(f.o, mul(f.x, p[0])), mul(f.y, p[1])), off); }

  private list(l: any): any[] {
    const out: any[] = [];
    // No list iterator in the bindings: walk a copy, keeping a value copy of each shape.
    const copy = new this.oc.TopTools_ListOfShape_3(l);
    while (copy.Size() > 0) { const s = copy.First_1(); out.push(s.Oriented(s.Orientation_1())); copy.RemoveFirst(); }
    copy.delete();
    return out;
  }

  private sub(shape: any, kind: "FACE" | "EDGE"): any[] {
    const oc = this.oc, A = oc.TopAbs_ShapeEnum;
    const out: any[] = [];
    const map = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(shape, kind === "FACE" ? A.TopAbs_FACE : A.TopAbs_EDGE, map);
    for (let i = 1; i <= map.Extent(); i++) out.push(kind === "FACE" ? oc.TopoDS.Face_1(map.FindKey(i)) : oc.TopoDS.Edge_1(map.FindKey(i)));
    return out;
  }

  private subWires(shape: any): any[] {
    const oc = this.oc;
    const out: any[] = [];
    const map = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_WIRE, map);
    for (let i = 1; i <= map.Extent(); i++) out.push(oc.TopoDS.Wire_1(map.FindKey(i)));
    return out;
  }

  private centroid(face: any): V3 {
    const props = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    return this.xyz(props.CentreOfMass());
  }

  private edgeMid(edge: any): V3 {
    const props = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.LinearProperties(edge, props, false, false);
    return this.xyz(props.CentreOfMass());
  }

  /** Names of a body's faces after an operation, carried over from its inputs. */
  private carry(mk: any, inputs: Named[], result: any, fallback: string): Named {
    const pairs: [any, string][] = [];
    for (const n of inputs) n.faces.forEach((f, i) => {
      if (mk.IsDeleted(f)) return;
      const mods = this.list(mk.Modified(f));
      if (!mods.length) pairs.push([f, n.names[i]]);
      else for (const m of mods) pairs.push([m, n.names[i]]);
    });
    const faces = this.sub(result, "FACE");
    let k = 0;
    const names = faces.map(f => pairs.find(([g]) => g.IsSame(f))?.[1] ?? `${fallback}:new:${k++}`);
    return { shape: result, faces, names };
  }

  // ---------- references ----------

  resolveFace(body: Named | null, ref: FaceRef): any {
    if (!body) throw new FeatureError("E-TN-LOST", `Reference lost: face ${ref.name}`);
    const idx = body.names.map((n, i) => (n === ref.name ? i : -1)).filter(i => i >= 0);
    if (!idx.length) throw new FeatureError("E-TN-LOST", `Reference lost: face ${ref.name}`);
    if (idx.length === 1 || !ref.hint) return body.faces[idx[0]];
    let best = idx[0], bd = Infinity;
    for (const i of idx) { const d = d3(this.centroid(body.faces[i]), ref.hint); if (d < bd) { bd = d; best = i; } }
    return body.faces[best];
  }

  resolveEdge(body: Named | null, ref: EdgeRef): any {
    if (!body) throw new FeatureError("E-TN-LOST", "Reference lost: edge (no body)");
    const [na, nb] = ref.faces;
    const fa = body.faces.filter((_f, i) => body.names[i] === na);
    const fb = body.faces.filter((_f, i) => body.names[i] === nb);
    const cands: any[] = [];
    for (const a of fa) {
      const ea = this.sub(a, "EDGE");
      for (const b of fb) {
        if (a.IsSame(b)) continue;
        for (const e of this.sub(b, "EDGE")) if (ea.some(x => x.IsSame(e)) && !cands.some(c => c.IsSame(e))) cands.push(e);
      }
    }
    if (!cands.length) throw new FeatureError("E-TN-LOST", `Reference lost: edge between ${na} and ${nb}`);
    if (cands.length === 1 || !ref.hint) return cands[0];
    let best = cands[0], bd = Infinity;
    for (const e of cands) { const d = d3(this.edgeMid(e), ref.hint); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  /** The frame of a sketch plane. */
  frameOf(sk: SketchFeature, body: Named | null, frames: Record<string, Frame> = {}): Frame {
    return this.planeFrame(sk.plane, body, frames);
  }

  /** The frame of a plane reference: a standard plane, a flat face, or a reference plane evaluated before. */
  planeFrame(ref: PlaneRef, body: Named | null, frames: Record<string, Frame>): Frame {
    if ("std" in ref) return STD_FRAMES[ref.std];
    if ("plane" in ref) {
      const f = frames[ref.plane];
      if (!f) throw new FeatureError("E-FT-PARENT", "The reference plane is missing or has an error.");
      return f;
    }
    const oc = this.oc;
    const face = this.resolveFace(body, ref.face);
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) throw new FeatureError("E-FT-NOTPLANAR", "A sketch needs a flat face or a plane.");
    const pos = ad.Plane().Position();
    let n = this.xyz(pos.Direction());
    const x = this.xyz(pos.XDirection());
    const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    if (reversed) { n = mul(n, -1); }
    let o: V3 = mul(n, dot(this.xyz(pos.Location()), n));
    if (ref.offset) o = add(o, mul(n, ref.offset));
    return frameFrom(o, x, n);
  }

  /** A reference plane: offset along the base's normal, or turned about a straight edge. */
  private refPlane(f: PlaneFeature, body: Named | null, frames: Record<string, Frame>): Frame {
    const base = this.planeFrame(f.base, body, frames);
    const sg = f.flip ? -1 : 1;
    if (f.mode === "offset") {
      const o = add(base.o, mul(base.n, sg * f.offset.v));
      return { o: mul(base.n, dot(o, base.n)), x: base.x, y: base.y, n: base.n };
    }
    if (!f.axis) throw new FeatureError("E-REF-AXIS", "Pick a straight edge to turn the plane about.");
    const oc = this.oc;
    const e = this.resolveEdge(body, f.axis);
    const ad = new oc.BRepAdaptor_Curve_2(e);
    if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) throw new FeatureError("E-REF-AXIS", "The plane turns about a straight edge.");
    const lin = ad.Line();
    const p = this.xyz(lin.Location());
    const u = this.xyz(lin.Direction());
    const a = sg * (f.angle?.v ?? 0);
    const rot = (v: V3) => rotate(v, u, a);
    const n = rot(base.n);
    const x = rot(base.x);
    // Through the edge: the origin is the world origin's projection onto the turned plane.
    return frameFrom(mul(n, dot(p, n)), x, n);
  }

  /** A reference axis as a frame: `o` a point on it, `n` its direction. */
  private refAxis(f: AxisFeature, body: Named | null, frames: Record<string, Frame>): Frame {
    const oc = this.oc;
    const line = (o: V3, d: V3) => frameFrom(o, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], unit(d));
    if (f.mode === "edge") {
      if (!f.edge) throw new FeatureError("E-REF-PICK", "Pick a straight edge.");
      const ad = new oc.BRepAdaptor_Curve_2(this.resolveEdge(body, f.edge));
      if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) throw new FeatureError("E-REF-PICK", "The axis needs a straight edge.");
      return line(this.xyz(ad.Line().Location()), this.xyz(ad.Line().Direction()));
    }
    if (f.mode === "cylinder") {
      if (!f.face) throw new FeatureError("E-REF-PICK", "Pick a cylindrical or conical face.");
      const ad = new oc.BRepAdaptor_Surface_2(this.resolveFace(body, f.face), true);
      const ty = ad.GetType();
      const ax = ty === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder ? ad.Cylinder().Axis() : ty === oc.GeomAbs_SurfaceType.GeomAbs_Cone ? ad.Cone().Axis() : null;
      if (!ax) throw new FeatureError("E-REF-PICK", "The axis needs a cylindrical or conical face.");
      return line(this.xyz(ax.Location()), this.xyz(ax.Direction()));
    }
    const [a, b] = (f.planes ?? []).map(p => this.planeFrame(p, body, frames));
    if (!a || !b) throw new FeatureError("E-REF-PICK", "Pick two planes or flat faces.");
    const d = cross(a.n, b.n);
    const s = Math.hypot(...d);
    if (s < 1e-9) throw new FeatureError("E-REF-PARALLEL", "The two planes are parallel: they do not meet.");
    // The point on both planes nearest the origin.
    const da = dot(a.o, a.n), db = dot(b.o, b.n);
    const o = mul(add(mul(cross(b.n, d), da), mul(cross(d, a.n), db)), 1 / (s * s));
    return line(o, d);
  }

  /** A reference point as a frame at the point. */
  private refPoint(f: PointFeature, body: Named | null): Frame {
    const oc = this.oc;
    const at = (o: V3): Frame => ({ o, x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] });
    if (f.mode === "face") {
      if (!f.face) throw new FeatureError("E-REF-PICK", "Pick a face.");
      return at(this.centroid(this.resolveFace(body, f.face)));
    }
    if (!f.edge) throw new FeatureError("E-REF-PICK", "Pick an edge.");
    const e = this.resolveEdge(body, f.edge);
    if (f.mode === "mid") return at(this.edgeMid(e));
    const ad = new oc.BRepAdaptor_Curve_2(e);
    if (f.mode === "centre") {
      const ty = ad.GetType();
      if (ty !== oc.GeomAbs_CurveType.GeomAbs_Circle) throw new FeatureError("E-REF-PICK", "The centre needs a circle or an arc.");
      return at(this.xyz(ad.Circle().Location()));
    }
    const p0 = this.xyz(ad.Value(ad.FirstParameter())), p1 = this.xyz(ad.Value(ad.LastParameter()));
    const hint = f.at ?? f.edge.hint ?? p0;
    return at(d3(p0, hint) <= d3(p1, hint) ? p0 : p1);
  }

  // ---------- profiles ----------

  /** OCCT faces of a sketch's regions, plus which sketch curve each edge came from. */
  private profileFaces(sk: SketchFeature, frame: Frame, off: V3 = [0, 0, 0], skip?: Set<string>) {
    const oc = this.oc;
    const prof = sketchProfile(sk, skip);
    if (prof.error) throw new FeatureError(prof.error.code, prof.error.message);
    const edgeEnt: [any, string][] = [];
    const nrm = this.D(frame.n);
    const edgeOf = (s: Seg) => {
      let e: any;
      if (s.kind === "line") e = new oc.BRepBuilderAPI_MakeEdge_3(this.P(this.w(frame, s.a, off)), this.P(this.w(frame, s.b, off))).Edge();
      else if (s.kind === "spline") {
        // One B-spline edge: the Bézier segments joined with triple knots (C1 form of the C2 curve).
        const n = (s.bz.length - 1) / 3;
        const poles = new oc.TColgp_Array1OfPnt_2(1, s.bz.length);
        s.bz.forEach((q, i) => poles.SetValue(i + 1, this.P(this.w(frame, q, off))));
        const knots = new oc.TColStd_Array1OfReal_2(1, n + 1), mults = new oc.TColStd_Array1OfInteger_2(1, n + 1);
        // Knots at the chord lengths the interpolant was parametrised by, so the joins are C2 in the parameter too.
        let u = 0;
        for (let i = 0; i <= n; i++) {
          if (i) u += Math.hypot(s.bz[3 * i][0] - s.bz[3 * i - 3][0], s.bz[3 * i][1] - s.bz[3 * i - 3][1]) || 1e-9;
          knots.SetValue(i + 1, u); mults.SetValue(i + 1, i === 0 || i === n ? 4 : 3);
        }
        const curve = new oc.Geom_BSplineCurve_1(poles, knots, mults, 3, false);
        // The interpolant is C2: drop the interior knots to single ones (cleaner curve, accurate mass properties).
        for (let i = n; i >= 2; i--) curve.RemoveKnot(i, 1, 1e-7 * (1 + Math.abs(s.bz[0][0]) + Math.abs(s.bz[0][1])));
        e = new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(curve)).Edge();
      } else if (s.kind === "ellipse" || s.kind === "earc") {
        // gp_Elips wants the major radius first: swap the axes when the "minor" one is longer.
        const { c, u, r1, r2 } = s.el;
        const x: V2 = r1 >= r2 ? u : [-u[1], u[0]];
        const xw = add(this.w(frame, [c[0] + x[0], c[1] + x[1]], off), mul(this.w(frame, c, off), -1));
        const el = new oc.gp_Elips_2(new oc.gp_Ax2_2(this.P(this.w(frame, c, off)), nrm, this.D(xw)), Math.max(r1, r2), Math.min(r1, r2));
        if (s.kind === "ellipse") e = new oc.BRepBuilderAPI_MakeEdge_12(el).Edge();
        else {
          const pa = this.P(this.w(frame, s.a, off)), pb = this.P(this.w(frame, s.b, off));
          e = s.ccw ? new oc.BRepBuilderAPI_MakeEdge_14(el, pa, pb).Edge() : oc.TopoDS.Edge_1(new oc.BRepBuilderAPI_MakeEdge_14(el, pb, pa).Edge().Reversed());
        }
      } else {
        const circ = new oc.gp_Circ_2(new oc.gp_Ax2_2(this.P(this.w(frame, s.c, off)), nrm, this.D(frame.x)), s.r);
        if (s.kind === "circle") e = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
        else {
          const pa = this.P(this.w(frame, s.a, off)), pb = this.P(this.w(frame, s.b, off));
          // Arc from a to b counter-clockwise about the normal, reversed when the loop runs the other way.
          e = s.ccw ? new oc.BRepBuilderAPI_MakeEdge_10(circ, pa, pb).Edge() : oc.TopoDS.Edge_1(new oc.BRepBuilderAPI_MakeEdge_10(circ, pb, pa).Edge().Reversed());
        }
      }
      return e;
    };
    const wireOf = (loop: Seg[]) => {
      const mk = new oc.BRepBuilderAPI_MakeWire_1();
      for (const s of loop) mk.Add_1(edgeOf(s));
      if (!mk.IsDone()) throw new FeatureError("E-SK-OPEN", "A sketch contour could not be closed.");
      return mk.Wire();
    };
    const faces = prof.faces.map((pf: ProfileFace) => {
      // The outer loop runs counter-clockwise about the sketch normal and holes clockwise, whichever
      // way the sketch's curves happen to be chained (a hole wire the same way round adds area).
      const oriented = (loop: Seg[], ccw: boolean) => {
        const w = wireOf(loop);
        return (polyArea(loopPolygon(loop)) > 0) === ccw ? w : oc.TopoDS.Wire_1(w.Reversed());
      };
      const mk = new oc.BRepBuilderAPI_MakeFace_15(oriented(pf.outer, true), true);
      for (const h of pf.holes) mk.Add(oriented(h, false));
      const fix = new oc.ShapeFix_Face_2(mk.Face());
      fix.Perform();
      const face = fix.Face();
      // Wire building and healing copy edges: match the face's edges to the sketch curves by position.
      const segs = [pf.outer, ...pf.holes].flat();
      for (const e of this.sub(face, "EDGE")) {
        const p = this.edgeMid(e);
        let best = segs[0], bd = Infinity;
        for (const sg of segs) { const d = this.segDist(sg, frame, off, p); if (d < bd) { bd = d; best = sg; } }
        edgeEnt.push([e, best.ent]);
      }
      return face;
    });
    return { faces, edgeEnt };
  }

  /** Distance from a point to (the middle of) a sketch curve placed in the world. */
  private segDist(s: Seg, frame: Frame, off: V3, p: V3) {
    if (s.kind === "line") return d3(this.w(frame, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], off), p);
    if (s.kind === "ellipse" || s.kind === "earc" || s.kind === "spline") {
      // Nearest of a few points along the curve.
      const pts = loopPolygon([s], 16);
      if (s.kind === "earc") pts.push(s.b);
      if (s.kind === "spline") pts.push(s.bz[s.bz.length - 1]);
      return Math.min(...pts.map(q => d3(this.w(frame, q, off), p)));
    }
    const c = this.w(frame, s.c, off);
    if (s.kind === "circle") return Math.abs(d3(c, p) - s.r) + Math.abs((p[0] - c[0]) * frame.n[0] + (p[1] - c[1]) * frame.n[1] + (p[2] - c[2]) * frame.n[2]);
    const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
    let a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
    if (s.ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
    const t = (a0 + a1) / 2;
    return d3(this.w(frame, [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)], off), p);
  }

  // ---------- features ----------

  private sweep(f: Feature & { type: "extrude" | "revolve" }, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const sk = doc.features.find(x => x.id === f.sketch);
    if (!sk || sk.type !== "sketch") throw new FeatureError("E-FT-NOSKETCH", "The feature's sketch is missing.");
    if (sk.suppressed) throw new FeatureError("E-FT-PARENT", "The feature's sketch is suppressed.");
    const frame = frames[sk.id] ?? this.frameOf(sk, prev, frames);
    let tools: Named[] = [];
    if (f.type === "extrude" && (f.end === "upto" || f.end === "offset")) {
      tools = this.upTo(f, sk, frame, prev, frames);
    } else if (f.type === "extrude") {
      // A cut goes into the material (against the sketch normal); Reverse direction flips either.
      const dir = (f.op === "cut" ? -1 : 1) * (f.flip ? -1 : 1);
      let d1 = f.depth.v, d2 = f.depth2?.v ?? 0;
      if (f.end === "mid") { d2 = d1 / 2; d1 = d1 / 2; }
      if (f.end === "through" || f.end === "through2") {
        if (!prev) throw new FeatureError("E-FT-NOBODY", "Through all needs a body to cut.");
        d1 = this.size(prev.shape) * 2 + 1;
        // Through all both: as far again behind the sketch plane.
        d2 = f.end === "through2" ? d1 : 0;
      }
      if (!(d1 + d2 > 1e-6)) throw new FeatureError("E-FT-ZERO", "The depth must be more than 0.");
      const off = mul(frame.n, -d2 * dir);
      const { faces, edgeEnt } = this.profileFaces(sk, frame, off);
      for (const face0 of faces) {
        const face = f.thin ? this.thinFace(face0, f.thin) : face0;
        const mk = new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(frame.n, (d1 + d2) * dir)), false, true);
        mk.Build(new oc.Message_ProgressRange_1());
        if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The extrusion failed.");
        let t = this.nameSweep(mk, f.id, edgeEnt, mk.Shape());
        // Draft while extruding: the side faces taper about the sketch plane, away from it.
        if (f.draft && Math.abs(f.draft.angle.v) > 1e-9) {
          const a = f.draft.angle.v;
          if (Math.abs(a) >= Math.PI / 2 - 1e-3) throw new FeatureError("E-DRAFT-ANGLE", "The draft angle must be between 0° and 90°.");
          const sides = t.faces.filter((_x, i) => t.names[i].includes(":side:") || t.names[i].includes(":new:"));
          t = this.applyDraft(t, sides, mul(frame.n, dir), f.draft.outward ? -a : a, add(this.w(frame, [0, 0]), off), f.id);
        }
        tools.push(t);
      }
    } else {
      const ax = sk.ents.find(e => e.id === f.axis);
      if (!ax || ax.t !== "line") throw new FeatureError("E-FT-AXIS", "Pick a line of the sketch as the axis.");
      const pa = sk.ents.find(e => e.id === ax.a), pb = sk.ents.find(e => e.id === ax.b);
      if (!pa || pa.t !== "point" || !pb || pb.t !== "point") throw new FeatureError("E-FT-AXIS", "The axis line is broken.");
      const A = this.w(frame, [pa.x, pa.y]), B = this.w(frame, [pb.x, pb.y]);
      const dirV: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      if (Math.hypot(...dirV) < 1e-9) throw new FeatureError("E-FT-AXIS", "The axis line has no length.");
      const sgn = f.flip ? -1 : 1;
      const upto = f.end === "upto";
      let angle = Math.min(f.angle.v, Math.PI * 2);
      if (upto) angle = this.revolveUpTo(f, sk, frame, A, mul(unit(dirV), sgn), prev, frames);
      // Direction 2 (blind only): the profile turns back first, then sweeps both angles.
      const back = upto ? 0 : f.mid ? angle / 2 : Math.max(0, Math.min(f.angle2?.v ?? 0, Math.PI * 2 - angle));
      if (!(angle > 1e-9)) throw new FeatureError("E-FT-ZERO", "The angle must be more than 0.");
      if (!f.mid) angle += back;
      const { faces, edgeEnt } = this.profileFaces(sk, frame, [0, 0, 0], new Set([ax.id]));
      for (let face0 of faces) {
        let face = f.thin ? this.thinFace(face0, f.thin) : face0;
        if (back > 1e-9 && angle < Math.PI * 2 - 1e-9) {
          const tr = new oc.gp_Trsf_1();
          tr.SetRotation_1(new oc.gp_Ax1_2(this.P(A), this.D(dirV)), -sgn * back);
          const mk = new oc.BRepBuilderAPI_Transform_2(face, tr, false);
          face = mk.Shape();
          face0 = face;
          // Edge names follow the rotated copy.
          for (const pair of edgeEnt) { const m = this.list(mk.Modified(pair[0])); if (m.length) pair[0] = m[0]; }
        }
        const mk = new oc.BRepPrimAPI_MakeRevol_1(face, new oc.gp_Ax1_2(this.P(A), this.D(mul(dirV, sgn))), angle, false);
        mk.Build(new oc.Message_ProgressRange_1());
        if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The revolve failed. Is the profile crossing the axis?");
        tools.push(this.nameSweep(mk, f.id, edgeEnt, mk.Shape()));
      }
    }
    // Several regions: fuse the tools first.
    let tool = tools[0];
    for (const t of tools.slice(1)) tool = this.bool("fuse", tool, t, f.id);
    if (!(f.type === "extrude" && f.outside)) this.tools.set(f.id, [{ shape: tool, op: f.op === "boss" ? "fuse" : "cut" }]);
    if (f.op === "boss") return prev ? this.bool("fuse", prev, tool, f.id) : tool;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body to cut yet.");
    const out = this.bool(f.type === "extrude" && f.outside ? "common" : "cut", prev, tool, f.id);
    if (Math.abs(this.volume(out.shape) - this.volume(prev.shape)) < 1e-9) throw new FeatureError("E-FT-NOCHANGE", "The cut does not touch the body.");
    return out;
  }

  /**
   * Up to face/plane (FR-FT-011): a long prism toward the target, then the part beyond the
   * target's plane cut away with a slab; the target's face becomes the feature's end face.
   * Flat faces and planes only in P1.
   */
  private upTo(f: Feature & { type: "extrude" }, sk: SketchFeature, frame: Frame, prev: Named | null, frames: Record<string, Frame>): Named[] {
    const oc = this.oc;
    if (!f.upTo) throw new FeatureError("E-FT-UPTO", "Pick the face or plane the extrusion goes up to.");
    let target: Frame;
    try { target = this.planeFrame(f.upTo, prev, frames); }
    catch (err) {
      if (err instanceof FeatureError && err.code === "E-FT-NOTPLANAR") throw new FeatureError("E-FT-UPTO", "Up to face needs a flat face or a plane.");
      throw err;
    }
    const prof = sketchProfile(sk);
    if (prof.error) throw new FeatureError(prof.error.code, prof.error.message);
    // Where the profile's middle meets the target along the sketch normal.
    const pts = prof.faces.flatMap(pf => pf.outer.flatMap(sg => (sg.kind === "circle" ? [[sg.c[0] - sg.r, sg.c[1]], [sg.c[0] + sg.r, sg.c[1]]] : sg.kind === "ellipse" ? [sg.el.c] : sg.kind === "spline" ? [sg.bz[0], sg.bz[sg.bz.length - 1]] : [sg.a, sg.b]))) as [number, number][];
    const mid: [number, number] = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const c = this.w(frame, mid);
    const den = dot(frame.n, target.n);
    if (Math.abs(den) < 1e-9) throw new FeatureError("E-FT-UPTO", "The face is parallel to the extrusion direction.");
    let s = dot(add(target.o, mul(c, -1)), target.n) / den;
    if (Math.abs(s) < 1e-7) throw new FeatureError("E-FT-ZERO", "The face is in the sketch plane.");
    if (f.end === "offset") {
      // Offset from surface: stop short of the face by the distance (past it when reversed).
      const o = (f.upToOffset?.v ?? 0) * (f.reverseOffset ? -1 : 1);
      const s2 = s - Math.sign(s) * o;
      if (Math.abs(s2) < 1e-7 || Math.sign(s2) !== Math.sign(s)) throw new FeatureError("E-FT-OFFSET", "The offset is larger than the distance to the face.");
      target = { ...target, o: add(target.o, mul(target.n, (s2 - s) * den)) };
      s = s2;
    }
    const dir = Math.sign(s);
    const big = Math.abs(s) * 2 + (prev ? this.size(prev.shape) : 0) * 2 + 10;
    const { faces, edgeEnt } = this.profileFaces(sk, frame);
    const tools: Named[] = [];
    for (const face of faces) {
      const mk = new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(frame.n, big * dir)), false, true);
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The extrusion failed.");
      tools.push(this.nameSweep(mk, f.id, edgeEnt, mk.Shape()));
    }
    // The slab: a big square on the target plane, swept away from the sketch.
    const span = big * 4;
    const pf = new oc.BRepBuilderAPI_MakeFace_9(new oc.gp_Pln_2(new oc.gp_Ax3_3(this.P(target.o), this.D(target.n), this.D(target.x))), -span, span, -span, span).Face();
    const away = Math.sign(dot(frame.n, target.n)) * dir;
    const mk = new oc.BRepPrimAPI_MakePrism_1(pf, this.V(mul(target.n, span * away)), false, true);
    mk.Build(new oc.Message_ProgressRange_1());
    const slabFaces = this.sub(mk.Shape(), "FACE");
    const first = this.sub(mk.FirstShape(), "FACE");
    const slab: Named = { shape: mk.Shape(), faces: slabFaces, names: slabFaces.map(x => (first.some(g => g.IsSame(x)) ? `${f.id}:end` : `${f.id}:slab`)) };
    return tools.map(t => {
      const out = this.bool("cut", t, slab, f.id);
      if (out.names.some(n => n === `${f.id}:slab`)) throw new FeatureError("E-FT-UPTO", "The extrusion does not reach that face.");
      return out;
    });
  }

  /** Names the faces of a prism or revolution from the sketch curves they were swept from. */
  private nameSweep(mk: any, fid: string, edgeEnt: [any, string][], shape: any): Named {
    const faces = this.sub(shape, "FACE");
    const names: (string | null)[] = faces.map(() => null);
    const count = new Map<string, number>();
    for (const [e, ent] of edgeEnt) {
      for (const g of this.list(mk.Generated(e))) {
        const i = faces.findIndex(f => f.IsSame(g));
        if (i < 0) continue;
        const k = count.get(ent) ?? 0;
        count.set(ent, k + 1);
        names[i] = k ? `${fid}:side:${ent}:${k}` : `${fid}:side:${ent}`;
      }
    }
    const first = mk.FirstShape(), last = mk.LastShape();
    const firstFaces = this.sub(first, "FACE"), lastFaces = this.sub(last, "FACE");
    faces.forEach((f, i) => {
      if (names[i]) return;
      if (firstFaces.some(g => g.IsSame(f))) names[i] = `${fid}:start`;
      else if (lastFaces.some(g => g.IsSame(f))) names[i] = `${fid}:end`;
    });
    let k = 0;
    return { shape, faces, names: names.map(n => n ?? `${fid}:new:${k++}`) };
  }

  private bool(kind: "fuse" | "cut" | "common", a: Named, b: Named, fid: string): Named {
    const oc = this.oc;
    const pr = new oc.Message_ProgressRange_1();
    const mk = kind === "fuse" ? new oc.BRepAlgoAPI_Fuse_3(a.shape, b.shape, pr)
      : kind === "cut" ? new oc.BRepAlgoAPI_Cut_3(a.shape, b.shape, pr)
      : new oc.BRepAlgoAPI_Common_3(a.shape, b.shape, pr);
    if (!mk.IsDone() || mk.HasErrors()) throw new FeatureError("E-FT-BOOL", kind === "fuse" ? "The new material could not be joined to the body." : "The cut failed.");
    return this.carry(mk, [a, b], mk.Shape(), fid);
  }

  /** The material a cut took away: the body before it minus the body after it (the cut preview). */
  removed(before: Named, after: Named): Named { return this.bool("cut", before, after, "removed"); }

  private round(f: Feature & { type: "fillet" | "chamfer" }, prev: Named | null): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.edges.length) throw new FeatureError("E-FT-NOEDGES", "Pick at least one edge.");
    const size = f.type === "fillet" ? f.radius.v : f.distance.v;
    if (!(size > 1e-6)) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    const mode = f.type === "chamfer" ? f.mode ?? "equal" : "equal";
    if (f.type === "chamfer" && mode === "two" && !((f.distance2?.v ?? 0) > 1e-6)) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    if (f.type === "chamfer" && mode === "angle" && !((f.angle?.v ?? 0) > 1e-6 && (f.angle?.v ?? 0) < Math.PI / 2)) throw new FeatureError("E-FT-ANGLE", "The chamfer angle must be between 0° and 90°.");
    const edges = f.edges.map(r => this.resolveEdge(prev, r));
    const make = (list: number[]) => {
      const mk = f.type === "fillet"
        ? new oc.BRepFilletAPI_MakeFillet(prev.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational)
        : new oc.BRepFilletAPI_MakeChamfer(prev.shape);
      for (const i of list) {
        const e = edges[i];
        if (f.type === "fillet" || mode === "equal") mk.Add_2(size, e);
        else {
          const r = f.edges[i];
          const face = this.faceOfEdge(prev, e, r.faces[f.type === "chamfer" && f.flip ? 1 : 0]);
          if (mode === "two") mk.Add_3(size, (f as Feature & { type: "chamfer" }).distance2!.v, e, face);
          else mk.AddDA(size, (f as Feature & { type: "chamfer" }).angle!.v, e, face);
        }
      }
      try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
      return mk.IsDone() ? mk : null;
    };
    const all = edges.map((_e, i) => i);
    let used = all;
    let mk = make(all);
    if (!mk && f.type === "fillet" && f.keepFit) {
      // Keep features that fit: add edges one at a time, skipping those that fail.
      used = [];
      for (const i of all) if (make([...used, i])) used.push(i);
      mk = used.length ? make(used) : null;
      if (mk && used.length < all.length) this.warning = `${all.length - used.length} of ${all.length} edges could not be rounded and were skipped.`;
    }
    if (!mk) {
      throw new FeatureError(f.type === "fillet" ? "E-FT-FILLET" : "E-FT-CHAMFER",
        f.type === "fillet" ? `The fillet radius ${size} mm is too large for the selected edges, or the edges cannot be rounded.` : `The chamfer ${size} mm is too large for the selected edges.`);
    }
    const out = this.carry(mk, [prev], mk.Shape(), f.id);
    // Faces made from each edge: named after the edge.
    used.forEach(i => {
      for (const g of this.list(mk!.Generated(edges[i]))) {
        const j = out.faces.findIndex(x => x.IsSame(g));
        if (j >= 0) out.names[j] = `${f.id}:${f.type}:${i}`;
      }
    });
    return out;
  }

  /** The face with this name that holds the edge. */
  private faceOfEdge(body: Named, edge: any, name: string): any {
    for (let i = 0; i < body.faces.length; i++) {
      if (body.names[i] !== name) continue;
      if (this.sub(body.faces[i], "EDGE").some(e => e.IsSame(edge))) return body.faces[i];
    }
    throw new FeatureError("E-TN-LOST", `Reference lost: face ${name}`);
  }

  /** Shell (FR-FT-060): MakeThickSolid; kept faces keep their names, the new walls are `fid:off:<face>`. */
  private shell(f: ShellFeature, prev: Named | null): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    const t = f.thickness.v;
    if (!(t > 1e-6)) throw new FeatureError("E-FT-ZERO", "The thickness must be more than 0.");
    const list = new oc.TopTools_ListOfShape_1();
    for (const r of f.faces) list.Append_1(this.resolveFace(prev, r));
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      mk.MakeThickSolidByJoin(prev.shape, list, f.outward ? t : -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, new oc.Message_ProgressRange_1());
    } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-FT-SHELL", "The shell failed: the wall may be too thick for this body, or a fillet is smaller than the thickness.");
    const result = mk.Shape();
    const faces = this.sub(result, "FACE");
    const names: (string | null)[] = faces.map(() => null);
    prev.faces.forEach((pf, i) => {
      const j = faces.findIndex(x => x.IsSame(pf));
      if (j >= 0) names[j] = prev.names[i];
      for (const m of [...this.list(mk.Modified(pf)), ...this.list(mk.Generated(pf))]) {
        const k = faces.findIndex(x => x.IsSame(m));
        if (k >= 0 && !names[k]) names[k] = j >= 0 ? `${f.id}:off:${prev.names[i]}` : prev.names[i];
      }
    });
    // Outward: the original faces are the inside now; whatever is unnamed is new.
    let n = 0;
    return { shape: result, faces, names: names.map(x => x ?? `${f.id}:new:${n++}`) };
  }

  /**
   * Draft (FR-FT-061): BRepOffsetAPI_DraftAngle tapers each picked face about the neutral plane,
   * pulling along the plane's normal. Drafted faces keep their names.
   */
  private draft(f: DraftFeature, prev: Named | null, frames: Record<string, Frame>): Named {
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.plane) throw new FeatureError("E-DRAFT-PLANE", "Pick the neutral plane: a flat face or a plane.");
    if (!f.faces.length) throw new FeatureError("E-DRAFT-FACES", "Click the faces to draft.");
    const a = f.angle.v;
    if (!(Math.abs(a) > 1e-6) || Math.abs(a) >= Math.PI / 2 - 1e-3) throw new FeatureError("E-DRAFT-ANGLE", "The draft angle must be between 0° and 90°.");
    const fr = this.planeFrame(f.plane, prev, frames);
    const n = f.flip ? mul(fr.n, -1) : fr.n;
    return this.applyDraft(prev, f.faces.map(r => this.resolveFace(prev, r)), n, a, fr.o, f.id);
  }

  /** Tapers faces of a body by an angle about the plane through `o` normal to the pull direction `n`; faces keep their names. */
  private applyDraft(prev: Named, picked: any[], n: V3, a: number, o: V3, fid: string): Named {
    const oc = this.oc;
    const pln = new oc.gp_Pln_3(this.P(o), this.D(n));
    const mk = new oc.BRepOffsetAPI_DraftAngle_2(prev.shape);
    for (const face of picked) {
      try { mk.Add(oc.TopoDS.Face_1(face), this.D(n), a, pln, true); } catch { /* reported below */ }
      if (!mk.AddDone()) throw new FeatureError("E-DRAFT-FACE", "A face can't be drafted about this neutral plane: pick faces that cross it, not parallel to it.");
    }
    try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-DRAFT-FAIL", "The draft failed: try a smaller angle or fewer faces.");
    const result = mk.Shape();
    const faces = this.sub(result, "FACE");
    const names: (string | null)[] = faces.map(() => null);
    prev.faces.forEach((pf, i) => {
      const j = faces.findIndex(x => x.IsSame(pf));
      if (j >= 0) { names[j] = prev.names[i]; return; }
      for (const m of [...this.list(mk.Modified(pf)), ...this.list(mk.Generated(pf))]) {
        const k = faces.findIndex(x => x.IsSame(m));
        if (k >= 0 && !names[k]) names[k] = prev.names[i];
      }
    });
    let k = 0;
    return { shape: result, faces, names: names.map(x => x ?? `${fid}:new:${k++}`) };
  }

  /**
   * Revolve up to face or plane (FR-FT-022): the angle from the profile to the first place where it
   * meets the target, which must be flat and contain the axis.
   */
  private revolveUpTo(f: Feature & { type: "revolve" }, sk: SketchFeature, frame: Frame, A: V3, u: V3, prev: Named | null, frames: Record<string, Frame>): number {
    if (!f.upTo) throw new FeatureError("E-FT-UPTO", "Pick the face or plane the revolve goes up to.");
    let target: Frame;
    try { target = this.planeFrame(f.upTo, prev, frames); }
    catch (err) {
      if (err instanceof FeatureError && err.code === "E-FT-NOTPLANAR") throw new FeatureError("E-RV-UPTO", "Up to face for a revolve needs a flat face or plane through the axis.");
      throw err;
    }
    const n = unit(target.n);
    if (Math.abs(dot(n, u)) > 1e-6 || Math.abs(dot(n, add(A, mul(target.o, -1)))) > 1e-4) throw new FeatureError("E-RV-UPTO", "Up to face for a revolve needs a flat face or plane through the axis.");
    const prof = sketchProfile(sk);
    if (prof.error) throw new FeatureError(prof.error.code, prof.error.message);
    const pts = prof.faces.flatMap(pf => pf.outer.flatMap(sg => (sg.kind === "circle" ? [[sg.c[0] - sg.r, sg.c[1]], [sg.c[0] + sg.r, sg.c[1]]] : sg.kind === "ellipse" ? [sg.el.c] : sg.kind === "spline" ? [sg.bz[0], sg.bz[sg.bz.length - 1]] : [sg.a, sg.b]))) as [number, number][];
    const c = this.w(frame, [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]);
    const w = add(c, mul(A, -1));
    const r0 = add(w, mul(u, -dot(w, u)));
    if (Math.hypot(...r0) < 1e-9) throw new FeatureError("E-RV-UPTO", "Up to face for a revolve needs a flat face or plane through the axis.");
    // r(θ) = r0 cos θ + (u × r0) sin θ lies in the target plane where a cos θ + b sin θ = 0.
    const a = dot(r0, n), b = dot(cross(u, r0), n);
    const t0 = Math.atan2(-a, b);
    const cands = [t0, t0 + Math.PI].map(x => { let y = x % (Math.PI * 2); if (y < 0) y += Math.PI * 2; return y; }).filter(x => x > 1e-6).sort((x, y) => x - y);
    return cands[0] ?? Math.PI;
  }

  /**
   * Thin feature (FR-FT-015): the profile face becomes a band of thickness t along its boundary,
   * inside it, outside it or centred on it (2D offsets of the face's wires, then a face boolean).
   */
  private thinFace(face: any, thin: { t: Num; mode: "inside" | "outside" | "mid" }): any {
    const oc = this.oc;
    const t = thin.t.v;
    if (!(t > 1e-6)) throw new FeatureError("E-FT-ZERO", "The wall thickness must be more than 0.");
    const offsetFace = (d: number) => {
      if (Math.abs(d) < 1e-12) return face;
      const mk = new oc.BRepOffsetAPI_MakeOffset_2(oc.TopoDS.Face_1(face), oc.GeomAbs_JoinType.GeomAbs_Arc, false);
      try { mk.Perform(d, 0); } catch { /* reported below */ }
      if (!mk.IsDone()) throw new FeatureError("E-FT-THIN", "The wall is too thick for this profile.");
      const wires = this.subWires(mk.Shape());
      if (!wires.length) throw new FeatureError("E-FT-THIN", "The wall is too thick for this profile.");
      // The largest wire is the outer boundary; the others are holes.
      const area = (w: any) => { const f = new oc.BRepBuilderAPI_MakeFace_15(w, true).Face(); const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(f, p, false, false); return Math.abs(p.Mass()); };
      const sized = wires.map((w: any) => ({ w, a: area(w) })).sort((x: { a: number }, y: { a: number }) => y.a - x.a);
      const mf = new oc.BRepBuilderAPI_MakeFace_15(sized[0].w, true);
      for (const h of sized.slice(1)) mf.Add(h.w);
      const fix = new oc.ShapeFix_Face_2(mf.Face());
      fix.Perform();
      return fix.Face();
    };
    const outer = thin.mode === "outside" ? offsetFace(t) : thin.mode === "mid" ? offsetFace(t / 2) : face;
    const inner = thin.mode === "outside" ? face : thin.mode === "mid" ? offsetFace(-t / 2) : offsetFace(-t);
    const cut = new oc.BRepAlgoAPI_Cut_3(outer, inner, new oc.Message_ProgressRange_1());
    if (!cut.IsDone() || cut.HasErrors()) throw new FeatureError("E-FT-THIN", "The wall is too thick for this profile.");
    const faces = this.sub(cut.Shape(), "FACE");
    if (!faces.length) throw new FeatureError("E-FT-THIN", "The wall is too thick for this profile.");
    if (faces.length === 1) return faces[0];
    // Several bands (a profile with holes): one compound face set.
    const b = new oc.BRep_Builder();
    const comp = new oc.TopoDS_Compound();
    b.MakeCompound(comp);
    for (const x of faces) b.Add(comp, x);
    return comp;
  }

  /**
   * Hole wizard (FR-FT-050): each hole is a profile in (radius, depth) revolved about its axis,
   * pointing into the material (against the face normal); all holes are cut in one go.
   */
  private hole(f: HoleFeature, prev: Named | null, frames: Record<string, Frame>): { body: Named; frame: Frame } {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.plane) throw new FeatureError("E-HOLE-FACE", "Pick a flat face or a plane for the holes.");
    const fr = this.planeFrame(f.plane, prev, frames);
    // The panel places holes in this frame, so it is known even before the first hole.
    frames[f.id] = fr;
    if (!f.pts.length) throw new FeatureError("E-HOLE-PTS", "Click on the face to place the holes.");
    const r = f.diameter.v / 2;
    if (!(r > 1e-6)) throw new FeatureError("E-FT-ZERO", "The diameter must be more than 0.");
    const through = f.end === "through";
    const depth = through ? this.size(prev.shape) * 2 + 1 : f.depth.v;
    if (!(depth > 1e-6)) throw new FeatureError("E-FT-ZERO", "The depth must be more than 0.");
    // Profile from the axis outward, starting above the face so the top is cut cleanly.
    const lift = Math.max(0.01, r * 0.05);
    const prof: [number, number][] = [[0, lift]];
    if (f.kind === "cbore") {
      const R = (f.cbDia?.v ?? 0) / 2, d = f.cbDepth?.v ?? 0;
      if (!(R > r) || !(d > 0) || d >= depth) throw new FeatureError("E-HOLE-CBORE", "The counterbore must be wider than the hole and less deep.");
      prof.push([R, lift], [R, -d], [r, -d]);
    } else if (f.kind === "csink") {
      const R = (f.csDia?.v ?? 0) / 2, a = f.csAngle?.v ?? Math.PI / 2;
      if (!(R > r) || !(a > 0.1 && a < Math.PI - 0.1)) throw new FeatureError("E-HOLE-CSINK", "The countersink must be wider than the hole, at an angle between 6° and 174°.");
      const h = (R - r) / Math.tan(a / 2);
      prof.push([R + lift * Math.tan(a / 2), lift], [r, -h]);
    } else prof.push([r, lift]);
    const tipH = f.flat || through ? 0 : r / Math.tan((118 * Math.PI) / 360);
    prof.push([r, -depth], [0, -depth - tipH]);
    const tools: Named[] = [];
    f.pts.forEach((p, i) => {
      const o = add(add(fr.o, mul(fr.x, p[0])), mul(fr.y, p[1]));
      // The profile lies in the plane through the axis and the frame's x: (r, z) → o + x·r + n·z.
      const poly = new oc.BRepBuilderAPI_MakePolygon_1();
      for (const [rr, z] of prof) poly.Add_1(this.P(add(add(o, mul(fr.x, rr)), mul(fr.n, z))));
      poly.Close();
      const face = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true).Face();
      const mk = new oc.BRepPrimAPI_MakeRevol_1(face, new oc.gp_Ax1_2(this.P(o), this.D(fr.n)), 2 * Math.PI, false);
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The hole could not be made.");
      const shape = mk.Shape();
      const faces = this.sub(shape, "FACE");
      tools.push({ shape, faces, names: faces.map((_x, k) => `${f.id}:h${i}:${k}`) });
    });
    let tool = tools[0];
    for (const t of tools.slice(1)) tool = this.bool("fuse", tool, t, f.id);
    this.tools.set(f.id, [{ shape: tool, op: "cut" }]);
    const out = this.bool("cut", prev, tool, f.id);
    if (Math.abs(this.volume(out.shape) - this.volume(prev.shape)) < 1e-9) throw new FeatureError("E-FT-NOCHANGE", "The holes do not touch the body.");
    return { body: out, frame: fr };
  }

  /**
   * Modelled thread (FR-FT-055): a 60° V groove swept along a helix on the cylinder the edge bounds and cut
   * from the body. Internal threads cut outward from the tap drill to the major diameter, external ones inward
   * from the shaft to the minor diameter. The helix starts a pitch outside the end so the groove runs out cleanly.
   */
  private helicalThread(f: ThreadFeature, prev: Named, edge: any): Named {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_Curve_2(edge);
    if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Circle) throw new FeatureError("E-THR-EDGE", "A thread needs a round edge of a cylinder.");
    const circ = ad.Circle();
    const c = this.xyz(circ.Location()), a = unit(this.xyz(circ.Axis().Direction())), r = circ.Radius();
    const P = f.pitch ?? 0;
    if (!(P > 1e-6)) throw new FeatureError("E-THR-PITCH", "A modelled thread needs a pitch: pick a standard size.");
    // Which way the cylinder runs from the edge, and whether it is a hole: probe just inside the material.
    const xd = unit(cross(a, Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const inside = (q: V3) => new oc.BRepClass3d_SolidClassifier_3(prev.shape, this.P(q), 1e-7).State() === oc.TopAbs_State.TopAbs_IN;
    const probe = (d: V3, rr: number, s: number) => inside(add(add(c, mul(d, s)), mul(xd, rr)));
    const eps = Math.min(P * 0.25, r * 0.05);
    let dir: V3 | null = null, internal = false;
    for (const d of [a, mul(a, -1)] as V3[]) {
      if (probe(d, r + eps, eps)) { dir = d; internal = true; break; }
      if (probe(d, r - eps, eps)) { dir = d; internal = false; break; }
    }
    if (!dir) throw new FeatureError("E-THR-EDGE", "A thread needs a round edge of a cylinder.");
    // Length: as set, or as far as the cylinder runs (probed at a quarter pitch).
    const size = this.size(prev.shape);
    let L = f.upToEnd ? 0 : f.length.v;
    if (f.upToEnd) {
      const rr = internal ? r + eps : r - eps;
      for (let s = eps; s < size * 2; s += P / 4) { if (!probe(dir, rr, s)) break; L = s; }
    }
    if (!(L > P * 0.5)) throw new FeatureError("E-FT-ZERO", "The thread length must be more than half a pitch.");
    // Groove depth: to the other diameter of the thread, else ISO's 0.5413 P (internal) / 0.6134 P (external).
    const other = f.diameter.v / 2;
    const h = internal ? (other > r + 1e-6 && other - r < P ? other - r : 0.5413 * P) : (other < r - 1e-6 && r - other < P ? r - other : 0.6134 * P);
    const over = P * 0.1, t30 = Math.tan(Math.PI / 6);
    const half = Math.min((h + over) * t30, P * 0.45);
    // Helix on a cylinder of radius r, from one pitch before the end face to the far end.
    const s0 = -P, turns = (L - s0) / P;
    const ax3 = new oc.gp_Ax3_3(this.P(add(c, mul(dir, s0))), this.D(dir), this.D(xd));
    const surf = new oc.Handle_Geom_Surface_2(new oc.Geom_CylindricalSurface_1(ax3, r));
    const line = new oc.Handle_Geom2d_Curve_2(new oc.Geom2d_Line_3(new oc.gp_Pnt2d_3(0, 0), new oc.gp_Dir2d_4(2 * Math.PI, P)));
    const len = turns * Math.hypot(2 * Math.PI, P);
    const helix = new oc.BRepBuilderAPI_MakeEdge_31(line, surf, 0, len).Edge();
    oc.BRepLib.BuildCurves3d_2(helix);
    const spine = new oc.BRepBuilderAPI_MakeWire_2(helix).Wire();
    // The V profile in the plane through the axis at the helix start: wide end beyond the surface, tip at depth h.
    const o0 = add(add(c, mul(dir, s0)), mul(xd, r));
    const out = internal ? -1 : 1;
    const pt = (rad: number, ax: number) => this.P(add(add(o0, mul(xd, rad)), mul(dir, ax)));
    const poly = new oc.BRepBuilderAPI_MakePolygon_1();
    poly.Add_1(pt(out * over, -half)); poly.Add_1(pt(out * over, half)); poly.Add_1(pt(-out * h, 0));
    poly.Close();
    const sweep = new oc.BRepOffsetAPI_MakePipeShell(spine);
    sweep.SetMode_1(true);
    sweep.Add_1(poly.Wire(), false, false);
    sweep.Build(new oc.Message_ProgressRange_1());
    if (!sweep.IsDone()) throw new FeatureError("E-FT-FAIL", "The thread could not be made.");
    sweep.MakeSolid();
    const shape = sweep.Shape();
    const faces = this.sub(shape, "FACE");
    const tool: Named = { shape, faces, names: faces.map((_x, k) => `${f.id}:t${k}`) };
    this.tools.set(f.id, [{ shape, op: "cut" }]);
    return this.bool("cut", prev, tool, f.id);
  }

  /** A direction or an axis from a line reference: point and unit direction. */
  private lineOf(ref: LineRef | undefined, body: Named | null, frames: Record<string, Frame>, what: string): { o: V3; d: V3 } {
    const oc = this.oc;
    if (!ref) throw new FeatureError("E-PAT-DIR", `Pick ${what}.`);
    if (ref.axis) {
      const fr = frames[ref.axis];
      if (!fr) throw new FeatureError("E-FT-PARENT", "The reference axis is missing or has an error.");
      return { o: fr.o, d: unit(fr.n) };
    }
    if (ref.edge) {
      const ad = new oc.BRepAdaptor_Curve_2(this.resolveEdge(body, ref.edge));
      const ty = ad.GetType();
      if (ty === oc.GeomAbs_CurveType.GeomAbs_Line) return { o: this.xyz(ad.Line().Location()), d: this.xyz(ad.Line().Direction()) };
      if (ty === oc.GeomAbs_CurveType.GeomAbs_Circle) { const ax = ad.Circle().Axis(); return { o: this.xyz(ax.Location()), d: this.xyz(ax.Direction()) }; }
      throw new FeatureError("E-PAT-DIR", "Use a straight or round edge.");
    }
    if (ref.face) {
      const face = this.resolveFace(body, ref.face);
      const ad = new oc.BRepAdaptor_Surface_2(face, true);
      const ty = ad.GetType();
      if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) { const ax = ad.Cylinder().Axis(); return { o: this.xyz(ax.Location()), d: this.xyz(ax.Direction()) }; }
      if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Cone) { const ax = ad.Cone().Axis(); return { o: this.xyz(ax.Location()), d: this.xyz(ax.Direction()) }; }
      if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        let n = this.xyz(ad.Plane().Position().Direction());
        if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
        return { o: this.centroid(face), d: n };
      }
      throw new FeatureError("E-PAT-DIR", "Use a flat or round face.");
    }
    throw new FeatureError("E-PAT-DIR", `Pick ${what}.`);
  }

  /** The tools of the seed features, in feature order. */
  private seedTools(ids: string[], doc: PartDoc): Tool[] {
    if (!ids.length) throw new FeatureError("E-PAT-SEED", "Pick the features to copy.");
    const out: Tool[] = [];
    for (const id of ids) {
      const f = doc.features.find(x => x.id === id);
      if (!f) throw new FeatureError("E-PAT-SEED", "A feature to copy is missing.");
      if (f.suppressed) continue;
      const t = this.tools.get(id);
      if (!t) throw new FeatureError("E-PAT-SEED", "Only extrudes, cuts, revolves, holes, mirrors and patterns can be copied for now.");
      out.push(...t);
    }
    if (!out.length) throw new FeatureError("E-PAT-SEED", "All the features to copy are suppressed.");
    return out;
  }

  private transformed(t: Tool, trsf: any, fid: string, tag: string): Tool {
    const oc = this.oc;
    const mk = new oc.BRepBuilderAPI_Transform_2(t.shape.shape, trsf, true);
    const shape = mk.Shape();
    const faces = this.sub(shape, "FACE");
    const names: string[] = faces.map((_f, i) => `${fid}:${tag}:new:${i}`);
    t.shape.faces.forEach((f, i) => {
      for (const m of this.list(mk.Modified(f))) { const j = faces.findIndex(x => x.IsSame(m)); if (j >= 0) names[j] = `${fid}:${tag}:${t.shape.names[i]}`; }
    });
    return { shape: { shape, faces, names }, op: t.op };
  }

  private solids(shape: any) {
    const oc = this.oc;
    let n = 0;
    for (const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) n++;
    return n;
  }

  /**
   * Applies copies of tools to the body; a copy that adds nothing (a cut beside the part, a boss
   * floating free of it) is skipped and listed in a warning (FR-FT-075).
   */
  private applyCopies(body: Named | null, copies: { tool: Tool; label: string }[], fid: string, seeds: Tool[] = []): Named {
    if (!body) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    const skipped: string[] = [];
    const used: Tool[] = [];
    for (const c of copies) {
      try {
        const before = this.volume(body.shape), solids = this.solids(body.shape);
        const out = this.bool(c.tool.op, body, c.tool.shape, fid);
        const after = this.volume(out.shape);
        if (Math.abs(after - before) < 1e-9 || (c.tool.op === "fuse" && this.solids(out.shape) > solids)) { skipped.push(c.label); continue; }
        body = out;
        used.push(c.tool);
      } catch { skipped.push(c.label); }
    }
    if (!used.length) throw new FeatureError("E-PAT-NONE", "No copy touches the body.");
    // Copying this feature later copies its seeds too (a mirror of a pattern mirrors every instance).
    this.tools.set(fid, [...seeds, ...used]);
    if (skipped.length) this.warning = `${skipped.length} of ${copies.length} copies fall outside the body and were skipped: ${[...new Set(skipped)].join("; ")}.`;
    return body;
  }

  /** Mirror (FR-FT-072): the seed features' tools reflected in a plane, or the whole body joined to its reflection. */
  private mirror(f: MirrorFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.plane) throw new FeatureError("E-MIR-PLANE", "Pick a plane or a flat face to mirror about.");
    const fr = this.planeFrame(f.plane, prev, frames);
    const trsf = new oc.gp_Trsf_1();
    trsf.SetMirror_3(new oc.gp_Ax2_3(this.P(fr.o), this.D(fr.n)));
    const tools = f.features.length ? this.seedTools(f.features, doc) : [{ shape: prev, op: "fuse" as const }];
    return this.applyCopies(prev, tools.map((t, i) => ({ tool: this.transformed(t, trsf, f.id, `m${i}`), label: "1" })), f.id, f.features.length ? tools : []);
  }

  /** Linear pattern (FR-FT-070): count × count2 copies; instance (0, 0) is the seed. */
  private linearPattern(f: LinearPatternFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const tools = this.seedTools(f.features, doc);
    const d1 = mul(this.lineOf(f.dir, prev, frames, "a direction: an edge, a face or an axis").d, f.flip ? -1 : 1);
    const n1 = Math.max(1, Math.round(f.count)), n2 = f.dir2 ? Math.max(1, Math.round(f.count2 ?? 1)) : 1;
    const d2 = f.dir2 ? mul(this.lineOf(f.dir2, prev, frames, "the second direction").d, f.flip2 ? -1 : 1) : [0, 0, 0] as V3;
    if (n1 * n2 < 2) throw new FeatureError("E-PAT-COUNT", "The pattern needs at least 2 instances.");
    if (!(f.spacing.v > 1e-6) || (f.dir2 && n2 > 1 && !((f.spacing2?.v ?? 0) > 1e-6))) throw new FeatureError("E-FT-ZERO", "The spacing must be more than 0.");
    const skip = new Set(f.skip ?? []);
    const copies: { tool: Tool; label: string }[] = [];
    for (let j = 0; j < n2; j++) for (let i = 0; i < n1; i++) {
      if (i === 0 && j === 0) continue;
      const key = f.dir2 ? `${i},${j}` : `${i}`;
      if (skip.has(key)) continue;
      const v = add(mul(d1, i * f.spacing.v), mul(d2, j * (f.spacing2?.v ?? 0)));
      const trsf = new oc.gp_Trsf_1();
      trsf.SetTranslation_1(this.V(v));
      tools.forEach((t, k) => copies.push({ tool: this.transformed(t, trsf, f.id, `i${key.replace(",", "_")}s${k}`), label: String(key) }));
    }
    return this.applyCopies(prev, copies, f.id, tools);
  }

  /** Circular pattern (FR-FT-071): copies turned about an axis; equal spacing spreads them over the angle. */
  private circularPattern(f: CircularPatternFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const tools = this.seedTools(f.features, doc);
    const ax = this.lineOf(f.axis, prev, frames, "an axis: a round edge or face, a straight edge or a reference axis");
    const n = Math.max(1, Math.round(f.count));
    if (n < 2) throw new FeatureError("E-PAT-COUNT", "The pattern needs at least 2 instances.");
    const total = f.angle.v;
    if (!(total > 1e-9)) throw new FeatureError("E-FT-ZERO", "The angle must be more than 0.");
    const full = Math.abs(total - 2 * Math.PI) < 1e-9;
    const step = f.equal ? total / (full ? n : n - 1) : total;
    const skip = new Set(f.skip ?? []);
    const copies: { tool: Tool; label: string }[] = [];
    for (let i = 1; i < n; i++) {
      if (skip.has(String(i))) continue;
      const trsf = new oc.gp_Trsf_1();
      trsf.SetRotation_1(new oc.gp_Ax1_2(this.P(ax.o), this.D(ax.d)), (f.flip ? -1 : 1) * step * i);
      tools.forEach((t, k) => copies.push({ tool: this.transformed(t, trsf, f.id, `i${i}s${k}`), label: String(i) }));
    }
    return this.applyCopies(prev, copies, f.id, tools);
  }

  private size(shape: any) {
    const oc = this.oc;
    const box = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, box, false);
    const a = this.xyz(box.CornerMin()), b = this.xyz(box.CornerMax());
    return d3(a, b);
  }

  private volume(shape: any) {
    const p = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.VolumeProperties_1(shape, p, true, false, false);
    return p.Mass();
  }

  // ---------- evaluation ----------

  /** Evaluates the document; unchanged leading features come from the cache. */
  evaluate(doc: PartDoc): { body: Named | null; statuses: FeatureStatus[]; frames: Record<string, Frame> } {
    const end = doc.rollback ?? doc.features.length;
    let body: Named | null = null;
    let chain = "";
    const statuses: FeatureStatus[] = [];
    const frames: Record<string, Frame> = {};
    const failed = new Set<string>();
    const next: CacheEntry[] = [];
    this.tools = new Map();
    // Freeze bar (FR-HIS-024): features up to it keep their cached result even when they changed.
    const frozen = doc.freezeAfter ? doc.features.findIndex(f => f.id === doc.freezeAfter) + 1 : 0;
    doc.features.forEach((f, i) => {
      if (i >= end) { statuses.push({ id: f.id, ok: true, code: "rolled-back" }); return; }
      const hit = this.cache[i];
      const keep = i < frozen && hit && hit.status.id === f.id && next.length === i;
      chain = keep ? hit.key : `${chain}|${JSON.stringify(f)}`;
      if (hit && hit.key === chain) {
        next.push(hit);
        statuses.push(hit.status);
        if (hit.frame) frames[f.id] = hit.frame;
        if (hit.tools) this.tools.set(f.id, hit.tools);
        if (!hit.status.ok) failed.add(f.id);
        if (hit.body) body = hit.body;
        return;
      }
      let status: FeatureStatus = { id: f.id, ok: true };
      let frame: Frame | undefined;
      if (f.suppressed) status = { id: f.id, ok: true, code: "suppressed" };
      else {
        try {
          if (featureRefs(f).features.some(p => failed.has(p))) throw new FeatureError("E-FT-PARENT", "A sketch or plane this feature uses has an error.");
          this.warning = "";
          if (f.type === "sketch") { frame = this.frameOf(f, body, frames); frames[f.id] = frame; }
          else if (f.type === "plane") { frame = this.refPlane(f, body, frames); frames[f.id] = frame; }
          else if (f.type === "axis") { frame = this.refAxis(f, body, frames); frames[f.id] = frame; }
          else if (f.type === "point") { frame = this.refPoint(f, body); frames[f.id] = frame; }
          else if (f.type === "extrude" || f.type === "revolve") body = this.sweep(f, doc, body, frames);
          else if (f.type === "fillet" || f.type === "chamfer") body = this.round(f, body);
          else if (f.type === "shell") body = this.shell(f, body);
          else if (f.type === "draft") body = this.draft(f, body, frames);
          else if (f.type === "hole") { const h = this.hole(f, body, frames); body = h.body; frame = h.frame; frames[f.id] = frame; }
          else if (f.type === "mirror") body = this.mirror(f, doc, body, frames);
          else if (f.type === "lpattern") body = this.linearPattern(f, doc, body, frames);
          else if (f.type === "cpattern") body = this.circularPattern(f, doc, body, frames);
          else if (f.type === "thread") {
            // Cosmetic only: the edge must still be there; the body is unchanged.
            if (!body) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
            if (!f.edge) throw new FeatureError("E-FT-NOEDGES", "Pick a round edge of a cylinder.");
            const e = this.resolveEdge(body, f.edge);
            if (f.modelled) body = this.helicalThread(f, body, e);
          }
          if (this.warning) status = { id: f.id, ok: true, code: "warning", warning: this.warning };
        } catch (err) {
          const e = err as Error;
          status = { id: f.id, ok: false, code: e instanceof FeatureError ? e.code : "E-KRN", message: e instanceof FeatureError ? e.message : `Kernel error: ${e.message ?? e}` };
          failed.add(f.id);
        }
      }
      statuses.push(status);
      next.push({ key: chain, body, status, frame: frame ?? frames[f.id], tools: this.tools.get(f.id) });
    });
    this.cache = next;
    return { body, statuses, frames };
  }

  /** Triangles of the body in occt-import-js's layout (one range per B-rep face, in face order). */
  mesh(body: Named, name: string, color: [number, number, number], quality = 1): ModelMesh {
    const oc = this.oc;
    const lin = Math.max(this.size(body.shape) * 4e-4 * quality, 1e-3);
    new oc.BRepMesh_IncrementalMesh_2(body.shape, lin, false, 0.35 * quality, false);
    const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
    const ranges: ModelMesh["brep_faces"] = [];
    for (const face of body.faces) {
      const loc = new oc.TopLoc_Location_1();
      const h = oc.BRep_Tool.Triangulation(face, loc, 0);
      const first = idx.length / 3;
      if (!h.IsNull()) {
        const tri = h.get();
        const trsf = loc.Transformation();
        const base = pos.length / 3;
        const nn = tri.NbNodes();
        const fpos: V3[] = [];
        for (let i = 1; i <= nn; i++) { const p = this.xyz(tri.Node(i).Transformed(trsf)); fpos.push(p); pos.push(...p); }
        const fn = new Float64Array(nn * 3);
        const rev = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        for (let t = 1; t <= tri.NbTriangles(); t++) {
          const T = tri.Triangle(t);
          let a = T.Value(1) - 1, b = T.Value(2) - 1;
          const c = T.Value(3) - 1;
          if (rev) [a, b] = [b, a];
          idx.push(base + a, base + b, base + c);
          const A = fpos[a], B = fpos[b], C = fpos[c];
          const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
          const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
          for (const v of [a, b, c]) for (let k = 0; k < 3; k++) fn[v * 3 + k] += n[k];
        }
        for (let i = 0; i < nn; i++) {
          const l = Math.hypot(fn[3 * i], fn[3 * i + 1], fn[3 * i + 2]) || 1;
          nrm.push(fn[3 * i] / l, fn[3 * i + 1] / l, fn[3 * i + 2] / l);
        }
      }
      ranges.push({ first, last: idx.length / 3 - 1, color: null });
    }
    return { name, color, brep_faces: ranges, attributes: { position: { array: pos }, normal: { array: nrm } }, index: { array: idx } };
  }

  /** Volume, area, centre of mass and principal moments of inertia (density 1) of the body. */
  props(body: Named): BodyProps {
    const oc = this.oc;
    const vp = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(body.shape, vp, true, false, false);
    const sp = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(body.shape, sp, false, false);
    const m = vp.MatrixOfInertia();
    const I = [0, 1, 2].map(r => [0, 1, 2].map(c => m.Value(r + 1, c + 1)));
    const { values, vectors } = eigenSym3(I);
    return { volume: vp.Mass(), area: sp.Mass(), com: this.xyz(vp.CentreOfMass()), moments: values as V3, axes: vectors as [V3, V3, V3] };
  }

  /** Drops cached shapes (a new document). */
  reset() { this.cache = []; }
}

/** The sketch a feature is built from, if any. */
export function parentOf(f: Feature): string | null {
  return f.type === "extrude" || f.type === "revolve" ? f.sketch : null;
}

/** Eigenvalues (ascending) and unit eigenvectors of a symmetric 3×3 matrix (Jacobi rotations). */
export function eigenSym3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map(r => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map(i => a[i][i]), vectors: order.map(i => [v[0][i], v[1][i], v[2][i]]) };
}
