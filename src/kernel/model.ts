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
import type { AxisFeature, BodyProps, EdgeRef, FaceRef, Feature, FeatureStatus, Frame, PartDoc, PlaneFeature, PlaneRef, PointFeature, SketchFeature, V3 } from "../model/types";
import { featureRefs } from "../model/doc";
import { sketchProfile, type ProfileFace, type Seg } from "../sketch/profile";

export class FeatureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A body and the names of its faces (parallel arrays). */
interface Named { shape: any; faces: any[]; names: string[] }

interface CacheEntry { key: string; body: Named | null; status: FeatureStatus; frame?: Frame }

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
      else {
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
      const mk = new oc.BRepBuilderAPI_MakeFace_15(wireOf(pf.outer), true);
      for (const h of pf.holes) mk.Add(wireOf(h));
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
    if (f.type === "extrude" && f.end === "upto") {
      tools = this.upTo(f, sk, frame, prev, frames);
    } else if (f.type === "extrude") {
      // A cut goes into the material (against the sketch normal); Reverse direction flips either.
      const dir = (f.op === "cut" ? -1 : 1) * (f.flip ? -1 : 1);
      let d1 = f.depth.v, d2 = f.depth2?.v ?? 0;
      if (f.end === "mid") { d2 = d1 / 2; d1 = d1 / 2; }
      if (f.end === "through") {
        if (!prev) throw new FeatureError("E-FT-NOBODY", "Through all needs a body to cut.");
        d1 = this.size(prev.shape) * 2 + 1;
        d2 = f.op === "cut" ? 0 : 0;
      }
      if (!(d1 + d2 > 1e-6)) throw new FeatureError("E-FT-ZERO", "The depth must be more than 0.");
      const off = mul(frame.n, -d2 * dir);
      const { faces, edgeEnt } = this.profileFaces(sk, frame, off);
      for (const face of faces) {
        const mk = new oc.BRepPrimAPI_MakePrism_1(face, this.V(mul(frame.n, (d1 + d2) * dir)), false, true);
        mk.Build(new oc.Message_ProgressRange_1());
        if (!mk.IsDone()) throw new FeatureError("E-FT-FAIL", "The extrusion failed.");
        tools.push(this.nameSweep(mk, f.id, edgeEnt, mk.Shape()));
      }
    } else {
      const ax = sk.ents.find(e => e.id === f.axis);
      if (!ax || ax.t !== "line") throw new FeatureError("E-FT-AXIS", "Pick a line of the sketch as the axis.");
      const pa = sk.ents.find(e => e.id === ax.a), pb = sk.ents.find(e => e.id === ax.b);
      if (!pa || pa.t !== "point" || !pb || pb.t !== "point") throw new FeatureError("E-FT-AXIS", "The axis line is broken.");
      const A = this.w(frame, [pa.x, pa.y]), B = this.w(frame, [pb.x, pb.y]);
      const dirV: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      if (Math.hypot(...dirV) < 1e-9) throw new FeatureError("E-FT-AXIS", "The axis line has no length.");
      const angle = Math.min(f.angle.v, Math.PI * 2);
      if (!(angle > 1e-9)) throw new FeatureError("E-FT-ZERO", "The angle must be more than 0.");
      const sgn = f.flip ? -1 : 1;
      const { faces, edgeEnt } = this.profileFaces(sk, frame, [0, 0, 0], new Set([ax.id]));
      for (let face of faces) {
        if (f.mid && angle < Math.PI * 2 - 1e-9) {
          const tr = new oc.gp_Trsf_1();
          tr.SetRotation_1(new oc.gp_Ax1_2(this.P(A), this.D(dirV)), -sgn * angle / 2);
          const mk = new oc.BRepBuilderAPI_Transform_2(face, tr, false);
          face = mk.Shape();
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
    const pts = prof.faces.flatMap(pf => pf.outer.flatMap(sg => (sg.kind === "circle" ? [[sg.c[0] - sg.r, sg.c[1]], [sg.c[0] + sg.r, sg.c[1]]] : [sg.a, sg.b]))) as [number, number][];
    const mid: [number, number] = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const c = this.w(frame, mid);
    const den = dot(frame.n, target.n);
    if (Math.abs(den) < 1e-9) throw new FeatureError("E-FT-UPTO", "The face is parallel to the extrusion direction.");
    const s = dot(add(target.o, mul(c, -1)), target.n) / den;
    if (Math.abs(s) < 1e-7) throw new FeatureError("E-FT-ZERO", "The face is in the sketch plane.");
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
    doc.features.forEach((f, i) => {
      if (i >= end) { statuses.push({ id: f.id, ok: true, code: "rolled-back" }); return; }
      chain = `${chain}|${JSON.stringify(f)}`;
      const hit = this.cache[i];
      if (hit && hit.key === chain) {
        next.push(hit);
        statuses.push(hit.status);
        if (hit.frame) frames[f.id] = hit.frame;
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
          if (this.warning) status = { id: f.id, ok: true, code: "warning", warning: this.warning };
        } catch (err) {
          const e = err as Error;
          status = { id: f.id, ok: false, code: e instanceof FeatureError ? e.code : "E-KRN", message: e instanceof FeatureError ? e.message : `Kernel error: ${e.message ?? e}` };
          failed.add(f.id);
        }
      }
      statuses.push(status);
      next.push({ key: chain, body, status, frame });
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
