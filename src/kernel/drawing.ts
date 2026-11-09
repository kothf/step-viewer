// Drawing views (FRS 11.2, FR-DRW-010/016): hidden-line projection of a body with
// OCCT's exact HLR (HLRBRep_Algo). A view is a direction and an "up" vector; the
// result is flat 2D geometry in model millimetres (x right, y up on the sheet),
// sorted into visible / hidden and sharp / tangent / silhouette edges. Lines and
// circular arcs stay exact (dimensions and centre marks need them); other curves
// become polylines within a small chord error.

export type V3 = [number, number, number];
/** Edge class: 0 sharp edge, 1 tangent (smooth) edge, 2 silhouette (outline). */
export type EdgeClass = 0 | 1 | 2;
export type Seg2 =
  | { k: "l"; c: EdgeClass; p: [number, number, number, number] }
  /** Arc counter-clockwise from a0 to a1 (radians, a1 > a0; a full circle has a1 − a0 = 2π). */
  | { k: "a"; c: EdgeClass; o: [number, number]; r: number; a0: number; a1: number }
  | { k: "p"; c: EdgeClass; p: number[] };
export interface Projection {
  vis: Seg2[];
  hid: Seg2[];
  /** Bounds of the visible geometry: [xmin, ymin, xmax, ymax]. */
  box: [number, number, number, number];
  ms: number;
  /** Section views: the cut faces as closed 2D loops (fill even-odd). */
  cut?: number[][];
  /** Section views: for each `cut` loop, the index of the input solid it lies on (TopExp order; -1 unknown). */
  cutOf?: number[];
  /** Section views: for each `cut` loop, who it belongs to (component id or body) and its material, set by the worker. */
  cutKey?: string[];
  cutMat?: (string | null)[];
  /** Shaded views (FR-DRW-010): triangles facing the viewer, back to front, 7 numbers each: u0 v0 u1 v1 u2 v2 grey. */
  shade?: number[];
  /** A quick polygonal preview (`projectPoly`): drawn, never measured. */
  preview?: boolean;
}
/** A view direction: `dir` points from the model towards the viewer; `up` is the sheet's +y. */
export interface ViewDir { dir: V3; up: V3 }

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Sheet x direction of a view (right-handed: x = up × dir). */
export function viewAxes(v: ViewDir): { x: V3; y: V3; n: V3 } {
  const n = unit(v.dir);
  let up = v.up;
  if (Math.abs(dot(unit(up), n)) > 0.999) up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const x = unit(cross(up, n));
  return { x, y: cross(n, x), n };
}

/** Reads STEP / IGES / BREP bytes into one shape (all roots in a compound). */
export function readShape(oc: any, bytes: Uint8Array, name: string): any {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const path = `/drw-${Math.random().toString(36).slice(2)}.${ext === "igs" || ext === "iges" ? "igs" : ext === "brep" ? "brep" : "stp"}`;
  oc.FS.writeFile(path, bytes);
  try {
    if (ext === "brep") {
      const shape = new oc.TopoDS_Shape();
      oc.BRepTools.Read_2(shape, path, new oc.BRep_Builder(), new oc.Message_ProgressRange_1());
      if (shape.IsNull()) throw new Error("Could not read the BREP file");
      return shape;
    }
    const reader = ext === "igs" || ext === "iges" ? new oc.IGESControl_Reader_1() : new oc.STEPControl_Reader_1();
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("Could not read the file");
    reader.TransferRoots(new oc.Message_ProgressRange_1());
    const shape = reader.OneShape();
    if (shape.IsNull()) throw new Error("The file has no geometry");
    return shape;
  } finally {
    try { oc.FS.unlink(path); } catch { /* gone */ }
  }
}

/** Projects `shape` along a view. `tol` is the chord error for free-form curves (mm). */
export function project(oc: any, shape: any, view: ViewDir, tol = 0.02): Projection {
  const t0 = Date.now();
  const { x, n } = viewAxes(view);
  const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(x[0], x[1], x[2]));
  const algo = new oc.HLRBRep_Algo_1();
  algo.Add_2(shape, 0);
  algo.Projector_1(new oc.HLRAlgo_Projector_2(ax));
  algo.Update();
  algo.Hide_1();
  const h = new oc.HLRBRep_HLRToShape(new oc.Handle_HLRBRep_Algo_2(algo));
  const vis: Seg2[] = [], hid: Seg2[] = [];
  const take = (s: any, out: Seg2[], c: EdgeClass) => { if (s && !s.IsNull()) edges(oc, s, out, c, tol); };
  take(h.VCompound_1(), vis, 0);
  take(h.Rg1LineVCompound_1(), vis, 1);
  take(h.OutLineVCompound_1(), vis, 2);
  take(h.HCompound_1(), hid, 0);
  take(h.Rg1LineHCompound_1(), hid, 1);
  take(h.OutLineHCompound_1(), hid, 2);
  return { vis, hid: unhide(hid, vis), box: bounds(vis.length ? vis : hid), ms: Date.now() - t0 };
}

/**
 * A quick preview of a view (FR-DRW-016, NFR-PERF-040): OCCT's polygonal HLR (HLRBRep_PolyAlgo) on the
 * shape's triangulation, meshed at `lin` mm chord error. Every line is a polyline, so it is for showing
 * only: dimensions and picking wait for the exact projection. The result is marked `preview`.
 */
export function projectPoly(oc: any, shape: any, view: ViewDir, lin: number): Projection {
  const t0 = Date.now();
  new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, 0.5, false);
  const { x, n } = viewAxes(view);
  const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(x[0], x[1], x[2]));
  const algo = new oc.HLRBRep_PolyAlgo_1();
  algo.Load(shape);
  algo.Projector_2(new oc.HLRAlgo_Projector_2(ax));
  algo.Update();
  const h = new oc.HLRBRep_PolyHLRToShape();
  h.Update(new oc.Handle_HLRBRep_PolyAlgo_2(algo));
  const vis: Seg2[] = [], hid: Seg2[] = [];
  const take = (get: () => any, out: Seg2[], c: EdgeClass) => { let s: any; try { s = get(); } catch { return; } if (s && !s.IsNull()) polyEdges(oc, s, out, c); };
  take(() => h.VCompound_1(), vis, 0);
  take(() => h.Rg1LineVCompound_1(), vis, 1);
  take(() => h.OutLineVCompound_1(), vis, 2);
  take(() => h.HCompound_1(), hid, 0);
  take(() => h.Rg1LineHCompound_1(), hid, 1);
  take(() => h.OutLineHCompound_1(), hid, 2);
  return { vis, hid, box: bounds(vis.length ? vis : hid), ms: Date.now() - t0, preview: true };
}

/** The straight pieces of a polygonal HLR result (its edges are lines between mesh points), joined end to end. */
function polyEdges(oc: any, comp: any, out: Seg2[], c: EdgeClass) {
  const A = oc.TopAbs_ShapeEnum;
  let run: number[] | null = null;
  const flush = () => { if (run && run.length >= 4) out.push(run.length === 4 ? { k: "l", c, p: [run[0], run[1], run[2], run[3]] } : { k: "p", c, p: run }); run = null; };
  for (const ex = new oc.TopExp_Explorer_2(comp, A.TopAbs_EDGE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const e = oc.TopoDS.Edge_1(ex.Current());
    let ad: any;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { continue; }
    const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
    const ax = a.X(), ay = a.Y(), bx = b.X(), by = b.Y();
    if (Math.hypot(bx - ax, by - ay) < 1e-9) continue;
    if (run && Math.abs(run[run.length - 2] - ax) < 1e-7 && Math.abs(run[run.length - 1] - ay) < 1e-7) run.push(bx, by);
    else { flush(); run = [ax, ay, bx, by]; }
  }
  flush();
}

/** Removes the parts of hidden lines and arcs that lie under visible ones (a back edge behind the outline). */
export function unhide(hid: Seg2[], vis: Seg2[], eps = 1e-4): Seg2[] {
  const out: Seg2[] = [];
  const sub = (iv: [number, number][], a: number, b: number) => {
    const r: [number, number][] = [];
    for (const [s, e] of iv) {
      if (b <= s + eps || a >= e - eps) { r.push([s, e]); continue; }
      if (a > s + eps) r.push([s, a]);
      if (b < e - eps) r.push([b, e]);
    }
    return r;
  };
  for (const h of hid) {
    if (h.k === "l") {
      const [x0, y0, x1, y1] = h.p, L = Math.hypot(x1 - x0, y1 - y0);
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      let iv: [number, number][] = [[0, L]];
      for (const v of vis) {
        if (v.k !== "l") continue;
        const d0 = (v.p[0] - x0) * uy - (v.p[1] - y0) * ux, d1 = (v.p[2] - x0) * uy - (v.p[3] - y0) * ux;
        if (Math.abs(d0) > eps || Math.abs(d1) > eps) continue;
        const t0 = (v.p[0] - x0) * ux + (v.p[1] - y0) * uy, t1 = (v.p[2] - x0) * ux + (v.p[3] - y0) * uy;
        iv = sub(iv, Math.min(t0, t1), Math.max(t0, t1));
        if (!iv.length) break;
      }
      for (const [a, b] of iv) if (b - a > eps * 10) out.push({ k: "l", c: h.c, p: [x0 + ux * a, y0 + uy * a, x0 + ux * b, y0 + uy * b] });
    } else if (h.k === "a") {
      let iv: [number, number][] = [[h.a0, h.a1]];
      const ae = eps / Math.max(h.r, eps);
      for (const v of vis) {
        if (v.k !== "a" || Math.abs(v.r - h.r) > eps || Math.hypot(v.o[0] - h.o[0], v.o[1] - h.o[1]) > eps) continue;
        // Compare in the hidden arc's turn: try the visible arc shifted by whole turns.
        for (const k of [-2, -1, 0, 1, 2]) iv = sub(iv, v.a0 + k * 2 * Math.PI - ae, v.a1 + k * 2 * Math.PI + ae);
        if (!iv.length) break;
      }
      for (const [a, b] of iv) if (b - a > ae * 10) out.push({ ...h, a0: a, a1: b });
    } else out.push(h);
  }
  return out;
}

function edges(oc: any, comp: any, out: Seg2[], c: EdgeClass, tol: number) {
  const A = oc.TopAbs_ShapeEnum, T = oc.GeomAbs_CurveType;
  for (const ex = new oc.TopExp_Explorer_2(comp, A.TopAbs_EDGE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const e = oc.TopoDS.Edge_1(ex.Current());
    let ad: any;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { continue; }
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0)) continue;
    const P = (u: number): [number, number] => { const p = ad.Value(u); return [p.X(), p.Y()]; };
    const ty = ad.GetType();
    if (ty === T.GeomAbs_Line) {
      const a = P(u0), b = P(u1);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-7) out.push({ k: "l", c, p: [a[0], a[1], b[0], b[1]] });
    } else if (ty === T.GeomAbs_Circle) {
      const ci = ad.Circle(), loc = ci.Location(), r = ci.Radius();
      const o: [number, number] = [loc.X(), loc.Y()];
      const a = P(u0), b = P(u1), m = P((u0 + u1) / 2);
      const ang = (p: [number, number]) => Math.atan2(p[1] - o[1], p[0] - o[0]);
      if (u1 - u0 > 2 * Math.PI - 1e-9) { out.push({ k: "a", c, o, r, a0: 0, a1: 2 * Math.PI }); continue; }
      let a0 = ang(a), a1 = ang(b);
      const am = ang(m);
      const norm = (v: number) => { while (v < 0) v += 2 * Math.PI; while (v >= 2 * Math.PI) v -= 2 * Math.PI; return v; };
      // Counter-clockwise from a0 must pass the middle point; otherwise swap the ends.
      if (norm(am - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
      let sweep = norm(a1 - a0);
      if (sweep < 1e-9) sweep = 2 * Math.PI;
      out.push({ k: "a", c, o, r, a0, a1: a0 + sweep });
    } else {
      const pts: number[] = [];
      try {
        const d = new oc.GCPnts_TangentialDeflection_2(ad, 0.1, tol, 2, 1e-9, 1e-7);
        for (let i = 1; i <= d.NbPoints(); i++) { const p = d.Value(i); pts.push(p.X(), p.Y()); }
      } catch {
        for (let i = 0; i <= 32; i++) { const p = P(u0 + (u1 - u0) * i / 32); pts.push(p[0], p[1]); }
      }
      if (pts.length < 4) continue;
      // A straight run (a circle seen edge-on) becomes a line, so it can hide under a visible one.
      const n = pts.length, x0 = pts[0], y0 = pts[1], x1 = pts[n - 2], y1 = pts[n - 1], L = Math.hypot(x1 - x0, y1 - y0);
      let straight = L > 1e-7;
      for (let i = 2; straight && i < n - 2; i += 2) straight = Math.abs((pts[i] - x0) * (y1 - y0) - (pts[i + 1] - y0) * (x1 - x0)) / L < 1e-6
        && (pts[i] - x0) * (x1 - x0) + (pts[i + 1] - y0) * (y1 - y0) >= -1e-9 && (pts[i] - x1) * (x0 - x1) + (pts[i + 1] - y1) * (y0 - y1) >= -1e-9;
      if (straight) out.push({ k: "l", c, p: [x0, y0, x1, y1] });
      else out.push({ k: "p", c, p: pts });
    }
  }
}

/** Bounds of 2D segments: [xmin, ymin, xmax, ymax]. */
export function bounds(segs: Seg2[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const s of segs) {
    if (s.k === "l") { add(s.p[0], s.p[1]); add(s.p[2], s.p[3]); }
    else if (s.k === "p") for (let i = 0; i < s.p.length; i += 2) add(s.p[i], s.p[i + 1]);
    else {
      add(s.o[0] + s.r * Math.cos(s.a0), s.o[1] + s.r * Math.sin(s.a0));
      add(s.o[0] + s.r * Math.cos(s.a1), s.o[1] + s.r * Math.sin(s.a1));
      for (let q = Math.ceil(s.a0 / (Math.PI / 2)); q * Math.PI / 2 <= s.a1; q++) add(s.o[0] + s.r * Math.cos(q * Math.PI / 2), s.o[1] + s.r * Math.sin(q * Math.PI / 2));
    }
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Tight bounds and volume of a shape (model mm). */
export function shapeInfo(oc: any, shape: any): { box: [V3, V3]; volume: number } {
  const b = new oc.Bnd_Box_1();
  oc.BRepBndLib.AddOptimal(shape, b, false, false);
  const lo = b.CornerMin(), hi = b.CornerMax();
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, p, true, false, false);
  return { box: [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]], volume: Math.abs(p.Mass()) };
}

/**
 * An aligned section's model (FR-DRW-012): the part of `shape` on the `s` side of the plane through `c` is turned by
 * `ang` about the axis through `c` along `axis`, so the second leg's cut lies in the first leg's plane; the other part
 * stays. Both go into one compound, which is then cut like a straight section.
 */
export function alignedShape(oc: any, shape: any, al: { c: V3; s: V3; axis: V3; ang: number }): any {
  const info = shapeInfo(oc, shape);
  const [lo, hi] = info.box;
  const L = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10
    + 2 * Math.hypot(al.c[0] - (lo[0] + hi[0]) / 2, al.c[1] - (lo[1] + hi[1]) / 2, al.c[2] - (lo[2] + hi[2]) / 2);
  const half = (n: V3) => {
    // A box L deep on the n side of the plane, 2L wide across it.
    const t: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u0: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]], ul = Math.hypot(...u0);
    const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
    const w: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const o = [0, 1, 2].map(i => al.c[i] - u[i] * L - w[i] * L);
    const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(o[0], o[1], o[2]), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(u[0], u[1], u[2]));
    const box = new oc.BRepPrimAPI_MakeBox_5(ax, 2 * L, 2 * L, L).Shape();
    const mk = new oc.BRepAlgoAPI_Common_3(shape, box, new oc.Message_ProgressRange_1());
    mk.Build(new oc.Message_ProgressRange_1());
    if (!mk.IsDone()) throw new Error("The section could not be cut");
    return mk.Shape();
  };
  const keep = half([-al.s[0], -al.s[1], -al.s[2]]), turn = half(al.s);
  const tr = new oc.gp_Trsf_1();
  tr.SetRotation_1(new oc.gp_Ax1_2(new oc.gp_Pnt_3(al.c[0], al.c[1], al.c[2]), new oc.gp_Dir_4(al.axis[0], al.axis[1], al.axis[2])), al.ang);
  const b = new oc.BRep_Builder(), comp = new oc.TopoDS_Compound();
  b.MakeCompound(comp);
  b.Add(comp, keep);
  b.Add(comp, new oc.BRepBuilderAPI_Transform_2(turn, tr, true).Shape());
  return comp;
}

/** The shapes of a TopTools_ListOfShape (the bindings have no list iterator: walk a copy). */
function shapeList(oc: any, l: any): any[] {
  const out: any[] = [];
  const copy = new oc.TopTools_ListOfShape_3(l);
  while (copy.Size() > 0) { const s = copy.First_1(); out.push(s.Oriented(s.Orientation_1())); copy.RemoveFirst(); }
  copy.delete();
  return out;
}

/** A section view (FR-DRW-012): `view.dir` is the plane's normal, pointing at the viewer; material on the viewer's side of the plane through `p` is cut away. `cut` holds the cut faces as closed 2D loops (outer and holes alike; fill them even-odd). */
/**
 * `stair` (offset and half sections): the cutter is a staircase polygon of (t, o) points in the plane through `o`
 * spanned by `e` and `m`, run through the model square to that plane; values of 1e8 or more stand for "beyond the
 * model". Cut faces lying on any of `planes` (n · p) are hatched. `keep` is drawn whole (components left uncut).
 */
export function section(oc: any, shape: any, view: ViewDir, p: V3, tol = 0.02, poly?: number[], opts: { stair?: { o: V3; e: V3; m: V3; pts: number[]; planes: number[] }; keep?: any } = {}): Projection {
  const { x, y, n } = viewAxes(view);
  const info = shapeInfo(oc, shape);
  const [lo, hi] = info.box;
  const L = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10;
  let box: any;
  const st = opts.stair;
  if (st) {
    const { o, e, m } = st;
    const w: V3 = [e[1] * m[2] - e[2] * m[1], e[2] * m[0] - e[0] * m[2], e[0] * m[1] - e[1] * m[0]];
    const far = L + Math.hypot(o[0] - (lo[0] + hi[0]) / 2, o[1] - (lo[1] + hi[1]) / 2, o[2] - (lo[2] + hi[2]) / 2);
    const cl = (k: number) => Math.abs(k) >= 1e8 ? Math.sign(k) * far : k;
    const mp = new oc.BRepBuilderAPI_MakePolygon_1();
    let last: number[] | null = null;
    for (let i = 0; i + 1 < st.pts.length; i += 2) {
      const t = cl(st.pts[i]), k = cl(st.pts[i + 1]);
      const q = [0, 1, 2].map(j => o[j] + e[j] * t + m[j] * k - w[j] * far);
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) < 1e-7) continue;
      mp.Add_1(new oc.gp_Pnt_3(q[0], q[1], q[2]));
      last = q;
    }
    mp.Close();
    if (!mp.IsDone()) throw new Error("The section could not be cut");
    const face = new oc.BRepBuilderAPI_MakeFace_15(mp.Wire(), true).Face();
    box = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(w[0] * 2 * far, w[1] * 2 * far, w[2] * 2 * far), false, true).Shape();
  } else if (poly && poly.length >= 6) {
    // Broken-out section (FR-DRW-015): only the material inside the outline (view axes u, v),
    // from the plane through p towards the viewer, is taken away.
    const d = dot(p, n);
    const mp = new oc.BRepBuilderAPI_MakePolygon_1();
    for (let i = 0; i + 1 < poly.length; i += 2) {
      const u = poly[i], v = poly[i + 1];
      mp.Add_1(new oc.gp_Pnt_3(x[0] * u + y[0] * v + n[0] * d, x[1] * u + y[1] * v + n[1] * d, x[2] * u + y[2] * v + n[2] * d));
    }
    mp.Close();
    if (!mp.IsDone()) throw new Error("The section could not be cut");
    const face = new oc.BRepBuilderAPI_MakeFace_15(mp.Wire(), true).Face();
    box = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(n[0] * L, n[1] * L, n[2] * L), false, true).Shape();
  } else {
    const o = [p[0] - x[0] * L - y[0] * L, p[1] - x[1] * L - y[1] * L, p[2] - x[2] * L - y[2] * L];
    const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(o[0], o[1], o[2]), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(x[0], x[1], x[2]));
    box = new oc.BRepPrimAPI_MakeBox_5(ax, 2 * L, 2 * L, L).Shape();
  }
  const cutter = new oc.BRepAlgoAPI_Cut_3(shape, box, new oc.Message_ProgressRange_1());
  cutter.Build(new oc.Message_ProgressRange_1());
  if (!cutter.IsDone()) throw new Error("The section could not be cut");
  const rest = cutter.Shape();
  // Which input solid each piece of the result came from, so each component or body is hatched on its own.
  const A0 = oc.TopAbs_ShapeEnum, owned: { f: any; i: number }[] = [];
  {
    let i = 0;
    for (const ex = new oc.TopExp_Explorer_2(shape, A0.TopAbs_SOLID, A0.TopAbs_SHAPE); ex.More(); ex.Next(), i++) {
      const s = ex.Current();
      let pieces = shapeList(oc, cutter.Modified(s));
      if (!pieces.length && !cutter.IsDeleted(s)) pieces = [s];
      for (const pc of pieces) for (const fx = new oc.TopExp_Explorer_2(pc, A0.TopAbs_FACE, A0.TopAbs_SHAPE); fx.More(); fx.Next()) owned.push({ f: fx.Current(), i });
    }
  }
  let drawn = rest;
  if (opts.keep) {
    const b = new oc.BRep_Builder(), c = new oc.TopoDS_Compound();
    b.MakeCompound(c); b.Add(c, rest); b.Add(c, opts.keep);
    drawn = c;
  }
  const proj = project(oc, drawn, view, tol);
  // Faces on the cutting plane: their wires, flattened into the view's axes.
  const cut: number[][] = [], cutOf: number[] = [];
  const A = oc.TopAbs_ShapeEnum, d0 = dot(p, n);
  for (const ex = new oc.TopExp_Explorer_2(rest, A.TopAbs_FACE, A.TopAbs_SHAPE); ex.More(); ex.Next()) {
    const f = oc.TopoDS.Face_1(ex.Current());
    const ad = new oc.BRepAdaptor_Surface_2(f, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
    const pl = ad.Plane(), dn = pl.Axis().Direction(), lp = pl.Location();
    if (Math.abs(Math.abs(dn.X() * n[0] + dn.Y() * n[1] + dn.Z() * n[2]) - 1) > 1e-7) continue;
    const ld = lp.X() * n[0] + lp.Y() * n[1] + lp.Z() * n[2];
    if (!(st ? st.planes : [d0]).some(d => Math.abs(ld - d) <= 1e-5)) continue;
    const owner = owned.find(o => o.f.IsSame(f))?.i ?? -1;
    for (const wx = new oc.TopExp_Explorer_2(f, A.TopAbs_WIRE, A.TopAbs_SHAPE); wx.More(); wx.Next()) {
      const loop: number[] = [];
      for (const it = new oc.BRepTools_WireExplorer_2(oc.TopoDS.Wire_1(wx.Current())); it.More(); it.Next()) {
        const c = new oc.BRepAdaptor_Curve_2(it.Current());
        const fwd = it.Current().Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD;
        const u0 = c.FirstParameter(), u1 = c.LastParameter();
        const nSeg = c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : Math.max(8, Math.ceil((u1 - u0) / 0.1));
        for (let i = 0; i < nSeg; i++) {
          const u = fwd ? u0 + (u1 - u0) * i / nSeg : u1 - (u1 - u0) * i / nSeg;
          const q = c.Value(u), P: V3 = [q.X(), q.Y(), q.Z()];
          loop.push(dot(P, x), dot(P, y));
        }
      }
      if (loop.length >= 6) { cut.push(loop); cutOf.push(owner); }
    }
  }
  return { ...proj, cut, cutOf };
}

// ---------- model topology for dimensions and centre marks (FR-DRW-021/023) ----------

/**
 * A model edge for dimensions: `k` names it by the faces it joins (persistent face names for parts,
 * face indices for files), so a dimension finds it again after the part changes; `m` is its middle.
 * Circles carry centre, axis, radius and the angle they sweep.
 */
export interface MEdge { k: string; t: "l" | "c" | "o"; a: V3; b: V3; m: V3; c?: V3; ax?: V3; r?: number; sp?: number }
/** A cylindrical face: axis point and direction, radius, extent along the axis from `o`, angle swept. */
export interface MCyl { o: V3; ax: V3; r: number; v0: number; v1: number; sp: number; f?: string }
/** `com`: the shape's centre of mass (uniform density), for a drawing's centre of mass point; absent for sheets. */
export interface Topo { edges: MEdge[]; cyls: MCyl[]; com?: V3 }

/** Edges and cylinders of a shape. `names` are the faces' persistent names in TopExp order (else f<i>). */
export function topology(oc: any, shape: any, names?: string[]): Topo {
  const A = oc.TopAbs_ShapeEnum, T = oc.GeomAbs_CurveType;
  const emap = new oc.TopTools_IndexedMapOfShape_1(), fmap = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, A.TopAbs_EDGE, emap);
  oc.TopExp.MapShapes_1(shape, A.TopAbs_FACE, fmap);
  const faceOf: string[][] = Array.from({ length: emap.Extent() + 1 }, () => []);
  const faceEdges: number[][] = [];
  for (let i = 1; i <= fmap.Extent(); i++) {
    const f = fmap.FindKey(i), name = names?.[i - 1] ?? `f${i - 1}`;
    const m = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(f, A.TopAbs_EDGE, m);
    const list: number[] = [];
    for (let j = 1; j <= m.Extent(); j++) { const k = emap.FindIndex(m.FindKey(j)); if (k > 0) { if (!faceOf[k].includes(name)) faceOf[k].push(name); list.push(k); } }
    faceEdges.push(list);
    m.delete();
  }
  const xyz = (p: any): V3 => [p.X(), p.Y(), p.Z()];
  const edges: MEdge[] = [];
  const byIndex: (MEdge | null)[] = [null];
  for (let i = 1; i <= emap.Extent(); i++) {
    const e = oc.TopoDS.Edge_1(emap.FindKey(i));
    let ad: any;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { byIndex.push(null); continue; }
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0) || oc.BRep_Tool.Degenerated(e)) { byIndex.push(null); continue; }
    const k = [...faceOf[i]].sort().join("|") || `e${i}`;
    const a = xyz(ad.Value(u0)), b = xyz(ad.Value(u1)), m = xyz(ad.Value((u0 + u1) / 2));
    const ty = ad.GetType();
    let me: MEdge;
    if (ty === T.GeomAbs_Line) me = { k, t: "l", a, b, m };
    else if (ty === T.GeomAbs_Circle) {
      const ci = ad.Circle();
      me = { k, t: "c", a, b, m, c: xyz(ci.Location()), ax: xyz(ci.Axis().Direction()), r: ci.Radius(), sp: Math.min(2 * Math.PI, u1 - u0) };
    } else me = { k, t: "o", a, b, m };
    edges.push(me);
    byIndex.push(me);
  }
  const cyls: MCyl[] = [];
  for (let i = 1; i <= fmap.Extent(); i++) {
    const f = oc.TopoDS.Face_1(fmap.FindKey(i));
    let sa: any;
    try { sa = new oc.BRepAdaptor_Surface_2(f, true); } catch { continue; }
    if (sa.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) continue;
    const cy = sa.Cylinder(), ax3 = cy.Position();
    const o = xyz(ax3.Location()), ax = unit(xyz(ax3.Direction())), r = cy.Radius();
    let v0 = Infinity, v1 = -Infinity;
    for (const k of faceEdges[i - 1]) {
      const me = byIndex[k];
      if (!me) continue;
      for (const p of [me.a, me.b, me.m]) { const v = dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], ax); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    }
    const sp = Math.min(2 * Math.PI, sa.LastUParameter() - sa.FirstUParameter());
    if (v1 > v0) cyls.push({ o, ax, r, v0, v1, sp, f: names?.[i - 1] ?? `f${i - 1}` });
  }
  emap.delete(); fmap.delete();
  let com: V3 | undefined;
  try {
    const g = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, g, true, false, false);
    if (Math.abs(g.Mass()) > 1e-9) { const c = g.CentreOfMass(); com = [c.X(), c.Y(), c.Z()]; }
    g.delete();
  } catch { /* no volume */ }
  return com ? { edges, cyls, com } : { edges, cyls };
}

// ---------- geometry compare (FR-PDM-050) ----------

/** Triangles of a shape (positions and indices, no normals: the viewer computes them). */
export interface Tris { position: number[]; index: number[] }

export function triangles(oc: any, shape: any, lin: number): Tris {
  new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, 0.4, false);
  const pos: number[] = [], idx: number[] = [];
  const ex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const face = oc.TopoDS.Face_1(ex.Current());
    const loc = new oc.TopLoc_Location_1();
    const h = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (h.IsNull()) continue;
    const tri = h.get(), trsf = loc.Transformation(), base = pos.length / 3;
    for (let i = 1; i <= tri.NbNodes(); i++) { const p = tri.Node(i).Transformed(trsf); pos.push(p.X(), p.Y(), p.Z()); }
    const rev = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    for (let t = 1; t <= tri.NbTriangles(); t++) {
      const T = tri.Triangle(t);
      let a = T.Value(1) - 1, b = T.Value(2) - 1;
      if (rev) [a, b] = [b, a];
      idx.push(base + a, base + b, base + T.Value(3) - 1);
    }
  }
  return { position: pos, index: idx };
}

/**
 * Shading for a view (FR-DRW-010): the shape's triangles that face the viewer, in the view's axes, sorted back to
 * front for painting, each with a grey from a light over the viewer's left shoulder. `lin` is the mesh's chord error.
 */
export function shadeTris(oc: any, shape: any, view: ViewDir, lin: number): number[] {
  const { x, y, n } = viewAxes(view);
  const L = unit([n[0] + 0.35 * y[0] - 0.3 * x[0], n[1] + 0.35 * y[1] - 0.3 * x[1], n[2] + 0.35 * y[2] - 0.3 * x[2]]);
  const { position: P, index: I } = triangles(oc, shape, lin);
  const tris: { d: number; q: number[] }[] = [];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const A: V3 = [P[a], P[a + 1], P[a + 2]], B: V3 = [P[b], P[b + 1], P[b + 2]], C: V3 = [P[c], P[c + 1], P[c + 2]];
    const nn = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    const len = Math.hypot(...nn);
    if (len < 1e-12) continue;
    const N: V3 = [nn[0] / len, nn[1] / len, nn[2] / len];
    if (dot(N, n) <= 1e-6) continue;
    const g = Math.round((0.32 + 0.6 * Math.max(0, dot(N, L))) * 64) / 64;
    tris.push({ d: (dot(A, n) + dot(B, n) + dot(C, n)) / 3, q: [dot(A, x), dot(A, y), dot(B, x), dot(B, y), dot(C, x), dot(C, y), g] });
  }
  tris.sort((p, q) => p.d - q.d);
  return tris.flatMap(t => t.q);
}

export interface ShapeFacts { volume: number; area: number; com: V3; box: [V3, V3] }

export function shapeFacts(oc: any, shape: any): ShapeFacts {
  const vp = new oc.GProp_GProps_1(), sp = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, vp, true, false, false);
  oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
  const c = vp.CentreOfMass();
  return { volume: Math.abs(vp.Mass()), area: sp.Mass(), com: [c.X(), c.Y(), c.Z()], box: shapeInfo(oc, shape).box };
}

export interface GeomDiff {
  a: ShapeFacts; b: ShapeFacts;
  /** Material only in the older version, only in the newer one, and in both. */
  removed: { volume: number; mesh: Tris }; added: { volume: number; mesh: Tris }; common: Tris;
}

/** Two versions of a body: what each has that the other lacks, by booleans, with meshes to show it. */
export function geometryDiff(oc: any, a: any, b: any): GeomDiff {
  const fa = shapeFacts(oc, a), fb = shapeFacts(oc, b);
  const size = Math.max(...[0, 1, 2].map(k => Math.max(fa.box[1][k], fb.box[1][k]) - Math.min(fa.box[0][k], fb.box[0][k])));
  const lin = Math.max(size * 1e-3, 1e-3);
  const run = (kind: "cut" | "common", x: any, y: any) => {
    const pr = new oc.Message_ProgressRange_1();
    const mk = kind === "cut" ? new oc.BRepAlgoAPI_Cut_3(x, y, pr) : new oc.BRepAlgoAPI_Common_3(x, y, pr);
    if (!mk.IsDone() || mk.HasErrors()) throw new Error("The two versions could not be compared.");
    return mk.Shape();
  };
  const rem = run("cut", a, b), add = run("cut", b, a), com = run("common", a, b);
  const vol = (s: any) => { const p = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(s, p, true, false, false); return Math.abs(p.Mass()); };
  return {
    a: fa, b: fb,
    removed: { volume: vol(rem), mesh: triangles(oc, rem, lin) },
    added: { volume: vol(add), mesh: triangles(oc, add, lin) },
    common: triangles(oc, com, lin),
  };
}
