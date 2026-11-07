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
import type { ScaleFeature, ImportFeature, FilletFeature, CombineFeature, SplitBodyFeature, DeleteBodyFeature, MoveBodyFeature, SplitFeature, RibFeature, HelixFeature, LoftFeature, SweepFeature, AxisFeature, BodyProps, CsysFeature, CircularPatternFeature, EdgeRef, HoleFeature, FaceRef, Feature, FeatureStatus, Frame, LinearPatternFeature, LineRef, MirrorFeature, PartDoc, PlaneFeature, PlaneRef, PointFeature, ShellFeature, DraftFeature, Num, SketchFeature, ThreadFeature, V3, VertexRef, ExtrudeFeature } from "../model/types";
import { featureRefs } from "../model/doc";
import { loopPolygon, polyArea, sketchCurves, sketchPath, sketchProfile, type ProfileFace, type Seg } from "../sketch/profile";
import { applyExt, projectEdge, type ModelEdge } from "../sketch/external";
import { solve } from "../sketch/solver";

export class FeatureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A body and the names of its faces (parallel arrays). */
interface Named { shape: any; faces: any[]; names: string[] }

/** What a feature added or removed, so mirror and patterns can copy it: its tool solids and how each was applied. */
type Tool = { shape: Named; op: "fuse" | "cut" };
/** A curve feature's result (helix): the OCCT wire and points along it for the view. */
interface Curve { wire: any; pts: V3[] }
interface CacheEntry { key: string; body: Named | null; status: FeatureStatus; frame?: Frame; tools?: Tool[]; sketch?: SketchFeature; curve?: Curve }

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
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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
  /** Curves made by helix features in the current evaluation (FR-FT-083). */
  private curves = new Map<string, Curve>();
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

  /** A shown-edge description of an OCCT edge (for sketch curves that follow it). */
  private modelEdge(e: any): ModelEdge {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_Curve_2(e);
    const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
    const start = this.xyz(ad.Value(t0)), end = this.xyz(ad.Value(t1)), mid = this.xyz(ad.Value((t0 + t1) / 2));
    const ty = ad.GetType();
    if (ty === oc.GeomAbs_CurveType.GeomAbs_Line) return { type: "line", start, end, mid, closed: false };
    if (ty === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const c = ad.Circle();
      const closed = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6 || d3(start, end) < 1e-7;
      return { type: closed ? "circle" : "arc", start, end, mid, closed, center: this.xyz(c.Location()), axis: this.xyz(c.Axis().Direction()), radius: c.Radius() };
    }
    return { type: "curve", start, end, mid, closed: d3(start, end) < 1e-7 };
  }

  /**
   * On edge relations (FR-SK-064): moves each converted curve onto its model edge as the body is now,
   * marks the ones whose edge is gone as dangling, and re-solves. Null when nothing changed.
   */
  followEdges(sk: SketchFeature, body: Named | null, frame: Frame): SketchFeature | null {
    if (!sk.rels.some(r => r.ext)) return null;
    const out: SketchFeature = structuredClone(sk);
    let lost = 0;
    for (const r of out.rels) {
      if (!r.ext) continue;
      const ent = out.ents.find(e => e.id === r.e[0]);
      let ok = false;
      try {
        const g = body && ent ? projectEdge(this.modelEdge(this.resolveEdge(body, r.ext)), frame) : null;
        ok = !!g && applyExt(out, ent!, g);
      } catch { ok = false; }
      if (ok) delete r.dangling; else { r.dangling = true; lost++; }
    }
    if (lost) this.warning = "The sketch has dangling references: model edges it follows are gone.";
    if (JSON.stringify(out) === JSON.stringify(sk)) return null;
    solve(out);
    return JSON.stringify(out) === JSON.stringify(sk) ? null : out;
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

  /** A reference coordinate system (FR-REF-005): o its origin, x/y its axes, n its Z. */
  private refCsys(f: CsysFeature, body: Named | null, frames: Record<string, Frame>): Frame {
    const o: V3 = f.origin ? this.vertexPos(f.origin, body, frames) : [0, 0, 0];
    const u = (v: V3): V3 => mul(v, 1 / (Math.hypot(...v) || 1));
    let z = f.z ? u(this.lineOf(f.z, body, frames, "the Z direction: an edge, a face or an axis").d) : [0, 0, 1] as V3;
    if (f.flipZ) z = mul(z, -1);
    let x = f.x ? u(this.lineOf(f.x, body, frames, "the X direction: an edge, a face or an axis").d) : null;
    if (!x) x = Math.abs(z[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    if (f.flipX) x = mul(x, -1);
    const sq = add(x, mul(z, -dot(x, z)));
    if (Math.hypot(...sq) < 1e-6) throw new FeatureError("E-REF-PARALLEL", "The X and Z directions are parallel.");
    x = u(sq);
    return { o, x, y: cross(z, x), n: z };
  }

  // ---------- profiles ----------

  /** OCCT faces of a sketch's regions, plus which sketch curve each edge came from. */
  private profileFaces(sk: SketchFeature, frame: Frame, off: V3 = [0, 0, 0], skip?: Set<string>) {
    const oc = this.oc;
    const prof = sketchProfile(sk, skip);
    if (prof.error) throw new FeatureError(prof.error.code, prof.error.message);
    const edgeEnt: [any, string][] = [];
    const edgeOf = (s: Seg) => this.segEdge(s, frame, off);
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

  /** An OCCT edge for a sketch curve placed on its plane (moved by `off`). */
  private segEdge(s: Seg, frame: Frame, off: V3 = [0, 0, 0]): any {
    const oc = this.oc;
    const nrm = this.D(frame.n);
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
    // Start from (FR-FT-013): the profile moves along the sketch normal before it is swept.
    const so = f.type === "extrude" ? mul(frame.n, this.startShift(f, frame, prev, frames)) : [0, 0, 0] as V3;
    if (f.type === "extrude" && (f.end === "upto" || f.end === "offset")) {
      tools = this.upTo(f, sk, frame, prev, frames, so);
    } else if (f.type === "extrude") {
      // A cut goes into the material (against the sketch normal); Reverse direction flips either.
      let dir = (f.op === "cut" ? -1 : 1) * (f.flip ? -1 : 1);
      let d1 = f.depth.v, d2 = f.depth2?.v ?? 0;
      if (f.end === "mid") { d2 = d1 / 2; d1 = d1 / 2; }
      if (f.end === "vertex") {
        // Up to vertex: as far as the vertex's level, toward it.
        const s = dot(add(this.vertexPos(f.upToVertex, prev, frames), mul(add(frame.o, so), -1)), frame.n);
        if (Math.abs(s) < 1e-7) throw new FeatureError("E-FT-ZERO", "The vertex is level with the start of the extrusion.");
        dir = Math.sign(s); d1 = Math.abs(s); d2 = 0;
      }
      if (f.end === "next") {
        if (!prev) throw new FeatureError("E-FT-NOBODY", "Up to next needs a body.");
        d1 = this.reach(prev.shape, add(frame.o, so), mul(frame.n, dir)) + 1; d2 = 0;
      }
      if (f.end === "through" || f.end === "through2") {
        if (!prev) throw new FeatureError("E-FT-NOBODY", "Through all needs a body to cut.");
        d1 = this.size(prev.shape) * 2 + 1;
        // Through all both: as far again behind the sketch plane.
        d2 = f.end === "through2" ? d1 : 0;
      }
      if (!(d1 + d2 > 1e-6)) throw new FeatureError("E-FT-ZERO", "The depth must be more than 0.");
      const off = add(so, mul(frame.n, -d2 * dir));
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
        if (f.end === "next") t = this.upToNext(t, prev!, f, add(frame.o, so), mul(frame.n, dir), d1);
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
    if (f.op === "boss" && prev && f.merge === false) return this.compoundOf([...this.bodyList(prev), tool]);
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
  private upTo(f: Feature & { type: "extrude" }, sk: SketchFeature, frame: Frame, prev: Named | null, frames: Record<string, Frame>, so: V3 = [0, 0, 0]): Named[] {
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
    const c = add(this.w(frame, mid), so);
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
    const { faces, edgeEnt } = this.profileFaces(sk, frame, so);
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

  /** Where a vertex reference is: an edge end or a reference point. */
  private vertexPos(r: VertexRef | undefined, body: Named | null, frames: Record<string, Frame>): V3 {
    if (!r) throw new FeatureError("E-FT-VERTEX", "Pick a vertex.");
    if ("point" in r) {
      const fr = frames[r.point];
      if (!fr) throw new FeatureError("E-FT-PARENT", "The reference point is missing or suppressed.");
      return fr.o;
    }
    return this.refPoint({ id: "", type: "point", name: "", mode: "vertex", edge: r.edge, at: r.at }, body).o;
  }

  /** Start from (FR-FT-013): how far the profile moves along the sketch normal. */
  private startShift(f: ExtrudeFeature, frame: Frame, prev: Named | null, frames: Record<string, Frame>): number {
    if (f.start === "offset") return (f.startOffset?.v ?? 0) * (f.startReverse ? -1 : 1);
    if (f.start === "vertex") return dot(add(this.vertexPos(f.startVertex, prev, frames), mul(frame.o, -1)), frame.n);
    if (f.start !== "surface") return 0;
    if (!f.startRef) throw new FeatureError("E-FT-START", "Pick the face or plane the extrusion starts from.");
    let target: Frame;
    try { target = this.planeFrame(f.startRef, prev, frames); }
    catch (err) {
      if (err instanceof FeatureError && err.code === "E-FT-NOTPLANAR") throw new FeatureError("E-FT-START", "Start from a face needs a flat face or a plane.");
      throw err;
    }
    if (Math.abs(Math.abs(dot(target.n, frame.n)) - 1) > 1e-6) throw new FeatureError("E-FT-START", "The start face must be parallel to the sketch.");
    return dot(add(target.o, mul(frame.o, -1)), target.n) / dot(frame.n, target.n);
  }

  /**
   * Up to next (FR-FT-012): a long tool, then the piece of it next to the profile: for a boss the
   * gap up to the body, for a cut the material up to where it first opens into a void.
   */
  private upToNext(tool: Named, body: Named, f: ExtrudeFeature, start: V3, dirN: V3, len: number): Named {
    const oc = this.oc, A = oc.TopAbs_ShapeEnum;
    const piece = this.bool(f.op === "boss" ? "cut" : "common", tool, body, f.id);
    const level = (s: any) => {
      const map = new oc.TopTools_IndexedMapOfShape_1();
      oc.TopExp.MapShapes_1(s, A.TopAbs_VERTEX, map);
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i <= map.Extent(); i++) {
        const d = dot(add(this.xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex_1(map.FindKey(i)))), mul(start, -1)), dirN);
        lo = Math.min(lo, d); hi = Math.max(hi, d);
      }
      return [lo, hi];
    };
    let best: any = null, bestLo = Infinity, bestHi = 0;
    for (const ex = new oc.TopExp_Explorer_2(piece.shape, A.TopAbs_SOLID, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const s = oc.TopoDS.Solid_1(ex.Current());
      const [lo, hi] = level(s);
      if (Math.abs(lo) < Math.abs(bestLo)) { best = s; bestLo = lo; bestHi = hi; }
    }
    if (!best || Math.abs(bestLo) > 1e-4) throw new FeatureError(f.op === "boss" ? "E-FT-NEXT" : "E-FT-NOCHANGE", f.op === "boss" ? "The profile starts inside the body: there is no gap up to the next face." : "The cut does not touch the body.");
    if (f.op === "boss" && bestHi > len - 1e-3) throw new FeatureError("E-FT-NEXT", "Nothing is in the way: the extrusion never meets the body.");
    const faces = this.sub(best, "FACE");
    const names = faces.map((x, i) => { const j = piece.faces.findIndex(g => g.IsSame(x)); return j >= 0 ? piece.names[j] : `${f.id}:new:${i}`; });
    return { shape: best, faces, names };
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
    if (f.type === "fillet" && f.kind === "full") return this.fullRound(f, prev);
    if (f.type === "fillet" && f.kind === "face") return this.faceFillet(f, prev);
    if (!f.edges.length) throw new FeatureError("E-FT-NOEDGES", "Pick at least one edge.");
    const size = f.type === "fillet" ? f.radius.v : f.distance.v;
    if (!(size > 1e-6)) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    const mode = f.type === "chamfer" ? f.mode ?? "equal" : "equal";
    if (f.type === "chamfer" && mode === "two" && !((f.distance2?.v ?? 0) > 1e-6)) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    if (f.type === "chamfer" && mode === "angle" && !((f.angle?.v ?? 0) > 1e-6 && (f.angle?.v ?? 0) < Math.PI / 2)) throw new FeatureError("E-FT-ANGLE", "The chamfer angle must be between 0° and 90°.");
    const edges = f.edges.map(r => this.resolveEdge(prev, r));
    // Multiple radius fillet (FR-FT-031): an edge's own radius, else the feature's.
    const rad = (i: number) => (f.type === "fillet" && f.multi ? f.edges[i].r ?? size : size);
    const vari = f.type === "fillet" && !!f.variable;
    const rad2 = (i: number) => (vari ? (f as FilletFeature).edges[i].r2 ?? rad(i) : rad(i));
    const radV = (i: number) => (vari ? (f as FilletFeature).edges[i].r ?? size : rad(i));
    if (f.edges.some((_e, i) => !(radV(i) > 1e-6) || !(rad2(i) > 1e-6))) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    const make = (list: number[]) => {
      const mk = f.type === "fillet"
        ? new oc.BRepFilletAPI_MakeFillet(prev.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational)
        : new oc.BRepFilletAPI_MakeChamfer(prev.shape);
      for (const i of list) {
        const e = edges[i];
        if (vari) {
          // Variable radius: r at the end nearer `at` (else the edge's first vertex), r2 at the other.
          const at = (f as FilletFeature).edges[i].at;
          const p0 = this.xyz(oc.BRep_Tool.Pnt(oc.TopExp.FirstVertex(e, true))), p1 = this.xyz(oc.BRep_Tool.Pnt(oc.TopExp.LastVertex(e, true)));
          const swap = !!at && d3(p1, at) < d3(p0, at);
          (mk as any).Add_3(swap ? rad2(i) : radV(i), swap ? radV(i) : rad2(i), e);
        } else if (f.type === "fillet" || mode === "equal") mk.Add_2(rad(i), e);
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

  /** A flat face's plane: a point on it and its outward normal; null when it is not flat. */
  private facePlane(face: any): { p: V3; n: V3 } | null {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
    const pos = ad.Plane().Position();
    let n = this.xyz(pos.Direction());
    if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
    return { p: this.centroid(face), n };
  }

  /**
   * Face fillet (FR-FT-032): rounds every edge where a face of set 1 meets a face of set 2 with one
   * radius (the rolling ball between the two sets). New faces are named `fid:fillet:i`.
   */
  private faceFillet(f: FilletFeature, prev: Named): Named {
    const oc = this.oc;
    const r = f.radius.v;
    if (!(r > 1e-6)) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    if (!f.faces1?.length || !f.faces2?.length) throw new FeatureError("E-FT-FACESETS", "Pick the faces of face set 1 and face set 2.");
    const a = f.faces1.map(x => this.resolveFace(prev, x)), b = f.faces2.map(x => this.resolveFace(prev, x));
    const eb = b.flatMap(x => this.sub(x, "EDGE"));
    const edges: any[] = [];
    for (const e of a.flatMap(x => this.sub(x, "EDGE"))) if (eb.some(g => g.IsSame(e)) && !edges.some(g => g.IsSame(e))) edges.push(e);
    if (!edges.length) throw new FeatureError("E-FT-FACESETS", "The two face sets do not meet: a face fillet rounds the edges between them.");
    const mk = new oc.BRepFilletAPI_MakeFillet(prev.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    for (const e of edges) mk.Add_2(r, e);
    try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-FT-FILLET", `The fillet radius ${r} mm is too large for the selected edges, or the edges cannot be rounded.`);
    const out = this.carry(mk, [prev], mk.Shape(), f.id);
    edges.forEach((e, i) => {
      for (const g of this.list(mk.Generated(e))) {
        const j = out.faces.findIndex(x => x.IsSame(g));
        if (j >= 0) out.names[j] = `${f.id}:fillet:${i}`;
      }
    });
    return out;
  }

  /**
   * Full round fillet (FR-FT-032): side face sets 1 and 2 are parallel flat faces facing apart; each
   * flat centre face between them is replaced by a half cylinder of radius half the gap, tangent to
   * both sides. The material under the centre face, down to the cylinder axis, outside the cylinder
   * is cut away. New faces are named `fid:round:k`.
   */
  private fullRound(f: FilletFeature, prev: Named): Named {
    const oc = this.oc;
    if (!f.faces1?.length || !f.faces2?.length || !f.center?.length) throw new FeatureError("E-FT-FACESETS", "Pick side face set 1, the centre face set and side face set 2.");
    const s1 = this.facePlane(this.resolveFace(prev, f.faces1[0])), s2 = this.facePlane(this.resolveFace(prev, f.faces2[0]));
    if (!s1 || !s2) throw new FeatureError("E-FT-FULLROUND", "A full round needs flat, parallel side faces facing apart.");
    if (dot(s1.n, s2.n) > -1 + 1e-6) throw new FeatureError("E-FT-FULLROUND", "A full round needs flat, parallel side faces facing apart.");
    const gap = dot(sub3(s1.p, s2.p), s1.n);
    if (!(gap > 1e-6)) throw new FeatureError("E-FT-FULLROUND", "A full round needs flat, parallel side faces facing apart.");
    const r = gap / 2, mid = add(s1.p, mul(s1.n, -r)), L = this.size(prev.shape) * 2 + 100;
    let tool: Named | null = null;
    for (const ref of f.center) {
      const face = this.resolveFace(prev, ref), c = this.facePlane(face);
      if (!c || Math.abs(dot(c.n, s1.n)) > 1e-6) throw new FeatureError("E-FT-FULLROUND", "The centre faces must be flat and square to the side faces.");
      const a = unit(cross(c.n, s1.n));
      const onMid = sub3(c.p, mul(s1.n, dot(sub3(c.p, mid), s1.n)));
      const axis = add(onMid, mul(c.n, -r));
      const slab = new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(c.n, -r)), true, true).Shape();
      const cyl = new oc.BRepPrimAPI_MakeCylinder_3(new oc.gp_Ax2_3(this.P(add(axis, mul(a, -L))), this.D(a)), r, 2 * L).Shape();
      const cut = new oc.BRepAlgoAPI_Cut_3(slab, cyl, new oc.Message_ProgressRange_1());
      if (!cut.IsDone() || cut.HasErrors()) throw new FeatureError("E-FT-FULLROUND", "The full round could not be made for these faces.");
      const t: Named = { shape: cut.Shape(), faces: this.sub(cut.Shape(), "FACE"), names: [] };
      t.names = t.faces.map((_x, i) => `${f.id}:round:${i}`);
      tool = tool ? this.bool("fuse", tool, t, f.id) : t;
    }
    const out = this.bool("cut", prev, tool!, f.id);
    if (Math.abs(this.volume(out.shape) - this.volume(prev.shape)) < 1e-9) throw new FeatureError("E-FT-FULLROUND", "The full round could not be made for these faces.");
    let k = 0;
    out.names = out.names.map(n => (n.startsWith(`${f.id}:`) ? `${f.id}:round:${k++}` : n));
    return out;
  }

  /**
   * Scale (FR-BODY-006): the picked bodies (all when none) scaled about the origin or each body's
   * centroid, by one factor or per axis. Faces keep their names.
   */
  private scaleBodies(f: ScaleFeature, prev: Named | null): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    const k: V3 = f.axes ? [f.fx?.v ?? 1, f.fy?.v ?? 1, f.fz?.v ?? 1] : [f.factor.v, f.factor.v, f.factor.v];
    if (k.some(x => !(x > 1e-9))) throw new FeatureError("E-BDY-SCALE", "The scale factor must be more than 0.");
    const list = this.bodyList(prev);
    const picked = f.bodies.length ? this.pickedBodies(list, prev, f.bodies) : list.map((_b, i) => i);
    const out: Named[] = list.map((b, i) => {
      if (!picked.includes(i)) return b;
      let c: V3 = [0, 0, 0];
      if (f.about === "centroid") { const p = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(b.shape, p, true, false, false); c = this.xyz(p.CentreOfMass()); }
      let mk: any;
      if (!f.axes) {
        const tr = new oc.gp_Trsf_1();
        tr.SetScale(this.P(c), k[0]);
        mk = new oc.BRepBuilderAPI_Transform_2(b.shape, tr, true);
      } else {
        const g = new oc.gp_GTrsf_1();
        for (let j = 0; j < 3; j++) g.SetValue(j + 1, j + 1, k[j]);
        g.SetTranslationPart(new oc.gp_XYZ_2(c[0] * (1 - k[0]), c[1] * (1 - k[1]), c[2] * (1 - k[2])));
        mk = new oc.BRepBuilderAPI_GTransform_2(b.shape, g, true);
      }
      const shape = mk.Shape();
      const faces = this.sub(shape, "FACE");
      const names = faces.map((x, n) => { const j = b.faces.findIndex(y => this.list(mk.Modified(y)).some(m => m.IsSame(x))); return j >= 0 ? b.names[j] : `${f.id}:new:${n}`; });
      return { shape, faces, names };
    });
    return this.compoundOf(out);
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

  // ---------- P3: helix, sweep, loft (FRS 9.9) ----------

  /** A sketch feature evaluated before `doc`'s current feature, with its frame. */
  private sketchOf(id: string | undefined, doc: PartDoc, body: Named | null, frames: Record<string, Frame>, what: string): { sk: SketchFeature; frame: Frame } {
    const sk = id ? doc.features.find(x => x.id === id) : undefined;
    if (!sk || sk.type !== "sketch") throw new FeatureError("E-FT-NOSKETCH", `Pick ${what}.`);
    if (sk.suppressed) throw new FeatureError("E-FT-PARENT", "A sketch this feature uses is suppressed.");
    return { sk, frame: frames[sk.id] ?? this.frameOf(sk, body, frames) };
  }

  /**
   * Helix / spiral (FR-FT-083): on a cylinder (or a cone, with taper) through the sketch's circle, as a
   * Geom2d line on the surface, so the curve is exact.
   */
  private helix(f: HelixFeature, doc: PartDoc, body: Named | null, frames: Record<string, Frame>): Curve {
    const oc = this.oc;
    const { sk, frame } = this.sketchOf(f.sketch, doc, body, frames, "a sketch with a circle");
    const circ = (sk.ents.find(e => e.t === "circle" && !e.cons) ?? sk.ents.find(e => e.t === "circle")) as (SketchFeature["ents"][number] & { t: "circle" }) | undefined;
    if (!circ) throw new FeatureError("E-HLX-CIRCLE", "A helix starts from a circle in its sketch.");
    const cp = sk.ents.find(e => e.id === circ.c);
    if (!cp || cp.t !== "point") throw new FeatureError("E-HLX-CIRCLE", "A helix starts from a circle in its sketch.");
    const r = circ.r;
    let P = f.pitch.v, N = f.revs.v, H = f.height.v;
    if (f.mode === "pitchRev") H = P * N;
    else if (f.mode === "heightRev") P = H / N;
    else N = H / P;
    if (!(P > 1e-6 && N > 1e-6 && H > 1e-6)) throw new FeatureError("E-HLX-VALUES", "Height, pitch and revolutions must be more than 0.");
    if (N > 2000) throw new FeatureError("E-HLX-VALUES", "A helix can have at most 2000 revolutions.");
    const ta = f.taper?.v ?? 0;
    if (Math.abs(ta) >= (80 * Math.PI) / 180) throw new FeatureError("E-HLX-TAPER", "The taper angle must be less than 80°.");
    if (r + H * Math.tan(ta) <= 1e-6) throw new FeatureError("E-HLX-TAPER", "The taper closes the helix before its end: use a smaller angle.");
    const dir = mul(frame.n, f.reverse ? -1 : 1);
    const s0 = f.start?.v ?? 0;
    const xd = unit(add(mul(frame.x, Math.cos(s0)), mul(frame.y, Math.sin(s0))));
    const yd = cross(dir, xd);
    const c = this.w(frame, [cp.x, cp.y]);
    const sg = f.cw ? -1 : 1;
    const ax3 = new oc.gp_Ax3_3(this.P(c), this.D(dir), this.D(xd));
    const cone = Math.abs(ta) > 1e-9;
    const surf = new oc.Handle_Geom_Surface_2(cone ? new oc.Geom_ConicalSurface_1(ax3, ta, r) : new oc.Geom_CylindricalSurface_1(ax3, r));
    // Along a cone's generator the parameter is the slant length: z = v·cos(taper).
    const dv = cone ? P / Math.cos(ta) : P;
    const line = new oc.Handle_Geom2d_Curve_2(new oc.Geom2d_Line_3(new oc.gp_Pnt2d_3(0, 0), new oc.gp_Dir2d_4(sg * 2 * Math.PI, dv)));
    const edge = new oc.BRepBuilderAPI_MakeEdge_31(line, surf, 0, N * Math.hypot(2 * Math.PI, dv)).Edge();
    oc.BRepLib.BuildCurves3d_2(edge);
    const wire = new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
    const pts: V3[] = [];
    const n = Math.max(16, Math.min(8000, Math.ceil(N * 72)));
    for (let k = 0; k <= n; k++) {
      const tt = (k / n) * N, z = tt * P, rr = r + z * Math.tan(ta), th = sg * 2 * Math.PI * tt;
      pts.push(add(add(c, mul(dir, z)), add(mul(xd, rr * Math.cos(th)), mul(yd, rr * Math.sin(th)))));
    }
    return { wire, pts };
  }

  /** The wire of a sweep path: a helix, or a sketch's chain of curves. */
  private pathWire(f: SweepFeature, doc: PartDoc, body: Named | null, frames: Record<string, Frame>): any {
    const oc = this.oc;
    if (!f.path) throw new FeatureError("E-SWP-PATH", "Pick a path: a sketch or a helix.");
    if ("helix" in f.path) {
      const c = this.curves.get(f.path.helix);
      if (!c) throw new FeatureError("E-FT-PARENT", "The helix is missing or has an error.");
      return c.wire;
    }
    const { sk, frame } = this.sketchOf(f.path.sketch, doc, body, frames, "a path sketch");
    const p = sketchPath(sk);
    if (p.error) throw new FeatureError(p.error.code, p.error.message);
    const mk = new oc.BRepBuilderAPI_MakeWire_1();
    for (const sg of p.segs) mk.Add_1(this.segEdge(sg, frame));
    if (!mk.IsDone()) throw new FeatureError("E-SWP-PATH", "The path's curves do not join end to end.");
    return mk.Wire();
  }

  /** Sweep (FR-FT-080/081): profile regions (or a circle) along a path, with MakePipeShell. */
  private sweepAlong(f: SweepFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const spine = this.pathWire(f, doc, prev, frames);
    const helixPath = !!f.path && "helix" in f.path;
    const pipe = (w: any, edgeEnt: [any, string][]): Named => {
      const mk = new oc.BRepOffsetAPI_MakePipeShell(spine);
      if (f.orient === "normal") {
        // Keep normal constant: the profile keeps its start orientation all along.
        const ad = new oc.BRepAdaptor_CompCurve_2(spine, false);
        const p0 = new oc.gp_Pnt_1(), v0 = new oc.gp_Vec_1();
        ad.D1(ad.FirstParameter(), p0, v0);
        const t0 = unit(this.xyz(v0));
        mk.SetMode_2(new oc.gp_Ax2_3(p0, this.D(t0)));
      } else mk.SetMode_1(helixPath);
      mk.Add_1(w, false, false);
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new FeatureError("E-SWP-FAIL", "The sweep failed. Is the profile too big for the path's bends, or far from the path?");
      if (!mk.MakeSolid()) throw new FeatureError("E-SWP-FAIL", "The sweep did not close into a solid.");
      let shape = mk.Shape();
      if (this.volume(shape) < 0) shape = shape.Reversed();
      return this.nameSweep(mk, f.id, edgeEnt, shape);
    };
    const tools: Named[] = [];
    if (f.circular) {
      const d = f.circular.v;
      if (!(d > 1e-6)) throw new FeatureError("E-FT-ZERO", "The diameter must be more than 0.");
      const ad = new oc.BRepAdaptor_CompCurve_2(spine, false);
      const p0 = new oc.gp_Pnt_1(), v0 = new oc.gp_Vec_1();
      ad.D1(ad.FirstParameter(), p0, v0);
      const e = new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(new oc.gp_Ax2_3(p0, this.D(unit(this.xyz(v0)))), d / 2)).Edge();
      tools.push(pipe(new oc.BRepBuilderAPI_MakeWire_2(e).Wire(), [[e, "circle"]]));
    } else {
      const { sk, frame } = this.sketchOf(f.profile, doc, prev, frames, "a profile sketch");
      const { faces, edgeEnt } = this.profileFaces(sk, frame);
      for (const face of faces) {
        const wires = this.subWires(face);
        const outer = oc.BRepTools.OuterWire(face);
        let t = pipe(outer, edgeEnt);
        // Holes in the profile: their sweeps are cut out of the outer one.
        for (const h of wires) if (!h.IsSame(outer)) t = this.bool("cut", t, pipe(h, edgeEnt), f.id);
        tools.push(t);
      }
    }
    return this.applyTool(f, tools, prev);
  }

  /** Loft (FR-FT-082): through the profiles' outer contours in order, with ThruSections. */
  private loft(f: LoftFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (f.profiles.length < 2) throw new FeatureError("E-LOFT-PROFILES", "Pick two or more profile sketches.");
    const mk = new oc.BRepOffsetAPI_ThruSections(true, !!f.ruled, 1e-6);
    let firstEdges: [any, string][] = [];
    const wires: any[] = [];
    f.profiles.forEach((id, k) => {
      const { sk, frame } = this.sketchOf(id, doc, prev, frames, "the profile sketches");
      const { faces, edgeEnt } = this.profileFaces(sk, frame);
      if (faces.length !== 1) throw new FeatureError("E-LOFT-PROFILE", "Each loft profile must be one closed region.");
      const w = oc.BRepTools.OuterWire(faces[0]);
      if (k === 0) firstEdges = edgeEnt;
      wires.push(w);
    });
    if (f.close && wires.length >= 3) wires.push(wires[0]);
    for (const w of wires) mk.AddWire(w);
    mk.CheckCompatibility(true);
    mk.Build(new oc.Message_ProgressRange_1());
    if (!mk.IsDone()) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles twist, or cross each other?");
    let shape = mk.Shape();
    if (this.volume(shape) < 0) shape = shape.Reversed();
    // Faces from the first profile's curves are named after them; the end caps start/end.
    const faces = this.sub(shape, "FACE");
    const names: (string | null)[] = faces.map(() => null);
    for (const [e, ent] of firstEdges) {
      let g: any = null;
      try { g = mk.GeneratedFace(e); } catch { g = null; }
      if (!g || g.IsNull()) continue;
      const i = faces.findIndex(x => x.IsSame(g));
      if (i >= 0 && !names[i]) names[i] = `${f.id}:side:${ent}`;
    }
    const first = this.sub(mk.FirstShape(), "FACE"), last = this.sub(mk.LastShape(), "FACE");
    faces.forEach((x, i) => { if (!names[i] && first.some(g => g.IsSame(x))) names[i] = `${f.id}:start`; else if (!names[i] && last.some(g => g.IsSame(x))) names[i] = `${f.id}:end`; });
    let k = 0;
    const tool: Named = { shape, faces, names: names.map(n => n ?? `${f.id}:new:${k++}`) };
    return this.applyTool(f, [tool], prev);
  }

  /**
   * Rib (FR-FT-062): the open chain thickened (a 2D region from open offsets for Normal to sketch, a
   * slab along the normal for Parallel to sketch), run out a long way, minus the body; the pieces
   * that touch the sketch and stop at the body are joined to it. The first direction that reaches
   * the body wins; `flip` tries the other one first.
   */
  private rib(f: RibFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "A rib needs a body to stand on.");
    const { sk, frame } = this.sketchOf(f.sketch, doc, prev, frames, "an open sketch");
    const p = sketchPath(sk);
    if (p.error) throw new FeatureError(p.error.code, p.error.message);
    if (p.closed) throw new FeatureError("E-RIB-OPEN", "A rib needs an open sketch: lines or arcs that do not close.");
    const t = f.thickness.v;
    if (!(t > 1e-6)) throw new FeatureError("E-FT-ZERO", "The thickness must be more than 0.");
    const mw = new oc.BRepBuilderAPI_MakeWire_1();
    for (const sg of p.segs) mw.Add_1(this.segEdge(sg, frame));
    if (!mw.IsDone()) throw new FeatureError("E-RIB-OPEN", "The rib's curves do not join end to end.");
    const w = mw.Wire();
    const [s0, s1] = f.side === "mid" ? [-t / 2, t / 2] : f.side === "other" ? [-t, 0] : [0, t];
    const big = this.size(prev.shape) * 3 + 100;
    const ends = (x: any): [V3, V3] => { const a = new oc.BRepAdaptor_CompCurve_2(x, false); return [this.xyz(a.Value(a.FirstParameter())), this.xyz(a.Value(a.LastParameter()))]; };
    const [a, b] = ends(w);
    const edges = (x: any) => this.sub(x, "EDGE");
    const named = (shape0: any): Named => { const shape = this.volume(shape0) < 0 ? shape0.Reversed() : shape0; const faces = this.sub(shape, "FACE"); return { shape, faces, names: faces.map((_, i) => `${f.id}:side:${i}`) }; };
    const fuseAll = (shapes: any[]) => {
      let out: Named = named(shapes[0]);
      for (const x of shapes.slice(1)) out = this.bool("fuse", out, named(x), f.id);
      return out;
    };
    let along: V3;
    const tool = (sgn: number): Named => {
      if (f.dir === "parallel") {
        // In the plane, square to the chord; thickness along the normal.
        along = mul(unit(cross(frame.n, add(b, mul(a, -1)))), sgn);
        const tr = new oc.gp_Trsf_1();
        tr.SetTranslation_1(this.V(mul(frame.n, s0)));
        const w0 = new oc.BRepBuilderAPI_Transform_2(w, tr, true).Shape();
        const solids = edges(w0).map(e => {
          const face = new oc.BRepPrimAPI_MakePrism_1(e, this.V(mul(along, big)), true, true).Shape();
          return new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(frame.n, s1 - s0)), true, true).Shape();
        });
        return fuseAll(solids);
      }
      // Normal to sketch: the region between two open offsets of the chain, run along the normal.
      along = mul(frame.n, sgn);
      // The side +d goes to: n × the chain's direction at its start.
      const t0 = p.segs[0].kind === "line" ? unit(add(this.w(frame, p.segs[0].b), mul(this.w(frame, p.segs[0].a), -1))) : null;
      const straight = p.segs.every(sg => sg.kind === "line") && p.segs.every(sg => sg.kind === "line" && Math.abs(Math.abs(dot(unit(add(this.w(frame, sg.b), mul(this.w(frame, sg.a), -1))), t0!)) - 1) < 1e-9);
      const off = (d: number): any => {
        if (Math.abs(d) < 1e-12) return w;
        if (straight) {
          // One straight line (or several in line): OCCT cannot tell its plane, so move it instead.
          const tr = new oc.gp_Trsf_1();
          tr.SetTranslation_1(this.V(mul(cross(frame.n, t0!), d)));
          return oc.TopoDS.Wire_1(new oc.BRepBuilderAPI_Transform_2(w, tr, true).Shape());
        }
        const make = (k: number) => {
          const mk = new oc.BRepOffsetAPI_MakeOffset_3(w, oc.GeomAbs_JoinType.GeomAbs_Intersection, true);
          mk.Perform(k, 0);
          if (!mk.IsDone()) throw new FeatureError("E-RIB-FAIL", "The rib's thickness could not be offset from the sketch.");
          return oc.TopoDS.Wire_1(mk.Shape());
        };
        // OCCT picks the wire's plane normal itself: check the side and offset the other way if needed.
        const o = make(d), [p0] = ends(o);
        const ad = new oc.BRepAdaptor_CompCurve_2(w, false), q = new oc.gp_Pnt_1(), v = new oc.gp_Vec_1();
        ad.D1(ad.FirstParameter(), q, v);
        const side = dot(add(p0, mul(this.xyz(q), -1)), cross(frame.n, unit(this.xyz(v))));
        return side * d > 0 ? o : make(-d);
      };
      const A = off(s1), B = off(s0);
      const [a0, a1] = ends(A), [b0, b1] = ends(B);
      // A forward, across the far end, B backward, back to the start: edges in wire order so MakeWire joins each.
      const ordered = (x: any) => { const o: any[] = []; for (const ex = new oc.BRepTools_WireExplorer_2(x); ex.More(); ex.Next()) o.push(ex.Current()); return o; };
      const mk = new oc.BRepBuilderAPI_MakeWire_1();
      for (const e of ordered(A)) mk.Add_1(e);
      if (d3(a1, b1) > 1e-9) mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(this.P(a1), this.P(b1)).Edge());
      for (const e of ordered(B).reverse()) mk.Add_1(oc.TopoDS.Edge_1(e.Reversed()));
      if (d3(b0, a0) > 1e-9) mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(this.P(b0), this.P(a0)).Edge());
      if (!mk.IsDone()) throw new FeatureError("E-RIB-FAIL", "The rib's thickness could not be offset from the sketch.");
      const face = new oc.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();
      return named(new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(along, big)), true, true).Shape());
    };
    for (const sgn of f.flip ? [-1, 1] : [1, -1]) {
      let piece: Named;
      try { piece = this.bool("cut", tool(sgn), prev, f.id); } catch (e) { if (e instanceof FeatureError && e.code === "E-RIB-FAIL") throw e; continue; }
      const keep: any[] = [];
      for (const ex = new oc.TopExp_Explorer_2(piece.shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
        const s = oc.TopoDS.Solid_1(ex.Current());
        const dist = new oc.BRepExtrema_DistShapeShape_2(s, w, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
        if (!dist.IsDone() || dist.Value() > 1e-4) continue;
        if (Math.max(this.reach(s, a, along!), this.reach(s, b, along!)) > big * 0.9) continue;
        keep.push(s);
      }
      if (!keep.length) continue;
      const faces: any[] = [], names: string[] = [];
      for (const s of keep) for (const x of this.sub(s, "FACE")) {
        const j = piece.faces.findIndex(g => g.IsSame(x));
        faces.push(x); names.push(j >= 0 ? piece.names[j] : `${f.id}:new:${names.length}`);
      }
      let rib: Named = { shape: keep[0], faces: this.sub(keep[0], "FACE"), names: [] };
      if (keep.length === 1) rib = { shape: keep[0], faces, names };
      else {
        const bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
        bb.MakeCompound(comp);
        for (const s of keep) bb.Add(comp, s);
        rib = { shape: comp, faces, names };
      }
      this.tools.set(f.id, [{ shape: rib, op: "fuse" }]);
      return this.bool("fuse", prev, rib, f.id);
    }
    throw new FeatureError("E-RIB-MISS", "The rib does not reach the body. Does the sketch sit next to the part, or should the direction flip?");
  }

  /**
   * Split line (FR-FT-084): the sketch's curves run out both ways along its normal into sheets; their
   * sections with the picked faces (or the whole body) split those faces with BRepFeat_SplitShape.
   * The pieces keep the face's name (their hints tell them apart).
   */
  private splitLine(f: SplitFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body to split yet.");
    const { sk, frame } = this.sketchOf(f.sketch, doc, prev, frames, "a sketch to project");
    const segs = sketchCurves(sk);
    if (!segs.length) throw new FeatureError("E-SPL-EMPTY", "The sketch has no curves to project.");
    const big = this.size(prev.shape) * 2 + 100;
    const bb = new oc.BRep_Builder(), sheets = new oc.TopoDS_Compound();
    bb.MakeCompound(sheets);
    for (const sg of segs) {
      const e = this.segEdge(sg, frame, mul(frame.n, -big));
      bb.Add(sheets, new oc.BRepPrimAPI_MakePrism_1(e, this.V(mul(frame.n, 2 * big)), false, true).Shape());
    }
    const targets = f.faces.length ? f.faces.map(r => this.resolveFace(prev, r)) : [prev.shape];
    const seq = new oc.TopTools_SequenceOfShape_1();
    for (const tgt of targets) {
      const sec = new oc.BRepAlgoAPI_Section_3(tgt, sheets, false);
      sec.ComputePCurveOn1(true);
      sec.Approximation(true);
      sec.Build(new oc.Message_ProgressRange_1());
      if (!sec.IsDone()) throw new FeatureError("E-SPL-FAIL", "The sketch could not be projected onto the faces.");
      for (const e of this.sub(sec.Shape(), "EDGE")) seq.Append_1(e);
    }
    if (!seq.Length()) throw new FeatureError("E-SPL-MISS", "The projected sketch does not cross the faces.");
    const sp = new oc.BRepFeat_SplitShape_2(prev.shape);
    sp.Add_1(seq);
    sp.Build(new oc.Message_ProgressRange_1());
    if (!sp.IsDone()) throw new FeatureError("E-SPL-FAIL", "The faces could not be split.");
    const out = this.carry(sp, [prev], sp.Shape(), f.id);
    if (out.faces.length === prev.faces.length) throw new FeatureError("E-SPL-MISS", "The projected sketch does not cross the faces.");
    return out;
  }

  /** Imported body (FR-FT-130): read the BREP text; with `heal`, sew and fix it (FR-FT-131). A body already there stays: this is another body. */
  private importBody(f: ImportFeature, prev: Named | null): Named {
    const oc = this.oc;
    if (!f.brep) throw new FeatureError("E-IMP-EMPTY", "The imported body has no geometry.");
    const path = `/imp-${f.id}.brep`;
    oc.FS.writeFile(path, f.brep);
    let shape = new oc.TopoDS_Shape();
    const ok = oc.BRepTools.Read_2(shape, path, new oc.BRep_Builder(), new oc.Message_ProgressRange_1());
    oc.FS.unlink(path);
    if (!ok || shape.IsNull()) throw new FeatureError("E-IMP-READ", "The imported body could not be read.");
    if (f.heal) {
      const tol = f.tol?.v ?? 0.1;
      if (!(tol > 0)) throw new FeatureError("E-FT-ZERO", "The tolerance must be more than 0.");
      const before = this.freeEdges(shape, 1e-6);
      const valid0 = new oc.BRepCheck_Analyzer(shape, true, false).IsValid_2();
      const sew = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
      sew.Add(shape);
      sew.Perform(new oc.Message_ProgressRange_1());
      let healed = sew.SewedShape();
      const fix = new oc.ShapeFix_Shape_2(healed);
      fix.Perform(new oc.Message_ProgressRange_1());
      healed = fix.Shape();
      // Closed shells outside solids become solids.
      const bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
      bb.MakeCompound(comp);
      for (const ex = new oc.TopExp_Explorer_2(healed, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) bb.Add(comp, ex.Current());
      for (const ex = new oc.TopExp_Explorer_2(healed, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SOLID); ex.More(); ex.Next()) {
        const sh = oc.TopoDS.Shell_1(ex.Current());
        if (oc.BRep_Tool.IsClosed_1(sh)) {
          let solid = new oc.ShapeFix_Solid_1().SolidFromShell(sh);
          if (this.volume(solid) < 0) solid = solid.Reversed();
          bb.Add(comp, solid);
        } else bb.Add(comp, sh);
      }
      shape = comp;
      const after = this.freeEdges(shape, 1e-6);
      const valid1 = new oc.BRepCheck_Analyzer(shape, true, false).IsValid_2();
      this.warning = `Check and heal: ${before} free edges before, ${after} after; ${valid0 ? "valid" : "not valid"} before, ${valid1 ? "valid" : "not valid"} after; ${this.solids(shape)} solid bodies.`;
    }
    const faces = this.sub(shape, "FACE");
    const mine: Named = { shape, faces, names: faces.map((_, i) => `${f.id}:f${i}`) };
    return prev ? this.compoundOf([prev, mine]) : mine;
  }

  /** Edges on one face only (gaps and open boundaries), counted by a sewing pass that joins nothing new. */
  private freeEdges(shape: any, tol: number): number {
    const sew = new this.oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
    sew.Add(shape);
    sew.Perform(new this.oc.Message_ProgressRange_1());
    return sew.NbFreeEdges();
  }

  // ---------- multibody (FRS 9.10) ----------

  /** The solids of a body, each with the body's face names. */
  private bodyList(body: Named): Named[] {
    const oc = this.oc, out: Named[] = [];
    for (const ex = new oc.TopExp_Explorer_2(body.shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const solid = oc.TopoDS.Solid_1(ex.Current());
      const faces = this.sub(solid, "FACE");
      out.push({ shape: solid, faces, names: faces.map((x, i) => { const j = body.faces.findIndex(g => g.IsSame(x)); return j >= 0 ? body.names[j] : `?:${i}`; }) });
    }
    return out;
  }

  /** Bodies back into one shape: a compound when there are several. */
  private compoundOf(parts: Named[]): Named {
    if (parts.length === 1) return parts[0];
    const oc = this.oc, bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
    bb.MakeCompound(comp);
    for (const p of parts) bb.Add(comp, p.shape);
    return { shape: comp, faces: parts.flatMap(p => p.faces), names: parts.flatMap(p => p.names) };
  }

  /** Which body holds the face a body pick names. */
  private bodyIndex(list: Named[], body: Named, ref: FaceRef): number {
    const face = this.resolveFace(body, ref);
    const i = list.findIndex(b => b.faces.some(x => x.IsSame(face)));
    if (i < 0) throw new FeatureError("E-TN-LOST", `Reference lost: face ${ref.name}`);
    return i;
  }

  private pickedBodies(list: Named[], body: Named, refs: FaceRef[]): number[] {
    return [...new Set(refs.map(r => this.bodyIndex(list, body, r)))];
  }

  /** Combine (FR-BODY-002). */
  private combine(f: CombineFeature, prev: Named | null): Named {
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    const list = this.bodyList(prev);
    if (!f.main) throw new FeatureError("E-CMB-BODIES", "Pick the main body and at least one other body.");
    const mi = this.bodyIndex(list, prev, f.main);
    const ti = this.pickedBodies(list, prev, f.tools).filter(i => i !== mi);
    if (!ti.length) throw new FeatureError("E-CMB-BODIES", "Pick the main body and at least one other body.");
    let out = list[mi];
    for (const i of ti) out = this.bool(f.op === "add" ? "fuse" : f.op === "subtract" ? "cut" : "common", out, list[i], f.id);
    if (f.op !== "subtract" && this.volume(out.shape) < 1e-9) throw new FeatureError("E-CMB-EMPTY", "The bodies share no material.");
    return this.compoundOf([...list.filter((_, i) => i !== mi && !ti.includes(i)), ...this.bodyList(out)]);
  }

  /** Split body (FR-BODY-003): the bodies the plane crosses (or the picked ones) become separate pieces. */
  private splitBody(f: SplitBodyFeature, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.plane) throw new FeatureError("E-BSP-PLANE", "Pick a plane or a flat face to split with.");
    const fr = this.planeFrame(f.plane, prev, frames);
    const list = this.bodyList(prev);
    const picked = f.bodies.length ? this.pickedBodies(list, prev, f.bodies) : list.map((_, i) => i);
    const big = this.size(prev.shape) * 2 + 100;
    const face = new oc.BRepBuilderAPI_MakeFace_9(new oc.gp_Pln_2(new oc.gp_Ax3_3(this.P(fr.o), this.D(fr.n), this.D(fr.x))), -big, big, -big, big).Face();
    const out: Named[] = [];
    let cut = false;
    list.forEach((b, i) => {
      if (!picked.includes(i)) { out.push(b); return; }
      const mk = new oc.BRepAlgoAPI_Splitter_1();
      const args = new oc.TopTools_ListOfShape_1(), tools = new oc.TopTools_ListOfShape_1();
      args.Append_1(b.shape);
      tools.Append_1(face);
      mk.SetArguments(args);
      mk.SetTools(tools);
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone() || mk.HasErrors()) throw new FeatureError("E-BSP-FAIL", "The body could not be split.");
      const pieces = this.bodyList(this.carry(mk, [b], mk.Shape(), f.id));
      if (pieces.length > 1) cut = true;
      out.push(...pieces);
    });
    if (!cut) throw new FeatureError("E-BSP-MISS", "The plane does not cut the bodies.");
    return this.compoundOf(out);
  }

  /** Delete/Keep bodies (FR-BODY-001). */
  private deleteBodies(f: DeleteBodyFeature, prev: Named | null): Named {
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.bodies.length) throw new FeatureError("E-BDY-PICK", "Pick the bodies.");
    const list = this.bodyList(prev);
    const picked = this.pickedBodies(list, prev, f.bodies);
    const rest = list.filter((_, i) => picked.includes(i) === !!f.keep);
    if (!rest.length) throw new FeatureError("E-BDY-NONE", "Nothing would be left: keep at least one body.");
    return this.compoundOf(rest);
  }

  /** Move/Copy body (FR-BODY-004): rotation about the axis, then the translation. Moved faces keep their names. */
  private moveBodies(f: MoveBodyFeature, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.bodies.length) throw new FeatureError("E-BDY-PICK", "Pick the bodies.");
    const list = this.bodyList(prev);
    const picked = this.pickedBodies(list, prev, f.bodies);
    const trsf = new oc.gp_Trsf_1();
    if (f.axis && f.angle && Math.abs(f.angle.v) > 1e-12) {
      const ax = this.lineOf(f.axis, prev, frames, "an axis");
      trsf.SetRotation_1(new oc.gp_Ax1_2(this.P(ax.o), this.D(ax.d)), f.angle.v);
    }
    const tr = new oc.gp_Trsf_1();
    tr.SetTranslation_1(this.V([f.dx.v, f.dy.v, f.dz.v]));
    const all = tr.Multiplied(trsf);
    if (all.Form() === oc.gp_TrsfForm.gp_Identity && !f.copy) throw new FeatureError("E-BDY-NOMOVE", "Give a distance or an angle.");
    const out: Named[] = [];
    list.forEach((b, i) => {
      if (!picked.includes(i)) { out.push(b); return; }
      const t = this.transformed({ shape: b, op: "fuse" }, all, f.id, "c").shape;
      if (f.copy) { out.push(b, t); return; }
      // A move keeps the names: the body is the same one, somewhere else.
      const mk = new oc.BRepBuilderAPI_Transform_2(b.shape, all, true);
      const faces = this.sub(mk.Shape(), "FACE");
      const names = faces.map((x, k) => { const j = b.faces.findIndex(g => this.list(mk.Modified(g)).some(m => m.IsSame(x))); return j >= 0 ? b.names[j] : `${f.id}:new:${k}`; });
      out.push({ shape: mk.Shape(), faces, names });
    });
    return this.compoundOf(out);
  }

  /** Boss or cut with a feature's tool solids; the tools are kept for mirror and patterns. */
  private applyTool(f: { id: string; op: "boss" | "cut" }, tools: Named[], prev: Named | null): Named {
    let tool = tools[0];
    for (const t of tools.slice(1)) tool = this.bool("fuse", tool, t, f.id);
    this.tools.set(f.id, [{ shape: tool, op: f.op === "boss" ? "fuse" : "cut" }]);
    if (f.op === "boss") return prev ? this.bool("fuse", prev, tool, f.id) : tool;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body to cut yet.");
    const out = this.bool("cut", prev, tool, f.id);
    if (Math.abs(this.volume(out.shape) - this.volume(prev.shape)) < 1e-9) throw new FeatureError("E-FT-NOCHANGE", "The cut does not touch the body.");
    return out;
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

  /** How far the shape reaches from a point along a direction (0 when all of it is behind). */
  private reach(shape: any, from: V3, d: V3) {
    const oc = this.oc;
    const box = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, box, false);
    const a = this.xyz(box.CornerMin()), b = this.xyz(box.CornerMax());
    let r = 0;
    for (let i = 0; i < 8; i++) r = Math.max(r, dot(add([i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]], mul(from, -1)), d));
    return r;
  }

  private volume(shape: any) {
    const p = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.VolumeProperties_1(shape, p, true, false, false);
    return p.Mass();
  }

  // ---------- evaluation ----------

  /** Evaluates the document; unchanged leading features come from the cache. */
  evaluate(doc: PartDoc): { body: Named | null; statuses: FeatureStatus[]; frames: Record<string, Frame>; sketches: Record<string, SketchFeature>; curves: Record<string, V3[]> } {
    const end = doc.rollback ?? doc.features.length;
    // Sketches whose On edge curves moved with the model (FR-SK-064): later features use the moved copy.
    doc = { ...doc, features: [...doc.features] };
    const sketches: Record<string, SketchFeature> = {};
    let body: Named | null = null;
    let chain = "";
    const statuses: FeatureStatus[] = [];
    const frames: Record<string, Frame> = {};
    const failed = new Set<string>();
    const next: CacheEntry[] = [];
    this.tools = new Map();
    this.curves = new Map();
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
        if (hit.sketch) { doc.features[i] = hit.sketch; sketches[f.id] = hit.sketch; }
        if (hit.curve) this.curves.set(f.id, hit.curve);
        if (!hit.status.ok) failed.add(f.id);
        if (hit.body) body = hit.body;
        return;
      }
      let status: FeatureStatus = { id: f.id, ok: true };
      let frame: Frame | undefined;
      let moved: SketchFeature | undefined;
      if (f.suppressed) status = { id: f.id, ok: true, code: "suppressed" };
      else {
        try {
          if (featureRefs(f).features.some(p => failed.has(p))) throw new FeatureError("E-FT-PARENT", "A sketch or plane this feature uses has an error.");
          this.warning = "";
          if (f.type === "sketch") {
            frame = this.frameOf(f, body, frames);
            frames[f.id] = frame;
            moved = this.followEdges(f, body, frame) ?? undefined;
            if (moved) { doc.features[i] = moved; sketches[f.id] = moved; }
          } else if (f.type === "plane") { frame = this.refPlane(f, body, frames); frames[f.id] = frame; }
          else if (f.type === "axis") { frame = this.refAxis(f, body, frames); frames[f.id] = frame; }
          else if (f.type === "point") { frame = this.refPoint(f, body); frames[f.id] = frame; }
          else if (f.type === "csys") { frame = this.refCsys(f, body, frames); frames[f.id] = frame; }
          else if (f.type === "extrude" || f.type === "revolve") body = this.sweep(f, doc, body, frames);
          else if (f.type === "fillet" || f.type === "chamfer") body = this.round(f, body);
          else if (f.type === "shell") body = this.shell(f, body);
          else if (f.type === "draft") body = this.draft(f, body, frames);
          else if (f.type === "hole") { const h = this.hole(f, body, frames); body = h.body; frame = h.frame; frames[f.id] = frame; }
          else if (f.type === "mirror") body = this.mirror(f, doc, body, frames);
          else if (f.type === "helix") this.curves.set(f.id, this.helix(f, doc, body, frames));
          else if (f.type === "sweep") body = this.sweepAlong(f, doc, body, frames);
          else if (f.type === "loft") body = this.loft(f, doc, body, frames);
          else if (f.type === "rib") body = this.rib(f, doc, body, frames);
          else if (f.type === "split") body = this.splitLine(f, doc, body, frames);
          else if (f.type === "import") body = this.importBody(f, body);
          else if (f.type === "combine") body = this.combine(f, body);
          else if (f.type === "bsplit") body = this.splitBody(f, body, frames);
          else if (f.type === "delbody") body = this.deleteBodies(f, body);
          else if (f.type === "movebody") body = this.moveBodies(f, body, frames);
          else if (f.type === "scale") body = this.scaleBodies(f, body);
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
      next.push({ key: chain, body, status, frame: frame ?? frames[f.id], tools: this.tools.get(f.id), sketch: moved, curve: this.curves.get(f.id) });
    });
    this.cache = next;
    const curves: Record<string, V3[]> = {};
    for (const [id, c] of this.curves) curves[id] = c.pts;
    return { body, statuses, frames, sketches, curves };
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
    return { volume: vp.Mass(), area: sp.Mass(), com: this.xyz(vp.CentreOfMass()), moments: values as V3, axes: vectors as [V3, V3, V3], bodies: this.solids(body.shape) };
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
