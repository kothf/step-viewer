// Parasolid B-rep (as parsed by parasolid-kit in native/parasolid-wasm) to
// OpenCASCADE shapes, so SLDPRT parts open with exact geometry.
//
// The Parasolid model is topology (body, region, shell, face, loop, fin, edge,
// vertex) plus geometry (curves, surfaces). Edges and vertices are built once
// and shared by the faces on both sides, faces get their surface and their
// loops as wires with 3D curves only, and ShapeFix then adds what OCCT needs
// and Parasolid does not store: parameter curves, seams on periodic surfaces,
// and tolerances. That is the same route OCCT's own STEP reader takes.
//
// Parasolid lengths are metres; everything is built in millimetres.

/* eslint-disable @typescript-eslint/no-explicit-any */

type V = [number, number, number];
type Id = number;

export interface PsCurve {
  id: Id; sense: number; t: string;
  point?: V; dir?: V; center?: V; normal?: V; x?: V; r?: number; r1?: number; r2?: number; f?: number;
  basis?: Id; p0?: V; p1?: V; t0?: number; t1?: number;
  degree?: number; dim?: number; periodic?: boolean; closed?: boolean; rational?: boolean; cv?: number[]; knots?: number[]; mults?: number[];
  surface?: Id; pcurve?: Id; original?: Id | null;
  surfaces?: [Id, Id]; chart?: V[]; start?: V | null; end?: V | null;
}

export interface PsSurface {
  id: Id; sense: number; t: string;
  point?: V; normal?: V; axis?: V; x?: V; r?: number; r1?: number; r2?: number; sin?: number; cos?: number;
  blend?: string; supports?: [Id, Id]; spine?: Id; ranges?: [number, number];
  index?: number; blendSurface?: Id; profile?: Id; section?: Id; dir?: V; basis?: Id; offset?: number;
  uDegree?: number; vDegree?: number; nu?: number; nv?: number; dim?: number; uPeriodic?: boolean; vPeriodic?: boolean; rational?: boolean;
  cv?: number[]; uKnots?: number[]; vKnots?: number[]; uMults?: number[]; vMults?: number[];
}

export interface PsModel {
  ok: boolean; error?: string; key: string; complete: boolean;
  diagnostics: { code: string; message: string }[];
  bodies: { id: Id; res: number; regions: Id[] }[];
  regions: { id: Id; body: Id; solid: boolean; shells: Id[] }[];
  shells: { id: Id; region: Id; front: Id[]; back: Id[]; wires: Id[] }[];
  faces: { id: Id; front: Id; back: Id; sense: number; surface: Id | null; loops: Id[] }[];
  loops: { id: Id; face: Id; fins: Id[] }[];
  fins: { id: Id; sense: number; dummy: boolean; loop: Id | null; edge: Id | null; vertex: Id | null; curve: Id | null; other: Id | null; next: Id | null }[];
  edges: { id: Id; start: Id | null; end: Id | null; curve: Id | null; tol: number | null; fins: Id[] }[];
  vertices: { id: Id; p: V | null; tol: number | null }[];
  curves: PsCurve[];
  surfaces: PsSurface[];
  attributes: { name: string; owner: string; of: Id; reals: (number | null)[]; text: string | null }[];
}

export interface PsBody {
  id: Id;
  shape: any;
  /** RGB 0..1 from the body's colour attribute, if any. */
  color: V | null;
  faces: number;
  /** Faces that could not be built (left out of the shape). */
  failed: number;
}

const S = 1000; // metres to millimetres

export class ParasolidBuilder {
  private curves = new Map<Id, PsCurve>();
  private surfaces = new Map<Id, PsSurface>();
  private fins = new Map<Id, PsModel["fins"][number]>();
  private loops = new Map<Id, PsModel["loops"][number]>();
  private edges = new Map<Id, PsModel["edges"][number]>();
  private vertexDefs = new Map<Id, PsModel["vertices"][number]>();
  private faceDefs = new Map<Id, PsModel["faces"][number]>();
  private geomCurves = new Map<Id, any>();
  private geomSurfaces = new Map<Id, any>();
  private vertices = new Map<Id, any>();
  /** Built edge per Parasolid edge, oriented from its start vertex to its end vertex. */
  private topoEdges = new Map<Id, any>();
  private builder: any;
  /** Why faces or edges failed, for the report. */
  notes: string[] = [];

  private oc: any;
  private m: PsModel;

  constructor(oc: any, m: PsModel) {
    this.oc = oc;
    this.m = m;
    for (const c of m.curves) this.curves.set(c.id, c);
    for (const s of m.surfaces) this.surfaces.set(s.id, s);
    for (const f of m.fins) this.fins.set(f.id, f);
    for (const l of m.loops) this.loops.set(l.id, l);
    for (const e of m.edges) this.edges.set(e.id, e);
    for (const v of m.vertices) this.vertexDefs.set(v.id, v);
    for (const f of m.faces) this.faceDefs.set(f.id, f);
    this.builder = new oc.BRep_Builder();
  }

  private note(msg: string) { if (this.notes.length < 40) this.notes.push(msg); }

  // ---------- basic values ----------

  private pnt(v: V) { return new this.oc.gp_Pnt_3(v[0] * S, v[1] * S, v[2] * S); }
  private dir(v: V) { return new this.oc.gp_Dir_4(v[0], v[1], v[2]); }
  private ax2(p: V, n: V, x: V) { return new this.oc.gp_Ax2_2(this.pnt(p), this.dir(n), this.dir(x)); }
  private ax3(p: V, n: V, x: V) { return new this.oc.gp_Ax3_3(this.pnt(p), this.dir(n), this.dir(x)); }
  private hc(c: any) { return new this.oc.Handle_Geom_Curve_2(c); }
  private hs(s: any) { return new this.oc.Handle_Geom_Surface_2(s); }

  // ---------- curves ----------

  /** The 3D curve of a Parasolid curve, in its own parameter direction (sense not applied). */
  curve(id: Id): any {
    const hit = this.geomCurves.get(id);
    if (hit) return hit;
    const c = this.curves.get(id);
    if (!c) throw new Error(`curve ${id} missing`);
    const made = this.makeCurve(c);
    this.geomCurves.set(id, made);
    return made;
  }

  private makeCurve(c: PsCurve): any {
    const oc = this.oc;
    switch (c.t) {
      case "line": return this.hc(new oc.Geom_Line_3(this.pnt(c.point!), this.dir(c.dir!)));
      case "circle": return this.hc(new oc.Geom_Circle_2(this.ax2(c.center!, c.normal!, c.x!), c.r! * S));
      case "ellipse": return this.hc(new oc.Geom_Ellipse_2(this.ax2(c.center!, c.normal!, c.x!), c.r1! * S, c.r2! * S));
      case "parabola": return this.hc(new oc.Geom_Parabola_2(this.ax2(c.center!, c.normal!, c.x!), c.f! * S));
      case "hyperbola": return this.hc(new oc.Geom_Hyperbola_2(this.ax2(c.center!, c.normal!, c.x!), c.r1! * S, c.r2! * S));
      case "trimmed": return this.curve(c.basis!);
      case "nurbs": return this.hc(this.bspline3d(c));
      case "surface_parametric": {
        if (c.original != null && this.curves.get(c.original)?.t !== "surface_parametric") {
          try { return this.curve(c.original); } catch { /* fall back to the parameter curve */ }
        }
        return this.hc(this.curveFromPoints(this.sampleSpCurve(c), false));
      }
      case "intersection": {
        const pts = (c.chart ?? []).map(p => [p[0] * S, p[1] * S, p[2] * S] as V);
        if (pts.length < 2) throw new Error("intersection curve without chart points");
        return this.hc(this.curveFromPoints(pts, false));
      }
      default: throw new Error(`unsupported curve ${c.t}`);
    }
  }

  private bspline3d(c: PsCurve) {
    const oc = this.oc;
    const dim = c.dim!, n = c.cv!.length / dim;
    const poles = new oc.TColgp_Array1OfPnt_2(1, n);
    const weights = new oc.TColStd_Array1OfReal_2(1, n);
    for (let i = 0; i < n; i++) {
      const w = c.rational ? c.cv![i * dim + 3] : 1;
      poles.SetValue(i + 1, new oc.gp_Pnt_3(c.cv![i * dim] / w * S, c.cv![i * dim + 1] / w * S, c.cv![i * dim + 2] / w * S));
      weights.SetValue(i + 1, w);
    }
    const knots = this.reals(c.knots!), mults = this.ints(c.mults!);
    // Periodic Parasolid B-curves store all their poles and knots, so the non-periodic form is the same curve.
    return c.rational ? new oc.Geom_BSplineCurve_2(poles, weights, knots, mults, c.degree!, false, false)
      : new oc.Geom_BSplineCurve_1(poles, knots, mults, c.degree!, false);
  }

  private reals(a: number[]) {
    const r = new this.oc.TColStd_Array1OfReal_2(1, a.length);
    a.forEach((x, i) => r.SetValue(i + 1, x));
    return r;
  }

  private ints(a: number[]) {
    const r = new this.oc.TColStd_Array1OfInteger_2(1, a.length);
    a.forEach((x, i) => r.SetValue(i + 1, x));
    return r;
  }

  /** A B-spline through points (mm); for intersection and surface-parametric curves. */
  private curveFromPoints(pts: V[], closed: boolean) {
    const oc = this.oc;
    // Drop repeated points: the interpolation fails on them.
    const clean: V[] = [];
    for (const p of pts) {
      const q = clean[clean.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-6) clean.push(p);
    }
    if (clean.length === 2) return new oc.Geom_Line_3(new oc.gp_Pnt_3(...clean[0]), new oc.gp_Dir_4(clean[1][0] - clean[0][0], clean[1][1] - clean[0][1], clean[1][2] - clean[0][2]));
    const arr = new oc.TColgp_Array1OfPnt_2(1, clean.length);
    clean.forEach((p, i) => arr.SetValue(i + 1, new oc.gp_Pnt_3(p[0], p[1], p[2])));
    // Through the points within a micrometre (the HArray that GeomAPI_Interpolate takes is not bound).
    const fit = new oc.GeomAPI_PointsToBSpline_2(arr, 3, 5, oc.GeomAbs_Shape.GeomAbs_C2, 1e-3);
    if (!fit.IsDone()) throw new Error("curve fit failed");
    void closed;
    return fit.Curve().get();
  }

  /** Points (mm) along a surface-parametric curve: its 2D B-spline mapped through the surface. */
  private sampleSpCurve(c: PsCurve): V[] {
    const oc = this.oc;
    const pc = this.curves.get(c.pcurve!);
    const sd = this.surfaces.get(c.surface!);
    if (!pc || pc.t !== "nurbs" || !sd) throw new Error("surface-parametric curve without a 2D B-spline");
    const surf = this.surface(c.surface!);
    const map = this.uvMap(sd);
    const dim = pc.dim!, n = pc.cv!.length / dim;
    const poles = new oc.TColgp_Array1OfPnt2d_2(1, n);
    const weights = new oc.TColStd_Array1OfReal_2(1, n);
    for (let i = 0; i < n; i++) {
      const w = pc.rational ? pc.cv![i * dim + 2] : 1;
      const [u, v] = map(pc.cv![i * dim] / w, pc.cv![i * dim + 1] / w);
      poles.SetValue(i + 1, new oc.gp_Pnt2d_3(u, v));
      weights.SetValue(i + 1, w);
    }
    const knots = this.reals(pc.knots!), mults = this.ints(pc.mults!);
    const c2 = pc.rational ? new oc.Geom2d_BSplineCurve_2(poles, weights, knots, mults, pc.degree!, false)
      : new oc.Geom2d_BSplineCurve_1(poles, knots, mults, pc.degree!, false);
    const wrap = this.periodWrap(sd);
    const t0 = c2.FirstParameter(), t1 = c2.LastParameter();
    const N = Math.max(16, Math.min(400, (pc.knots!.length + 2) * 12));
    const out: V[] = [];
    for (let k = 0; k <= N; k++) {
      const p2 = c2.Value(t0 + ((t1 - t0) * k) / N);
      const [u, v] = wrap(p2.X(), p2.Y());
      const p = surf.get().Value(u, v);
      out.push([p.X(), p.Y(), p.Z()]);
    }
    return out;
  }

  /**
   * Parameter curves on periodic Parasolid surfaces may run past one period;
   * the B-splines built here are not periodic, so bring (u, v) back into range.
   */
  private periodWrap(sd: PsSurface): (u: number, v: number) => [number, number] {
    const range = (c: any): [number, number] | null => [c.FirstParameter(), c.LastParameter()];
    let ur: [number, number] | null = null, vr: [number, number] | null = null;
    if (sd.t === "swept" && this.curves.get(sd.section!)?.periodic) ur = range(this.curve(sd.section!).get());
    else if (sd.t === "spun" && this.curves.get(sd.profile!)?.periodic) vr = range(this.curve(sd.profile!).get());
    else if (sd.t === "nurbs") {
      const g = this.surface(sd.id).get();
      if (sd.uPeriodic) ur = [g.UKnot(g.FirstUKnotIndex()), g.UKnot(g.LastUKnotIndex())];
      if (sd.vPeriodic) vr = [g.VKnot(g.FirstVKnotIndex()), g.VKnot(g.LastVKnotIndex())];
    }
    const w = (x: number, r: [number, number] | null) => {
      if (!r) return x;
      const p = r[1] - r[0];
      if (!(p > 0)) return x;
      const y = r[0] + ((((x - r[0]) % p) + p) % p);
      // Keep the end of the range rather than wrapping it to the start.
      return Math.abs(x - r[1]) < 1e-12 ? r[1] : y;
    };
    return (u, v) => [w(u, ur), w(v, vr)];
  }

  /** Parasolid (u, v) of a surface to OCCT's (u, v) of the surface built here. */
  private uvMap(sd: PsSurface): (u: number, v: number) => [number, number] {
    switch (sd.t) {
      case "plane": return (u, v) => [u * S, v * S];
      case "cylinder": return (u, v) => [u, v * S];
      case "cone": return (u, v) => [u, (v * S) / sd.cos!];
      case "sphere": case "torus": case "nurbs": return (u, v) => [u, v];
      case "swept": {
        // u is the section's own parameter (a length only on a line), v the distance along the sweep.
        const line = this.curves.get(sd.section!)?.t === "line";
        return (u, v) => [line ? u * S : u, v * S];
      }
      case "spun": {
        // Parasolid: u along the profile, v the angle; OCCT puts the angle first. The axis is
        // reversed in makeSurface so the normals agree, which reverses the angle too.
        const line = this.curves.get(sd.profile!)?.t === "line";
        return (u, v) => [-v, line ? u * S : u];
      }
      default: throw new Error(`parameter curve on a ${sd.t} surface`);
    }
  }

  // ---------- surfaces ----------

  surface(id: Id): any {
    const hit = this.geomSurfaces.get(id);
    if (hit) return hit;
    const s = this.surfaces.get(id);
    if (!s) throw new Error(`surface ${id} missing`);
    const made = this.makeSurface(s);
    this.geomSurfaces.set(id, made);
    return made;
  }

  private makeSurface(s: PsSurface): any {
    const oc = this.oc;
    switch (s.t) {
      case "plane": return this.hs(new oc.Geom_Plane_1(this.ax3(s.point!, s.normal!, s.x!)));
      case "cylinder": return this.hs(new oc.Geom_CylindricalSurface_1(this.ax3(s.point!, s.axis!, s.x!), s.r! * S));
      case "cone": return this.hs(new oc.Geom_ConicalSurface_1(this.ax3(s.point!, s.axis!, s.x!), Math.atan2(s.sin!, s.cos!), s.r! * S));
      case "sphere": return this.hs(new oc.Geom_SphericalSurface_1(this.ax3(s.point!, s.axis!, s.x!), s.r! * S));
      case "torus": {
        if (s.r1! <= 0) {
          // A lemon torus (negative major radius): the minor circle spun about the axis.
          const z = s.axis!, x = s.x!, c = s.point!, R = s.r1!;
          const y: V = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
          const circle = new oc.Geom_Circle_2(this.ax2([c[0] + x[0] * R, c[1] + x[1] * R, c[2] + x[2] * R], [-y[0], -y[1], -y[2]], x), s.r2! * S);
          return this.hs(new oc.Geom_SurfaceOfRevolution(this.hc(circle), new oc.gp_Ax1_2(this.pnt(c), this.dir(z))));
        }
        return this.hs(new oc.Geom_ToroidalSurface_1(this.ax3(s.point!, s.axis!, s.x!), s.r1! * S, s.r2! * S));
      }
      case "nurbs": return this.hs(this.bsplineSurface(s));
      case "offset": {
        const basis = this.surface(s.basis!);
        // The offset is along the basis surface's normal; a reversed basis flips it.
        const sign = (this.surfaces.get(s.basis!)?.sense ?? 1) < 0 ? -1 : 1;
        return this.hs(new oc.Geom_OffsetSurface(basis, s.offset! * S * sign, false));
      }
      case "spun": {
        const profile = this.curve(s.profile!);
        // OCCT's normal is d/du x d/dv with u the angle; Parasolid's has the profile first, so the axis is reversed.
        const a = s.axis!;
        return this.hs(new oc.Geom_SurfaceOfRevolution(profile, new oc.gp_Ax1_2(this.pnt(s.point!), this.dir([-a[0], -a[1], -a[2]]))));
      }
      case "swept": {
        const section = this.curve(s.section!);
        return this.hs(new oc.Geom_SurfaceOfLinearExtrusion(section, this.dir(s.dir!)));
      }
      case "blended_edge": return this.hs(this.blendSurface(s));
      default: throw new Error(`unsupported surface ${s.t}`);
    }
  }

  private bsplineSurface(s: PsSurface) {
    const oc = this.oc;
    const dim = s.dim!, nu = s.nu!, nv = s.nv!;
    const poles = new oc.TColgp_Array2OfPnt_2(1, nu, 1, nv);
    const weights = new oc.TColStd_Array2OfReal_2(1, nu, 1, nv);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const k = (i * nv + j) * dim;
      const w = s.rational ? s.cv![k + 3] : 1;
      poles.SetValue(i + 1, j + 1, new oc.gp_Pnt_3(s.cv![k] / w * S, s.cv![k + 1] / w * S, s.cv![k + 2] / w * S));
      weights.SetValue(i + 1, j + 1, w);
    }
    const args = [this.reals(s.uKnots!), this.reals(s.vKnots!), this.ints(s.uMults!), this.ints(s.vMults!), s.uDegree!, s.vDegree!, false, false];
    return s.rational ? new oc.Geom_BSplineSurface_2(poles, weights, ...args) : new oc.Geom_BSplineSurface_1(poles, ...args);
  }

  /**
   * A rolling-ball blend: Parasolid defines it implicitly (a ball of the given
   * radius rolling between two surfaces along a spine). Here it is the pipe of
   * that radius around the spine, which is the same surface for the constant
   * radius fillets a CAD app makes, trimmed later by the face's edges.
   */
  private blendSurface(s: PsSurface) {
    const oc = this.oc;
    const r = Math.abs(s.ranges?.[0] ?? 0) * S;
    if (!(r > 0)) throw new Error("blend without a radius");
    const spine = this.curve(s.spine!);
    const pipe = new oc.GeomFill_Pipe_2(spine, r);
    pipe.Perform_2(1e-4, false, oc.GeomAbs_Shape.GeomAbs_C1, 9, 200);
    if (!pipe.IsDone()) throw new Error("blend pipe failed");
    return pipe.Surface().get();
  }

  // ---------- topology ----------

  private vertex(id: Id) {
    const hit = this.vertices.get(id);
    if (hit) return hit;
    const v = this.vertexDefs.get(id);
    if (!v?.p) throw new Error(`vertex ${id} has no point`);
    const made = new this.oc.BRepBuilderAPI_MakeVertex(this.pnt(v.p)).Vertex();
    this.vertices.set(id, made);
    return made;
  }

  /** The curve an edge runs along, and whether it runs against the curve's parameter. */
  private edgeCurve(e: PsModel["edges"][number]): { curve: any; reversed: boolean } {
    if (e.curve != null) {
      const c = this.curves.get(e.curve)!;
      return { curve: this.curve(e.curve), reversed: c.sense < 0 };
    }
    // Tolerant edge: the curves are on its fins.
    for (const fid of e.fins) {
      const f = this.fins.get(fid);
      if (!f || f.curve == null) continue;
      const c = this.curves.get(f.curve)!;
      return { curve: this.curve(f.curve), reversed: (c.sense < 0) !== (f.sense < 0) };
    }
    throw new Error(`edge ${e.id} has no curve`);
  }

  /** The OCCT edge of a Parasolid edge, oriented along the Parasolid edge. */
  private edge(id: Id) {
    const hit = this.topoEdges.get(id);
    if (hit) return hit;
    const oc = this.oc;
    const e = this.edges.get(id);
    if (!e) throw new Error(`edge ${id} missing`);
    let ic = e.curve != null ? this.curves.get(e.curve) : undefined;
    // A trimmed intersection curve: the chart of its basis, in the trimmed curve's sense.
    if (ic?.t === "trimmed") {
      const basis = this.curves.get(ic.basis!);
      if (basis?.t === "intersection") ic = { ...basis, sense: ic.sense };
    }
    if (ic?.t === "intersection" && e.start != null && e.end != null && e.start !== e.end) {
      try { return this.intersectionEdge(e, ic); } catch (err) { this.note(`edge ${id}: ${errText(err, oc)}`); }
    }
    const { curve, reversed } = this.edgeCurve(e);
    const g = curve.get();
    const B = this.builder, O = oc.TopAbs_Orientation;
    const tol = Math.max(1e-5, (e.tol ?? 0) * S);
    const made = new oc.TopoDS_Edge();
    B.MakeEdge_2(made, curve, tol);
    const first = g.FirstParameter(), last = g.LastParameter();
    const periodic = g.IsPeriodic(), period = periodic ? g.Period() : 0;
    let p0: number, p1: number;
    if (e.start == null || e.end == null) {
      // A closed edge without vertices (a full circle): the whole periodic curve, on one vertex.
      if (!periodic && g.Value(first).Distance(g.Value(last)) > 1e-3) throw new Error(`edge ${id} has no vertices on an open curve`);
      const v = new oc.BRepBuilderAPI_MakeVertex(g.Value(first)).Vertex();
      B.Add(made, v.Oriented(O.TopAbs_FORWARD));
      B.Add(made, v.Oriented(O.TopAbs_REVERSED));
      p0 = first; p1 = periodic ? first + period : last;
    } else {
      // Along the curve's parameter the edge runs from `a` to `b`.
      const [a, b] = reversed ? [e.end, e.start] : [e.start, e.end];
      const va = this.vertex(a), vb = this.vertex(b);
      if (a === b) {
        p0 = this.project(curve, a, va, null); p1 = periodic ? p0 + period : last;
        if (!periodic) p0 = first;
      } else {
        p0 = this.project(curve, a, va, null);
        p1 = this.project(curve, b, vb, p0);
        if (p1 <= p0) {
          if (periodic) p1 += period * Math.ceil((p0 - p1) / period + 1e-12);
          else if (g.IsClosed() && Math.abs(p1 - first) < 1e-9) p1 = last;
          else if (g.IsClosed() && Math.abs(p0 - last) < 1e-9) p0 = first;
          else {
            // The curve runs the other way than its sense says (seen on intersection curves): follow the vertices.
            [p0, p1] = [p1, p0];
            this.note(`edge ${id}: curve sense disagrees with its vertices`);
            const flipped = new oc.TopoDS_Edge();
            B.MakeEdge_2(flipped, curve, tol);
            B.Add(flipped, vb.Oriented(O.TopAbs_FORWARD));
            B.Add(flipped, va.Oriented(O.TopAbs_REVERSED));
            B.Range_1(flipped, p0, p1, false);
            const edge = reversed ? flipped : oc.TopoDS.Edge_1(flipped.Reversed());
            this.topoEdges.set(id, edge);
            return edge;
          }
        }
      }
      B.Add(made, va.Oriented(O.TopAbs_FORWARD));
      B.Add(made, vb.Oriented(O.TopAbs_REVERSED));
    }
    B.Range_1(made, p0, p1, false);
    const edge = reversed ? oc.TopoDS.Edge_1(made.Reversed()) : made;
    this.topoEdges.set(id, edge);
    return edge;
  }

  /**
   * An edge on an intersection curve. Parasolid keeps such a curve as the two
   * surfaces plus a chart of points along it; the chart can run past the edge
   * or all the way round. Fit a B-spline only through the stretch between the
   * edge's vertices, densified with points put back onto both surfaces.
   */
  private intersectionEdge(e: PsModel["edges"][number], c: PsCurve) {
    const oc = this.oc;
    const chart = (c.chart ?? []).map(p => [p[0] * S, p[1] * S, p[2] * S] as V);
    if (chart.length < 2) throw new Error("intersection curve without chart points");
    const P = (vid: Id) => { const p = this.vertexDefs.get(vid)!.p!; return [p[0] * S, p[1] * S, p[2] * S] as V; };
    const reversed = c.sense < 0;
    // Along the chart the edge runs from A to B.
    const [ia, ib] = reversed ? [e.end!, e.start!] : [e.start!, e.end!];
    const A = P(ia), B = P(ib);
    const closed = dist(chart[0], chart[chart.length - 1]) < 1e-6;
    const n = chart.length - 1;
    const at = (q: V) => {
      // Position along the chart polyline: segment index + fraction.
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const a = chart[i], b = chart[i + 1], ab = sub(b, a), L2 = dot(ab, ab);
        const t = L2 > 0 ? Math.min(1, Math.max(0, dot(sub(q, a), ab) / L2)) : 0;
        const d = dist(q, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
        if (d < bd - 1e-12) { bd = d; best = i + t; }
      }
      return best;
    };
    let sa = at(A), sb = at(B);
    if (closed) { if (sb <= sa + 1e-9) sb += n; }
    else if (sb < sa) throw new Error("vertices in the wrong order along the intersection chart");
    const pts: V[] = [A];
    for (let k = Math.floor(sa) + 1; k < sb - 1e-9; k++) pts.push(chart[k % n]);
    pts.push(B);
    const dense = this.refineOnSurfaces(pts, c.surfaces!);
    const curve = this.hc(this.curveFromPoints(dense, false));
    const g = curve.get();
    const B_ = this.builder, O = oc.TopAbs_Orientation;
    const made = new oc.TopoDS_Edge();
    B_.MakeEdge_2(made, curve, Math.max(1e-5, (e.tol ?? 0) * S));
    B_.Add(made, this.vertex(ia).Oriented(O.TopAbs_FORWARD));
    B_.Add(made, this.vertex(ib).Oriented(O.TopAbs_REVERSED));
    B_.Range_1(made, g.FirstParameter(), g.LastParameter(), false);
    const edge = reversed ? oc.TopoDS.Edge_1(made.Reversed()) : made;
    this.topoEdges.set(e.id, edge);
    return edge;
  }

  /**
   * Points between chart points, put onto the intersection of both surfaces:
   * each step projects onto both (with their normals) and moves to where the
   * two tangent planes meet the plane across the chord. That converges fast
   * even where the surfaces meet at a small angle (fillet boundaries).
   */
  private refineOnSurfaces(pts: V[], surfaces: [Id, Id]): V[] {
    let s1: Projector, s2: Projector;
    try { s1 = this.projector(surfaces[0]); s2 = this.projector(surfaces[1]); } catch { return pts; }
    const out: V[] = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], len = dist(a, b);
      const t = sub(b, a);
      // A short chord is close enough already; longer ones get more points.
      const k = len < 0.05 ? 0 : len < 2 ? 1 : 3;
      for (let j = 1; j <= k; j++) {
        const f = j / (k + 1);
        let q: V | null = [a[0] + t[0] * f, a[1] + t[1] * f, a[2] + t[2] * f];
        for (let it = 0; it < 8 && q; it++) {
          const r1 = s1(q), r2 = s2(q);
          if (!r1 || !r2) { q = null; break; }
          const x: V = solve3([r1.n, r2.n, t], [dot(r1.n, r1.p), dot(r2.n, r2.p), dot(t, q)])
            ?? [(r1.p[0] + r2.p[0]) / 2, (r1.p[1] + r2.p[1]) / 2, (r1.p[2] + r2.p[2]) / 2];
          const moved = dist(x, q);
          q = x;
          if (moved < 1e-8) break;
        }
        // A point that wandered off (onto another sheet of a surface) is left out.
        if (q && dist(q, a) + dist(q, b) < len * 1.5 + 1e-6) out.push(q);
      }
      out.push(b);
    }
    return out;
  }

  private projectors = new Map<Id, Projector>();

  /** Nearest point and normal on a surface: closed form for analytic ones, OCCT for the rest. */
  private projector(id: Id): Projector {
    const hit = this.projectors.get(id);
    if (hit) return hit;
    const sd = this.surfaces.get(id)!;
    let f: Projector;
    const P = sd.point ? sd.point.map(x => x * S) as V : [0, 0, 0] as V;
    const A = sd.axis ?? sd.normal ?? [0, 0, 1];
    const radial = (p: V) => { const h = dot(sub(p, P), A); const q: V = [P[0] + A[0] * h, P[1] + A[1] * h, P[2] + A[2] * h]; return { h, q, d: sub(p, q) }; };
    const unit = (v: V): V | null => { const l = Math.hypot(...v); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null; };
    switch (sd.t) {
      case "plane": f = p => { const h = dot(sub(p, P), A); return { p: [p[0] - A[0] * h, p[1] - A[1] * h, p[2] - A[2] * h], n: A }; }; break;
      case "cylinder": f = p => { const { q, d } = radial(p); const u = unit(d); if (!u) return null; const r = sd.r! * S; return { p: [q[0] + u[0] * r, q[1] + u[1] * r, q[2] + u[2] * r], n: u }; }; break;
      case "sphere": f = p => { const u = unit(sub(p, P)); if (!u) return null; const r = sd.r! * S; return { p: [P[0] + u[0] * r, P[1] + u[1] * r, P[2] + u[2] * r], n: u }; }; break;
      case "cone": {
        const ang = Math.atan2(sd.sin!, sd.cos!), ca = Math.cos(ang), sa = Math.sin(ang), r0 = sd.r! * S;
        f = p => {
          const { h, d } = radial(p); const u = unit(d); if (!u) return null;
          const dd = Math.hypot(...d), tt = h * ca + (dd - r0) * sa;
          const hh = tt * ca, rr = r0 + tt * sa;
          const n: V = [u[0] * ca - A[0] * sa, u[1] * ca - A[1] * sa, u[2] * ca - A[2] * sa];
          return { p: [P[0] + A[0] * hh + u[0] * rr, P[1] + A[1] * hh + u[1] * rr, P[2] + A[2] * hh + u[2] * rr], n };
        };
        break;
      }
      case "torus": {
        const R = sd.r1! * S, r = sd.r2! * S;
        f = p => {
          const { d } = radial(p); const u = unit(d); if (!u) return null;
          const c: V = [P[0] + u[0] * R, P[1] + u[1] * R, P[2] + u[2] * R];
          const w = unit(sub(p, c)); if (!w) return null;
          return { p: [c[0] + w[0] * r, c[1] + w[1] * r, c[2] + w[2] * r], n: w };
        };
        break;
      }
      default: {
        const oc = this.oc, surf = this.surface(id), sas = new oc.ShapeAnalysis_Surface(surf), g = surf.get();
        let prev: any = null;
        f = p => {
          try {
            const gp = new oc.gp_Pnt_3(p[0], p[1], p[2]);
            const uv = prev ? sas.NextValueOfUV(prev, gp, 1e-7, -1) : sas.ValueOfUV(gp, 1e-7);
            prev = uv;
            const pt = new oc.gp_Pnt_1(), du = new oc.gp_Vec_1(), dv = new oc.gp_Vec_1();
            g.D1(uv.X(), uv.Y(), pt, du, dv);
            const n = unit([du.Y() * dv.Z() - du.Z() * dv.Y(), du.Z() * dv.X() - du.X() * dv.Z(), du.X() * dv.Y() - du.Y() * dv.X()]);
            return n ? { p: [pt.X(), pt.Y(), pt.Z()], n } : null;
          } catch { return null; }
        };
      }
    }
    this.projectors.set(id, f);
    return f;
  }

  /** The curve parameter of a vertex (after `after`, on a periodic curve); widens the vertex tolerance to its distance. */
  private project(curve: any, vid: Id, v: any, after: number | null): number {
    const oc = this.oc;
    const p = this.pnt(this.vertexDefs.get(vid)!.p!);
    const g = curve.get();
    const proj = new oc.GeomAPI_ProjectPointOnCurve_2(p, curve);
    const first = g.FirstParameter(), last = g.LastParameter();
    let t: number, d: number;
    if (proj.NbPoints()) {
      let best = 1;
      d = proj.Distance(1);
      for (let k = 2; k <= proj.NbPoints(); k++) if (proj.Distance(k) < d - 1e-9) { d = proj.Distance(k); best = k; }
      t = proj.Parameter_1(best);
    } else {
      // No perpendicular foot: the point is past an end of a bounded curve (a fitted intersection curve).
      if (!Number.isFinite(first) || !Number.isFinite(last)) throw new Error(`vertex ${vid} does not project onto its edge's curve`);
      const d0 = g.Value(first).Distance(p), d1 = g.Value(last).Distance(p);
      [t, d] = d0 <= d1 ? [first, d0] : [last, d1];
    }
    // Ends of a bounded curve: snap, the projection can land a hair inside.
    if (!g.IsPeriodic() && Number.isFinite(first) && Number.isFinite(last)) {
      const atFirst = g.Value(first).Distance(p) <= d + 1e-6, atLast = g.Value(last).Distance(p) <= d + 1e-6;
      // On a closed curve both ends are the vertex: the start of the edge takes the first, its end the last.
      if (atFirst && atLast) t = after == null ? first : last;
      else if (atFirst) t = first;
      else if (atLast) t = last;
    }
    if (d > 1e-5) this.builder.UpdateVertex_6(v, Math.min(d * 1.5, 0.1));
    return t;
  }

  /** A loop as a wire, oriented around the face normal (Parasolid's convention). */
  private wire(loopId: Id) {
    const oc = this.oc;
    const lp = this.loops.get(loopId)!;
    const w = new oc.TopoDS_Wire();
    this.builder.MakeWire(w);
    let n = 0;
    for (const fid of lp.fins) {
      const f = this.fins.get(fid);
      if (!f || f.edge == null) continue;
      let e = this.edge(f.edge);
      if (f.sense < 0) e = oc.TopoDS.Edge_1(e.Reversed());
      this.builder.Add(w, e);
      n++;
    }
    return n ? w : null;
  }

  /** A face with its loops. `outward`: the face's normal points out of the body's material. */
  private face(id: Id, outward: boolean) {
    const oc = this.oc;
    const f = this.faceDefs.get(id)!;
    if (f.surface == null) throw new Error(`face ${id} has no surface`);
    const sd = this.surfaces.get(f.surface)!;
    const surf = this.surface(f.surface);
    // +1: the face's normal (loops run anticlockwise around it) is the OCCT surface's normal.
    const sameAsSurface = (f.sense >= 0) === (sd.sense >= 0);
    const face = new oc.TopoDS_Face();
    this.builder.MakeFace_2(face, surf, 1e-6);
    for (const l of f.loops) {
      const w = this.wire(l);
      if (!w) continue;
      this.builder.Add(face, sameAsSurface ? w : w.Reversed());
    }
    // Stored loops are relative to the surface; the face's own orientation says where the material is.
    const out = sameAsSurface === outward ? face : face.Reversed();
    return oc.TopoDS.Face_1(out);
  }

  // ---------- bodies ----------

  build(): PsBody[] {
    const oc = this.oc;
    const out: PsBody[] = [];
    for (const b of this.m.bodies) {
      const shells: { faces: Id[]; outward: boolean[] }[] = [];
      for (const rid of b.regions) {
        const r = this.m.regions.find(x => x.id === rid);
        if (!r?.solid) continue;
        for (const sid of r.shells) {
          const sh = this.m.shells.find(x => x.id === sid);
          if (!sh) continue;
          // Material behind the face: its normal points out (back faces of a solid region's shell).
          const faces = [...sh.back, ...sh.front], outward = [...sh.back.map(() => true), ...sh.front.map(() => false)];
          if (faces.length) shells.push({ faces, outward });
        }
      }
      if (!shells.length) continue;
      let failed = 0, count = 0;
      const solid = new oc.TopoDS_Solid();
      this.builder.MakeSolid(solid);
      for (const sh of shells) {
        const shell = new oc.TopoDS_Shell();
        this.builder.MakeShell(shell);
        sh.faces.forEach((fid, k) => {
          count++;
          try { this.builder.Add(shell, this.face(fid, sh.outward[k])); }
          catch (err) { failed++; this.note(`face ${fid}: ${errText(err, oc)}`); }
        });
        this.builder.Add(solid, shell);
      }
      out.push({ id: b.id, shape: this.fix(solid), color: this.colorOf(b.id), faces: count, failed });
    }
    return out;
  }

  /** ShapeFix adds parameter curves, seams and tolerances. */
  private fix(shape: any) {
    const oc = this.oc;
    try {
      const fix = new oc.ShapeFix_Shape_2(shape);
      fix.SetPrecision(1e-5);
      fix.SetMaxTolerance(0.05);
      fix.Perform(new oc.Message_ProgressRange_1());
      const out = fix.Shape();
      // A solid whose faces ended up inside out has a negative volume.
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(out, props, true, false, false);
      return props.Mass() < 0 ? out.Reversed() : out;
    } catch (err) {
      this.note(`ShapeFix: ${errText(err, oc)}`);
      return shape;
    }
  }

  /** A CAD app writes body colours as the SDL/TYSA_COLOUR attribute (RGB 0..1). */
  private colorOf(bodyId: Id): V | null {
    const a = this.m.attributes.find(x => x.owner === "body" && x.of === bodyId && /COLOU?R/i.test(x.name) && x.reals.length >= 3);
    if (!a) return null;
    const [r, g, b] = a.reals;
    return r != null && g != null && b != null ? [r, g, b] : null;
  }
}

type Projector = (p: V) => { p: V; n: V } | null;

/** Solves the 3x3 system rows·x = rhs (Cramer); null when it is (nearly) singular. */
function solve3(m: [V, V, V], r: [number, number, number]): V | null {
  const [a, b, c] = m;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const scale = Math.hypot(...a) * Math.hypot(...b) * Math.hypot(...c);
  if (!(Math.abs(det) > 1e-10 * scale)) return null;
  const d = (x: V, y: V, z: V) => x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]);
  const X: V = [r[0], a[1], a[2]], Y: V = [r[1], b[1], b[2]], Z: V = [r[2], c[1], c[2]];
  const X2: V = [a[0], r[0], a[2]], Y2: V = [b[0], r[1], b[2]], Z2: V = [c[0], r[2], c[2]];
  const X3: V = [a[0], a[1], r[0]], Y3: V = [b[0], b[1], r[1]], Z3: V = [c[0], c[1], r[2]];
  return [d(X, Y, Z) / det, d(X2, Y2, Z2) / det, d(X3, Y3, Z3) / det];
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function errText(err: unknown, oc: any): string {
  if (typeof err === "number") {
    try { return oc.OCJS?.getStandard_FailureData?.(err)?.GetMessageString?.() || `OCCT error ${err}`; } catch { return `OCCT error ${err}`; }
  }
  return err instanceof Error ? err.message : String(err);
}
