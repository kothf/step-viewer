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
import type { HealFeature, RecognizedHole, SketchPatternFeature, CopySource, UntrimSurfFeature, IntersectFeature, IntersectRegion, Sketch3dFeature, CurveFeature, SweepSurfFeature, SweepPath, DeleteFaceFeature, MoveFaceFeature, PlaneSurfFeature, ExtrudeSurfFeature, OffsetSurfFeature, KnitFeature, ThickenFeature, ReplaceFaceFeature, RevolveSurfFeature, LoftSurfFeature, TrimSurfFeature, FillSurfFeature, ExtendSurfFeature, ScaleFeature, ImportFeature, FilletFeature, ChamferFeature, CombineFeature, IndentFeature, SplitBodyFeature, DeleteBodyFeature, MoveBodyFeature, SplitFeature, RibFeature, HelixFeature, LoftFeature, SweepFeature, AxisFeature, BodyProps, CsysFeature, CircularPatternFeature, EdgeRef, HoleFeature, FaceRef, Feature, FeatureStatus, Frame, LinearPatternFeature, LineRef, MirrorFeature, PartDoc, PlaneFeature, PlaneRef, PointFeature, ShellFeature, DraftFeature, Num, SketchFeature, ThreadFeature, V3, VertexRef, ExtrudeFeature } from "../model/types";
import { featureRefs } from "../model/doc";
import { ctxFrame } from "../model/context";
import { loopPolygon, polyArea, sketchCurves, sketchPath, sketchProfile, type ProfileFace, type Seg } from "../sketch/profile";
import { splineBezierN } from "../sketch/spline";
import { chain3d } from "../sketch/sketch3d";
import { applyExt, projectEdge, type ModelEdge } from "../sketch/external";
import { solve } from "../sketch/solver";
import { evalSheet } from "../sheetmetal/kernel";
import { SheetError, type SheetState } from "../sheetmetal/sheet";
import { isSheet } from "../sheetmetal/types";
import { evalWeld, isWeld, type WeldHost } from "../weldments/kernel";

export class FeatureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A body and the names of its faces (parallel arrays). */
export interface Named { shape: any; faces: any[]; names: string[] }

/** What a feature added or removed, so mirror and patterns can copy it: its tool solids and how each was applied. */
type Tool = { shape: Named; op: "fuse" | "cut" };
/** A curve feature's result (helix): the OCCT wire and points along it for the view. */
interface Curve { wire: any; pts: V3[] }
interface CacheEntry { key: string; body: Named | null; sheets: Named | null; status: FeatureStatus; frame?: Frame; tools?: Tool[]; sketch?: SketchFeature; curve?: Curve; regions?: IntersectRegion[]; sm?: SheetState | null }

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
  /** Regions each intersect feature found (for its panel). */
  private regions = new Map<string, IntersectRegion[]>();
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
    if ("ctx" in ref) return ctxFrame(ref.ctx);
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

  /** One B-spline edge through cubic Bézier poles (3n + 1): joined with triple knots at the chord lengths, then the interior knots dropped (the interpolant is C2). */
  private bezierEdge(bz: V3[]): any {
    const oc = this.oc;
    const n = (bz.length - 1) / 3;
    const poles = new oc.TColgp_Array1OfPnt_2(1, bz.length);
    bz.forEach((q, i) => poles.SetValue(i + 1, this.P(q)));
    const knots = new oc.TColStd_Array1OfReal_2(1, n + 1), mults = new oc.TColStd_Array1OfInteger_2(1, n + 1);
    // Knots at the chord lengths the interpolant was parametrised by, so the joins are C2 in the parameter too.
    let u = 0;
    for (let i = 0; i <= n; i++) {
      if (i) u += d3(bz[3 * i], bz[3 * i - 3]) || 1e-9;
      knots.SetValue(i + 1, u); mults.SetValue(i + 1, i === 0 || i === n ? 4 : 3);
    }
    const curve = new oc.Geom_BSplineCurve_1(poles, knots, mults, 3, false);
    for (let i = n; i >= 2; i--) curve.RemoveKnot(i, 1, 1e-7 * (1 + Math.abs(bz[0][0]) + Math.abs(bz[0][1]) + Math.abs(bz[0][2])));
    return new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(curve)).Edge();
  }

  /** An OCCT edge for a sketch curve placed on its plane (moved by `off`). */
  private segEdge(s: Seg, frame: Frame, off: V3 = [0, 0, 0]): any {
    const oc = this.oc;
    const nrm = this.D(frame.n);
    let e: any;
    if (s.kind === "line") e = new oc.BRepBuilderAPI_MakeEdge_3(this.P(this.w(frame, s.a, off)), this.P(this.w(frame, s.b, off))).Edge();
    else if (s.kind === "spline") {
      e = this.bezierEdge(s.bz.map(q => this.w(frame, q, off)));
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
      let target: Named | null = null;
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
      if (f.end === "body") {
        // Up to body: like up to next, against the picked solid only.
        if (!prev) throw new FeatureError("E-FT-NOBODY", "Up to body needs a body.");
        if (!f.upToBody) throw new FeatureError("E-FT-UPBODY", "Pick the body the extrusion goes up to.");
        const list = this.bodyList(prev);
        target = list[this.bodyIndex(list, prev, f.upToBody)];
        d1 = this.reach(target.shape, add(frame.o, so), mul(frame.n, dir)) + 1; d2 = 0;
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
        if (f.end === "body") t = this.upToNext(t, target!, f, add(frame.o, so), mul(frame.n, dir), d1);
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

  /** `a` minus a tool solid whose faces are named `<fid>:t<i>` (assembly features, FR-ASM-027). */
  cutBy(a: Named, tool: any, fid: string): Named {
    const faces = this.sub(tool, "FACE");
    return this.bool("cut", a, { shape: tool, faces, names: faces.map((_f, i) => `${fid}:t${i}`) }, fid);
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
    if (f.type === "chamfer" && f.mode === "vertex") return this.vertexChamfer(f, prev);
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
        else if (mode === "offset") mk.Add_2(this.offsetChamfer(prev, e, f.edges[i], size), e);
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
    if (f.type === "fillet" && f.setbacks?.length) return this.setbackCorners(f, prev, out, edges, used, (i: number) => Math.max(radV(i), rad2(i)));
    return out;
  }

  /**
   * Setback fillets (FR-FT-033): at each picked corner the fillets of the edges meeting there are cut
   * by planes square to the edges `d` mm from the vertex; the fillet pieces inside and the corner blend
   * are taken out and the opening is filled with one patch (BRepOffsetAPI_MakeFilling) tangent to the
   * faces around it, named `fid:setback:k`.
   */
  private setbackCorners(f: FilletFeature, prev: Named, body: Named, edges: any[], used: number[], rad: (i: number) => number): Named {
    const oc = this.oc;
    const corners = (f.setbacks ?? []).map((s, k) => {
      if ("point" in s.v) throw new FeatureError("E-FT-VERTEX", "Pick a vertex of the body.");
      if (!(s.d > 1e-6)) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
      // The corner: the end of a filleted edge nearest the click (the clicked edge may be one the preview made).
      const at = s.v.at;
      let vtx: any = null, best = Infinity;
      for (const i of used) for (const x of [oc.TopExp.FirstVertex(edges[i], false), oc.TopExp.LastVertex(edges[i], false)]) {
        const dd = d3(this.xyz(oc.BRep_Tool.Pnt(x)), at);
        if (dd < best) { best = dd; vtx = x; }
      }
      if (!vtx) throw new FeatureError("E-FT-SETBACK3", "A setback needs a corner where three or more filleted edges meet.");
      const o = this.xyz(oc.BRep_Tool.Pnt(vtx));
      const legs: { i: number; p: V3; t: V3 }[] = [];
      for (const i of used) {
        const e = edges[i];
        // Vertices in curve order (not the edge's orientation), so they match the parameters.
        const first = oc.TopExp.FirstVertex(e, false).IsSame(vtx);
        if (!first && !oc.TopExp.LastVertex(e, false).IsSame(vtx)) continue;
        const c = new oc.BRepAdaptor_Curve_2(e);
        const u0 = first ? c.FirstParameter() : c.LastParameter();
        const len = oc.GCPnts_AbscissaPoint.Length_7(c, c.FirstParameter(), c.LastParameter(), 1e-7);
        if (s.d >= len - 1e-6) throw new FeatureError("E-FT-SETBACK", "The setback is longer than an edge at the corner.");
        const u = new oc.GCPnts_AbscissaPoint_2(c, first ? s.d : -s.d, u0).Parameter();
        const p = new oc.gp_Pnt_1(), v = new oc.gp_Vec_1();
        c.D1(u, p, v);
        legs.push({ i, p: this.xyz(p), t: mul(unit(this.xyz(v)), first ? 1 : -1) });
      }
      if (legs.length < 3) throw new FeatureError("E-FT-SETBACK3", "A setback needs a corner where three or more filleted edges meet.");
      return { k, o, d: s.d, legs, reach: s.d + 2 * Math.max(...legs.map(l => rad(l.i))) };
    });
    // Cut the fillet faces of every leg where its plane crosses them.
    const big = this.size(body.shape) * 2 + 100;
    const seq = new oc.TopTools_SequenceOfShape_1();
    for (const c of corners) for (const l of c.legs) {
      const pl = new oc.BRepBuilderAPI_MakeFace_9(new oc.gp_Pln_3(this.P(l.p), this.D(l.t)), -big, big, -big, big).Face();
      body.faces.forEach((x, j) => {
        if (body.names[j] !== `${f.id}:fillet:${l.i}`) return;
        const sec = new oc.BRepAlgoAPI_Section_3(x, pl, false);
        sec.ComputePCurveOn1(true);
        sec.Approximation(true);
        sec.Build(new oc.Message_ProgressRange_1());
        if (sec.IsDone()) for (const e of this.sub(sec.Shape(), "EDGE")) if (d3(this.edgeMid(e), c.o) < c.reach) seq.Append_1(e);
      });
    }
    if (seq.Length()) {
      const sp = new oc.BRepFeat_SplitShape_2(body.shape);
      sp.Add_1(seq);
      sp.Build(new oc.Message_ProgressRange_1());
      if (!sp.IsDone()) throw new FeatureError("E-FT-SETBACK", "The corner could not be set back.");
      body = this.carry(sp, [body], sp.Shape(), f.id);
    }
    // The faces inside each corner: made by the fillet, on the vertex side of every leg's plane.
    const old = new Set(prev.names);
    const gone = new Set<number>();
    const loops: { k: number; faces: number[] }[] = corners.map(c => {
      const faces: number[] = [];
      body.faces.forEach((x, j) => {
        if (old.has(body.names[j]) || gone.has(j)) return;
        const m = this.centroid(x);
        if (d3(m, c.o) < c.reach && c.legs.every(l => dot(sub3(m, l.p), l.t) < 0)) { faces.push(j); gone.add(j); }
      });
      if (!faces.length) throw new FeatureError("E-FT-SETBACK", "The corner could not be set back.");
      return { k: c.k, faces };
    });
    // Each opening filled with a patch tangent to the faces around it.
    const patches: Named[] = [];
    for (const lp of loops) {
      const bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
      bb.MakeCompound(comp);
      for (const j of lp.faces) bb.Add(comp, body.faces[j]);
      const wires = this.subWires(new oc.ShapeAnalysis_FreeBounds_3(comp, false, false, false).GetClosedWires());
      if (wires.length !== 1) throw new FeatureError("E-FT-SETBACK", "The corner could not be set back.");
      const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
      for (const e of this.sub(wires[0], "EDGE")) {
        const j = body.faces.findIndex((x, q) => !gone.has(q) && this.sub(x, "EDGE").some(g => g.IsSame(e)));
        if (j >= 0) mk.Add_2(e, body.faces[j], oc.GeomAbs_Shape.GeomAbs_G1, true);
        else mk.Add_1(e, oc.GeomAbs_Shape.GeomAbs_C0, true);
      }
      try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
      if (!mk.IsDone()) throw new FeatureError("E-FT-SETBACK", "The corner could not be set back.");
      const faces = this.sub(mk.Shape(), "FACE");
      patches.push({ shape: mk.Shape(), faces, names: faces.map((_, q) => `${f.id}:setback:${lp.k}${q ? `:${q}` : ""}`) });
    }
    // Sew the kept faces and the patches back into solids.
    const sew = new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
    const kept = body.faces.map((x, j) => ({ x, name: body.names[j] })).filter((_x, j) => !gone.has(j));
    for (const k of kept) sew.Add(k.x);
    for (const p of patches) sew.Add(p.shape);
    sew.Perform(new oc.Message_ProgressRange_1());
    const sewn = sew.SewedShape();
    const bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
    bb.MakeCompound(comp);
    let open = 0;
    for (const ex = new oc.TopExp_Explorer_2(sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const sh = oc.TopoDS.Shell_1(ex.Current());
      if (!oc.BRep_Tool.IsClosed_1(sh)) { open++; continue; }
      let solid = new oc.ShapeFix_Solid_1().SolidFromShell(sh);
      if (this.volume(solid) < 0) solid = solid.Reversed();
      bb.Add(comp, solid);
    }
    if (open || this.solids(comp) !== this.solids(body.shape)) throw new FeatureError("E-FT-SETBACK", "The corner could not be set back.");
    const shape = this.solids(comp) === 1 ? new oc.TopExp_Explorer_2(comp, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE).Current() : comp;
    // Names: by identity through the sewing, else the nearest centroid.
    const map: [any, string, V3][] = [...kept.map(k => [k.x, k.name] as [any, string]), ...patches.flatMap(p => p.faces.map((x, q) => [x, p.names[q]] as [any, string]))]
      .map(([x, n]) => [sew.IsModified(x) ? sew.Modified(x) : x, n, this.centroid(x)] as [any, string, V3]);
    const faces = this.sub(shape, "FACE");
    let q = 0;
    const names = faces.map(x => {
      const hit = map.find(([g]) => g.IsSame(x));
      if (hit) return hit[1];
      const c = this.centroid(x);
      let best: [any, string, V3] | null = null;
      for (const e of map) if (!best || d3(e[2], c) < d3(best[2], c)) best = e;
      return best && d3(best[2], c) < 1e-2 * (1 + this.size(x)) ? best[1] : `${f.id}:new:${q++}`;
    });
    return { shape, faces, names };
  }

  /** A stable key for an edge: the sorted names of the faces that hold it. */
  private edgeKey(body: Named, e: any): string {
    const names: string[] = [];
    body.faces.forEach((x, i) => { if (this.sub(x, "EDGE").some(y => y.IsSame(e))) names.push(body.names[i]); });
    return names.sort().join("|");
  }

  /** The outward normal of a face at a point on it (orientation-corrected). */
  private normalNear(face: any, p: V3): V3 {
    const oc = this.oc;
    const uv = new oc.ShapeAnalysis_Surface(oc.BRep_Tool.Surface_2(face)).ValueOfUV(this.P(p), 1e-6);
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    const q = new oc.gp_Pnt_1(), du = new oc.gp_Vec_1(), dv = new oc.gp_Vec_1();
    ad.D1(uv.X(), uv.Y(), q, du, dv);
    const n = unit(cross(this.xyz(du), this.xyz(dv)));
    return face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? mul(n, -1) : n;
  }

  /**
   * Offset face chamfer (FR-FT-041): both faces move in by `d`; the chamfer runs where their offsets
   * meet, so on each face it is d / tan(θ/2) from the edge (θ = the angle between the faces, in the
   * material). Measured at the middle of the edge.
   */
  private offsetChamfer(prev: Named, e: any, r: EdgeRef, d: number): number {
    const oc = this.oc;
    const c = new oc.BRepAdaptor_Curve_2(e);
    const mid = this.xyz(c.Value((c.FirstParameter() + c.LastParameter()) / 2));
    const n1 = this.normalNear(this.faceOfEdge(prev, e, r.faces[0]), mid), n2 = this.normalNear(this.faceOfEdge(prev, e, r.faces[1]), mid);
    // φ = turn between the outward normals; the faces meet at θ = π − φ, and tan(φ/2) = 1 / tan(θ/2).
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
    if (phi < 1e-3 || phi > Math.PI - 1e-3) throw new FeatureError("E-FT-CHAMFER", "An offset face chamfer needs faces that meet at an angle.");
    return d * Math.tan(phi / 2);
  }

  /**
   * Vertex chamfer (FR-FT-041): at each picked corner of three straight edges, the corner is cut off by
   * the plane through the points at distances 1, 2 and 3 along them (the clicked edge first, then the
   * others in name order). The new faces are `fid:vertex:k`.
   */
  private vertexChamfer(f: ChamferFeature, prev: Named): Named {
    const oc = this.oc;
    const vs = f.vertices ?? [];
    if (!vs.length) throw new FeatureError("E-FT-NOVERTEX", "Pick at least one vertex.");
    const ds = [f.distance.v, f.distance2?.v ?? f.distance.v, f.distance3?.v ?? f.distance.v];
    if (ds.some(x => !(x > 1e-6))) throw new FeatureError("E-FT-ZERO", "The size must be more than 0.");
    let body = prev;
    vs.forEach((vr, k) => {
      if ("point" in vr) throw new FeatureError("E-FT-VERTEX", "Pick a vertex of the body.");
      const clicked = this.resolveEdge(body, vr.edge);
      const ends = [oc.TopExp.FirstVertex(clicked, true), oc.TopExp.LastVertex(clicked, true)];
      const vtx = d3(this.xyz(oc.BRep_Tool.Pnt(ends[0])), vr.at) <= d3(this.xyz(oc.BRep_Tool.Pnt(ends[1])), vr.at) ? ends[0] : ends[1];
      const o = this.xyz(oc.BRep_Tool.Pnt(vtx));
      const at: any[] = [];
      for (const e of this.sub(body.shape, "EDGE")) {
        if (oc.BRep_Tool.Degenerated(e) || at.some(x => x.IsSame(e))) continue;
        if (oc.TopExp.FirstVertex(e, true).IsSame(vtx) || oc.TopExp.LastVertex(e, true).IsSame(vtx)) at.push(e);
      }
      if (at.length !== 3) throw new FeatureError("E-FT-VERTEX3", "A vertex chamfer needs a corner where exactly three edges meet.");
      const key = (e: any) => (e.IsSame(clicked) ? "" : this.edgeKey(body, e));
      at.sort((a, b) => key(a).localeCompare(key(b)));
      const pts = at.map((e, i) => {
        const c = new oc.BRepAdaptor_Curve_2(e);
        if (c.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) throw new FeatureError("E-FT-VERTEX3", "A vertex chamfer needs a corner where exactly three edges meet.");
        const a = this.xyz(c.Value(c.FirstParameter())), b = this.xyz(c.Value(c.LastParameter()));
        const far = d3(a, o) < d3(b, o) ? b : a, len = d3(far, o);
        if (ds[i] >= len - 1e-6) throw new FeatureError("E-FT-CHAMFER", `The chamfer ${ds[i]} mm is too large for the selected edges.`);
        return add(o, mul(unit(add(far, mul(o, -1))), ds[i]));
      });
      // The corner: a ruled loft from the triangle to the vertex (a tetrahedron).
      const poly = new oc.BRepBuilderAPI_MakePolygon_1();
      for (const p of pts) poly.Add_1(this.P(p));
      poly.Close();
      const mk = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
      mk.AddWire(poly.Wire());
      mk.AddVertex(new oc.BRepBuilderAPI_MakeVertex(this.P(o)).Vertex());
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new FeatureError("E-FT-CHAMFER", "The corner could not be chamfered.");
      let tool = mk.Shape();
      if (this.volume(tool) < 0) tool = tool.Reversed();
      const c = mul(add(add(pts[0], pts[1]), add(pts[2], o)), 0.25);
      if (new oc.BRepClass3d_SolidClassifier_3(body.shape, this.P(c), 1e-7).State() !== oc.TopAbs_State.TopAbs_IN)
        throw new FeatureError("E-FT-VCONCAVE", "A vertex chamfer works on outside corners.");
      const tri = mk.FirstShape();
      const faces = this.sub(tool, "FACE");
      const named: Named = { shape: tool, faces, names: faces.map(x => (x.IsSame(tri) ? `${f.id}:vertex:${k}` : `${f.id}:vside:${k}`)) };
      body = this.bool("cut", body, named, f.id);
    });
    return body;
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
    let out: Named = { shape: result, faces, names: names.map(x => x ?? `${f.id}:new:${n++}`) };
    // Multi-thickness (FR-FT-060): each picked wall's offset face moves by its own thickness minus the
    // shell's, out of the material (thicker) or into it (thinner); the walls next to it grow to meet it.
    (f.multi ?? []).forEach((r, i) => {
      if (!(r.t > 1e-6)) throw new FeatureError("E-FT-ZERO", "The thickness must be more than 0.");
      if (f.faces.some(x => x.name === r.name)) throw new FeatureError("E-SH-MULTI", "A face to remove cannot have its own thickness.");
      const wall = `${f.id}:off:${r.name}`;
      const j = out.names.indexOf(wall);
      if (j < 0) throw new FeatureError("E-SH-MULTI", "A multi-thickness face has no wall of its own.");
      if (!this.facePlane(out.faces[j])) throw new FeatureError("E-SH-FLAT", "Multi-thickness faces must be flat.");
      const delta = r.t - t;
      if (Math.abs(delta) < 1e-9) return;
      out = this.moveFaces({ id: `${f.id}:m${i}`, type: "moveface", name: "", faces: [{ name: wall }], distance: { v: Math.abs(delta) }, flip: delta < 0 }, out, {});
    });
    return out;
  }

  /** Delete face (FR-FT-101): BRepAlgoAPI_Defeaturing removes the faces and extends their neighbours to close the gap. */
  private deleteFaces(f: DeleteFaceFeature, prev: Named | null): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.faces.length) throw new FeatureError("E-FT-NOFACES", "Click the faces to delete.");
    const mk = new oc.BRepAlgoAPI_Defeaturing();
    mk.SetShape(prev.shape);
    for (const r of f.faces) mk.AddFaceToRemove(this.resolveFace(prev, r));
    mk.SetToFillHistory(true);
    try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    if (!mk.IsDone() || mk.HasErrors()) throw new FeatureError("E-FT-DELFACE", "The faces could not be deleted: the faces around them cannot be extended to close the gap.");
    return this.carry(mk, [prev], mk.Shape(), f.id);
  }

  /**
   * Move face (FR-FT-101), offset: each flat face is pushed out along its normal (a prism of the face
   * fused on) or pulled in (a prism cut away). The moved face keeps its name; the new side faces are `fid:side:k`.
   */
  private moveFaces(f: MoveFaceFeature, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.faces.length) throw new FeatureError("E-FT-NOFACES", "Click the faces to move.");
    if (f.mode === "rotate") return this.rotateFaces(f, prev, frames);
    const tr = f.mode === "translate";
    const d = f.distance.v;
    const vec: V3 = [f.dx?.v ?? 0, f.dy?.v ?? 0, f.dz?.v ?? 0];
    if (tr ? !(Math.hypot(...vec) > 1e-6) : !(d > 1e-6)) throw new FeatureError("E-FT-ZERO", "The distance must be more than 0.");
    let body = prev, k = 0;
    for (const r of f.faces) {
      const face = this.resolveFace(body, r), pl = this.facePlane(face);
      if (!pl) throw new FeatureError("E-FT-MOVEFLAT", "Move face works on flat faces.");
      // Translate: only the move along the normal changes a flat face (its neighbours grow with it).
      const along = tr ? dot(vec, pl.n) : f.flip ? -d : d;
      if (Math.abs(along) < 1e-9) continue;
      const dir = mul(pl.n, along);
      const mk = new oc.BRepPrimAPI_MakePrism_1(face, this.V(dir), false, true);
      if (!mk.IsDone()) throw new FeatureError("E-FT-MOVEFACE", "The face could not be moved.");
      let tool = mk.Shape();
      if (this.volume(tool) < 0) tool = tool.Reversed();
      const top = mk.LastShape();
      const faces = this.sub(tool, "FACE");
      const named: Named = { shape: tool, faces, names: faces.map(x => (x.IsSame(top) ? r.name : `${f.id}:side:${k++}`)) };
      // The original face goes inside (fuse) or is cut away; its name moves to the prism's far end.
      const rest: Named = { shape: body.shape, faces: body.faces, names: body.names.map((n, i) => (body.faces[i].IsSame(face) ? `${f.id}:old` : n)) };
      body = this.mergeSides(this.bool(along < 0 ? "cut" : "fuse", rest, named, f.id), f.id);
    }
    if (body === prev) throw new FeatureError("E-MVF-PARALLEL", "The move is parallel to the faces, so it changes nothing.");
    return body;
  }

  /** Move face, rotate: each flat face turns about an axis in its plane, as a draft hinged on that axis. */
  private rotateFaces(f: MoveFaceFeature, prev: Named, frames: Record<string, Frame>): Named {
    const a = f.angle?.v ?? 0;
    if (!(Math.abs(a) > 1e-6) || Math.abs(a) >= Math.PI / 2 - 1e-3) throw new FeatureError("E-MVF-ANGLE", "The angle must be between 0° and 90°.");
    const ax = this.lineOf(f.axis, prev, frames, "an axis to rotate about");
    const tol = 1e-6 * (1 + this.size(prev.shape));
    let body = prev;
    for (const r of f.faces) {
      const face = this.resolveFace(body, r), pl = this.facePlane(face);
      if (!pl) throw new FeatureError("E-FT-MOVEFLAT", "Move face works on flat faces.");
      if (Math.abs(dot(ax.d, pl.n)) > 1e-6 || Math.abs(dot(add(ax.o, mul(pl.p, -1)), pl.n)) > tol) throw new FeatureError("E-MVF-AXIS", "The axis must lie in the plane of each face: pick an edge of the face.");
      // Pull square to the axis in the face's plane: the face is parallel to it, so the draft turns it about the axis.
      const pull = unit(cross(ax.d, pl.n));
      body = this.applyDraft(body, [face], pull, f.flip ? -a : a, ax.o, f.id);
    }
    return body;
  }

  // ---------- surfaces (FRS 9.11, FR-FT-100) ----------

  /** The surface bodies: each child of the sheets compound, with its face names. */
  private sheetList(sheets: Named | null): Named[] {
    if (!sheets) return [];
    const oc = this.oc, out: Named[] = [];
    for (const it = new oc.TopoDS_Iterator_2(sheets.shape, true, true); it.More(); it.Next()) {
      const s = it.Value();
      const faces = this.sub(s, "FACE");
      out.push({ shape: s, faces, names: faces.map((x, i) => { const j = sheets.faces.findIndex(g => g.IsSame(x)); return j >= 0 ? sheets.names[j] : `?:${i}`; }) });
    }
    return out;
  }

  /** Surface bodies back into the sheets compound (always a compound, so each child is one surface body). */
  private sheetsOf(parts: Named[]): Named | null {
    if (!parts.length) return null;
    const oc = this.oc, bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
    bb.MakeCompound(comp);
    for (const p of parts) bb.Add(comp, p.shape);
    return { shape: comp, faces: parts.flatMap(p => p.faces), names: parts.flatMap(p => p.names) };
  }

  /** The connected pieces of a sewn shape (shells, then faces outside them), each named by `nameOf`. */
  private sheetParts(shape: any, nameOf: (face: any, k: number) => string): Named[] {
    const oc = this.oc, A = oc.TopAbs_ShapeEnum, out: Named[] = [];
    let k = 0;
    const add = (s: any) => { const faces = this.sub(s, "FACE"); out.push({ shape: s, faces, names: faces.map(x => nameOf(x, k++)) }); };
    for (const ex = new oc.TopExp_Explorer_2(shape, A.TopAbs_SHELL, A.TopAbs_SHAPE); ex.More(); ex.Next()) add(ex.Current());
    for (const ex = new oc.TopExp_Explorer_2(shape, A.TopAbs_FACE, A.TopAbs_SHELL); ex.More(); ex.Next()) add(ex.Current());
    return out;
  }

  /** A face picked on a surface body or a solid. */
  private resolveAny(body: Named | null, sheets: Named | null, ref: FaceRef): any {
    return sheets && sheets.names.includes(ref.name) ? this.resolveFace(sheets, ref) : this.resolveFace(body, ref);
  }

  /** Which surface body holds a picked face. */
  private sheetIndex(list: Named[], sheets: Named | null, ref: FaceRef): number {
    if (!sheets || !sheets.names.includes(ref.name)) throw new FeatureError("E-SRF-PICK", "Pick a face of a surface body.");
    const face = this.resolveFace(sheets, ref);
    const i = list.findIndex(b => b.faces.some(x => x.IsSame(face)));
    if (i < 0) throw new FeatureError("E-TN-LOST", `Reference lost: face ${ref.name}`);
    return i;
  }

  /** Planar surface: the sketch's closed regions become flat surface bodies. */
  private planeSurf(f: PlaneSurfFeature, doc: PartDoc, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Named | null {
    const { sk, frame } = this.sketchOf(f.sketch, doc, body, frames, "a sketch with a closed contour");
    const { faces } = this.profileFaces(sk, frame);
    if (!faces.length) throw new FeatureError("E-SRF-EMPTY", "The sketch has no closed contour.");
    return this.sheetsOf([...this.sheetList(sheets), ...faces.map((x, k) => ({ shape: x, faces: [x], names: [`${f.id}:face:${k}`] }))]);
  }

  /** Extruded surface: every sketch curve swept along the normal; touching sheets are sewn into one surface body. */
  private extSurf(f: ExtrudeSurfFeature, doc: PartDoc, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Named | null {
    const oc = this.oc;
    const { sk, frame } = this.sketchOf(f.sketch, doc, body, frames, "a sketch");
    const segs = sketchCurves(sk);
    if (!segs.length) throw new FeatureError("E-SRF-EMPTY", "The sketch has no curves.");
    const d = f.depth.v;
    if (!(d > 1e-6)) throw new FeatureError("E-FT-ZERO", "The depth must be more than 0.");
    const dir = mul(frame.n, f.flip ? -1 : 1);
    const off: V3 = f.mid ? mul(dir, -d / 2) : [0, 0, 0];
    const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
    const pieces: [any, string][] = [];
    for (const sg of segs) {
      const prism = new oc.BRepPrimAPI_MakePrism_1(this.segEdge(sg, frame, off), this.V(mul(dir, d)), false, true).Shape();
      for (const x of this.sub(prism, "FACE")) pieces.push([x, sg.ent]);
      sew.Add(prism);
    }
    sew.Perform(new oc.Message_ProgressRange_1());
    const res = sew.SewedShape();
    const after = pieces.map(([x, ent]) => [sew.IsModified(x) ? sew.Modified(x) : x, ent] as [any, string]);
    const parts = this.sheetParts(res, (x, k) => { const p = after.find(([g]) => g.IsSame(x)); return p ? `${f.id}:side:${p[1]}` : `${f.id}:new:${k}`; });
    return this.sheetsOf([...this.sheetList(sheets), ...parts]);
  }

  /** Offset surface: the picked faces (sewn where they touch) offset along their normals, or copied at 0. */
  private offSurf(f: OffsetSurfFeature, body: Named | null, sheets: Named | null): Named | null {
    const oc = this.oc;
    if (!f.faces.length) throw new FeatureError("E-NOFACES", "Click the faces to offset.");
    const src = f.faces.map(r => [this.resolveAny(body, sheets, r), r.name] as [any, string]);
    const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
    for (const [x] of src) sew.Add(x);
    sew.Perform(new oc.Message_ProgressRange_1());
    const joined = sew.SewedShape();
    const mid = src.map(([x, n]) => [sew.IsModified(x) ? sew.Modified(x) : x, n] as [any, string]);
    const d = f.distance.v * (f.flip ? -1 : 1);
    let mk: any;
    if (Math.abs(d) < 1e-9) mk = new oc.BRepBuilderAPI_Copy_2(joined, true, false);
    else {
      mk = new oc.BRepOffsetAPI_MakeOffsetShape();
      try { mk.PerformBySimple(joined, d); } catch { /* reported below */ }
    }
    if (!mk.IsDone()) throw new FeatureError("E-SRF-OFFSET", "The faces could not be offset: try a smaller distance.");
    const res = mk.Shape();
    const map: [any, string][] = [];
    for (const [x, n] of mid) for (const m of this.list(mk.Modified(x))) map.push([m, n]);
    // The simple offset keeps no history but builds the faces in the input's order.
    const inF = this.sub(joined, "FACE"), outF = this.sub(res, "FACE");
    if (!map.length && inF.length === outF.length) inF.forEach((x, i) => { const n = mid.find(([g]) => g.IsSame(x))?.[1]; if (n) map.push([outF[i], n]); });
    const parts = this.sheetParts(res, (x, k) => { const p = map.find(([g]) => g.IsSame(x)); return p ? `${f.id}:off:${p[1]}` : `${f.id}:new:${k}`; });
    if (!parts.length) throw new FeatureError("E-SRF-OFFSET", "The faces could not be offset: try a smaller distance.");
    return this.sheetsOf([...this.sheetList(sheets), ...parts]);
  }

  /** Knit: sews surface bodies into one; with `solid`, a closed result becomes a new solid body. */
  private knit(f: KnitFeature, body: Named | null, sheets: Named | null): { body: Named | null; sheets: Named | null } {
    const oc = this.oc;
    const list = this.sheetList(sheets);
    const idx = [...new Set(f.surfaces.map(r => this.sheetIndex(list, sheets, r)))];
    if (idx.length < (f.solid ? 1 : 2)) throw new FeatureError("E-KNIT-PICK", "Pick two or more surface bodies.");
    const tol = f.tol.v;
    if (!(tol > 0)) throw new FeatureError("E-FT-ZERO", "The tolerance must be more than 0.");
    const sew = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
    for (const i of idx) sew.Add(list[i].shape);
    sew.Perform(new oc.Message_ProgressRange_1());
    const res = sew.SewedShape();
    const map: [any, string][] = idx.flatMap(i => list[i].faces.map((x, j) => [sew.IsModified(x) ? sew.Modified(x) : x, list[i].names[j]] as [any, string]));
    const nameOf = (x: any, k: number) => map.find(([g]) => g.IsSame(x))?.[1] ?? `${f.id}:new:${k}`;
    const rest = list.filter((_, i) => !idx.includes(i));
    if (!f.solid) {
      const parts = this.sheetParts(res, nameOf);
      if (parts.length >= idx.length) throw new FeatureError("E-KNIT-GAP", "The surfaces do not meet: no edges were joined. Try a larger tolerance.");
      return { body, sheets: this.sheetsOf([...rest, ...parts]) };
    }
    const shells = this.sheetParts(res, nameOf);
    const solids: Named[] = [];
    for (const sh of shells) {
      if (sh.shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL || !oc.BRep_Tool.IsClosed_1(sh.shape)) throw new FeatureError("E-KNIT-OPEN", "The knitted surfaces do not close a volume, so no solid can be made. Try a larger tolerance.");
      let solid = new oc.ShapeFix_Solid_1().SolidFromShell(oc.TopoDS.Shell_1(sh.shape));
      if (this.volume(solid) < 0) solid = solid.Reversed();
      const faces = this.sub(solid, "FACE");
      solids.push({ shape: solid, faces, names: faces.map((x, k) => { const j = sh.faces.findIndex(g => g.IsSame(x)); return j >= 0 ? sh.names[j] : `${f.id}:new:${k}`; }) });
    }
    return { body: body ? this.compoundOf([...this.bodyList(body), ...solids]) : this.compoundOf(solids), sheets: this.sheetsOf(rest) };
  }

  /** Thicken: a surface body grown into a solid to one side, the other or both; merged with the solids unless `merge` is false. */
  private thicken(f: ThickenFeature, body: Named | null, sheets: Named | null): { body: Named | null; sheets: Named | null } {
    const oc = this.oc;
    if (!f.surface) throw new FeatureError("E-THK-PICK", "Pick the surface to thicken.");
    const list = this.sheetList(sheets);
    const i = this.sheetIndex(list, sheets, f.surface);
    const t = f.thickness.v;
    if (!(t > 1e-6)) throw new FeatureError("E-FT-ZERO", "The thickness must be more than 0.");
    let src = list[i];
    if (f.side === "both") {
      const off = new oc.BRepOffsetAPI_MakeOffsetShape();
      try { off.PerformBySimple(src.shape, -t / 2); } catch { /* reported below */ }
      if (!off.IsDone()) throw new FeatureError("E-THK-FAIL", "The surface could not be thickened: try a smaller thickness.");
      const shape = off.Shape(), faces = this.sub(shape, "FACE");
      const map = src.faces.flatMap((x, j) => this.list(off.Modified(x)).map(m => [m, src.names[j]] as [any, string]));
      if (!map.length && faces.length === src.faces.length) faces.forEach((x, k) => map.push([x, src.names[k]]));
      src = { shape, faces, names: faces.map((x, k) => map.find(([g]) => g.IsSame(x))?.[1] ?? `${f.id}:mid:${k}`) };
    }
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    try { mk.MakeThickSolidBySimple(src.shape, f.side === "other" ? -t : t); } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-THK-FAIL", "The surface could not be thickened: try a smaller thickness.");
    let shape = mk.Shape();
    if (this.volume(shape) < 0) shape = shape.Reversed();
    if (this.solids(shape) < 1 || Math.abs(this.volume(shape)) < 1e-9) throw new FeatureError("E-THK-FAIL", "The surface could not be thickened: try a smaller thickness.");
    const faces = this.sub(shape, "FACE");
    const names: (string | null)[] = faces.map(() => null);
    src.faces.forEach((x, j) => {
      const k = faces.findIndex(g => g.IsSame(x));
      if (k >= 0) names[k] = src.names[j];
      for (const m of [...this.list(mk.Modified(x)), ...this.list(mk.Generated(x))]) {
        const q = faces.findIndex(g => g.IsSame(m));
        if (q >= 0 && !names[q]) names[q] = k >= 0 ? `${f.id}:off:${src.names[j]}` : src.names[j];
      }
    });
    let n = 0;
    const solid: Named = { shape, faces, names: names.map(x => x ?? `${f.id}:new:${n++}`) };
    const rest = this.sheetsOf(list.filter((_, j) => j !== i));
    if (!body) return { body: solid, sheets: rest };
    return { body: f.merge === false ? this.compoundOf([...this.bodyList(body), solid]) : this.bool("fuse", body, solid, f.id), sheets: rest };
  }

  /** Revolved surface: each sketch curve but the axis turned about it; touching sheets are sewn into one surface body. */
  private revSurf(f: RevolveSurfFeature, doc: PartDoc, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Named | null {
    const oc = this.oc;
    const { sk, frame } = this.sketchOf(f.sketch, doc, body, frames, "a sketch");
    const ax = sk.ents.find(e => e.id === f.axis);
    if (!ax || ax.t !== "line") throw new FeatureError("E-FT-AXIS", "Pick a line of the sketch as the axis.");
    const pa = sk.ents.find(e => e.id === ax.a), pb = sk.ents.find(e => e.id === ax.b);
    if (!pa || pa.t !== "point" || !pb || pb.t !== "point") throw new FeatureError("E-FT-AXIS", "The axis line is broken.");
    const A = this.w(frame, [pa.x, pa.y]), B = this.w(frame, [pb.x, pb.y]);
    const dirV = sub3(B, A);
    if (Math.hypot(...dirV) < 1e-9) throw new FeatureError("E-FT-AXIS", "The axis line has no length.");
    const angle = Math.min(f.angle.v, 2 * Math.PI);
    if (!(angle > 1e-9)) throw new FeatureError("E-FT-ZERO", "The angle must be more than 0.");
    const segs = sketchCurves(sk).filter(sg => sg.ent !== f.axis);
    if (!segs.length) throw new FeatureError("E-SRF-EMPTY", "The sketch has no curves.");
    const axis = new oc.gp_Ax1_2(this.P(A), this.D(mul(dirV, f.flip ? -1 : 1)));
    const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
    const pieces: [any, string][] = [];
    for (const sg of segs) {
      const mk = new oc.BRepPrimAPI_MakeRevol_1(this.segEdge(sg, frame), axis, angle, false);
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The revolve failed. Is the profile crossing the axis?");
      const sh = mk.Shape();
      for (const x of this.sub(sh, "FACE")) pieces.push([x, sg.ent]);
      sew.Add(sh);
    }
    sew.Perform(new oc.Message_ProgressRange_1());
    const after = pieces.map(([x, ent]) => [sew.IsModified(x) ? sew.Modified(x) : x, ent] as [any, string]);
    const parts = this.sheetParts(sew.SewedShape(), (x, k) => { const p = after.find(([g]) => g.IsSame(x)); return p ? `${f.id}:side:${p[1]}` : `${f.id}:new:${k}`; });
    return this.sheetsOf([...this.sheetList(sheets), ...parts]);
  }

  /** Lofted surface: ThruSections without caps through each profile's chain of curves. */
  private loftSurf(f: LoftSurfFeature, doc: PartDoc, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Named | null {
    const oc = this.oc;
    if (f.profiles.length < 2) throw new FeatureError("E-LOFT-PROFILES", "Pick two or more profile sketches.");
    const mk = new oc.BRepOffsetAPI_ThruSections(false, !!f.ruled, 1e-6);
    let firstEdges: [any, string][] = [];
    let closed: boolean | null = null;
    f.profiles.forEach((id, k) => {
      const { sk, frame } = this.sketchOf(id, doc, body, frames, "the profile sketches");
      const path = sketchPath(sk);
      if (path.error) throw new FeatureError("E-LOFT-PROFILE", "Each surface loft profile must be one chain of curves.");
      if (closed != null && closed !== path.closed) throw new FeatureError("E-LOFT-MIX", "The profiles must be all open or all closed.");
      closed = path.closed;
      const w = new oc.BRepBuilderAPI_MakeWire_1();
      const edges = path.segs.map(sg => [this.segEdge(sg, frame), sg.ent] as [any, string]);
      for (const [e] of edges) w.Add_1(e);
      if (!w.IsDone()) throw new FeatureError("E-LOFT-PROFILE", "Each surface loft profile must be one chain of curves.");
      if (k === 0) firstEdges = edges;
      mk.AddWire(w.Wire());
    });
    mk.CheckCompatibility(true);
    try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles twist, or cross each other?");
    const shape = mk.Shape();
    const named: [any, string][] = [];
    for (const [e, ent] of firstEdges) {
      let g: any = null;
      try { g = mk.GeneratedFace(e); } catch { g = null; }
      if (g && !g.IsNull()) named.push([g, ent]);
    }
    const parts = this.sheetParts(shape, (x, k) => { const p = named.find(([g]) => g.IsSame(x)); return p ? `${f.id}:side:${p[1]}` : `${f.id}:new:${k}`; });
    return this.sheetsOf([...this.sheetList(sheets), ...parts]);
  }

  /** Swept surface (FR-FT-100): the profile sketch's chain of curves moved along the path, no caps. */
  private sweepSurf(f: SweepSurfFeature, doc: PartDoc, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Named | null {
    const oc = this.oc;
    const spine = this.pathWire(f.path, doc, body, frames);
    const { sk, frame } = this.sketchOf(f.profile, doc, body, frames, "a profile sketch");
    const p = sketchPath(sk);
    if (p.error) throw new FeatureError("E-SWS-PROFILE", "The profile must be one chain of curves, open or closed.");
    const mw = new oc.BRepBuilderAPI_MakeWire_1();
    const edgeEnt: [any, string][] = [];
    for (const sg of p.segs) { const e = this.segEdge(sg, frame); mw.Add_1(e); edgeEnt.push([e, sg.ent]); }
    if (!mw.IsDone()) throw new FeatureError("E-SWS-PROFILE", "The profile must be one chain of curves, open or closed.");
    const mk = new oc.BRepOffsetAPI_MakePipeShell(spine);
    if (f.orient === "normal") {
      const ad = new oc.BRepAdaptor_CompCurve_2(spine, false);
      const p0 = new oc.gp_Pnt_1(), v0 = new oc.gp_Vec_1();
      ad.D1(ad.FirstParameter(), p0, v0);
      mk.SetMode_2(new oc.gp_Ax2_3(p0, this.D(unit(this.xyz(v0)))));
    } else mk.SetMode_1(!!f.path && "helix" in f.path);
    mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
    // The wire's edges are copies: match them back to the sketch curves by position for the names.
    const wire = mw.Wire();
    const wedges = this.sub(wire, "EDGE");
    const named: [any, string][] = wedges.map(e => { const m = this.edgeMid(e); let best = edgeEnt[0][1], bd = Infinity; for (const [g, ent] of edgeEnt) { const d = d3(this.edgeMid(g), m); if (d < bd) { bd = d; best = ent; } } return [e, best] as [any, string]; });
    mk.Add_1(wire, false, false);
    try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-SWP-FAIL", "The sweep failed. Is the profile too big for the path's bends, or far from the path?");
    const shape = mk.Shape();
    const gen: [any, string][] = [];
    for (const [e, ent] of named) for (const g of this.list(mk.Generated(e))) gen.push([g, ent]);
    const parts = this.sheetParts(shape, (x, k) => { const q = gen.find(([g]) => g.IsSame(x)); return q ? `${f.id}:side:${q[1]}` : `${f.id}:new:${k}`; });
    return this.sheetsOf([...this.sheetList(sheets), ...parts]);
  }

  /**
   * Trim surface: the surface body split by a plane or a surface into the part on the tool's normal side
   * (common with a long slab: the tool pushed far along its normal) and the rest (cut); the side holding
   * the `keep` faces' hints stays, else the larger one.
   */
  private trimSurf(f: TrimSurfFeature, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Named | null {
    const oc = this.oc;
    if (!f.surface) throw new FeatureError("E-TRIM-PICK", "Pick the surface to trim.");
    if (!f.tool) throw new FeatureError("E-TRIM-TOOL", "Pick a plane or a surface to trim with.");
    const list = this.sheetList(sheets);
    const i = this.sheetIndex(list, sheets, f.surface);
    const target = list[i];
    const big = this.size(target.shape) * 4 + (body ? this.size(body.shape) : 0) + 100;
    let toolFace: any, n: V3;
    if ("plane" in f.tool) {
      const fr = this.planeFrame(f.tool.plane, body, frames);
      toolFace = new oc.BRepBuilderAPI_MakeFace_9(new oc.gp_Pln_2(new oc.gp_Ax3_3(this.P(fr.o), this.D(fr.n), this.D(fr.x))), -big, big, -big, big).Face();
      n = fr.n;
    } else {
      const ti = this.sheetIndex(list, sheets, f.tool.surface);
      if (ti === i) throw new FeatureError("E-TRIM-SELF", "A surface cannot trim itself.");
      toolFace = list[ti].shape;
      const pl = this.facePlane(list[ti].faces[0]);
      n = pl ? pl.n : this.faceNormalAt(list[ti].faces[0]);
    }
    const slab = new oc.BRepPrimAPI_MakePrism_1(toolFace, this.V(mul(n, big)), false, true).Shape();
    const pr = () => new oc.Message_ProgressRange_1();
    const inMk = new oc.BRepAlgoAPI_Common_3(target.shape, slab, pr());
    const outMk = new oc.BRepAlgoAPI_Cut_3(target.shape, slab, pr());
    if (!inMk.IsDone() || !outMk.IsDone()) throw new FeatureError("E-TRIM-FAIL", "The surface could not be trimmed.");
    const sides = [this.carry(inMk, [target], inMk.Shape(), f.id), this.carry(outMk, [target], outMk.Shape(), f.id)];
    const area = (x: Named) => x.faces.reduce((a, g) => { const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(g, p, false, false); return a + p.Mass(); }, 0);
    const areas = sides.map(area);
    if (areas.some(a => a < 1e-9)) throw new FeatureError("E-TRIM-MISS", "The tool does not cross the surface.");
    let keep = areas[0] >= areas[1] ? 0 : 1;
    const hints = f.keep.map(r => r.hint).filter((h): h is V3 => !!h);
    if (hints.length) {
      const dist = (x: Named) => Math.min(...hints.map(h => Math.min(...x.faces.map(g => d3(this.centroid(g), h)))));
      keep = dist(sides[0]) <= dist(sides[1]) ? 0 : 1;
    }
    const parts = this.sheetParts(sides[keep].shape, (x, k) => { const j = sides[keep].faces.findIndex(g => g.IsSame(x)); return j >= 0 ? sides[keep].names[j] : `${f.id}:new:${k}`; });
    return this.sheetsOf([...list.slice(0, i), ...parts, ...list.slice(i + 1)]);
  }

  /** Filled surface: an n-sided patch (BRepOffsetAPI_MakeFilling) bounded by an open loop of a surface body. */
  private fillSurf(f: FillSurfFeature, sheets: Named | null): Named | null {
    const oc = this.oc;
    if (!f.surface) throw new FeatureError("E-FILL-PICK", "Pick the surface whose opening to fill.");
    const list = this.sheetList(sheets);
    const i = this.sheetIndex(list, sheets, f.surface);
    const src = list[i];
    let loops = this.subWires(new oc.ShapeAnalysis_FreeBounds_3(src.shape, false, false, false).GetClosedWires());
    if (!loops.length) throw new FeatureError("E-FILL-NONE", "The surface has no closed opening to fill.");
    if (f.at) {
      const at = f.at;
      const dist = (w: any) => Math.min(...this.sub(w, "EDGE").map(e => d3(this.edgeMid(e), at)));
      loops = [loops.reduce((a, b) => (dist(b) < dist(a) ? b : a))];
    }
    const patches: Named[] = [];
    loops.forEach((w, k) => {
      const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
      for (const e of this.sub(w, "EDGE")) mk.Add_1(e, oc.GeomAbs_Shape.GeomAbs_C0, true);
      try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
      if (!mk.IsDone()) throw new FeatureError("E-FILL-FAIL", "The opening could not be filled.");
      const faces = this.sub(mk.Shape(), "FACE");
      patches.push({ shape: mk.Shape(), faces, names: faces.map((_, q) => `${f.id}:fill:${k}${q ? `:${q}` : ""}`) });
    });
    const rest = list.filter((_, j) => j !== i);
    if (f.merge === false) return this.sheetsOf([...list, ...patches]);
    const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
    sew.Add(src.shape);
    for (const p of patches) sew.Add(p.shape);
    sew.Perform(new oc.Message_ProgressRange_1());
    // Sewing may rebuild faces without reporting them as modified, so fall back to the nearest centroid.
    const map: [any, string, V3][] = [src, ...patches].flatMap(n => n.faces.map((x, j) => [sew.IsModified(x) ? sew.Modified(x) : x, n.names[j], this.centroid(x)] as [any, string, V3]));
    const nameOf = (x: any, q: number) => {
      const hit = map.find(([g]) => g.IsSame(x));
      if (hit) return hit[1];
      const c = this.centroid(x);
      let best: [any, string, V3] | null = null;
      for (const e of map) if (!best || d3(e[2], c) < d3(best[2], c)) best = e;
      return best && d3(best[2], c) < 1e-3 * (1 + this.size(x)) ? best[1] : `${f.id}:new:${q}`;
    };
    return this.sheetsOf([...rest, ...this.sheetParts(sew.SewedShape(), nameOf)]);
  }

  /** Extend surface: a one-face surface body's face grown past every side (BRepLib::ExtendFace); it keeps its name. */
  private extendSurf(f: ExtendSurfFeature, sheets: Named | null): Named | null {
    const oc = this.oc;
    if (!f.surface) throw new FeatureError("E-EXT-PICK", "Pick the surface to extend.");
    const list = this.sheetList(sheets);
    const i = this.sheetIndex(list, sheets, f.surface);
    if (list[i].faces.length !== 1) throw new FeatureError("E-EXT-ONE", "Extend works on surface bodies of one face.");
    const d = f.distance.v;
    if (!(d > 1e-6)) throw new FeatureError("E-FT-ZERO", "The distance must be more than 0.");
    const out = new oc.TopoDS_Face();
    try { oc.BRepLib.ExtendFace(list[i].faces[0], d, true, true, true, true, out); } catch { /* reported below */ }
    if (out.IsNull()) throw new FeatureError("E-EXT-FAIL", "The surface could not be extended.");
    const part: Named = { shape: out, faces: [out], names: [list[i].names[0]] };
    return this.sheetsOf([...list.slice(0, i), part, ...list.slice(i + 1)]);
  }

  /** Untrim surface (FR-FT-100): the face rebuilt on its own surface, over its parameter box or inside its outer wire. */
  private untrimSurf(f: UntrimSurfFeature, sheets: Named | null): Named | null {
    const oc = this.oc;
    if (!f.surface) throw new FeatureError("E-UNT-PICK", "Pick the surface to untrim.");
    const list = this.sheetList(sheets);
    const i = this.sheetIndex(list, sheets, f.surface);
    if (list[i].faces.length !== 1) throw new FeatureError("E-UNT-ONE", "Untrim works on surface bodies of one face.");
    const face = list[i].faces[0];
    const surf = oc.BRep_Tool.Surface_2(face);
    let out: any = null;
    try {
      if (f.mode === "holes") {
        const outer = oc.BRepTools.OuterWire(face);
        if (this.subWires(face).length < 2) throw new FeatureError("E-UNT-NOHOLE", "The surface has no holes to fill.");
        const mk = new oc.BRepBuilderAPI_MakeFace_21(surf, outer, true);
        if (mk.IsDone()) out = mk.Face();
      } else {
        const ad = new oc.BRepAdaptor_Surface_2(face, true);
        const mk = new oc.BRepBuilderAPI_MakeFace_14(surf, ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter(), 1e-6);
        if (mk.IsDone()) out = mk.Face();
      }
    } catch (e) { if (e instanceof FeatureError) throw e; out = null; }
    if (!out || out.IsNull()) throw new FeatureError("E-UNT-FAIL", "The surface could not be untrimmed.");
    if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) out = out.Reversed();
    const fix = new oc.ShapeFix_Face_2(out);
    fix.Perform();
    out = oc.TopoDS.Face_1(fix.Face());
    const part: Named = { shape: out, faces: [out], names: [list[i].names[0]] };
    return this.sheetsOf([...list.slice(0, i), part, ...list.slice(i + 1)]);
  }

  /** A point inside a solid: its centroid when that is inside, else a point just behind its largest face. */
  private insidePoint(solid: any): V3 {
    const oc = this.oc;
    const inside = (p: V3) => {
      const cl = new oc.BRepClass3d_SolidClassifier_3(solid, this.P(p), 1e-7);
      return cl.State() === oc.TopAbs_State.TopAbs_IN;
    };
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(solid, props, false, false, false);
    const c = this.xyz(props.CentreOfMass());
    if (inside(c)) return c;
    const faces = this.sub(solid, "FACE").map(x => ({ x, a: (() => { const p = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(x, p, false, false); return p.Mass(); })() })).sort((a, b) => b.a - a.a);
    const eps = Math.max(1e-4, this.size(solid) * 1e-4);
    for (const { x } of faces) {
      const p = this.centroid(x), n = this.faceNormalAt(x);
      for (const s of [-eps, eps, -10 * eps, 10 * eps]) { const q = add(p, mul(n, s)); if (inside(q)) return q; }
    }
    return c;
  }

  /**
   * Intersect (FR-BODY-007): BOPAlgo_MakerVolume builds every closed region the picked solids and
   * surfaces bound; the regions without an excluded point are kept (fused unless `merge === false`)
   * and replace the picked solids. Faces keep the names of the faces they came from.
   */
  private intersect(f: IntersectFeature, body: Named | null, sheets: Named | null): { body: Named | null; sheets: Named | null } {
    const oc = this.oc;
    const solids = body ? this.bodyList(body) : [], sl = this.sheetList(sheets);
    let si: number[], ti: number[];
    if (!f.bodies.length) { si = solids.map((_, i) => i); ti = sl.map((_, i) => i); }
    else {
      const onSheet = (r: FaceRef) => !!sheets && sheets.names.includes(r.name);
      ti = [...new Set(f.bodies.filter(onSheet).map(r => this.sheetIndex(sl, sheets, r)))];
      si = body ? this.pickedBodies(solids, body, f.bodies.filter(r => !onSheet(r))) : [];
    }
    if (si.length + ti.length < 1 || (si.length + ti.length < 2 && !ti.length)) throw new FeatureError("E-INT-PICK", "Pick the solids and surfaces that bound the regions (at least two, or surfaces alone).");
    const inputs = [...si.map(i => solids[i]), ...ti.map(i => sl[i])];
    const mk = new oc.BOPAlgo_MakerVolume_1();
    const args = new oc.TopTools_ListOfShape_1();
    for (const n of inputs) args.Append_1(n.shape);
    mk.SetArguments(args);
    mk.SetIntersect(true);
    mk.Perform(new oc.Message_ProgressRange_1());
    if (mk.HasErrors()) throw new FeatureError("E-INT-FAIL", "The bodies could not be intersected.");
    const res = this.carry(mk, inputs, mk.Shape(), f.id);
    const regions = this.bodyList(res).filter(r => Math.abs(this.volume(r.shape)) > 1e-9);
    if (!regions.length) throw new FeatureError("E-INT-NONE", "The bodies and surfaces enclose no region.");
    const info: IntersectRegion[] = regions.map(r => ({ c: this.insidePoint(r.shape), v: Math.abs(this.volume(r.shape)), out: false }));
    const contains = (r: Named, p: V3) => new oc.BRepClass3d_SolidClassifier_3(r.shape, this.P(p), 1e-7).State() === oc.TopAbs_State.TopAbs_IN;
    regions.forEach((r, k) => { const ex = f.exclude.map((p, i) => contains(r, p) ? i : -1).filter(i => i >= 0); info[k].out = ex.length > 0; if (ex.length) info[k].ex = ex; });
    this.regions.set(f.id, info);
    const kept = regions.filter((_, k) => !info[k].out);
    if (!kept.length) throw new FeatureError("E-INT-ALL", "Every region is excluded: keep at least one.");
    let out = kept;
    if (f.merge !== false && kept.length > 1) {
      let m = kept[0];
      for (const r of kept.slice(1)) m = this.bool("fuse", m, r, f.id);
      out = this.bodyList(m);
    }
    const restSolids = solids.filter((_, i) => !si.includes(i));
    const restSheets = sl.filter((_, i) => !ti.includes(i) || !f.consume);
    return { body: this.compoundOf([...restSolids, ...out]), sheets: this.sheetsOf(restSheets) };
  }

  /** The normal of a face at the middle of its parameter range (orientation-corrected). */
  private faceNormalAt(face: any): V3 {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    const u = (ad.FirstUParameter() + ad.LastUParameter()) / 2, v = (ad.FirstVParameter() + ad.LastVParameter()) / 2;
    const p = new oc.gp_Pnt_1(), d1u = new oc.gp_Vec_1(), d1v = new oc.gp_Vec_1();
    ad.D1(u, v, p, d1u, d1v);
    let n = unit(cross(this.xyz(d1u), this.xyz(d1v)));
    if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
    return n;
  }

  /** Delete face, "delete": the faces leave their solid, and what is left of it becomes a surface body. */
  private deleteToSurface(f: { id: string; faces: FaceRef[] }, prev: Named, sheets: Named | null): { body: Named | null; sheets: Named | null } {
    const oc = this.oc;
    const list = this.bodyList(prev);
    const gone = f.faces.map(r => this.resolveFace(prev, r));
    const idx = [...new Set(gone.map(g => list.findIndex(b => b.faces.some(x => x.IsSame(g)))))];
    if (idx.some(k => k < 0)) throw new FeatureError("E-TN-LOST", "Reference lost: a face to delete");
    const parts: Named[] = [];
    for (const k of idx) {
      const b = list[k];
      const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
      const kept = b.faces.map((x, j) => [x, b.names[j]] as [any, string]).filter(([x]) => !gone.some(g => g.IsSame(x)));
      if (!kept.length) continue;
      for (const [x] of kept) sew.Add(x);
      sew.Perform(new oc.Message_ProgressRange_1());
      const map = kept.map(([x, nm]) => [sew.IsModified(x) ? sew.Modified(x) : x, nm] as [any, string]);
      parts.push(...this.sheetParts(sew.SewedShape(), (x, q) => map.find(([g]) => g.IsSame(x))?.[1] ?? `${f.id}:new:${q}`));
    }
    const rest = list.filter((_, k) => !idx.includes(k));
    return { body: rest.length ? this.compoundOf(rest) : null, sheets: this.sheetsOf([...this.sheetList(sheets), ...parts]) };
  }

  /**
   * Replace face (FR-FT-101): each picked flat face is pushed far out as a prism (its far end `fid:cap`),
   * the extended body is split by the surface, and the pieces that reach a cap go. What is left meets the
   * surface; the new faces take the first picked face's name and the prism sides merge into their neighbours.
   */
  private replaceFaces(f: ReplaceFaceFeature, prev: Named | null, sheets: Named | null): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.faces.length) throw new FeatureError("E-RPF-FACES", "Click the faces to replace.");
    if (!f.surface) throw new FeatureError("E-RPF-SURF", "Pick the replacement surface.");
    const list = this.sheetList(sheets);
    const sheet = list[this.sheetIndex(list, sheets, f.surface)];
    const big = this.size(prev.shape) * 2 + this.size(sheet.shape) + 100;
    const targets = f.faces.map(r => this.resolveFace(prev, r));
    let ext = prev, k = 0;
    for (const face of targets) {
      const pl = this.facePlane(face);
      if (!pl) throw new FeatureError("E-RPF-FLAT", "Replace face works on flat faces.");
      const mk = new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(pl.n, big)), false, true);
      if (!mk.IsDone()) throw new FeatureError("E-RPF-FAIL", "The faces could not be replaced.");
      let tool = mk.Shape();
      if (this.volume(tool) < 0) tool = tool.Reversed();
      const top = mk.LastShape(), faces = this.sub(tool, "FACE");
      ext = this.bool("fuse", ext, { shape: tool, faces, names: faces.map(x => (x.IsSame(top) ? `${f.id}:cap` : `${f.id}:side:${k++}`)) }, f.id);
    }
    const sp = new oc.BRepAlgoAPI_Splitter_1();
    const args = new oc.TopTools_ListOfShape_1(), tools = new oc.TopTools_ListOfShape_1();
    args.Append_1(ext.shape);
    tools.Append_1(sheet.shape);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(new oc.Message_ProgressRange_1());
    if (!sp.IsDone() || sp.HasErrors()) throw new FeatureError("E-RPF-FAIL", "The faces could not be replaced.");
    const named: Named = { shape: sheet.shape, faces: sheet.faces, names: sheet.faces.map(() => f.faces[0].name) };
    const pieces = this.bodyList(this.carry(sp, [ext, named], sp.Shape(), f.id));
    const keep = pieces.filter(p => !p.names.includes(`${f.id}:cap`));
    if (keep.length === pieces.length || !keep.length) throw new FeatureError("E-RPF-MISS", "The surface must cross the faces' whole outline: make it bigger, or extend it.");
    return this.mergeSides(this.compoundOf(keep), f.id);
  }

  /**
   * Merges the new side faces `fid:side:*` into the coplanar faces next to them (ShapeUpgrade_UnifySameDomain,
   * only across their edges, so split lines and other seams stay). A merged face keeps the older name.
   */
  private mergeSides(b: Named, fid: string): Named {
    const oc = this.oc;
    const own = (n: string) => n.startsWith(`${fid}:`);
    const sideEdges = b.faces.filter((_, i) => own(b.names[i])).flatMap(x => this.sub(x, "EDGE"));
    if (!sideEdges.length) return b;
    const u = new oc.ShapeUpgrade_UnifySameDomain_2(b.shape, true, true, false);
    for (const e of this.sub(b.shape, "EDGE")) if (!sideEdges.some(x => x.IsSame(e))) u.KeepShape(e);
    try { u.Build(); } catch { return b; }
    const shape = u.Shape(), h = u.History_1().get();
    const faces = this.sub(shape, "FACE");
    const names: (string | null)[] = faces.map(() => null);
    b.faces.forEach((f, i) => {
      const mods = this.list(h.Modified(f));
      for (const m of mods.length ? mods : [f]) {
        const j = faces.findIndex(x => x.IsSame(m));
        if (j >= 0 && (!names[j] || (own(names[j]!) && !own(b.names[i])))) names[j] = b.names[i];
      }
    });
    let k = 0;
    return { shape, faces, names: names.map(n => n ?? `${fid}:new:${k++}`) };
  }

  /**
   * Draft (FR-FT-061): BRepOffsetAPI_DraftAngle tapers each picked face about the neutral plane,
   * pulling along the plane's normal. Drafted faces keep their names.
   */
  private draft(f: DraftFeature, prev: Named | null, frames: Record<string, Frame>): Named {
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    const parting = f.kind === "parting";
    if (!f.plane) throw new FeatureError("E-DRAFT-PLANE", parting ? "Pick the direction of pull: a flat face or a plane." : "Pick the neutral plane: a flat face or a plane.");
    if (parting ? !f.parting?.length : !f.faces.length) throw new FeatureError("E-DRAFT-FACES", parting ? "Click the edges of the parting line." : "Click the faces to draft.");
    const a = f.angle.v;
    if (!(Math.abs(a) > 1e-6) || Math.abs(a) >= Math.PI / 2 - 1e-3) throw new FeatureError("E-DRAFT-ANGLE", "The draft angle must be between 0° and 90°.");
    const fr = this.planeFrame(f.plane, prev, frames);
    const n = f.flip ? mul(fr.n, -1) : fr.n;
    if (!parting) return this.applyDraft(prev, f.faces.map(r => this.resolveFace(prev, r)), n, a, fr.o, f.id);
    // Parting line: each face hinges on its edge (the neutral plane through the edge's middle, square to the pull).
    const items: { face: any; o: V3 }[] = [];
    for (const r of f.parting!) {
      const e = this.resolveEdge(prev, r);
      const face = this.faceOfEdge(prev, e, r.faces[f.other ? 1 : 0]);
      if (items.some(x => x.face.IsSame(face))) continue;
      const c = new this.oc.BRepAdaptor_Curve_2(e);
      items.push({ face, o: this.xyz(c.Value((c.FirstParameter() + c.LastParameter()) / 2)) });
    }
    return this.applyDraftEach(prev, items, n, a, f.id);
  }

  private applyDraft(prev: Named, picked: any[], n: V3, a: number, o: V3, fid: string): Named {
    return this.applyDraftEach(prev, picked.map(face => ({ face, o })), n, a, fid);
  }

  /** Tapers faces of a body by an angle, each about the plane through its `o` normal to the pull direction `n`; faces keep their names. */
  private applyDraftEach(prev: Named, picked: { face: any; o: V3 }[], n: V3, a: number, fid: string): Named {
    const oc = this.oc;
    const mk = new oc.BRepOffsetAPI_DraftAngle_2(prev.shape);
    for (const { face, o } of picked) {
      const pln = new oc.gp_Pln_3(this.P(o), this.D(n));
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
    const big = this.size(prev.shape) * 2 + 1;
    const down = mul(fr.n, -1);
    // The depth at a hole centre: as set, through, to a plane (along the axis) or until the material ends.
    const depthAt = (o: V3): number => {
      if (through) return big;
      if (f.end === "upto") {
        if (!f.upTo) throw new FeatureError("E-HOLE-UPTO", "Pick the face or plane the hole goes up to.");
        const tp = this.planeFrame(f.upTo, prev, frames);
        const den = dot(tp.n, down);
        if (Math.abs(den) < 1e-9) throw new FeatureError("E-HOLE-UPTO", "The face or plane must not be parallel to the hole.");
        const s = dot(sub3(tp.o, o), tp.n) / den;
        if (!(s > 1e-6)) throw new FeatureError("E-HOLE-UPTO", "The face or plane is behind the hole's face.");
        return s;
      }
      if (f.end === "next") {
        // March down the axis, just inside the hole's wall, until it leaves the material; then bisect.
        const inside = (s: number) => new oc.BRepClass3d_SolidClassifier_3(prev.shape, this.P(add(o, mul(down, s))), 1e-7).State() === oc.TopAbs_State.TopAbs_IN;
        const step = Math.max(big / 400, 0.05);
        let s = step / 4;
        if (!inside(s)) throw new FeatureError("E-HOLE-NEXT", "There is no material under the hole's face.");
        while (s < big && inside(s + step)) s += step;
        let lo = s, hi = s + step;
        for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid; }
        return hi;
      }
      return f.depth.v;
    };
    const lift = Math.max(0.01, r * 0.05);
    const tan59 = Math.tan((118 * Math.PI) / 360);
    const profile = (depth: number): [number, number][] => {
      if (!(depth > 1e-6)) throw new FeatureError("E-FT-ZERO", "The depth must be more than 0.");
      // Profile from the axis outward, starting above the face so the top is cut cleanly.
      const prof: [number, number][] = [[0, lift]];
      if (f.kind === "cbore") {
        const R = (f.cbDia?.v ?? 0) / 2, d = f.cbDepth?.v ?? 0;
        if (!(R > r) || !(d > 0) || d >= depth) throw new FeatureError("E-HOLE-CBORE", "The counterbore must be wider than the hole and less deep.");
        prof.push([R, lift], [R, -d], [r, -d]);
      } else if (f.kind === "cdrill") {
        // Counterdrill: a wider drill with a conical bottom down to the hole.
        const R = (f.cdDia?.v ?? 0) / 2, d = f.cdDepth?.v ?? 0, a = f.cdAngle?.v ?? (118 * Math.PI) / 180;
        if (!(a > 0.1 && a < Math.PI - 0.1)) throw new FeatureError("E-HOLE-CDRILL", "The counterdrill must be wider than the hole and less deep, at an angle between 6° and 174°.");
        const h = (R - r) / Math.tan(a / 2);
        if (!(R > r) || !(d > 0) || d + h >= depth) throw new FeatureError("E-HOLE-CDRILL", "The counterdrill must be wider than the hole and less deep, at an angle between 6° and 174°.");
        prof.push([R, lift], [R, -d], [r, -d - h]);
      } else if (f.kind === "csink") {
        const R = (f.csDia?.v ?? 0) / 2, a = f.csAngle?.v ?? Math.PI / 2;
        if (!(R > r) || !(a > 0.1 && a < Math.PI - 0.1)) throw new FeatureError("E-HOLE-CSINK", "The countersink must be wider than the hole, at an angle between 6° and 174°.");
        const h = (R - r) / Math.tan(a / 2);
        prof.push([R + lift * Math.tan(a / 2), lift], [r, -h]);
      } else prof.push([r, lift]);
      const tipH = f.flat || f.end !== "blind" ? 0 : r / tan59;
      prof.push([r, -depth], [0, -depth - tipH]);
      return prof;
    };
    const revolve = (o: V3, prof: [number, number][]) => {
      // The profile lies in the plane through the axis and the frame's x: (r, z) → o + x·r + n·z.
      const poly = new oc.BRepBuilderAPI_MakePolygon_1();
      for (const [rr, z] of prof) poly.Add_1(this.P(add(add(o, mul(fr.x, rr)), mul(fr.n, z))));
      poly.Close();
      const face = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true).Face();
      const mk = new oc.BRepPrimAPI_MakeRevol_1(face, new oc.gp_Ax1_2(this.P(o), this.D(fr.n)), 2 * Math.PI, false);
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The hole could not be made.");
      return mk.Shape();
    };
    const tools: Named[] = [];
    f.pts.forEach((p, i) => {
      const o = add(add(fr.o, mul(fr.x, p[0])), mul(fr.y, p[1]));
      let shape = revolve(o, profile(depthAt(o)));
      if (f.kind === "slot") {
        // Slot: the hole at both ends of the centre line, joined by the profile swept along it.
        const L = f.slotLen?.v ?? 0;
        if (!(L > 1e-6)) throw new FeatureError("E-HOLE-SLOT", "The slot length must be more than 0.");
        const ang = f.slotAngle?.v ?? 0, u = add(mul(fr.x, Math.cos(ang)), mul(fr.y, Math.sin(ang))), w = cross(fr.n, u);
        const o2 = add(o, mul(u, L));
        const prof = profile(Math.min(depthAt(o), depthAt(o2)));
        const poly = new oc.BRepBuilderAPI_MakePolygon_1();
        const half = [...prof.map(([rr, z]) => add(add(o, mul(w, rr)), mul(fr.n, z))), ...[...prof].reverse().map(([rr, z]) => add(add(o, mul(w, -rr)), mul(fr.n, z)))];
        for (const q of half) poly.Add_1(this.P(q));
        poly.Close();
        const sec = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true).Face();
        const pr = new oc.BRepPrimAPI_MakePrism_1(sec, this.V(mul(u, L)), false, true);
        if (!pr.IsDone()) throw new FeatureError("E-FT-FAIL", "The hole could not be made.");
        const nm = (sh: any): Named => { const fs = this.sub(sh, "FACE"); return { shape: sh, faces: fs, names: fs.map(() => "") }; };
        let joined = this.bool("fuse", nm(shape), nm(pr.Shape()), f.id);
        joined = this.bool("fuse", joined, nm(revolve(o2, prof)), f.id);
        const un = new oc.ShapeUpgrade_UnifySameDomain_2(joined.shape, true, true, false);
        try { un.Build(); shape = un.Shape(); } catch { shape = joined.shape; }
      }
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
    if (f.vpitch?.length) return this.helixVariable(f, frame, this.w(frame, [cp.x, cp.y]));
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

  /**
   * Variable pitch helix (FR-FT-083, P5): pitch and diameter run linearly between the rows' heights;
   * the turn angle is the integral of 2π/pitch over the height. One C2 spline edge through points
   * every 10°, which is close enough for sweeps (and keeps Frenet frames smooth).
   */
  private helixVariable(f: HelixFeature, frame: Frame, c: V3): Curve {
    const rows = f.vpitch!.map(q => ({ h: q.h.v, p: q.p.v, d: q.d.v }));
    if (rows.length < 2) throw new FeatureError("E-HLX-VALUES", "A variable pitch helix needs two or more rows.");
    rows[0].h = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!(rows[i].p > 1e-6 && rows[i].d > 1e-6)) throw new FeatureError("E-HLX-VALUES", "Every row's pitch and diameter must be more than 0.");
      if (i && !(rows[i].h > rows[i - 1].h + 1e-9)) throw new FeatureError("E-HLX-ROWS", "Each row's height must be more than the row above.");
    }
    const dir = mul(frame.n, f.reverse ? -1 : 1);
    const s0 = f.start?.v ?? 0;
    const xd = unit(add(mul(frame.x, Math.cos(s0)), mul(frame.y, Math.sin(s0))));
    const yd = cross(dir, xd);
    const sg = f.cw ? -1 : 1;
    // Angle at each height, by the exact integral of 1/(p0 + k·z) on each segment.
    const at = (z: number) => {
      let th = 0;
      for (let i = 0; i + 1 < rows.length; i++) {
        const a = rows[i], b = rows[i + 1], dz = Math.min(z, b.h) - a.h;
        if (dz <= 0) break;
        const k = (b.p - a.p) / (b.h - a.h);
        th += Math.abs(k) < 1e-12 ? dz / a.p : Math.log((a.p + k * dz) / a.p) / k;
      }
      return 2 * Math.PI * th;
    };
    const rad = (z: number) => {
      for (let i = 0; i + 1 < rows.length; i++) if (z <= rows[i + 1].h) return (rows[i].d + ((rows[i + 1].d - rows[i].d) * (z - rows[i].h)) / (rows[i + 1].h - rows[i].h)) / 2;
      return rows[rows.length - 1].d / 2;
    };
    const H = rows[rows.length - 1].h, turns = at(H) / (2 * Math.PI);
    if (turns > 2000) throw new FeatureError("E-HLX-VALUES", "A helix can have at most 2000 revolutions.");
    // Points every 10° of turn: invert the angle by bisection on each step.
    const n = Math.max(8, Math.min(20000, Math.ceil(turns * 36)));
    const zs: number[] = [0];
    for (let k = 1; k < n; k++) {
      const want = (at(H) * k) / n;
      let lo = zs[k - 1], hi = H;
      for (let it = 0; it < 50; it++) { const m = (lo + hi) / 2; if (at(m) < want) lo = m; else hi = m; }
      zs.push((lo + hi) / 2);
    }
    zs.push(H);
    const pts: V3[] = zs.map(z => {
      const th = sg * at(z), rr = rad(z);
      return add(add(c, mul(dir, z)), add(mul(xd, rr * Math.cos(th)), mul(yd, rr * Math.sin(th))));
    });
    const wire = new this.oc.BRepBuilderAPI_MakeWire_2(this.bezierEdge(splineBezierN(pts))).Wire();
    return { wire, pts };
  }

  /**
   * Auxiliary spine for a twisted sweep: points beside the path, turned about it by `twist` in
   * proportion to the length run, on rotation-minimising frames (double reflection). Each point lies
   * in the plane square to the path, which is how MakePipeShell matches them without curvilinear
   * equivalence.
   */
  private twistSpine(spine: any, twist: number): any {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_CompCurve_2(spine, false);
    const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
    const n = Math.max(24, Math.min(600, Math.ceil(Math.abs(twist) / (Math.PI / 18)) + 24 * this.sub(spine, "EDGE").length));
    const P: V3[] = [], T: V3[] = [];
    for (let k = 0; k <= n; k++) {
      const p = new oc.gp_Pnt_1(), v = new oc.gp_Vec_1();
      ad.D1(t0 + ((t1 - t0) * k) / n, p, v);
      P.push(this.xyz(p)); T.push(unit(this.xyz(v)));
    }
    const len: number[] = [0];
    for (let k = 1; k <= n; k++) len.push(len[k - 1] + d3(P[k], P[k - 1]));
    const L = len[n] || 1, off = 0.1 * L + 1;
    // A start normal square to the tangent.
    const a: V3 = Math.abs(T[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let r = unit(cross(cross(T[0], a), T[0]));
    const aux: V3[] = [];
    for (let k = 0; k <= n; k++) {
      if (k) {
        const v1 = sub3(P[k], P[k - 1]), c1 = dot(v1, v1);
        if (c1 > 1e-18) {
          const rL = sub3(r, mul(v1, (2 / c1) * dot(v1, r))), tL = sub3(T[k - 1], mul(v1, (2 / c1) * dot(v1, T[k - 1])));
          const v2 = sub3(T[k], tL), c2 = dot(v2, v2);
          r = unit(c2 > 1e-18 ? sub3(rL, mul(v2, (2 / c2) * dot(v2, rL))) : rL);
        }
      }
      const th = (twist * len[k]) / L;
      const b = cross(T[k], r);
      aux.push(add(P[k], mul(add(mul(r, Math.cos(th)), mul(b, Math.sin(th))), off)));
    }
    return new oc.BRepBuilderAPI_MakeWire_2(this.bezierEdge(splineBezierN(aux))).Wire();
  }

  /**
   * Scale law for a guided sweep: the guide's distance from the path, in planes square to the path,
   * over its distance at the start. The guide must start off the path (on the profile's edge).
   */
  private guideLaw(spine: any, guide: any): any {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_CompCurve_2(spine, false), ag = new oc.BRepAdaptor_CompCurve_2(guide, false);
    const t0 = ad.FirstParameter(), t1 = ad.LastParameter(), g0 = ag.FirstParameter(), g1 = ag.LastParameter();
    const m = Math.max(200, 80 * this.sub(guide, "EDGE").length);
    const G: V3[] = [];
    for (let k = 0; k <= m; k++) G.push(this.xyz(ag.Value(g0 + ((g1 - g0) * k) / m)));
    const n = Math.max(16, Math.min(200, 16 * this.sub(spine, "EDGE").length));
    const vals: [number, number][] = [];
    let j = 0;
    for (let k = 0; k <= n; k++) {
      const t = t0 + ((t1 - t0) * k) / n, p = new oc.gp_Pnt_1(), v = new oc.gp_Vec_1();
      ad.D1(t, p, v);
      const P = this.xyz(p), T = unit(this.xyz(v));
      // The guide's crossing of the plane square to the path, searched onward from the last one.
      let hit: V3 | null = null;
      for (let i = Math.max(0, j - 2); i < m && !hit; i++) {
        const a = dot(sub3(G[i], P), T), b = dot(sub3(G[i + 1], P), T);
        if ((a <= 0 && b >= 0) || (a >= 0 && b <= 0)) { const u = Math.abs(a - b) < 1e-15 ? 0 : a / (a - b); hit = add(G[i], mul(sub3(G[i + 1], G[i]), u)); j = i; }
      }
      if (!hit) hit = k === 0 ? G[0] : G[m];
      vals.push([t, d3(hit, P)]);
    }
    const d0 = vals[0][1];
    if (!(d0 > 1e-6)) throw new FeatureError("E-SWP-GUIDE", "The guide curve must start on the profile's edge, away from the path.");
    if (vals.some(([, d]) => !(d > 1e-6))) throw new FeatureError("E-SWP-GUIDE", "The guide curve meets the path: the profile would shrink to nothing.");
    const arr = new oc.TColgp_Array1OfPnt2d_2(1, vals.length);
    vals.forEach(([t, d], i) => arr.SetValue(i + 1, new oc.gp_Pnt2d_3(t, d / d0)));
    const li = new oc.Law_Interpol();
    li.Set_1(arr, false);
    return new oc.Handle_Law_Function_2(li);
  }

  /** The wire of a sweep path: a helix or curve feature, or a sketch's chain of curves. */
  private pathWire(path: SweepPath | undefined, doc: PartDoc, body: Named | null, frames: Record<string, Frame>): any {
    const oc = this.oc;
    if (!path) throw new FeatureError("E-SWP-PATH", "Pick a path: a sketch, a helix or a curve.");
    if ("helix" in path || "curve" in path) {
      const c = this.curves.get("helix" in path ? path.helix : path.curve);
      if (!c) throw new FeatureError("E-FT-PARENT", "helix" in path ? "The helix is missing or has an error." : "The curve is missing or has an error.");
      if (!c.wire) throw new FeatureError("E-SWP-PATH", "A 3D sketch path must be one chain of lines and splines.");
      return c.wire;
    }
    const { sk, frame } = this.sketchOf(path.sketch, doc, body, frames, "a path sketch");
    const p = sketchPath(sk);
    if (p.error) throw new FeatureError(p.error.code, p.error.message);
    const mk = new oc.BRepBuilderAPI_MakeWire_1();
    for (const sg of p.segs) mk.Add_1(this.segEdge(sg, frame));
    if (!mk.IsDone()) throw new FeatureError("E-SWP-PATH", "The path's curves do not join end to end.");
    return mk.Wire();
  }

  /** 3D sketch (FR-SK-080): its lines and splines as one wire when they form a chain (a sweep path); drawn from the document. */
  private sketch3d(f: Sketch3dFeature): Curve {
    const oc = this.oc;
    if (!f.segs.some(s => s.pts.length >= 2)) throw new FeatureError("E-3D-EMPTY", "The 3D sketch has no lines or splines.");
    const ch = chain3d(f);
    if ("error" in ch) return { wire: null, pts: [] };
    const P = (id: string): V3 => f.pts.find(p => p.id === id)?.p ?? [0, 0, 0];
    const mk = new oc.BRepBuilderAPI_MakeWire_1();
    for (const ids of ch.order) {
      const q = ids.map(P);
      const seg = f.segs.find(s => s.pts.length === ids.length && (s.pts.every((x, i) => x === ids[i]) || s.pts.every((x, i) => x === ids[ids.length - 1 - i])));
      const e = seg?.t === "spline" && q.length > 2 ? this.bezierEdge(splineBezierN(q)) : new oc.BRepBuilderAPI_MakeEdge_3(this.P(q[0]), this.P(q[q.length - 1])).Edge();
      mk.Add_1(e);
    }
    if (!mk.IsDone()) return { wire: null, pts: [] };
    return { wire: mk.Wire(), pts: [] };
  }

  /** Points along a wire, in order, for drawing it. */
  private wirePts(wire: any): V3[] {
    const oc = this.oc;
    const ad = new oc.BRepAdaptor_CompCurve_2(wire, false);
    const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
    const n = Math.max(32, Math.min(4000, 48 * this.sub(wire, "EDGE").length));
    const pts: V3[] = [];
    for (let k = 0; k <= n; k++) pts.push(this.xyz(ad.Value(t0 + ((t1 - t0) * k) / n)));
    return pts;
  }

  /**
   * 3D curves (FR-FT-085): through XYZ points (the sketch splines' C2 chord-length interpolant, one
   * B-spline edge), composite (model edges joined into one wire) or projected (a sketch chain projected
   * along its normal onto faces; the nearest piece in front of the sketch is kept).
   */
  private curve(f: CurveFeature, doc: PartDoc, body: Named | null, sheets: Named | null, frames: Record<string, Frame>): Curve {
    const oc = this.oc;
    if (f.kind === "xyz") {
      const pts = (f.pts ?? []).filter((q, i, a) => !i || d3(q, a[i - 1]) > 1e-9);
      if (f.closed && pts.length > 2 && d3(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
      if (pts.length < 2) throw new FeatureError("E-CRV-POINTS", "A curve needs at least two different points.");
      if (f.closed && pts.length < 3) throw new FeatureError("E-CRV-POINTS", "A closed curve needs at least three points.");
      const edge = pts.length === 2 ? new oc.BRepBuilderAPI_MakeEdge_3(this.P(pts[0]), this.P(pts[1])).Edge() : this.bezierEdge(splineBezierN(pts, !!f.closed));
      const wire = new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
      return { wire, pts: this.wirePts(wire) };
    }
    if (f.kind === "composite") {
      if (!f.edges?.length) throw new FeatureError("E-CRV-EDGES", "Pick the edges to join.");
      const list = new oc.TopTools_ListOfShape_1();
      for (const r of f.edges) list.Append_1(this.resolveEdge(body, r));
      const mk = new oc.BRepBuilderAPI_MakeWire_1();
      mk.Add_3(list);
      if (!mk.IsDone() || this.sub(mk.Wire(), "EDGE").length !== f.edges.length) throw new FeatureError("E-CRV-JOIN", "The edges do not join end to end into one chain.");
      const wire = mk.Wire();
      return { wire, pts: this.wirePts(wire) };
    }
    const { sk, frame } = this.sketchOf(f.sketch, doc, body, frames, "a sketch to project");
    const p = sketchPath(sk);
    if (p.error) throw new FeatureError(p.error.code, p.error.message);
    const mw = new oc.BRepBuilderAPI_MakeWire_1();
    for (const sg of p.segs) mw.Add_1(this.segEdge(sg, frame));
    if (!mw.IsDone()) throw new FeatureError("E-SWP-PATH", "The path's curves do not join end to end.");
    let target: any;
    if (f.faces?.length) {
      const bb = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
      bb.MakeCompound(comp);
      for (const r of f.faces) bb.Add(comp, this.resolveAny(body, sheets, r));
      target = comp;
    } else {
      target = body?.shape ?? sheets?.shape;
      if (!target) throw new FeatureError("E-FT-NOBODY", "There is no body to project onto.");
    }
    // The projection runs both ways along the line: the piece nearest in front of the sketch wins,
    // looking along the normal first (against it with `flip`), then the other way.
    for (const sg of f.flip ? [-1, 1] : [1, -1]) {
      const dir = mul(frame.n, sg);
      const pr = new oc.BRepProj_Projection_1(mw.Wire(), target, this.D(dir));
      let best: Curve | null = null, bd = Infinity;
      for (pr.Init(); pr.More(); pr.Next()) {
        const w = pr.Current();
        const pts = this.wirePts(w);
        const dist = pts.reduce((acc, q) => acc + dot(sub3(q, frame.o), dir), 0) / pts.length;
        if (dist < -1e-6 || dist >= bd) continue;
        bd = dist; best = { wire: w, pts };
      }
      if (best) return best;
    }
    throw new FeatureError("E-CRV-MISS", "The sketch does not project onto the faces.");
  }

  /** Sweep (FR-FT-080/081): profile regions (or a circle) along a path, with MakePipeShell. */
  private sweepAlong(f: SweepFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const spine = this.pathWire(f.path, doc, prev, frames);
    const helixPath = !!f.path && "helix" in f.path;
    const guide = f.guide ? this.pathWire(f.guide, doc, prev, frames) : null;
    const twist = !guide && f.orient !== "normal" && f.twist && Math.abs(f.twist.v) > 1e-9 ? this.twistSpine(spine, f.twist.v) : null;
    const law = guide ? this.guideLaw(spine, guide) : null;
    const pipe = (w: any, edgeEnt: [any, string][]): Named => {
      const mk = new oc.BRepOffsetAPI_MakePipeShell(spine);
      if (guide) {
        // Guide curve: the guide turns the profile (as an auxiliary spine) and a scale law keeps it touching.
        mk.SetMode_5(guide, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
      } else if (twist) {
        mk.SetMode_5(twist, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
      } else if (f.orient === "normal") {
        // Keep normal constant: the profile keeps its start orientation all along.
        const ad = new oc.BRepAdaptor_CompCurve_2(spine, false);
        const p0 = new oc.gp_Pnt_1(), v0 = new oc.gp_Vec_1();
        ad.D1(ad.FirstParameter(), p0, v0);
        const t0 = unit(this.xyz(v0));
        mk.SetMode_2(new oc.gp_Ax2_3(p0, this.D(t0)));
      } else mk.SetMode_1(helixPath);
      // Sharp corners (3D sketch and composite paths) get mitred, not stretched.
      mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
      // Path tangent at the start: OCCT turns the profile square to the path (WithCorrection).
      const fix = !!f.startTangent && !f.circular;
      if (law) mk.SetLaw_1(w, law, false, fix); else mk.Add_1(w, false, fix);
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
    if (f.centerline) return this.loftAlong(f, doc, prev, frames);
    const mk = new oc.BRepOffsetAPI_ThruSections(true, !!f.ruled, 1e-6);
    let firstEdges: [any, string][] = [];
    const wires: any[] = [];
    const starts: (V3 | undefined)[] = [];
    f.profiles.forEach((id, k) => {
      const { sk, frame } = this.sketchOf(id, doc, prev, frames, "the profile sketches");
      const { faces, edgeEnt } = this.profileFaces(sk, frame);
      if (faces.length !== 1) throw new FeatureError("E-LOFT-PROFILE", "Each loft profile must be one closed region.");
      const w = oc.BRepTools.OuterWire(faces[0]);
      if (k === 0) firstEdges = edgeEnt;
      wires.push(w);
      const cid = f.connectors?.[k];
      const cp = cid ? sk.ents.find(e => e.id === cid && e.t === "point") : undefined;
      if (cp && cp.t === "point") starts[k] = add(add(frame.o, mul(frame.x, cp.x)), mul(frame.y, cp.y));
    });
    // Connectors (FR-FT-082): each profile starts at its picked point, all wound the same way, so the loft
    // joins those points instead of letting OCCT line the profiles up.
    const connected = starts.some(Boolean);
    if (connected) {
      const d = sub3(this.wireCentre(wires[wires.length - 1]), this.wireCentre(wires[0]));
      wires.forEach((w, k) => { wires[k] = this.startWire(w, starts[k] ?? null, d); });
    }
    if (f.close && wires.length >= 3) wires.push(wires[0]);
    // Guide curves (FR-FT-082, P5): sections of the free loft between the profiles, stretched to the guides.
    const guided = !!f.guides?.length && !f.ruled && !f.close;
    if (guided) {
      const ns = f.profiles.map(id => this.sketchOf(id, doc, prev, frames, "the profile sketches").frame.n);
      wires.splice(0, wires.length, ...this.guidedSections(f, wires, ns, doc, prev, frames));
    }
    // Start / end normal to profile (FR-FT-082): a copy of the end profile a little way along its normal
    // (towards the next one) makes the smooth loft leave it square; the tangent length scales that step.
    if (!guided && !f.ruled && !f.close && (f.startNormal || f.endNormal)) {
      const norm = (id: string) => this.sketchOf(id, doc, prev, frames, "the profile sketches").frame.n;
      const cen = (w: any) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.LinearProperties(w, g, false, false); return this.xyz(g.CentreOfMass()); };
      const guide = (w: any, next: any, n: V3, len: number) => {
        const gap = add(cen(next), mul(cen(w), -1));
        const along = dot(gap, n) >= 0 ? n : mul(n, -1);
        const step = Math.max(Math.abs(dot(gap, n)), Math.hypot(...gap) * 0.5) * 0.25 * len;
        if (!(step > 1e-6)) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles twist, or cross each other?");
        const tr = new oc.gp_Trsf_1();
        tr.SetTranslation_1(this.V(mul(along, step)));
        return oc.TopoDS.Wire_1(new oc.BRepBuilderAPI_Transform_2(w, tr, true).Shape());
      };
      const L = wires.length;
      const first = f.startNormal ? guide(wires[0], wires[1], norm(f.profiles[0]), f.startLen ?? 1) : null;
      const last = f.endNormal ? guide(wires[L - 1], wires[L - 2], norm(f.profiles[L - 1]), f.endLen ?? 1) : null;
      if (first) wires.splice(1, 0, first);
      if (last) wires.splice(wires.length - 1, 0, last);
    }
    for (const w of wires) mk.AddWire(w);
    mk.CheckCompatibility(!connected);
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
   * A closed wire rebuilt to start at the vertex nearest `at` (when given) and to wind counter-clockwise
   * about `d`, keeping its edges (so names from them still resolve).
   */
  private startWire(w: any, at: V3 | null, d: V3): any {
    const oc = this.oc;
    let edges: any[] = [], verts: V3[] = [];
    for (const ex = new oc.BRepTools_WireExplorer_2(w); ex.More(); ex.Next()) { edges.push(ex.Current()); verts.push(this.xyz(oc.BRep_Tool.Pnt(ex.CurrentVertex()))); }
    if (edges.length < 2) return w;
    // Winding from the polygon of the vertices and the edge middles (arcs count).
    const pts: V3[] = [];
    edges.forEach((e, i) => {
      pts.push(verts[i]);
      const c = new oc.BRepAdaptor_Curve_2(e), u = (c.FirstParameter() + c.LastParameter()) / 2;
      pts.push(this.xyz(c.Value(u)));
    });
    let area: V3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) area = add(area, cross(pts[i], pts[(i + 1) % pts.length]));
    if (dot(area, d) < 0) {
      // Reverse: the edges in the other order, each reversed; edge i then starts where it used to end.
      const n = edges.length;
      const rev = edges.map((_, i) => edges[n - 1 - i].Reversed());
      const rv = edges.map((_, i) => verts[(n - i) % n]);
      edges = rev.map(e => oc.TopoDS.Edge_1(e)); verts = rv;
    }
    if (at) {
      let k = 0;
      verts.forEach((v, i) => { if (d3(v, at) < d3(verts[k], at)) k = i; });
      edges = [...edges.slice(k), ...edges.slice(0, k)];
    }
    const mw = new oc.BRepBuilderAPI_MakeWire_1();
    for (const e of edges) mw.Add_1(e);
    return mw.IsDone() ? mw.Wire() : w;
  }

  /** The centre of a wire's length. */
  private wireCentre(w: any): V3 {
    const g = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.LinearProperties(w, g, false, false);
    return this.xyz(g.CentreOfMass());
  }

  /**
   * Guide curves for a loft (FR-FT-082, P5). ThruSections has no guides, so the free loft is cut by
   * planes between each pair of profiles and every cut is stretched in its plane (about its centre)
   * until it passes through the guides there: a uniform scale for one guide, the smallest change of
   * shape that reaches them for more. The profiles with those sections in between are lofted again.
   */
  private guidedSections(f: LoftFeature, wires: any[], ns: V3[], doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): any[] {
    const oc = this.oc;
    const guides = f.guides!.map(g => this.pathWire(g, doc, prev, frames));
    const cens = wires.map(w => this.wireCentre(w));
    let span = 0;
    for (let i = 1; i < cens.length; i++) span = Math.max(span, d3(cens[i], cens[0]));
    const tol = Math.max(1e-3, span * 1e-3);
    const dist = (a: any, b: any) => {
      const d = new oc.BRepExtrema_DistShapeShape_2(a, b, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
      return d.IsDone() ? d : null;
    };
    for (const g of guides) for (const w of wires) {
      const d = dist(g, w);
      if (!d || d.Value() > tol) throw new FeatureError("E-LOFT-GUIDE", "Each guide curve must touch every profile.");
    }
    const samples = guides.map(g => {
      const ag = new oc.BRepAdaptor_CompCurve_2(g, false), a = ag.FirstParameter(), b = ag.LastParameter();
      const m = Math.max(400, 120 * this.sub(g, "EDGE").length), pts: V3[] = [];
      for (let k = 0; k <= m; k++) pts.push(this.xyz(ag.Value(a + ((b - a) * k) / m)));
      return pts;
    });
    // The free loft the sections are cut from.
    const free = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
    for (const w of wires) free.AddWire(w);
    free.CheckCompatibility(!f.connectors?.some(Boolean));
    free.Build(new oc.Message_ProgressRange_1());
    if (!free.IsDone()) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles twist, or cross each other?");
    const solid = free.Shape();
    const K = 5, out: any[] = [wires[0]];
    for (let i = 0; i + 1 < wires.length; i++) {
      const gap = sub3(cens[i + 1], cens[i]);
      const n0 = dot(ns[i], gap) >= 0 ? ns[i] : mul(ns[i], -1), n1 = dot(ns[i + 1], gap) >= 0 ? ns[i + 1] : mul(ns[i + 1], -1);
      for (let k = 1; k <= K; k++) {
        const t = k / (K + 1);
        const c0 = add(cens[i], mul(gap, t)), n = unit(add(mul(n0, 1 - t), mul(n1, t)));
        const sec = new oc.BRepAlgoAPI_Section_5(solid, new oc.gp_Pln_3(this.P(c0), this.D(n)), true);
        const list = new oc.TopTools_ListOfShape_1();
        for (const e of this.sub(sec.Shape(), "EDGE")) list.Append_1(e);
        const mw = new oc.BRepBuilderAPI_MakeWire_1();
        if (list.Size() > 0) mw.Add_3(list);
        if (list.Size() === 0 || !mw.IsDone()) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles twist, or cross each other?");
        const w = mw.Wire(), c = this.wireCentre(w);
        const u = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), v = cross(n, u);
        const F: [number, number][] = [], G: [number, number][] = [];
        samples.forEach(pts => {
          let hit: V3 | null = null, best = Infinity;
          for (let j = 0; j + 1 < pts.length; j++) {
            const a = dot(sub3(pts[j], c), n), b = dot(sub3(pts[j + 1], c), n);
            if ((a <= 0 && b >= 0) || (a >= 0 && b <= 0)) {
              const s = Math.abs(a - b) < 1e-15 ? 0 : a / (a - b), p = add(pts[j], mul(sub3(pts[j + 1], pts[j]), s));
              if (d3(p, c) < best) { best = d3(p, c); hit = p; }
            }
          }
          if (!hit) throw new FeatureError("E-LOFT-GUIDE", "Each guide curve must run from the first profile to the last.");
          const d = dist(new oc.BRepBuilderAPI_MakeVertex(this.P(hit)).Vertex(), w);
          if (!d) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles twist, or cross each other?");
          const q = sub3(this.xyz(d.PointOnShape2(1)), c), h = sub3(hit, c);
          F.push([dot(q, u), dot(q, v)]);
          G.push([dot(h, u), dot(h, v)]);
        });
        // A = I + (G − F) F⁺ (for one guide, a uniform scale instead).
        let A = [[1, 0], [0, 1]];
        const ff = F.reduce((s, q) => s + q[0] * q[0] + q[1] * q[1], 0);
        if (!(ff > 1e-18)) throw new FeatureError("E-LOFT-GUIDE", "A guide curve meets the middle of the loft: the section would shrink to nothing.");
        if (F.length === 1) {
          const s = (F[0][0] * G[0][0] + F[0][1] * G[0][1]) / ff;
          A = [[s, 0], [0, s]];
        } else {
          const M = [[0, 0], [0, 0]];
          for (const q of F) { M[0][0] += q[0] * q[0]; M[0][1] += q[0] * q[1]; M[1][0] += q[1] * q[0]; M[1][1] += q[1] * q[1]; }
          const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
          const Mi = det > 1e-9 * ff * ff ? [[M[1][1] / det, -M[0][1] / det], [-M[1][0] / det, M[0][0] / det]] : [[1 / ff, 0], [0, 1 / ff]];
          for (let r = 0; r < 2; r++) for (let cc = 0; cc < 2; cc++) {
            let sum = 0;
            F.forEach((q, j) => { const pinv = q[0] * Mi[0][cc] + q[1] * Mi[1][cc]; sum += (G[j][r] - q[r]) * pinv; });
            A[r][cc] += sum;
          }
        }
        if (!(A[0][0] * A[1][1] - A[0][1] * A[1][0] > 1e-9)) throw new FeatureError("E-LOFT-GUIDE", "A guide curve meets the middle of the loft: the section would shrink to nothing.");
        const U = [u, v];
        const A3 = [0, 1, 2].map(r => [0, 1, 2].map(cc => (r === cc ? 1 : 0) + [0, 1].reduce((s, a) => s + [0, 1].reduce((s2, b) => s2 + U[a][r] * (A[a][b] - (a === b ? 1 : 0)) * U[b][cc], 0), 0)));
        const g = new oc.gp_GTrsf_1();
        for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) g.SetValue(r + 1, cc + 1, A3[r][cc]);
        const tr = [0, 1, 2].map(r => c[r] - (A3[r][0] * c[0] + A3[r][1] * c[1] + A3[r][2] * c[2]));
        g.SetTranslationPart(new oc.gp_XYZ_2(tr[0], tr[1], tr[2]));
        const moved = new oc.BRepBuilderAPI_GTransform_2(w, g, true).Shape();
        out.push(oc.TopoDS.Wire_1(moved));
      }
      out.push(wires[i + 1]);
    }
    return out;
  }

  /**
   * Loft with a centreline (FR-FT-082, P5): MakePipeShell along the centreline through every
   * profile in order, so the loft follows the path between them.
   */
  private loftAlong(f: LoftFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const spine = this.pathWire(f.centerline, doc, prev, frames);
    const mk = new oc.BRepOffsetAPI_MakePipeShell(spine);
    mk.SetMode_1(false);
    let firstEdges: [any, string][] = [];
    f.profiles.forEach((id, k) => {
      const { sk, frame } = this.sketchOf(id, doc, prev, frames, "the profile sketches");
      const { faces, edgeEnt } = this.profileFaces(sk, frame);
      if (faces.length !== 1) throw new FeatureError("E-LOFT-PROFILE", "Each loft profile must be one closed region.");
      if (k === 0) firstEdges = edgeEnt;
      mk.Add_1(oc.BRepTools.OuterWire(faces[0]), false, false);
    });
    mk.Build(new oc.Message_ProgressRange_1());
    if (!mk.IsDone()) throw new FeatureError("E-LOFT-FAIL", "The loft failed. Do the profiles sit across the centreline, in its order?");
    if (!mk.MakeSolid()) throw new FeatureError("E-LOFT-FAIL", "The loft did not close into a solid.");
    let shape = mk.Shape();
    if (this.volume(shape) < 0) shape = shape.Reversed();
    return this.applyTool(f, [this.nameSweep(mk, f.id, firstEdges, shape)], prev);
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
      const da = f.draft?.v ?? 0;
      if (Math.abs(da) > 1e-9) {
        // Rib draft (FR-FT-062): the walls along the growth taper about the sketch plane; faces lying on the body stay.
        if (f.dir !== "normal") throw new FeatureError("E-RIB-DRAFT", "Draft works on ribs normal to the sketch.");
        if (Math.abs(da) >= Math.PI / 4) throw new FeatureError("E-DRAFT-ANGLE", "The draft angle must be between 0° and 45°.");
        const walls = rib.faces.filter(x => {
          const pl = this.facePlane(x);
          if (pl && Math.abs(dot(pl.n, along!)) > 1e-6) return false;
          const c = this.centroid(x);
          return new oc.BRepClass3d_SolidClassifier_3(prev.shape, this.P(c), 1e-6).State() !== oc.TopAbs_State.TopAbs_ON;
        });
        rib = this.applyDraft(rib, walls, along!, f.draftOut ? -da : da, frame.o, f.id);
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
    if (f.heal) shape = this.healShape(shape, f.tol?.v ?? 0.1, false).shape;
    const faces = this.sub(shape, "FACE");
    const mine: Named = { shape, faces, names: faces.map((_, i) => `${f.id}:f${i}`) };
    return prev ? this.compoundOf([prev, mine]) : mine;
  }

  /**
   * Check and heal (FR-FT-131): sew faces closer than `tol`, run ShapeFix_Shape, turn closed shells
   * outside solids into solids and optionally merge faces lying on one surface. The report (free
   * edges, validity and solid count before and after) goes in the warning, which `statusText` translates.
   */
  private healShape(shape: any, tol: number, unify: boolean): { shape: any } {
    const oc = this.oc;
    if (!(tol > 0)) throw new FeatureError("E-FT-ZERO", "The tolerance must be more than 0.");
    const before = this.freeEdges(shape, 1e-6);
    const valid0 = new oc.BRepCheck_Analyzer(shape, true, false).IsValid_2();
    const sew = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
    sew.Add(shape);
    sew.Perform(new oc.Message_ProgressRange_1());
    let healed = sew.SewedShape();
    const fix = new oc.ShapeFix_Shape_2(healed);
    fix.SetPrecision(Math.min(tol, 1e-4));
    fix.SetMaxTolerance(tol);
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
    let out: any = comp;
    if (unify) {
      const un = new oc.ShapeUpgrade_UnifySameDomain_2(out, true, true, false);
      try { un.Build(); out = un.Shape(); } catch { /* keep the faces as they are */ }
    }
    const after = this.freeEdges(out, 1e-6);
    const valid1 = new oc.BRepCheck_Analyzer(out, true, false).IsValid_2();
    this.warning = `Check and heal: ${before} free edges before, ${after} after; ${valid0 ? "valid" : "not valid"} before, ${valid1 ? "valid" : "not valid"} after; ${this.solids(out)} solid bodies.`;
    return { shape: out };
  }

  /**
   * Check and heal as a feature (FR-FT-131): the whole body healed, faces keeping their names where
   * they are the same or (rebuilt by the healing) have the same centroid; merged faces take the name
   * of the largest face they cover.
   */
  private heal(f: HealFeature, prev: Named | null): Named {
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body to check.");
    const { shape } = this.healShape(prev.shape, f.tol.v, !!f.unify);
    const oc = this.oc;
    const area = (x: any) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(x, g, false, false); return g.Mass(); };
    const old = prev.faces.map((x, i) => ({ x, name: prev.names[i], c: this.centroid(x), a: area(x) }));
    const faces = this.sub(shape, "FACE");
    let k = 0;
    const names = faces.map(x => {
      const same = old.find(o => o.x.IsSame(x));
      if (same) return same.name;
      const c = this.centroid(x), tol = 1e-3 * (1 + this.size(x));
      let best: typeof old[number] | null = null;
      for (const o of old) if (d3(o.c, c) < tol && (!best || d3(o.c, c) < d3(best.c, c))) best = o;
      if (best) return best.name;
      // A merged face: the largest old face whose centroid lies on it.
      const on = (p: V3) => {
        const d = new oc.BRepExtrema_DistShapeShape_2(new oc.BRepBuilderAPI_MakeVertex(this.P(p)).Vertex(), x, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange_1());
        return d.IsDone() && d.Value() < tol;
      };
      const inside = old.filter(o => on(o.c)).sort((a, b) => b.a - a.a);
      return inside[0]?.name ?? `${f.id}:new:${k++}`;
    });
    return { shape, faces, names };
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

  /**
   * The Bodies folder (FR-BODY-001): each solid with a stable key (the id of the earliest feature that
   * named one of its faces, `#k` for later bodies of the same feature), a face to name it by, and its
   * volume. One solid is the whole body as it is (no face matching needed).
   */
  bodyInfo(body: Named, doc: PartDoc): { key: string; ref: FaceRef; volume: number; part: Named }[] {
    const n = this.solids(body.shape);
    if (!n) return [];
    const parts = n === 1 ? [body] : this.bodyList(body);
    const order = new Map(doc.features.map((f, i) => [f.id, i]));
    const seen = new Map<string, number>();
    return parts.map(part => {
      let best = "", bi = Infinity;
      for (const nm of part.names) { const id = nm.split(":")[0], i = order.get(id) ?? Infinity; if (i < bi) { bi = i; best = id; } }
      const k = seen.get(best) ?? 0;
      seen.set(best, k + 1);
      const j = part.names.findIndex(x => x.startsWith(`${best}:`));
      const face = part.faces[Math.max(0, j)];
      return { key: k ? `${best}#${k + 1}` : best, ref: { name: part.names[Math.max(0, j)], hint: this.centroid(face) }, volume: this.volume(part.shape), part };
    });
  }

  /** The bodies that are shown, back into one shape for the view. */
  shownBodies(parts: Named[]): Named { return this.compoundOf(parts); }

  /** A body as BREP text (Insert part, FR-BODY-005: another part's result kept in this one). */
  /**
   * Feature recognition (FR-FT-102): round holes in the body at the end of the document. A hole is a
   * set of cylinder faces (material outside) on one axis, open on a flat face square to it at one end
   * (blind, with a flat or 118° drilled bottom) or both (through). The faces to fill come back with,
   * for each hole, its plane (the opening face, as it is after the fill) and centre in that frame.
   */
  recognizeHoles(doc: PartDoc): { faces: FaceRef[]; holes: RecognizedHole[] } {
    const oc = this.oc;
    const r = this.evaluate(doc);
    const body = r.body;
    if (!body) return { faces: [], holes: [] };
    const tol = Math.max(1e-4, this.size(body.shape) * 1e-6);
    type Cyl = { i: number; o: V3; d: V3; r: number; v0: number; v1: number };
    type Pln = { i: number; o: V3; n: V3 };
    const cyls: Cyl[] = [], plns: Pln[] = [], cones: { i: number; o: V3; d: V3 }[] = [];
    body.faces.forEach((face, i) => {
      const ad = new oc.BRepAdaptor_Surface_2(face, true);
      const ty = ad.GetType();
      if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
        const c = ad.Cylinder(), ax = c.Axis();
        const o = this.xyz(ax.Location()), d = unit(this.xyz(ax.Direction()));
        // Normal and point at the same parameter (a full round's centroid lies on its axis).
        const u = (ad.FirstUParameter() + ad.LastUParameter()) / 2, v = (ad.FirstVParameter() + ad.LastVParameter()) / 2;
        const pp = new oc.gp_Pnt_1(), du = new oc.gp_Vec_1(), dv = new oc.gp_Vec_1();
        ad.D1(u, v, pp, du, dv);
        let n = unit(cross(this.xyz(du), this.xyz(dv)));
        if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
        const rel = sub3(this.xyz(pp), o), radial = sub3(rel, mul(d, dot(rel, d)));
        // Material outside: the face normal points at the axis.
        if (dot(n, radial) >= 0) return;
        const vs = [ad.FirstVParameter(), ad.LastVParameter()];
        cyls.push({ i, o, d, r: c.Radius(), v0: Math.min(...vs), v1: Math.max(...vs) });
      } else if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        plns.push({ i, o: this.xyz(ad.Plane().Location()), n: this.faceNormalAt(face) });
      } else if (ty === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
        const ax = ad.Cone().Axis();
        cones.push({ i, o: this.xyz(ax.Location()), d: unit(this.xyz(ax.Direction())) });
      }
    });
    const onAxis = (p: V3, o: V3, d: V3) => { const q = sub3(p, o); return Math.hypot(...sub3(q, mul(d, dot(q, d)))) < tol * 10; };
    // Group the cylinder faces of one hole (a full round is often two half faces).
    const groups: { o: V3; d: V3; r: number; lo: number; hi: number; faces: number[] }[] = [];
    for (const c of cyls) {
      const g = groups.find(g => Math.abs(g.r - c.r) < tol * 10 && Math.abs(Math.abs(dot(g.d, c.d)) - 1) < 1e-6 && onAxis(c.o, g.o, g.d));
      const s = (v: number) => dot(sub3(add(c.o, mul(c.d, v)), g ? g.o : c.o), g ? g.d : c.d);
      const a = s(c.v0), b = s(c.v1);
      if (g) { g.lo = Math.min(g.lo, a, b); g.hi = Math.max(g.hi, a, b); g.faces.push(c.i); }
      else groups.push({ o: c.o, d: c.d, r: c.r, lo: Math.min(a, b), hi: Math.max(a, b), faces: [c.i] });
    }
    const found: { faces: number[]; open: number; at: V3; end: "blind" | "through"; depth: number; flat: boolean; r: number }[] = [];
    for (const g of groups) {
      const P0 = add(g.o, mul(g.d, g.lo)), P1 = add(g.o, mul(g.d, g.hi));
      // A flat face square to the axis through an end, facing away from the hole: the hole opens there.
      const cap = (P: V3, out: V3) => plns.find(p => Math.abs(dot(sub3(P, p.o), p.n)) < tol * 10 && dot(p.n, out) > 1 - 1e-6);
      const floor = (P: V3, up: V3) => plns.find(p => Math.abs(dot(sub3(P, p.o), p.n)) < tol * 10 && dot(p.n, up) > 1 - 1e-6);
      const open0 = cap(P0, mul(g.d, -1)), open1 = cap(P1, g.d);
      const len = g.hi - g.lo;
      if (open0 && open1) { found.push({ faces: g.faces, open: open0.i, at: P0, end: "through", depth: len, flat: true, r: g.r }); continue; }
      const open = open0 ?? open1;
      if (!open) continue;
      const [at, bot, up] = open0 ? [P0, P1, mul(g.d, -1)] : [P1, P0, g.d];
      const flatFace = floor(bot, up);
      const cone = cones.find(c => Math.abs(Math.abs(dot(c.d, g.d)) - 1) < 1e-6 && onAxis(c.o, g.o, g.d));
      if (flatFace) found.push({ faces: [...g.faces, flatFace.i], open: open.i, at, end: "blind", depth: len, flat: true, r: g.r });
      else if (cone) found.push({ faces: [...g.faces, cone.i], open: open.i, at, end: "blind", depth: len, flat: false, r: g.r });
    }
    // A face another hole fills cannot hold a hole.
    const filled = new Set(found.flatMap(h => h.faces));
    const keep = found.filter(h => !filled.has(h.open));
    if (!keep.length) return { faces: [], holes: [] };
    const ref = (i: number): FaceRef => ({ name: body.names[i], hint: this.centroid(body.faces[i]) });
    const faces = keep.flatMap(h => h.faces.map(ref));
    // The planes are measured after the fill, which is what the hole features will be built on.
    const del: Feature = { id: "__recog", type: "delface", name: "", faces };
    const after = this.evaluate({ ...doc, rollback: null, features: [...doc.features.slice(0, doc.rollback ?? doc.features.length), del] });
    if (after.statuses.at(-1)?.ok === false || !after.body) return { faces: [], holes: [] };
    const holes: RecognizedHole[] = keep.map(h => {
      const plane: PlaneRef = { face: { name: body.names[h.open], hint: h.at } };
      const fr = this.planeFrame(plane, after.body, after.frames);
      const q = sub3(h.at, fr.o);
      return { plane, pt: [dot(q, fr.x), dot(q, fr.y)], diameter: 2 * h.r, end: h.end, depth: h.depth, flat: h.flat };
    });
    return { faces, holes };
  }

  brepText(body: Named): { brep: string; solids: number; faces: number } {
    const oc = this.oc as any;
    const path = `/part${Date.now()}${Math.floor(Math.random() * 1e6)}.brep`;
    oc.BRepTools.Write_4(body.shape, path, false, false, oc.TopTools_FormatVersion.TopTools_FormatVersion_CURRENT, new oc.Message_ProgressRange_1());
    const brep = oc.FS.readFile(path, { encoding: "utf8" }) as string;
    oc.FS.unlink(path);
    return { brep, solids: this.solids(body.shape), faces: body.faces.length };
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

  /** A solid grown (or shrunk) by `d`, with rounded corners; faces named `<tag>:<k>`. */
  private grown(b: Named, d: number, tag: string): Named {
    const oc = this.oc;
    if (Math.abs(d) < 1e-9) return { shape: b.shape, faces: b.faces, names: b.faces.map((_, k) => `${tag}:${k}`) };
    const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
    try { mk.PerformByJoin(b.shape, d, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    if (!mk.IsDone()) throw new FeatureError("E-IND-OFFSET", "The tool body could not be offset: try a smaller clearance or thickness.");
    let sh = mk.Shape();
    if (sh.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
      const map = new oc.TopTools_IndexedMapOfShape_1();
      oc.TopExp.MapShapes_1(sh, oc.TopAbs_ShapeEnum.TopAbs_SHELL, map);
      const shells: any[] = [];
      for (let k = 1; k <= map.Extent(); k++) shells.push(map.FindKey(k));
      if (shells.length !== 1) throw new FeatureError("E-IND-OFFSET", "The tool body could not be offset: try a smaller clearance or thickness.");
      sh = new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(shells[0])).Solid();
      const fix = new oc.ShapeFix_Solid_1(); fix.Init(sh); fix.Perform(new oc.Message_ProgressRange_1()); sh = fix.Solid();
    }
    const faces = this.sub(sh, "FACE");
    return { shape: sh, faces, names: faces.map((_, k) => `${tag}:${k}`) };
  }

  /** Indent (FR-BODY-007). */
  private indent(f: IndentFeature, prev: Named | null): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    const list = this.bodyList(prev);
    if (!f.main) throw new FeatureError("E-IND-BODIES", "Pick the target body and at least one tool body.");
    const mi = this.bodyIndex(list, prev, f.main);
    const ti = this.pickedBodies(list, prev, f.tools).filter(i => i !== mi);
    if (!ti.length) throw new FeatureError("E-IND-BODIES", "Pick the target body and at least one tool body.");
    const c = Math.max(0, f.clearance.v), t = f.thickness.v;
    if (!f.cut && !(t > 1e-6)) throw new FeatureError("E-IND-THICK", "Give a thickness.");
    const centre = (sh: any): V3 => { const p = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(sh, p, true, false, false); return this.xyz(p.CentreOfMass()); };
    let target = list[mi];
    for (const i of ti) {
      const tool = list[i];
      const common = this.bool("common", tool, target, f.id);
      if (this.volume(common.shape) < 1e-9) throw new FeatureError("E-IND-MISS", "A tool body does not touch the target body.");
      if (!f.cut) {
        // The tools press in from the side where they stick out: the wall grows away from there.
        const out = this.bool("cut", tool, target, f.id);
        let d: V3 = [0, 0, 0];
        if (this.volume(out.shape) > 1e-9) {
          const a = centre(out.shape), b = centre(common.shape), v = sub3(b, a), l = Math.hypot(...v);
          if (l > 1e-9) d = mul(v, 1 / l);
        }
        const outer = this.grown(tool, c + t, `${f.id}:w${i}`);
        let region = target;
        if (Math.hypot(...d) > 0) for (let k = 1; k <= 4; k++) {
          const tr = new oc.gp_Trsf_1();
          tr.SetTranslation_1(this.V(mul(d, (c + t) * k / 4)));
          const mv = new oc.BRepBuilderAPI_Transform_2(target.shape, tr, true).Shape();
          const faces = this.sub(mv, "FACE");
          region = this.bool("fuse", region, { shape: mv, faces, names: faces.map((_, j) => `${f.id}:r:${j}`) }, f.id);
        }
        else {
          const box = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(target.shape, box, false);
          box.Enlarge(c + t);
          const lo = this.xyz(box.CornerMin()), hi = this.xyz(box.CornerMax());
          const bx = new oc.BRepPrimAPI_MakeBox_4(this.P(lo), this.P(hi)).Shape(), faces = this.sub(bx, "FACE");
          region = { shape: bx, faces, names: faces.map((_, j) => `${f.id}:r:${j}`) };
        }
        const wall = this.bool("common", outer, region, f.id);
        if (this.volume(wall.shape) > 1e-9) target = this.bool("fuse", target, wall, f.id);
      }
      target = this.bool("cut", target, this.grown(tool, c, `${f.id}:c${i}`), f.id);
    }
    if (this.volume(target.shape) < 1e-9) throw new FeatureError("E-IND-EMPTY", "Nothing is left of the target body.");
    return this.compoundOf([...list.filter((_, i) => i !== mi), ...this.bodyList(target)]);
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

  /**
   * What a mirror or pattern copies (FR-FT-070..073): feature tools (the default), the boss or cut that
   * picked faces bound, or picked bodies. `whole` (a mirror with nothing picked) copies the whole body.
   */
  private seedSet(f: CopySource & { id: string; features: string[] }, doc: PartDoc, prev: Named | null, whole = false): { tools: Tool[]; seeds: Tool[]; list: Named[]; idx: number[] } {
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (f.copy === "bodies") {
      if (!f.bodies?.length) throw new FeatureError("E-PAT-BODIES", "Pick the bodies to copy.");
      const list = this.bodyList(prev);
      return { tools: [], seeds: [], list, idx: this.pickedBodies(list, prev, f.bodies) };
    }
    if (f.copy === "faces") { const t = this.faceTool(f.faces, prev, f.id); return { tools: [t], seeds: [t], list: [], idx: [] }; }
    if (whole && !f.features.length) return { tools: [{ shape: prev, op: "fuse" }], seeds: [], list: [], idx: [] };
    const tools = this.seedTools(f.features, doc);
    return { tools, seeds: tools, list: [], idx: [] };
  }

  /**
   * The boss or cut some faces bound (FR-FT-070 faces): the faces are deleted (their neighbours grow to
   * close the gap) and the difference from the body is the tool, fused when the faces stood out, cut when
   * they went in.
   */
  private faceTool(refs: FaceRef[] | undefined, prev: Named, fid: string): Tool {
    const oc = this.oc;
    if (!refs?.length) throw new FeatureError("E-PAT-FACES", "Pick the faces to copy.");
    const mk = new oc.BRepAlgoAPI_Defeaturing();
    mk.SetShape(prev.shape);
    for (const r of refs) mk.AddFaceToRemove(this.resolveFace(prev, r));
    try { mk.Build(new oc.Message_ProgressRange_1()); } catch { /* reported below */ }
    const bad = () => new FeatureError("E-PAT-FACESET", "The faces could not be copied: pick all the faces of one boss or cut.");
    if (!mk.IsDone() || mk.HasErrors()) throw bad();
    const shape = mk.Shape(), faces = this.sub(shape, "FACE");
    const rest: Named = { shape, faces, names: faces.map((_, i) => `${fid}:rest:${i}`) };
    const vb = this.volume(prev.shape), vr = this.volume(shape);
    if (Math.abs(vb - vr) < 1e-9 * Math.max(1, vb)) throw bad();
    return vr < vb ? { shape: this.bool("cut", prev, rest, fid), op: "fuse" } : { shape: this.bool("cut", rest, prev, fid), op: "cut" };
  }

  /** The centre of what a pattern copies (the reference point of a sketch-driven pattern). */
  private seedCentre(set: { tools: Tool[]; list: Named[]; idx: number[] }): V3 {
    const oc = this.oc, p = new oc.GProp_GProps_1();
    const shapes = set.idx.length ? set.idx.map(i => set.list[i].shape) : set.tools.map(t => t.shape.shape);
    for (const sh of shapes) { const q = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(sh, q, true, false, false); p.Add(q, 1); }
    return this.xyz(p.CentreOfMass());
  }

  /**
   * Applies a mirror or pattern's transforms. Bodies: each copy becomes a new body (a mirror with merge
   * joins it to its original). Otherwise the tools are applied as bosses and cuts (see `applyCopies`).
   */
  private copyBy(f: CopySource & { id: string; type: string; merge?: boolean }, prev: Named, set: { tools: Tool[]; seeds: Tool[]; list: Named[]; idx: number[] }, xfs: { trsf: any; tag: (k: number) => string; label: string }[]): Named {
    if (f.copy === "bodies") {
      const out = [...set.list];
      for (const xf of xfs) for (const i of set.idx) {
        const c = this.transformed({ shape: set.list[i], op: "fuse" }, xf.trsf, f.id, xf.tag(i)).shape;
        if (f.merge) out[i] = this.bool("fuse", out[i], c, f.id);
        else out.push(c);
      }
      return this.compoundOf(out.flatMap(b => this.solids(b.shape) > 1 ? this.bodyList(b) : [b]));
    }
    const copies = xfs.flatMap(xf => set.tools.map((t, k) => ({ tool: this.transformed(t, xf.trsf, f.id, xf.tag(k)), label: xf.label })));
    return this.applyCopies(prev, copies, f.id, set.seeds);
  }

  /** Mirror (FR-FT-072): the seed features' tools reflected in a plane, or the whole body joined to its reflection. */
  private mirror(f: MirrorFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    if (!prev) throw new FeatureError("E-FT-NOBODY", "There is no body yet.");
    if (!f.plane) throw new FeatureError("E-MIR-PLANE", "Pick a plane or a flat face to mirror about.");
    const fr = this.planeFrame(f.plane, prev, frames);
    const trsf = new oc.gp_Trsf_1();
    trsf.SetMirror_3(new oc.gp_Ax2_3(this.P(fr.o), this.D(fr.n)));
    const set = this.seedSet(f, doc, prev, true);
    return this.copyBy(f, prev, set, [{ trsf, tag: k => f.copy === "bodies" ? `mb${k}` : `m${k}`, label: "1" }]);
  }

  /** Linear pattern (FR-FT-070): count × count2 copies; instance (0, 0) is the seed. */
  private linearPattern(f: LinearPatternFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const set = this.seedSet(f, doc, prev);
    const d1 = mul(this.lineOf(f.dir, prev, frames, "a direction: an edge, a face or an axis").d, f.flip ? -1 : 1);
    const n1 = Math.max(1, Math.round(f.count)), n2 = f.dir2 ? Math.max(1, Math.round(f.count2 ?? 1)) : 1;
    const d2 = f.dir2 ? mul(this.lineOf(f.dir2, prev, frames, "the second direction").d, f.flip2 ? -1 : 1) : [0, 0, 0] as V3;
    if (n1 * n2 < 2) throw new FeatureError("E-PAT-COUNT", "The pattern needs at least 2 instances.");
    if (!(f.spacing.v > 1e-6) || (f.dir2 && n2 > 1 && !((f.spacing2?.v ?? 0) > 1e-6))) throw new FeatureError("E-FT-ZERO", "The spacing must be more than 0.");
    const skip = new Set(f.skip ?? []);
    const xfs: { trsf: any; tag: (k: number) => string; label: string }[] = [];
    for (let j = 0; j < n2; j++) for (let i = 0; i < n1; i++) {
      if (i === 0 && j === 0) continue;
      const key = f.dir2 ? `${i},${j}` : `${i}`;
      if (skip.has(key)) continue;
      const v = add(mul(d1, i * f.spacing.v), mul(d2, j * (f.spacing2?.v ?? 0)));
      const trsf = new oc.gp_Trsf_1();
      trsf.SetTranslation_1(this.V(v));
      const tk = key.replace(",", "_");
      xfs.push({ trsf, tag: k => f.copy === "bodies" ? `i${tk}b${k}` : `i${tk}s${k}`, label: key });
    }
    return this.copyBy(f, prev!, set, xfs);
  }

  /** Circular pattern (FR-FT-071): copies turned about an axis; equal spacing spreads them over the angle. */
  private circularPattern(f: CircularPatternFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const set = this.seedSet(f, doc, prev);
    const ax = this.lineOf(f.axis, prev, frames, "an axis: a round edge or face, a straight edge or a reference axis");
    const n = Math.max(1, Math.round(f.count));
    if (n < 2) throw new FeatureError("E-PAT-COUNT", "The pattern needs at least 2 instances.");
    const total = f.angle.v;
    if (!(total > 1e-9)) throw new FeatureError("E-FT-ZERO", "The angle must be more than 0.");
    const full = Math.abs(total - 2 * Math.PI) < 1e-9;
    const step = f.equal ? total / (full ? n : n - 1) : total;
    const skip = new Set(f.skip ?? []);
    const xfs: { trsf: any; tag: (k: number) => string; label: string }[] = [];
    for (let i = 1; i < n; i++) {
      if (skip.has(String(i))) continue;
      const trsf = new oc.gp_Trsf_1();
      trsf.SetRotation_1(new oc.gp_Ax1_2(this.P(ax.o), this.D(ax.d)), (f.flip ? -1 : 1) * step * i);
      xfs.push({ trsf, tag: k => f.copy === "bodies" ? `i${i}b${k}` : `i${i}s${k}`, label: String(i) });
    }
    return this.copyBy(f, prev!, set, xfs);
  }

  /**
   * Sketch-driven / table-driven pattern (FR-FT-073): a copy moved from the seed's reference point to each
   * free point of a sketch (points that are not ends or centres of curves, construction or not), or by
   * each table row's X/Y offset in a coordinate system.
   */
  private sketchPattern(f: SketchPatternFeature, doc: PartDoc, prev: Named | null, frames: Record<string, Frame>): Named {
    const oc = this.oc;
    const set = this.seedSet(f, doc, prev);
    const offs: V3[] = [];
    if (f.src === "table") {
      const fr = f.csys ? frames[f.csys] : { o: [0, 0, 0] as V3, x: [1, 0, 0] as V3, y: [0, 1, 0] as V3, n: [0, 0, 1] as V3 };
      if (!fr) throw new FeatureError("E-FT-PARENT", "The coordinate system is missing or has an error.");
      for (const r of f.table ?? []) offs.push(add(mul(fr.x, r.x.v), mul(fr.y, r.y.v)));
    } else {
      const sk = doc.features.find(x => x.id === f.sketch);
      if (!sk || sk.type !== "sketch") throw new FeatureError("E-SPAT-SKETCH", "Pick a sketch with points.");
      const fr = frames[sk.id];
      if (!fr) throw new FeatureError("E-FT-PARENT", "A sketch or plane this feature uses has an error.");
      const used = new Set<string>();
      for (const e of sk.ents) if (e.t !== "point") for (const k of ["a", "b", "c", "p0", "p1"] as const) { const v = (e as Record<string, unknown>)[k]; if (typeof v === "string") used.add(v); }
      for (const e of sk.ents) if (e.t === "spline") for (const q of e.pts) used.add(q);
      const pts = sk.ents.filter(e => e.t === "point" && !used.has(e.id) && e.id !== f.refPt) as { id: string; x: number; y: number }[];
      const ref = f.refPt ? sk.ents.find(e => e.id === f.refPt && e.t === "point") as { x: number; y: number } | undefined : undefined;
      let r: [number, number];
      if (ref) r = [ref.x, ref.y];
      else { const c = sub3(this.seedCentre(set), fr.o); r = [dot(c, fr.x), dot(c, fr.y)]; }
      for (const q of pts) offs.push(add(mul(fr.x, q.x - r[0]), mul(fr.y, q.y - r[1])));
    }
    const xfs: { trsf: any; tag: (k: number) => string; label: string }[] = [];
    offs.forEach((v, i) => {
      if (Math.hypot(...v) < 1e-6) return;
      const trsf = new oc.gp_Trsf_1();
      trsf.SetTranslation_1(this.V(v));
      xfs.push({ trsf, tag: k => f.copy === "bodies" ? `p${i}b${k}` : `p${i}s${k}`, label: String(i + 1) });
    });
    if (!xfs.length) throw new FeatureError("E-SPAT-NONE", f.src === "table" ? "Add table rows with offsets other than 0, 0." : "The sketch has no free points away from the seed.");
    return this.copyBy(f, prev!, set, xfs);
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
  evaluate(doc: PartDoc): { body: Named | null; sheets: Named | null; statuses: FeatureStatus[]; frames: Record<string, Frame>; sketches: Record<string, SketchFeature>; curves: Record<string, V3[]>; regions: Record<string, IntersectRegion[]>; sheet: SheetState | null } {
    const end = doc.rollback ?? doc.features.length;
    // Sketches whose On edge curves moved with the model (FR-SK-064): later features use the moved copy.
    doc = { ...doc, features: [...doc.features] };
    const sketches: Record<string, SketchFeature> = {};
    let body: Named | null = null;
    // Surface bodies (FRS 9.11): open sheets, kept apart from the solids.
    let sheets: Named | null = null;
    // Sheet metal (FR-FT-120): the panels and bends made so far.
    let sm: SheetState | null = null;
    let chain = "";
    const statuses: FeatureStatus[] = [];
    const frames: Record<string, Frame> = {};
    const failed = new Set<string>();
    const next: CacheEntry[] = [];
    this.tools = new Map();
    this.curves = new Map();
    this.regions = new Map();
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
        if (hit.regions) this.regions.set(f.id, hit.regions);
        if (!hit.status.ok) failed.add(f.id);
        body = hit.body;
        sheets = hit.sheets;
        sm = hit.sm ?? null;
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
          else if (f.type === "delface" && f.mode === "delete") { if (!body) throw new FeatureError("E-FT-NOBODY", "There is no body yet."); if (!f.faces.length) throw new FeatureError("E-FT-NOFACES", "Click the faces to delete."); ({ body, sheets } = this.deleteToSurface(f, body, sheets)); }
          else if (f.type === "delface") body = this.deleteFaces(f, body);
          else if (f.type === "revsurf") sheets = this.revSurf(f, doc, body, sheets, frames);
          else if (f.type === "loftsurf") sheets = this.loftSurf(f, doc, body, sheets, frames);
          else if (f.type === "trimsurf") sheets = this.trimSurf(f, body, sheets, frames);
          else if (f.type === "fillsurf") sheets = this.fillSurf(f, sheets);
          else if (f.type === "extendsurf") sheets = this.extendSurf(f, sheets);
          else if (f.type === "untrimsurf") sheets = this.untrimSurf(f, sheets);
          else if (f.type === "intersect") ({ body, sheets } = this.intersect(f, body, sheets));
          else if (f.type === "moveface") body = this.moveFaces(f, body, frames);
          else if (f.type === "planesurf") sheets = this.planeSurf(f, doc, body, sheets, frames);
          else if (f.type === "extsurf") sheets = this.extSurf(f, doc, body, sheets, frames);
          else if (f.type === "offsurf") sheets = this.offSurf(f, body, sheets);
          else if (f.type === "knit") ({ body, sheets } = this.knit(f, body, sheets));
          else if (f.type === "replaceface") body = this.replaceFaces(f, body, sheets);
          else if (f.type === "thicken") ({ body, sheets } = this.thicken(f, body, sheets));
          else if (f.type === "draft") body = this.draft(f, body, frames);
          else if (f.type === "hole") { const h = this.hole(f, body, frames); body = h.body; frame = h.frame; frames[f.id] = frame; }
          else if (f.type === "mirror") body = this.mirror(f, doc, body, frames);
          else if (f.type === "helix") this.curves.set(f.id, this.helix(f, doc, body, frames));
          else if (f.type === "sketch3d") this.curves.set(f.id, this.sketch3d(f));
          else if (f.type === "curve") this.curves.set(f.id, this.curve(f, doc, body, sheets, frames));
          else if (f.type === "sweepsurf") sheets = this.sweepSurf(f, doc, body, sheets, frames);
          else if (f.type === "sweep") body = this.sweepAlong(f, doc, body, frames);
          else if (f.type === "loft") body = this.loft(f, doc, body, frames);
          else if (f.type === "rib") body = this.rib(f, doc, body, frames);
          else if (isSheet(f)) ({ body, sm } = evalSheet(this.sheetApi(), f, doc, body, sm, sk => this.frameOf(sk, body, frames)));
          else if (isWeld(f)) body = evalWeld(this as unknown as WeldHost, f, doc, body, frames);
          else if (f.type === "split") body = this.splitLine(f, doc, body, frames);
          else if (f.type === "import") body = this.importBody(f, body);
          else if (f.type === "heal") body = this.heal(f, body);
          else if (f.type === "combine") body = this.combine(f, body);
          else if (f.type === "indent") body = this.indent(f, body);
          else if (f.type === "bsplit") body = this.splitBody(f, body, frames);
          else if (f.type === "delbody") body = this.deleteBodies(f, body);
          else if (f.type === "movebody") body = this.moveBodies(f, body, frames);
          else if (f.type === "scale") body = this.scaleBodies(f, body);
          else if (f.type === "lpattern") body = this.linearPattern(f, doc, body, frames);
          else if (f.type === "cpattern") body = this.circularPattern(f, doc, body, frames);
          else if (f.type === "spattern") body = this.sketchPattern(f, doc, body, frames);
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
          const coded = e instanceof FeatureError || e instanceof SheetError;
          status = { id: f.id, ok: false, code: coded ? (e as FeatureError).code : "E-KRN", message: coded ? e.message : `Kernel error: ${e.message ?? e}` };
          failed.add(f.id);
        }
      }
      statuses.push(status);
      next.push({ key: chain, body, sheets, status, frame: frame ?? frames[f.id], tools: this.tools.get(f.id), sketch: moved, curve: this.curves.get(f.id), regions: this.regions.get(f.id), sm });
    });
    this.cache = next;
    const curves: Record<string, V3[]> = {};
    for (const [id, c] of this.curves) curves[id] = c.pts;
    return { body, sheets, statuses, frames, sketches, curves, regions: Object.fromEntries(this.regions), sheet: sm };
  }

  /** The helpers sheet metal (src/sheetmetal) builds its solids with. */
  private sheetApi() {
    return { oc: this.oc, bool: this.bool.bind(this), segEdge: (s: Seg, fr: Frame) => this.segEdge(s, fr), sub: this.sub.bind(this), centroid: this.centroid.bind(this) };
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
